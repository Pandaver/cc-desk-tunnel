import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient, RequestInterruptedError } from '../src/client.ts';
import { getWebSession, pairWeb, logoutWeb } from '../src/browser-api.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, href = 'https://control.example.test/') {
  const original = {
    socket: globalThis.WebSocket,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  const clients = [];
  class Socket {
    static OPEN = 1;
    static all = [];
    readyState = 1;
    sent = [];
    constructor(url) {
      this.url = url;
      Socket.all.push(this);
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
    close(code = 1000) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
    message(value) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  globalThis.WebSocket = Socket;
  globalThis.window = { location: new URL(href) };
  const device = { id: randomUUID(), name: '浏览器' };
  const session = { device, expiresAt: null };
  globalThis.fetch = async () => new Response(JSON.stringify(session));
  t.after(() => {
    for (const client of clients) client.disconnect();
    globalThis.WebSocket = original.socket;
    globalThis.fetch = original.fetch;
    if (original.window === undefined) delete globalThis.window;
    else globalThis.window = original.window;
  });
  const connect = () => {
    const client = new ProxyClient();
    clients.push(client);
    client.connectWeb(device);
    const socket = Socket.all.at(-1);
    socket.onopen();
    return { client, socket };
  };
  const ready = (socket, sessions = []) =>
    socket.message({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      version: '0.3.5',
      connectionId: randomUUID(),
      adapter: 'claude-code',
      sessions,
      web: true,
    });
  return { connect, ready, device, session, Socket };
}

test('browser uses the same business client with cookie auth, without a service token or execution identity', (t) => {
  const { connect, ready } = fixture(t);
  const { client, socket } = connect();
  assert.equal(socket.url, 'wss://control.example.test/web/ws');
  assert.deepEqual(socket.sent, [{ type: 'web.auth', protocolVersion: PROTOCOL_VERSION }]);
  ready(socket);
  assert.equal(client.state.status, 'connected');
  assert.equal(client.state.webEnabled, true);
  assert.equal(client.credentials.reconnect, true);
  assert.equal(client.credentials.token, '');
});

test('browser public HTTP is rejected; loopback development uses the same-origin endpoint', (t) => {
  const { connect } = fixture(t, 'http://public.example.test/');
  assert.throws(connect, /HTTPS/);
  globalThis.window.location = new URL('http://127.0.0.1:18787/');
  const { socket } = connect();
  assert.equal(socket.url, 'ws://127.0.0.1:18787/web/ws');
});

test('revoking an established browser session stops retries and rejects pending operations without replay', async (t) => {
  const { connect, ready } = fixture(t);
  const { client, socket } = connect();
  ready(socket);
  const result = client
    .request({ type: 'run.cancel', sessionId: randomUUID(), runId: randomUUID() })
    .catch((error) => error);
  socket.close(4001);
  assert.ok((await result) instanceof RequestInterruptedError);
  assert.equal(client.state.webSessionExpired, true);
  assert.equal(client.state.status, 'disconnected');
  assert.equal(client.credentials, null);
  assert.equal(client.retryTimer, undefined);
  assert.equal(socket.sent.filter((message) => message.type === 'run.cancel').length, 1);
});

test('a handshake rejection after expiry checks the cookie and returns to login instead of retrying forever', async (t) => {
  const { connect, ready, Socket } = fixture(t);
  const { client, socket } = connect();
  ready(socket);
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  socket.close(1006);
  client.retryNow();
  await turn();
  assert.equal(client.state.webSessionExpired, true);
  assert.equal(Socket.all.length, 1);
});

test('a lost connection checks the same browser session, reconnects, and never resends business writes', async (t) => {
  const { connect, ready, Socket } = fixture(t);
  const { client, socket } = connect();
  ready(socket);
  const result = client
    .request({ type: 'message.send', sessionId: randomUUID(), text: 'once' })
    .catch((error) => error);
  socket.close(1006);
  client.retryNow();
  await turn();
  const next = Socket.all.at(-1);
  assert.notEqual(next, socket);
  next.onopen();
  ready(next);
  assert.ok((await result) instanceof RequestInterruptedError);
  assert.deepEqual(next.sent, [{ type: 'web.auth', protocolVersion: PROTOCOL_VERSION }]);
});

test('a delayed cookie check cannot reopen a disconnected or replaced browser client', async (t) => {
  const { connect, ready, Socket, session } = fixture(t);
  let finish;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const { client, socket } = connect();
  ready(socket);
  socket.close(1006);
  client.retryNow();
  client.disconnect();
  finish(new Response(JSON.stringify(session)));
  await turn();
  assert.equal(Socket.all.length, 1);
  assert.equal(client.state.status, 'disconnected');
});

test('replacing the browser cookie does not silently switch an existing controller identity', async (t) => {
  const { connect, ready, session } = fixture(t);
  const { client, socket } = connect();
  ready(socket);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ...session, device: { id: randomUUID(), name: 'new' } }));
  socket.close(1006);
  client.retryNow();
  await turn();
  assert.equal(client.state.webSessionExpired, true);
});

