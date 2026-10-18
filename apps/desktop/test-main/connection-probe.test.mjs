import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient } from '../src/client.ts';

function fixture(t) {
  const previous = { socket: globalThis.WebSocket, window: globalThis.window };
  const clients = [];
  class Socket {
    static OPEN = 1;
    static all = [];
    readyState = 1;
    bufferedAmount = 0;
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
  globalThis.window = { location: new URL('https://service.example/') };
  t.after(() => {
    for (const client of clients) client.disconnect();
    globalThis.WebSocket = previous.socket;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
  });
  function connect(browser = false, diagnostics = true) {
    const client = new ProxyClient();
    clients.push(client);
    const device = { id: randomUUID(), name: '测试设备' };
    if (browser) client.connectWeb(device);
    else client.connect('ws://127.0.0.1:8787/ws', 'test-token-'.repeat(4), device, false);
    const socket = Socket.all.at(-1);
    socket.onopen();
    socket.message({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      connectionId: randomUUID(),
      version: '0.3.5',
      adapter: 'simulation',
      sessions: [],
      ...(diagnostics ? { diagnostics: true } : {}),
    });
    return { client, socket };
  }
  const answer = (socket, requestId = socket.sent.at(-1).requestId) =>
    socket.message({ type: 'connection.probe.result', requestId });
  return { connect, answer, Socket };
}

test('desktop and browser measure one shared authenticated round trip without business requests', async (t) => {
  const { connect, answer, Socket } = fixture(t);
  for (const browser of [false, true]) {
    const { client, socket } = connect(browser);
    assert.equal(client.state.diagnosticsEnabled, true);
    const before = client.state;
    const count = Socket.all.length;
    const controller = new AbortController();
    const measurement = client.measureLatency(controller.signal);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    const request = socket.sent.at(-1);
    assert.equal(request.type, 'connection.probe');
    assert.match(request.requestId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(Object.keys(request).sort(), ['requestId', 'type']);
    assert.equal(client.pending.size, 0);
    answer(socket);
    const result = await measurement;
    assert.ok(Number.isFinite(result.elapsed) && result.elapsed >= 0);
    assert.equal(Socket.all.length, count);
    assert.equal(client.state, before);
    assert.equal(client.listeners.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('unrelated IDs and business responses never complete a diagnostic', async (t) => {
  const { connect, answer } = fixture(t);
  const { client, socket } = connect();
  let finished = false;
  const measurement = client.measureLatency(new AbortController().signal).then((result) => {
    finished = true;
    return result;
  });
  const id = socket.sent.at(-1).requestId;
  answer(socket, randomUUID());
  socket.message({ type: 'response', requestId: id, ok: true });
  await Promise.resolve();
  assert.equal(finished, false);
  answer(socket, id);
  await measurement;
  assert.equal(finished, true);
});

test('cancellation releases the probe, ignores its late reply and leaves business requests alone', async (t) => {
  const { connect, answer } = fixture(t);
  const { client, socket } = connect();
  const business = client.request({ type: 'web.status' });
  const businessId = socket.sent.at(-1).requestId;
  const before = client.state;
  const controller = new AbortController();
  const cancelled = assert.rejects(client.measureLatency(controller.signal), {
    name: 'AbortError',
  });
  const oldId = socket.sent.at(-1).requestId;
  controller.abort();
  await cancelled;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(client.pending.size, 1);
  let complete = false;
  const next = client.measureLatency(new AbortController().signal).then(() => {
    complete = true;
  });
  const nextId = socket.sent.at(-1).requestId;
  answer(socket, oldId);
  await Promise.resolve();
  assert.equal(complete, false);
  answer(socket, nextId);
  await next;
  socket.message({ type: 'response', requestId: businessId, ok: true });
  await business;
  assert.equal(client.state, before);
  assert.equal(client.pending.size, 0);
});

test('three-second diagnostic timeout does not reconnect or change the business error', async (t) => {
  const { connect, answer } = fixture(t);
  const { client, socket } = connect();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = client.state;
  const rejected = assert.rejects(client.measureLatency(new AbortController().signal), {
    name: 'TimeoutError',
  });
  t.mock.timers.tick(3000);
  await rejected;
  assert.equal(client.state, before);
  assert.equal(client.retryTimer, undefined);
  assert.equal(client.pending.size, 0);
  const next = client.measureLatency(new AbortController().signal);
  answer(socket);
  await next;
});

test('disconnect and connection identity change cancel rather than relabel a result', async (t) => {
  const { connect, answer } = fixture(t);
  for (const action of ['disconnect', 'close', 'identity']) {
    const { client, socket } = connect();
    const rejected = assert.rejects(client.measureLatency(new AbortController().signal), {
      name: 'AbortError',
    });
    const id = socket.sent.at(-1).requestId;
    if (action === 'disconnect') client.disconnect();
    else if (action === 'close') socket.close();
    else client.update({ connectionId: randomUUID() });
    await rejected;
    answer(socket, id);
    assert.equal(client.pending.size, 0);
  }
});

test('old servers, disconnected and congested sockets send no diagnostics', async (t) => {
  const { connect } = fixture(t);
  const old = connect(false, false);
  const count = old.socket.sent.length;
  assert.equal(old.client.state.diagnosticsEnabled, false);
  await assert.rejects(old.client.measureLatency(new AbortController().signal), /不支持/);
  assert.equal(old.socket.sent.length, count);
  const { client, socket } = connect();
  const before = socket.sent.length;
  await assert.rejects(client.measureLatency(AbortSignal.abort()), { name: 'AbortError' });
  socket.bufferedAmount = 65537;
  await assert.rejects(client.measureLatency(new AbortController().signal), /正忙/);
  assert.equal(socket.sent.length, before);
  client.disconnect();
  await assert.rejects(client.measureLatency(new AbortController().signal), /尚未连接/);
});

test('concurrent starts and synchronous send failures release no business resources', async (t) => {
  const { connect, answer } = fixture(t);
  const { client, socket } = connect();
  const first = client.measureLatency(new AbortController().signal);
  await assert.rejects(client.measureLatency(new AbortController().signal), /正在进行/);
  answer(socket);
  await first;
  const send = socket.send;
  socket.send = () => {
    throw new Error('write failed');
  };
  const before = client.state;
  await assert.rejects(client.measureLatency(new AbortController().signal), /发送失败/);
  socket.send = send;
  const next = client.measureLatency(new AbortController().signal);
  answer(socket);
  await next;
  assert.equal(client.state, before);
  assert.equal(client.pending.size, 0);
});