test('browser sessions independently select conversations while sharing the original protocol handler', (t) => {
  const { connect, ready } = fixture(t);
  const left = connect(),
    right = connect();
  ready(left.socket);
  ready(right.socket);
  const first = randomUUID(),
    second = randomUUID();
  left.client.select(first);
  right.client.select(second);
  assert.equal(left.client.state.selectedId, first);
  assert.equal(right.client.state.selectedId, second);
  assert.equal(left.socket.sent.at(-1).type, 'session.subscribe');
  assert.equal(right.socket.sent.at(-1).type, 'session.subscribe');
});

test('desktop management data replies use the existing correlated request mechanism', async (t) => {
  const { connect, ready } = fixture(t);
  const { client, socket } = connect();
  ready(socket);
  const request = client.fetch({ type: 'web.status' });
  const id = socket.sent.at(-1).requestId;
  socket.message({
    type: 'web.state',
    requestId: id,
    enabled: true,
    origin: 'https://control.example.test',
    grants: [],
  });
  socket.message({ type: 'response', requestId: id, ok: true });
  assert.equal((await request).origin, 'https://control.example.test');
  assert.equal(client.results.size, 0);
});

test('browser login uses same-origin cookies and never persists a service credential', async (t) => {
  const { session } = fixture(t);
  const requests = [];
  globalThis.fetch = async (path, options) => {
    requests.push({ path, options });
    return new Response(JSON.stringify(session));
  };
  assert.deepEqual(await getWebSession(), session);
  assert.deepEqual(await pairWeb('  temporary-code  '), session);
  await logoutWeb();
  assert.deepEqual(
    requests.map((entry) => entry.path),
    ['/web/session', '/web/pair', '/web/logout'],
  );
  for (const { options } of requests) {
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers?.Authorization, undefined);
  }
  assert.deepEqual(JSON.parse(requests[1].options.body), { code: 'temporary-code' });
});

test('anonymous lookup and logout are idempotent while pairing failures retain their useful message', async (t) => {
  fixture(t);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: '配对码已失效' }), { status: 401 });
  assert.equal(await getWebSession(), null);
  await logoutWeb();
  await assert.rejects(pairWeb('invalid'), /配对码已失效/);
});

test('malformed session identities and dates are rejected rather than creating a fake execution device', async (t) => {
  fixture(t);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ device: { id: 'bad', name: 'fake' }, expiresAt: 'never' }));
  await assert.rejects(getWebSession(), /格式不兼容/);
});

function management(t) {
  const fixtureValue = fixture(t);
  const { client, socket } = fixtureValue.connect();
  socket.message({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    version: '0.3.5',
    connectionId: randomUUID(),
    adapter: 'simulation',
    sessions: [],
    web: false,
    webControl: true,
    webPairing: true,
  });
  const reply = (state) => {
    const requestId = socket.sent.at(-1).requestId;
    socket.message({ type: 'web.state', requestId, ...state });
    socket.message({ type: 'response', requestId, ok: true });
  };
  const state = { enabled: true, origin: 'https://control.example.test', grants: [] };
  return { ...fixtureValue, client, socket, reply, state };
}

test('Web management is lazy, caches owner pairing and clears a consumed code on pushed state', async (t) => {
  const { client, socket, reply, state } = management(t);
  assert.equal(client.state.webEnabled, false);
  assert.equal(client.state.webControl, true);
  assert.equal(client.state.webState, null);
  assert.equal(
    socket.sent.some((m) => m.type.startsWith('web.') && m.type !== 'web.auth'),
    false,
  );
  const pending = client.fetch({ type: 'web.status', watch: true });
  const pairing = { code: 'test-code', expiresAt: '2000-01-01T00:00:00.000Z', remainingMs: 300000 };
  reply({ ...state, pairing });
  await pending;
  assert.equal(client.state.webState.pairing.code, pairing.code);
  const unsubscribe = client.subscribe(() => {});
  unsubscribe();
  assert.equal(client.getSnapshot().webState.pairing.code, pairing.code);
  const grant = {
    id: randomUUID(),
    name: 'Browser',
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
  socket.message({ type: 'web.changed', ...state, grants: [grant] });
  assert.equal(client.state.webState.grants.length, 1);
  assert.equal(client.state.webState.pairing, undefined);
  socket.message({ type: 'web.changed', enabled: false, grants: [] });
  assert.equal(client.state.webEnabled, false);
});

test('pair expiry follows the duration, not either computer wall clock', async (t) => {
  const { client, reply, state } = management(t);
  const request = client.fetch({ type: 'web.pair' });
  reply({
    ...state,
    pairing: { code: 'short', expiresAt: '2999-01-01T00:00:00.000Z', remainingMs: 25 },
  });
  await request;
  assert.equal(client.state.webState.pairing.code, 'short');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.state.webState.pairing, undefined);
});

test('Web operations lock across mounts and discard late replies and failed data', async (t) => {
  const { client, socket, state } = management(t);
  const pending = client.fetch({ type: 'web.configure', enabled: true }).catch((e) => e);
  const requestId = socket.sent.at(-1).requestId;
  assert.equal(client.state.webPending, true);
  await assert.rejects(client.fetch({ type: 'web.pair' }), /正在更新/);
  socket.message({ type: 'web.state', requestId, ...state });
  socket.message({ type: 'response', requestId, ok: false, message: 'fixture failure' });
  assert.match((await pending).message, /fixture failure/);
  assert.equal(client.state.webPending, false);
  assert.equal(client.state.webError, 'fixture failure');
  assert.equal(client.results.size, 0);
  socket.message({ type: 'web.state', requestId, enabled: false, grants: [] });
  assert.equal(client.state.webEnabled, true);
});

test('disconnect clears pairing, lock and cached state without an old finally unlocking a new request', async (t) => {
  const { client, socket, device, ready, Socket } = management(t);
  const pending = client.fetch({ type: 'web.status', watch: true }).catch((e) => e);
  socket.close(1006);
  assert.equal(client.state.webPending, false);
  assert.equal(client.state.webState, null);
  assert.equal(client.state.hasConnected, true);
  client.connectWeb(device);
  const next = Socket.all.at(-1);
  assert.equal(client.state.hasConnected, false);
  ready(next);
  const newer = client.fetch({ type: 'web.status' }).catch((e) => e);
  await pending;
  assert.equal(client.state.webPending, true);
  client.disconnect();
  await newer;
  assert.equal(client.state.hasConnected, false);
  assert.equal(client.state.webPending, false);
  assert.equal(client.results.size, 0);
});

test('first connection stays unestablished across retries until a ready frame arrives', async (t) => {
  const { connect, ready, Socket } = fixture(t);
  const { client, socket } = connect();
  socket.close(1006);
  assert.equal(client.state.hasConnected, false);
  client.retryNow();
  await turn();
  const next = Socket.all.at(-1);
  ready(next);
  assert.equal(client.state.hasConnected, true);
  next.close(1012);
  assert.equal(client.state.hasConnected, true);
  assert.equal(client.state.webSessionExpired, false);
});

test('legacy status replies keep the newly issued pairing without extending its lifetime', async (t) => {
  const { connect, ready } = fixture(t);
  const { client, socket } = connect();
  ready(socket);
  const reply = (pairing) => {
    const requestId = socket.sent.at(-1).requestId;
    socket.message({ type: 'web.state', requestId, enabled: true, grants: [], pairing });
    socket.message({ type: 'response', requestId, ok: true });
  };
  const first = client.fetch({ type: 'web.pair' });
  reply({ code: 'legacy', expiresAt: '2000-01-01T00:00:00.000Z' });
  await first;
  const deadline = client.webDeadline;
  const status = client.fetch({ type: 'web.status' });
  reply(undefined);
  await status;
  assert.equal(client.state.webState.pairing.code, 'legacy');
  assert.ok(Math.abs(client.webDeadline - deadline) < 1);
});

test('preparing Web access initializes once under one continuous lock and joins remounts', async (t) => {
  const { client, socket, reply, state } = management(t);
  const pendingStates = [];
  client.subscribe(() => pendingStates.push(client.state.webPending));
  const preparing = client.prepareWebAccess(true);
  assert.equal(client.prepareWebAccess(), preparing);
  assert.equal(client.prepareWebAccess(true), preparing);
  assert.equal(client.state.webPreparing, true);
  assert.equal(socket.sent.at(-1).type, 'web.configure');
  reply(state);
  await turn();
  assert.equal(client.state.webPending, true);
  assert.equal(socket.sent.at(-1).type, 'web.pair');
  assert.equal(socket.sent.at(-1).ifAbsent, true);
  assert.ok(pendingStates.every(Boolean));
  const pairing = { code: 'initialized', expiresAt: new Date().toISOString(), remainingMs: 300000 };
  reply({ ...state, pairing });
  assert.equal((await preparing).pairing.code, pairing.code);
  assert.equal(client.state.webPending, false);
  assert.equal(client.state.webPreparing, false);
  assert.equal(socket.sent.filter((m) => m.type === 'web.pair').length, 1);
});

test('preparation keeps an existing code and never enables a disabled service', async (t) => {
  const { client, socket, reply, state } = management(t);
  const disabled = client.prepareWebAccess();
  assert.equal(socket.sent.at(-1).watch, true);
  reply({ enabled: false, grants: [] });
  assert.equal((await disabled).enabled, false);
  const existing = client.prepareWebAccess();
  const pairing = { code: 'existing', expiresAt: new Date().toISOString(), remainingMs: 100000 };
  reply({ ...state, pairing });
  assert.equal((await existing).pairing.code, 'existing');
  assert.equal(
    socket.sent.some((m) => ['web.configure', 'web.pair'].includes(m.type)),
    false,
  );
});

test('preparation respects a pushed disable or a concurrent code before starting initialization', async (t) => {
  const { client, socket, reply, state } = management(t);
  const disabled = client.prepareWebAccess();
  reply(state);
  socket.message({ type: 'web.changed', enabled: false, grants: [] });
  assert.equal((await disabled).enabled, false);
  const existing = client.prepareWebAccess();
  reply(state);
  socket.message({
    type: 'web.changed',
    ...state,
    pairing: { code: 'other-window', expiresAt: new Date().toISOString(), remainingMs: 100000 },
  });
  assert.equal((await existing).pairing.code, 'other-window');
  assert.equal(
    socket.sent.some((m) => m.type === 'web.pair'),
    false,
  );
});

test('a failed initialization stays explicit and can recover an already-created code on retry', async (t) => {
  const { client, socket, reply, state } = management(t);
  const failed = client.prepareWebAccess().catch((e) => e);
  reply(state);
  await turn();
  socket.message({
    type: 'response',
    requestId: socket.sent.at(-1).requestId,
    ok: false,
    message: 'fixture write failure',
  });
  assert.match((await failed).message, /fixture write failure/);
  assert.equal(client.state.webError, 'fixture write failure');
  assert.equal(client.state.webPending, false);
  assert.equal(client.state.webPreparing, false);
  const before = socket.sent.length;
  await turn();
  assert.equal(socket.sent.length, before);
  const retry = client.prepareWebAccess();
  reply({
    ...state,
    pairing: { code: 'recovered', expiresAt: new Date().toISOString(), remainingMs: 100000 },
  });
  assert.equal((await retry).pairing.code, 'recovered');
  assert.equal(socket.sent.filter((m) => m.type === 'web.pair').length, 1);
  assert.equal(client.state.webError, null);
});

test('preparation cannot carry its second step into a disconnected or replaced service', async (t) => {
  const { client, socket, reply, state, device, Socket, ready } = management(t);
  const stale = client.prepareWebAccess().catch((e) => e);
  reply(state);
  client.connectWeb(device);
  const replacement = Socket.all.at(-1);
  ready(replacement);
  const fresh = client.prepareWebAccess();
  await turn();
  assert.ok((await stale) instanceof RequestInterruptedError);
  assert.equal(client.state.webPending, true);
  assert.equal(
    replacement.sent.some((m) => m.type === 'web.pair'),
    false,
  );
  const requestId = replacement.sent.at(-1).requestId;
  replacement.message({ type: 'web.state', requestId, enabled: true, grants: [] });
  replacement.message({ type: 'response', requestId, ok: true });
  await fresh;
  assert.equal(client.state.webPending, false);
  assert.equal(client.state.webError, null);
});

test('old services without idempotent pairing support are read without automatic mutations', async (t) => {
  const { client, socket, reply, state } = management(t);
  client.update({ webPairing: false });
  const prepared = client.prepareWebAccess();
  reply(state);
  assert.equal((await prepared).pairing, undefined);
  assert.equal(
    socket.sent.some((m) => m.type === 'web.pair'),
    false,
  );
});

test('preparation is serialized against ordinary Web actions and consumption is not a renewal loop', async (t) => {
  const { client, socket, reply, state } = management(t);
  const mutation = client.fetch({ type: 'web.pair' });
  await assert.rejects(client.prepareWebAccess(), /正在更新/);
  reply({
    ...state,
    pairing: { code: 'manual', expiresAt: new Date().toISOString(), remainingMs: 100000 },
  });
  await mutation;
  const before = socket.sent.length;
  socket.message({ type: 'web.changed', ...state });
  await turn();
  assert.equal(client.state.webState.pairing, undefined);
  assert.equal(socket.sent.length, before);
});
