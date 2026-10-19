import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  existsSync,
  renameSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { WebAccess } from '../src/web-access.ts';

const token = 'web-test-' + randomUUID();
const origin = 'http://localhost';

async function rejectedUpgrade(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url.replace('http', 'ws'), { headers });
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    socket.once('open', () => {
      socket.terminate();
      reject(new Error('Unexpected upgrade'));
    });
    socket.once('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.once('end', () => resolve({ status: response.statusCode!, body }));
    });
    socket.on('error', () => {});
  });
  try {
    return await response;
  } finally {
    socket.terminate();
  }
}
class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  constructor(url: string, browser?: string, prefix = '', browserOrigin = origin) {
    this.socket = new WebSocket(
      url.replace('http', 'ws') + (browser ? `${prefix}/web/ws` : '/ws'),
      browser
        ? { origin: browserOrigin, headers: { Host: new URL(browserOrigin).host, Cookie: browser } }
        : {},
    );
    this.socket.on('message', (raw) =>
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
    );
    this.socket.on('error', () => {});
  }
  async open(browser = false, device: string = randomUUID()) {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.send(
      browser
        ? { type: 'web.auth', protocolVersion: PROTOCOL_VERSION }
        : { type: 'auth', token, protocolVersion: PROTOCOL_VERSION, deviceName: '测试设备' },
    );
    if (!browser) this.send({ type: 'device', id: device });
    return this.wait((message) => message.type === 'ready');
  }
  send(value: object) {
    this.socket.send(JSON.stringify(value));
  }
  async wait(predicate: (message: ServerMessage) => boolean) {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for Web message');
  }
  async request(command: object) {
    const requestId = randomUUID();
    this.send({ ...command, requestId });
    const response = await this.wait(
      (message) => message.type === 'response' && message.requestId === requestId,
    );
    assert.equal(response.type, 'response');
    return response as Extract<ServerMessage, { type: 'response' }>;
  }
  async state(type = 'web.status', fields = {}) {
    const requestId = randomUUID();
    this.send({ type, requestId, ...fields });
    const state = await this.wait(
      (message) => message.type === 'web.state' && message.requestId === requestId,
    );
    assert.equal(state.type, 'web.state');
    return state as Extract<ServerMessage, { type: 'web.state' }>;
  }
}

async function fixture(
  t: TestContext,
  enabled = true,
  start = enabled,
  corrupt = false,
  configuredOrigin = origin,
  reverseProxy = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-access-'));
  const dist = join(directory, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'main-test.js'), 'export const app = true;');
  writeFileSync(join(dist, 'assets', 'main-test.js.map'), 'private source');
  writeFileSync(join(dist, 'private.json'), 'private configuration');
  writeFileSync(join(dist, 'favicon.ico'), 'icon');
  if (corrupt) writeFileSync(join(directory, 'web-grants.json'), '{');
  const server = createProxyServer({
    token,
    dataDir: directory,
    stepMs: 5,
    reverseProxy,
    ...(enabled ? { web: { origin: configuredOrigin, directory: dist } } : {}),
  });
  const url = await server.listen(0);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function prefix() {
    const file = join(directory, 'web-access', 'settings.json');
    const path = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).path : '';
    return path ? `/${path}` : '';
  }
  async function connect(cookie?: string, device?: string) {
    const client = new Client(url, cookie, prefix());
    clients.push(client);
    const ready = await client.open(!!cookie, device);
    return { client, ready };
  }
  async function http(
    path: string,
    method = 'GET',
    body?: object | string,
    headers: Record<string, string> = {},
    raw = false,
  ) {
    return new Promise<Response>((resolve, reject) => {
      const payload = typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined;
      const request = httpRequest(
        url + (raw || path === '/health' ? '' : prefix()) + path,
        {
          method,
          headers: {
            Host: 'localhost',
            ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const resultHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers))
              for (const item of [value].flat())
                if (item !== undefined) resultHeaders.append(key, item);
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode!,
                headers: resultHeaders,
              }),
            );
          });
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  }
  async function pair(desktop: Client) {
    const state = await desktop.state('web.pair');
    assert.ok(state.pairing);
    const response = await http('/web/pair', 'POST', { code: state.pairing.code });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    return {
      cookie,
      state,
      response,
      session: (await response.json()) as { device: { id: string }; expiresAt: null },
    };
  }
  if (start) {
    const { client } = await connect();
    assert.equal((await client.request({ type: 'web.configure', enabled: true })).ok, true);
    client.socket.close();
    await new Promise<void>((resolve) => client.socket.once('close', resolve));
  }
  return {
    directory,
    dist,
    server,
    url,
    clients,
    connect,
    http,
    pair,
    get path() {
      return prefix();
    },
  };
}

test('disabled Web leaves health, desktop authentication and unknown HTTP routes unchanged', async (t) => {
  const f = await fixture(t, false);
  assert.equal((await f.http('/')).status, 404);
  assert.equal((await f.http('/web/session')).status, 404);
  assert.equal((await f.http('/health')).status, 200);
  const { client, ready } = await f.connect();
  assert.equal(ready.type === 'ready' && ready.web, undefined);
  const state = await client.state();
  assert.equal(state.enabled, false);
  assert.deepEqual(state.grants, []);
  assert.equal(state.origin, undefined);
  assert.equal(existsSync(join(f.directory, 'web-grants.json')), false);
  assert.equal(ready.type === 'ready' && ready.webControl, undefined);
  assert.equal(
    (await client.request({ type: 'web.configure', enabled: true })).code,
    'web_unconfigured',
  );
});

test('same-origin pairing consumes code once, stores only a hash, survives restart and revokes all sockets', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const paired = await f.pair(desktop);
  assert.match(
    paired.response.headers.get('set-cookie')!,
    /HttpOnly; SameSite=Strict; Max-Age=34560000/,
  );
  assert.doesNotMatch(paired.response.headers.get('set-cookie')!, /Secure/);
  const session = await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), paired.session);
  assert.equal(paired.session.expiresAt, null);
  assert.equal(session.headers.get('set-cookie')!.split(';')[0], paired.cookie);
  assert.match(session.headers.get('set-cookie')!, /Max-Age=34560000/);
  assert.equal(
    (await f.http('/web/pair', 'POST', { code: paired.state.pairing!.code })).status,
    401,
  );
  const saved = readFileSync(join(f.directory, 'web-grants.json'), 'utf8');
  assert.ok(!saved.includes(paired.cookie.split('=')[1]));
  assert.ok(!saved.includes(paired.state.pairing!.code));
  const restarted = new WebAccess({ origin, directory: f.dist }, f.directory);
  assert.equal(restarted.state().grants.length, 1);
  restarted.close();
  const first = (await f.connect(paired.cookie)).client;
  const second = (await f.connect(paired.cookie)).client;
  const closed = [first, second].map(
    (client) => new Promise<number>((resolve) => client.socket.once('close', resolve)),
  );
  const response = await desktop.request({ type: 'web.revoke', grantId: paired.session.device.id });
  assert.equal(response.ok, true);
  assert.deepEqual(await Promise.all(closed), [4001, 4001]);
  assert.equal(
    (await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie })).status,
    401,
  );
  assert.deepEqual((await desktop.state()).grants, []);
});

test('browser uses existing session core without a seat, and disconnect does not stop its target run', async (t) => {
  const f = await fixture(t);
  const device = randomUUID();
  const { client: desktop } = await f.connect(undefined, device);
  const created = await desktop.request({
    type: 'session.create',
    title: '共享会话',
    projectPath: 'C:\\work',
  });
  assert.equal(created.ok, true);
  const paired = await f.pair(desktop);
  const { client: browser, ready } = await f.connect(paired.cookie);
  assert.ok(ready.type === 'ready' && ready.sessions.some((s) => s.id === created.sessionId));
  const presence = await browser.wait((message) => message.type === 'devices');
  assert.ok(presence.type === 'devices');
  assert.deepEqual(
    presence.devices.map((d) => d.id),
    [device],
  );
  assert.equal(
    (await browser.request({ type: 'session.subscribe', sessionId: created.sessionId })).ok,
    true,
  );
  assert.equal(
    (
      await browser.request({
        type: 'message.send',
        sessionId: created.sessionId,
        text: '浏览器消息',
        scenario: 'tool',
      })
    ).ok,
    true,
  );
  const approval = await browser.wait(
    (m) => m.type === 'session.event' && m.event.payload.type === 'approval.requested',
  );
  assert.ok(
    approval.type === 'session.event' && approval.event.payload.type === 'approval.requested',
  );
  browser.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(f.server.store.get(created.sessionId!).session.activeRun);
  const { client: another } = await f.connect(paired.cookie);
  assert.equal(
    (
      await another.request({
        type: 'approval.reply',
        sessionId: created.sessionId,
        runId: approval.event.runId,
        approvalId: approval.event.payload.approvalId,
        allowed: true,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await another.request({
        type: 'run.cancel',
        sessionId: created.sessionId,
        runId: approval.event.runId,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await another.request({
        type: 'session.rename',
        sessionId: created.sessionId,
        title: '重命名',
      })
    ).ok,
    true,
  );
  assert.equal(f.server.store.get(created.sessionId!).session.device!.id, device);
  assert.equal(f.server.store.get(created.sessionId!).session.title, '重命名');
});

test('browser denies device-local and administrative commands and cannot impersonate a desktop', async (t) => {
  const f = await fixture(t);
  const device = randomUUID();
  const { client: desktop } = await f.connect(undefined, device);
  const created = await desktop.request({
    type: 'session.create',
    title: '固定设备',
    projectPath: 'C:\\work',
  });
  const paired = await f.pair(desktop);
  const { client: browser } = await f.connect(paired.cookie);
  for (const command of [
    { type: 'session.create', title: '无执行设备', projectPath: 'C:\\other' },
    { type: 'session.move', sessionId: created.sessionId, projectPath: 'C:\\other' },
    { type: 'session.fork', sessionId: created.sessionId },
    { type: 'account.login' },
    { type: 'settings.get' },
    { type: 'instructions.get' },
    { type: 'service.update.check' },
    { type: 'web.status' },
    { type: 'web.configure', enabled: false },
    { type: 'web.pair' },
    { type: 'web.revoke', grantId: paired.session.device.id },
  ]) {
    const response = await browser.request(command);
    assert.equal(response.ok, false, command.type);
    assert.equal(response.code, 'browser_unavailable', command.type);
  }
  const closed = new Promise<number>((resolve) => browser.socket.once('close', resolve));
  browser.send({ type: 'device', id: device });
  assert.equal(await closed, 4002);
  assert.equal(f.server.store.list().length, 1);
  assert.equal(f.server.store.get(created.sessionId!).session.device!.id, device);
  assert.equal(
    (
      await desktop.request({
        type: 'session.rename',
        sessionId: created.sessionId,
        title: '仍在线',
      })
    ).ok,
    true,
  );
  for (const frame of [
    {
      type: 'tunnel.attach',
      connectionId: randomUUID(),
      channelId: randomUUID(),
      secret: 'a'.repeat(64),
    },
    { type: 'auth', protocolVersion: PROTOCOL_VERSION, token, deviceName: '伪装' },
  ]) {
    const { client } = await f.connect(paired.cookie);
    const stopped = new Promise<number>((resolve) => client.socket.once('close', resolve));
    client.send(frame);
    assert.equal(await stopped, 4002);
  }
});

test('strict HTTP origin and host, body validation, throttling and static allowlist', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.http('/')).status, 200);
  const asset = await f.http('/assets/main-test.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type')!, /javascript/);
  assert.match(asset.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  for (const path of [
    '/private.json',
    '/assets/main-test.js.map',
    '/web/unknown',
    '/settings',
    '/assets/%2e%2e/private.json',
  ])
    assert.equal((await f.http(path)).status, 404, path);
  assert.equal((await f.http('/', 'GET', undefined, { Host: 'attacker.test' })).status, 404);
  assert.equal(
    (
      await f.http(
        '/web/pair',
        'POST',
        { code: 'a'.repeat(24) },
        { Origin: 'http://attacker.test' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.http('/web/pair', 'POST', '{}', { 'Content-Type': 'text/plain' })).status,
    415,
  );
  assert.equal((await f.http('/web/pair', 'POST', 'x'.repeat(1025))).status, 413);
  assert.equal((await f.http('/web/pair', 'POST', '{')).status, 400);
  for (let i = 0; i < 5; i++)
    assert.equal((await f.http('/web/pair', 'POST', { code: 'a'.repeat(24) })).status, 401);
  assert.equal((await f.http('/web/pair', 'POST', { code: 'a'.repeat(24) })).status, 429);
});

test('concurrent code redemption creates one grant; logout revokes it and clears cookie', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const state = await desktop.state('web.pair');
  const responses = await Promise.all(
    [1, 2].map(() => f.http('/web/pair', 'POST', { code: state.pairing!.code })),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
  const cookie = responses
    .find((r) => r.status === 200)!
    .headers.get('set-cookie')!
    .split(';')[0];
  const { client: browser } = await f.connect(cookie);
  const closed = new Promise<number>((resolve) => browser.socket.once('close', resolve));
  const logout = await f.http('/web/logout', 'POST', {}, { Cookie: cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(await closed, 4001);
  assert.equal((await f.http('/web/session', 'GET', undefined, { Cookie: cookie })).status, 401);
});

test('nonloopback plaintext and inconsistent transport are rejected when the Web module starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-config-'));
  try {
    for (const [configured, transport] of [
      ['http://public.example', {}],
      ['http://localhost', { host: '0.0.0.0' }],
      ['https://public.example', {}],
      ['https://public.example/path', { reverseProxy: true }],
      ['https://user:pass@public.example', { reverseProxy: true }],
    ] as const)
      assert.throws(() => new WebAccess({ origin: configured, directory }, directory, transport));
    const valid = new WebAccess({ origin: 'https://public.example', directory }, directory, {
      reverseProxy: true,
    });
    valid.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function webRequest(web: WebAccess, code: string, configuredOrigin = origin) {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ code }))]), {
    method: 'POST',
    url: `/${web.state().path}/web/pair`,
    headers: {
      host: new URL(configuredOrigin).host,
      origin: configuredOrigin,
      'content-type': 'application/json',
    },
  }) as unknown as IncomingMessage;
  let status = 0;
  let body = '';
  const headers = new Map<string, string>();
  const response = {
    setHeader(key: string, value: string) {
      headers.set(key, value);
    },
    writeHead(value: number) {
      status = value;
      return this;
    },
    end(value = '') {
      body = value;
      return this;
    },
  } as unknown as ServerResponse;
  await web.handle(request, response, 'test');
  return { status, body, headers };
}

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    codes: number[];
    close: (code: number) => void;
  };
  socket.codes = [];
  socket.close = (code) => {
    socket.codes.push(code);
    socket.emit('close');
  };
  return socket;
}

test('temporary pair codes expire but permanent grants and sockets survive time and service restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-expiry-'));
  let now = Date.now();
  const web = new WebAccess({ origin, directory }, directory, {}, () => now);
  try {
    const expired = web.pair('desktop');
    now += 5 * 60_000;
    assert.equal((await webRequest(web, expired.code)).status, 401);
    const pairing = web.pair('desktop');
    const result = await webRequest(web, pairing.code);
    assert.equal(result.status, 200);
    const secret = result.headers.get('Set-Cookie')!.split(';')[0];
    const request = { headers: { cookie: secret } } as IncomingMessage;
    const grant = web.authenticate(request)!;
    assert.ok(grant);
    const sockets = Array.from({ length: 9 }, fakeSocket);
    sockets.forEach((socket, index) =>
      assert.equal(web.attach(grant, socket as unknown as WebSocket), index < 8),
    );
    assert.equal(
      web.authenticate({ headers: { cookie: `${secret}; ${secret}` } } as IncomingMessage),
      undefined,
    );
    now += 800 * 24 * 60 * 60_000;
    assert.equal(web.active(grant.id), true);
    assert.equal(web.authenticate(request)?.id, grant.id);
    assert.ok(sockets.every((socket) => socket.codes.length === 0));
    assert.equal(web.state().grants.length, 1);
    assert.equal(web.state().grants[0].expiresAt, null);
    const restarted = new WebAccess({ origin, directory }, directory, {}, () => now);
    assert.equal(restarted.state().grants.length, 1);
    assert.equal(restarted.authenticate(request)?.id, grant.id);
    restarted.close();
    web.revoke(grant.id);
    assert.equal(web.active(grant.id), false);
    assert.ok(sockets.slice(0, 8).every((socket) => socket.codes[0] === 4001));
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('grant write failures preserve pairing and existing access; corrupt grant files fail closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-storage-'));
  const web = new WebAccess({ origin, directory }, directory);
  try {
    const pairing = web.pair('desktop');
    const blocked = join(directory, 'web-grants.json.tmp');
    mkdirSync(blocked);
    await assert.rejects(webRequest(web, pairing.code));
    assert.equal(web.state().grants.length, 0);
    rmSync(blocked, { recursive: true });
    const paired = await webRequest(web, pairing.code);
    assert.equal(paired.status, 200);
    const grant = web.state().grants[0];
    mkdirSync(blocked);
    assert.throws(() => web.revoke(grant.id));
    assert.equal(web.active(grant.id), true);
    rmSync(blocked, { recursive: true });
    web.revoke(grant.id);
    assert.equal(web.active(grant.id), false);
    writeFileSync(join(directory, 'web-grants.json'), '{');
    assert.throws(() => new WebAccess({ origin, directory }, directory), /invalid/);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pair and persisted grant storage remain bounded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-bounds-'));
  const web = new WebAccess({ origin, directory }, directory);
  try {
    for (let i = 0; i < 16; i++) web.pair(String(i));
    assert.throws(() => web.pair('overflow'), /请求过多/);
    assert.ok(web.pair('0').code);
    const now = Date.now();
    const grants = Array.from({ length: 64 }, () => ({
      id: randomUUID(),
      name: '浏览器',
      createdAt: new Date(now).toISOString(),
      expiresAt: null,
      secretHash: createHash('sha256').update(randomUUID()).digest('hex'),
    }));
    writeFileSync(join(directory, 'web-grants.json'), JSON.stringify(grants));
    const full = new WebAccess({ origin, directory }, directory);
    assert.throws(() => full.pair('desktop'), /上限/);
    full.close();
    grants.push({ ...grants[0], id: randomUUID() });
    writeFileSync(join(directory, 'web-grants.json'), JSON.stringify(grants));
    assert.throws(() => new WebAccess({ origin, directory }, directory), /invalid/);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('asset symlinks cannot escape the configured frontend directory', async (t) => {
  const f = await fixture(t);
  const outside = join(f.directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.js'), 'secret');
  renameSync(join(f.dist, 'assets'), join(f.dist, 'original-assets'));
  symlinkSync(outside, join(f.dist, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.http('/assets/secret.js')).status, 404);
});

test('WebSocket requires cookie and exact Origin/Host; wrong protocol does not look like expired login', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const paired = await f.pair(desktop);
  for (const headers of [
    { Host: 'localhost', Origin: origin },
    { Host: 'localhost', Origin: 'http://other.test', Cookie: paired.cookie },
    { Host: 'other.test', Origin: origin, Cookie: paired.cookie },
    { Host: 'localhost', Cookie: paired.cookie },
  ]) {
    const ws = new WebSocket(f.url.replace('http', 'ws') + f.path + '/web/ws', { headers });
    const error = await new Promise<Error>((resolve) => ws.once('error', resolve));
    assert.match(error.message, headers.Host === 'other.test' ? /404/ : /403/);
  }
  const client = new Client(f.url, paired.cookie, f.path);
  f.clients.push(client);
  await new Promise<void>((resolve) => client.socket.once('open', resolve));
  const closed = new Promise<number>((resolve) => client.socket.once('close', resolve));
  client.send({ type: 'web.auth', protocolVersion: PROTOCOL_VERSION + 1 });
  const error = await client.wait((m) => m.type === 'connection.error');
  assert.ok(error.type === 'connection.error' && error.code === 'version_mismatch');
  assert.equal(await closed, 4002);
  assert.equal(
    (await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie })).status,
    200,
  );
});

test('authenticated browser command bursts are bounded without affecting the desktop connection', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const paired = await f.pair(desktop);
  const { client: browser } = await f.connect(paired.cookie);
  for (let i = 0; i < 100; i++)
    assert.equal((await browser.request({ type: 'web.status' })).code, 'browser_unavailable');
  assert.equal((await browser.request({ type: 'web.status' })).code, 'too_many_requests');
  assert.equal((await desktop.state()).enabled, true);
});

test('an idle browser remains authenticated until the grant is explicitly revoked', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-idle-'));
  let now = Date.now();
  const grant = {
    id: randomUUID(),
    name: '浏览器',
    createdAt: new Date(now).toISOString(),
    expiresAt: null,
    secretHash: createHash('sha256').update('test').digest('hex'),
  };
  writeFileSync(join(directory, 'web-grants.json'), JSON.stringify([grant]));
  const web = new WebAccess({ origin, directory }, directory, {}, () => now);
  try {
    const socket = fakeSocket();
    assert.equal(web.attach(grant, socket as unknown as WebSocket), true);
    now += 10 * 365 * 24 * 60 * 60_000;
    assert.equal(web.active(grant.id), true);
    assert.deepEqual(socket.codes, []);
    web.revoke(grant.id);
    assert.deepEqual(socket.codes, [4001]);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('browser connection limit requests a later retry without revoking its login', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const paired = await f.pair(desktop);
  for (let i = 0; i < 8; i++) await f.connect(paired.cookie);
  const extra = new Client(f.url, paired.cookie, f.path);
  f.clients.push(extra);
  const closed = await new Promise<number>((resolve) => extra.socket.once('close', resolve));
  assert.equal(closed, 1013);
  assert.equal(
    (await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie })).status,
    200,
  );
  assert.equal((await desktop.state()).grants.length, 1);
});

test('browser cookies isolate same-host services by port and protocol', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-cookie-origins-'));
  const services: WebAccess[] = [];
  try {
    const origins = ['http://localhost:8787', 'http://localhost:8788', 'https://localhost:8787'];
    const cookies: string[] = [];
    const ids: string[] = [];
    for (const [index, configuredOrigin] of origins.entries()) {
      const dataDir = join(directory, String(index));
      mkdirSync(dataDir);
      const web = new WebAccess({ origin: configuredOrigin, directory }, dataDir, {
        reverseProxy: true,
      });
      services.push(web);
      const response = await webRequest(web, web.pair('desktop').code, configuredOrigin);
      assert.equal(response.status, 200);
      const setCookie = response.headers.get('Set-Cookie')!;
      assert.match(setCookie, /^cc_web_session_[a-f0-9]{16}=/);
      assert.equal(setCookie.includes('; Secure'), configuredOrigin.startsWith('https:'));
      cookies.push(setCookie.split(';')[0]);
      ids.push((JSON.parse(response.body) as { device: { id: string } }).device.id);
    }
    assert.equal(new Set(cookies.map((cookie) => cookie.split('=')[0])).size, 3);
    const jar = cookies.join('; ');
    for (const [index, web] of services.entries()) {
      assert.equal(
        web.authenticate({ headers: { cookie: jar } } as IncomingMessage)?.id,
        ids[index],
      );
      const otherCookies = cookies.filter((_, cookieIndex) => cookieIndex !== index).join('; ');
      assert.equal(
        web.authenticate({ headers: { cookie: otherCookies } } as IncomingMessage),
        undefined,
      );
    }
  } finally {
    for (const web of services) web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('configured Web starts off without reading corrupt grant storage; enable failures do not stop desktop work', async (t) => {
  const f = await fixture(t, true, false, true);
  const { client: desktop, ready } = await f.connect();
  assert.ok(ready.type === 'ready' && ready.webControl === true && ready.web === undefined);
  assert.equal((await f.http('/')).status, 404);
  assert.equal((await f.http('/web/session')).status, 404);
  assert.equal((await desktop.state('web.status', { watch: true })).enabled, false);
  const failed = await desktop.request({ type: 'web.configure', enabled: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'web_start_failed');
  assert.equal(readFileSync(join(f.directory, 'web-grants.json'), 'utf8'), '{');
  assert.equal((await f.http('/health')).status, 200);
  assert.equal(
    (await desktop.request({ type: 'session.create', title: '未受影响', projectPath: 'C:\\work' }))
      .ok,
    true,
  );
  assert.equal(
    desktop.messages.some((message) => message.type === 'web.changed'),
    false,
  );
  writeFileSync(join(f.directory, 'web-grants.json'), '[]');
  assert.equal((await desktop.state('web.configure', { enabled: true })).enabled, true);
  assert.equal((await f.http('/')).status, 200);
  assert.equal((await desktop.state('web.configure', { enabled: false })).enabled, false);
  assert.equal((await f.http('/')).status, 404);
  assert.equal((await desktop.state('web.configure', { enabled: false })).enabled, false);
  assert.equal((await desktop.state('web.configure', { enabled: true })).enabled, true);
  assert.equal((await f.http('/')).status, 200);
});

test('disabling Web preserves grants, the desktop connection and active tasks; enabling restores browser login', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const created = await desktop.request({
    type: 'session.create',
    title: '持续执行',
    projectPath: 'C:\\work',
  });
  await desktop.request({ type: 'session.subscribe', sessionId: created.sessionId });
  await desktop.request({
    type: 'message.send',
    sessionId: created.sessionId,
    text: '等待审批',
    scenario: 'tool',
  });
  await desktop.wait(
    (message) =>
      message.type === 'session.event' && message.event.payload.type === 'approval.requested',
  );
  const paired = await f.pair(desktop);
  const { client: browser } = await f.connect(paired.cookie);
  const pending = await desktop.state('web.pair');
  const stored = readFileSync(join(f.directory, 'web-grants.json'), 'utf8');
  const closed = new Promise<number>((resolve) => browser.socket.once('close', resolve));
  await desktop.state('web.configure', { enabled: false });
  assert.equal(await closed, 1012);
  assert.equal(
    (await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie })).status,
    404,
  );
  assert.equal(readFileSync(join(f.directory, 'web-grants.json'), 'utf8'), stored);
  assert.equal(desktop.socket.readyState, WebSocket.OPEN);
  assert.equal(
    f.server.store.get(created.sessionId!).session.activeRun?.status,
    'awaiting_approval',
  );
  await desktop.state('web.configure', { enabled: true });
  assert.equal(
    (await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie })).status,
    200,
  );
  assert.equal((await f.http('/web/pair', 'POST', { code: pending.pairing!.code })).status, 401);
  assert.equal((await desktop.state()).pairing, undefined);
  await f.connect(paired.cookie);
  assert.equal(
    (
      await desktop.request({
        type: 'session.subscribe',
        sessionId: created.sessionId,
      })
    ).ok,
    true,
  );
});

test('only subscribed desktops receive personalized live changes for pairing, redemption, logout and enablement', async (t) => {
  const f = await fixture(t, true, false);
  const device = randomUUID();
  const { client: first } = await f.connect(undefined, device);
  const { client: other } = await f.connect();
  const { client: legacy } = await f.connect();
  await first.state('web.status', { watch: true });
  await other.state('web.status', { watch: true });
  await legacy.state();
  await first.state('web.configure', { enabled: true });
  for (const client of [first, other]) {
    const enabled = await client.wait((message) => message.type === 'web.changed');
    assert.ok(enabled.type === 'web.changed' && enabled.enabled && !enabled.pairing);
  }
  const pairing = await first.state('web.pair');
  const own = await first.wait((message) => message.type === 'web.changed');
  const foreign = await other.wait((message) => message.type === 'web.changed');
  assert.ok(own.type === 'web.changed' && own.pairing?.code === pairing.pairing!.code);
  assert.ok(foreign.type === 'web.changed' && foreign.pairing === undefined);
  assert.ok(pairing.pairing!.remainingMs! > 299_000 && pairing.pairing!.remainingMs! <= 300_000);
  assert.equal((await first.state()).pairing?.code, pairing.pairing!.code);
  const { client: reconnected } = await f.connect(undefined, device);
  assert.equal((await reconnected.state()).pairing?.code, pairing.pairing!.code);
  const renewed = await first.state('web.pair');
  assert.notEqual(renewed.pairing!.code, pairing.pairing!.code);
  assert.equal((await f.http('/web/pair', 'POST', { code: pairing.pairing!.code })).status, 401);
  for (const client of [first, other])
    await client.wait((message) => message.type === 'web.changed');
  const response = await f.http('/web/pair', 'POST', { code: renewed.pairing!.code });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  for (const client of [first, other]) {
    const consumed = await client.wait((message) => message.type === 'web.changed');
    assert.ok(consumed.type === 'web.changed' && consumed.grants.length === 1 && !consumed.pairing);
  }
  const { client: browser } = await f.connect(cookie);
  await f.http('/web/logout', 'POST', {}, { Cookie: cookie });
  for (const client of [first, other]) {
    const logout = await client.wait((message) => message.type === 'web.changed');
    assert.ok(logout.type === 'web.changed' && logout.grants.length === 0);
  }
  await other.state('web.status', { watch: false });
  await first.state('web.configure', { enabled: false });
  const disabled = await first.wait((message) => message.type === 'web.changed');
  assert.ok(disabled.type === 'web.changed' && !disabled.enabled && !disabled.pairing);
  for (const client of [other, legacy, browser, reconnected])
    assert.equal(
      client.messages.some((message) => message.type === 'web.changed'),
      false,
    );
});

test('public links from other sites load the entry page without loosening API or WebSocket origins', async (t) => {
  const f = await fixture(t);
  const external = {
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    Origin: 'https://external.example',
  };
  assert.equal((await f.http('/', 'GET', undefined, external)).status, 200);
  assert.equal(
    (
      await f.http('/assets/main-test.js', 'GET', undefined, {
        Origin: 'https://external.example',
        'Sec-Fetch-Site': 'cross-site',
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.http('/', 'GET', undefined, { ...external, Host: 'attacker.example' })).status,
    404,
  );
  assert.equal((await f.http('/web/session', 'GET', undefined, external)).status, 403);
  assert.equal((await f.http('/web/pair', 'POST', { code: 'a'.repeat(24) }, external)).status, 403);
});

test('pair expiry notifies observers and exposes remaining duration independently of the recipient clock', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-notify-expiry-'));
  let now = 1_800_000_000_000;
  let changes = 0;
  const web = new WebAccess(
    { origin, directory },
    directory,
    {},
    () => now,
    () => changes++,
  );
  try {
    const pair = web.pair('owner');
    assert.equal(changes, 1);
    assert.equal(web.state('other').pairing, undefined);
    assert.equal(web.state('owner').pairing?.remainingMs, 300_000);
    now += 299_999;
    t.mock.timers.tick(299_999);
    assert.equal(web.state('owner').pairing?.remainingMs, 1);
    now++;
    t.mock.timers.tick(1);
    assert.equal(changes, 2);
    assert.equal(web.state('owner').pairing, undefined);
    assert.equal(pair.expiresAt, new Date(now).toISOString());
    web.close();
    t.mock.timers.tick(600_000);
    assert.equal(changes, 2);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an in-flight pairing cannot persist a grant after Web is disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-stop-pair-'));
  const web = new WebAccess({ origin, directory }, directory);
  try {
    const code = web.pair('owner').code;
    const stream = new Readable({ read() {} });
    const request = Object.assign(stream, {
      method: 'POST',
      url: `/${web.state().path}/web/pair`,
      headers: { host: 'localhost', origin, 'content-type': 'application/json' },
    }) as unknown as IncomingMessage;
    let status = 0;
    const response = {
      setHeader() {},
      writeHead(value: number) {
        status = value;
        return this;
      },
      end() {},
    } as unknown as ServerResponse;
    const pending = web.handle(request, response, 'test');
    stream.push('{"code":"');
    await Promise.resolve();
    web.close();
    stream.push(`${code}"}`);
    stream.push(null);
    await pending;
    assert.equal(status, 503);
    assert.equal(existsSync(join(directory, 'web-grants.json')), false);
    assert.equal(web.state().grants.length, 0);
    assert.throws(() => web.pair('owner'), /尚未启用/);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid dormant Web configuration cannot break proxy startup or its control protocol', async (t) => {
  for (const configuredOrigin of [
    'not a URL',
    'http://public.example',
    'https://service.example/path',
  ]) {
    const f = await fixture(t, true, false, false, configuredOrigin);
    const { client, ready } = await f.connect();
    assert.ok(ready.type === 'ready' && ready.webControl && !ready.web);
    const state = await client.state('web.status', { watch: true });
    assert.equal(state.enabled, false);
    assert.equal(state.origin, undefined);
    const failed = await client.request({ type: 'web.configure', enabled: true });
    assert.equal(failed.code, 'web_start_failed');
    assert.equal((await f.http('/')).status, 404);
    assert.equal((await f.http('/health')).status, 200);
    assert.equal(existsSync(join(f.directory, 'web-grants.json')), false);
    assert.equal(
      (await client.request({ type: 'session.create', title: '正常连接', projectPath: 'C:\\work' }))
        .ok,
      true,
    );
  }
});

test('server wall-clock jumps do not expire a live pairing duration', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T12:00:00Z') });
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-monotonic-'));
  const web = new WebAccess({ origin, directory }, directory);
  try {
    const code = web.pair('owner').code;
    for (const jump of [10 * 60_000, 365 * 24 * 60 * 60_000]) {
      t.mock.timers.tick(jump);
      const pairing = web.state('owner').pairing;
      assert.equal(pairing?.code, code);
      assert.ok(pairing!.remainingMs! > 299_000);
    }
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('idempotent pairing initialization reuses the owner code without extending its deadline or broadcasting', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-pair-initialize-'));
  let now = 1_800_000_000_000;
  let changes = 0;
  const web = new WebAccess(
    { origin, directory },
    directory,
    {},
    () => now,
    () => changes++,
  );
  try {
    assert.equal(web.state('owner').pairing, undefined);
    assert.equal(changes, 0);
    const initial = web.pair('owner', true);
    assert.equal(changes, 1);
    now += 30_000;
    t.mock.timers.tick(30_000);
    for (let i = 0; i < 4; i++) {
      const reused = web.pair('owner', true);
      assert.equal(reused.code, initial.code);
      assert.equal(reused.expiresAt, initial.expiresAt);
      assert.equal(reused.remainingMs, 270_000);
    }
    assert.equal(changes, 1);
    assert.equal(web.state('other').pairing, undefined);
    const other = web.pair('other', true);
    assert.notEqual(other.code, initial.code);
    assert.equal(web.state('owner').pairing?.code, initial.code);
    now += 270_000;
    t.mock.timers.tick(270_000);
    assert.equal(web.state('owner').pairing, undefined);
    assert.equal(changes, 3);
    const replacement = web.pair('owner', true);
    assert.notEqual(replacement.code, initial.code);
    assert.equal(replacement.remainingMs, 300_000);
    assert.equal(web.state('other').pairing?.code, other.code);
    const explicit = web.pair('owner');
    assert.notEqual(explicit.code, replacement.code);
    assert.notEqual(web.pair('owner', false).code, explicit.code);
    web.close();
    assert.throws(() => web.pair('owner', true), /尚未启用/);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('idempotent pairing respects pending and grant limits while preserving existing owner codes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-pair-capacity-'));
  let web = new WebAccess({ origin, directory }, directory);
  try {
    const initial = web.pair('owner', true);
    for (let i = 1; i < 16; i++) web.pair(`other-${i}`, true);
    assert.equal(web.pair('owner', true).code, initial.code);
    assert.throws(() => web.pair('overflow', true), /正在等待配对的请求过多/);
    assert.equal(web.state('owner').pairing?.code, initial.code);
    const replaced = web.pair('owner', false);
    assert.notEqual(replaced.code, initial.code);
    web.close();
    writeFileSync(
      join(directory, 'web-grants.json'),
      JSON.stringify(
        Array.from({ length: 63 }, () => ({
          id: randomUUID(),
          name: '已配对浏览器',
          createdAt: new Date().toISOString(),
          expiresAt: null,
          secretHash: createHash('sha256').update(randomUUID()).digest('hex'),
        })),
      ),
    );
    web = new WebAccess({ origin, directory }, directory);
    const waiting = web.pair('other', true);
    const last = web.pair('owner', true);
    assert.equal((await webRequest(web, last.code)).status, 200);
    assert.equal(web.state('owner').pairing, undefined);
    assert.throws(() => web.pair('owner', true), /已配对浏览器数量已达上限/);
    assert.equal(web.pair('other', true).code, waiting.code);
    assert.equal((await webRequest(web, waiting.code)).status, 409);
    assert.equal(web.state().grants.length, 64);
    web.revoke(web.state().grants[0].id);
    assert.ok(web.pair('owner', true).code);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('idempotent pairing from simultaneous connections shares one device code and isolates other desktops', async (t) => {
  const f = await fixture(t, true, false);
  const device = randomUUID();
  const { client: first, ready } = await f.connect(undefined, device);
  const { client: second } = await f.connect(undefined, device);
  const { client: other } = await f.connect();
  assert.ok(ready.type === 'ready' && ready.webPairing === true);
  assert.equal((await first.request({ type: 'web.pair', ifAbsent: true })).code, 'web_disabled');
  assert.equal((await first.state()).pairing, undefined);
  assert.equal((await f.http('/')).status, 404);
  await first.state('web.configure', { enabled: true });
  const unidentified = new Client(f.url);
  f.clients.push(unidentified);
  await new Promise<void>((resolve) => unidentified.socket.once('open', resolve));
  unidentified.send({
    type: 'auth',
    token,
    protocolVersion: PROTOCOL_VERSION,
    deviceName: '未就绪',
  });
  await unidentified.wait((message) => message.type === 'ready');
  assert.equal(
    (await unidentified.request({ type: 'web.pair', ifAbsent: true })).code,
    'device_unknown',
  );
  for (const client of [first, second, other])
    assert.equal((await client.state('web.status', { watch: true })).pairing, undefined);
  const [a, b] = await Promise.all([
    first.state('web.pair', { ifAbsent: true }),
    second.state('web.pair', { ifAbsent: true }),
  ]);
  assert.ok(a.pairing);
  assert.equal(b.pairing?.code, a.pairing.code);
  assert.equal(b.pairing?.expiresAt, a.pairing.expiresAt);
  for (const client of [first, second, other]) {
    const event = await client.wait((message) => message.type === 'web.changed');
    assert.ok(event.type === 'web.changed');
    assert.equal(event.pairing?.code, client === other ? undefined : a.pairing.code);
  }
  for (const client of [first, second, other]) {
    await client.state();
    assert.equal(
      client.messages.some((message) => message.type === 'web.changed'),
      false,
    );
  }
  const consumed = await f.http('/web/pair', 'POST', { code: a.pairing.code });
  assert.equal(consumed.status, 200);
  assert.equal((await first.state()).pairing, undefined);
  const newPair = await second.state('web.pair', { ifAbsent: true });
  assert.notEqual(newPair.pairing?.code, a.pairing.code);
  assert.equal((await first.state()).pairing?.code, newPair.pairing?.code);
  assert.equal((await other.state()).pairing, undefined);
  const cookie = consumed.headers.get('set-cookie')!.split(';')[0];
  const { client: browser, ready: browserReady } = await f.connect(cookie);
  assert.equal(browserReady.type === 'ready' && browserReady.webPairing, undefined);
  assert.equal(
    (await browser.request({ type: 'web.pair', ifAbsent: true })).code,
    'browser_unavailable',
  );
});

test('Web settings initialize only on enable and persist a single random root suffix across restarts', async (t) => {
  const f = await fixture(t, true, false);
  const file = join(f.directory, 'web-access', 'settings.json');
  const { client: desktop, ready } = await f.connect();
  assert.ok(ready.type === 'ready' && ready.webSettings);
  assert.equal((await desktop.state()).path, undefined);
  assert.equal(existsSync(file), false);
  const initial = await desktop.state('web.configure', { enabled: true });
  assert.match(initial.path!, /^[a-f0-9]{32}$/);
  assert.equal(initial.domain, '');
  assert.equal(initial.url, `${origin}/${initial.path}/`);
  const saved = readFileSync(file, 'utf8');
  assert.equal((await desktop.state('web.configure', { enabled: true })).path, initial.path);
  await desktop.state('web.configure', { enabled: false });
  assert.equal(readFileSync(file, 'utf8'), saved);
  assert.equal((await desktop.state('web.configure', { enabled: true })).path, initial.path);
  const restarted = new WebAccess({ origin, directory: f.dist }, f.directory);
  assert.equal(restarted.state().path, initial.path);
  assert.equal(readFileSync(file, 'utf8'), saved);
  restarted.close();
});

test('an explicitly empty path enables the root entry and persists without being regenerated', async (t) => {
  const f = await fixture(t, true, false);
  const { client: desktop } = await f.connect();
  const initial = await desktop.state('web.configure', { enabled: true, path: '' });
  assert.equal(initial.path, '');
  assert.equal(initial.url, `${origin}/`);
  const file = join(f.directory, 'web-access', 'settings.json');
  const saved = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(saved).path, '');
  assert.equal((await desktop.state('web.configure', { enabled: true })).path, '');
  await desktop.state('web.configure', { enabled: false });
  assert.equal((await desktop.state('web.configure', { enabled: true })).path, '');
  const restarted = new WebAccess({ origin, directory: f.dist }, f.directory);
  try {
    assert.equal(restarted.state().path, '');
    assert.equal(restarted.state().url, `${origin}/`);
    assert.equal(readFileSync(file, 'utf8'), saved);
    restarted.configure({ regeneratePath: true });
    assert.match(restarted.state().path!, /^[a-f0-9]{32}$/);
  } finally {
    restarted.close();
  }
});

test('root entry serves assets, pairing and sockets while transitions hide all previous entry routes', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const paired = await f.pair(desktop);
  const { client: oldBrowser } = await f.connect(paired.cookie);
  const pending = await desktop.state('web.pair');
  const oldPath = f.path;
  const closed = new Promise<number>((resolve) => oldBrowser.socket.once('close', resolve));
  const state = await desktop.state('web.configure', { enabled: true, path: '' });
  assert.equal(await closed, 1012);
  assert.equal(state.path, '');
  assert.equal(state.url, `${origin}/`);
  assert.equal(state.pairing?.code, pending.pairing!.code);
  for (const path of ['/', '/?q=1', '/assets/main-test.js', '/favicon.ico']) {
    const response = await f.http(path, 'GET', undefined, {}, true);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('location'), null);
  }
  assert.equal((await f.http('/', 'HEAD', undefined, {}, true)).status, 200);
  assert.equal((await f.http('//', 'GET', undefined, {}, true)).status, 404);
  assert.equal((await f.http('/web/session')).status, 401);
  const current = await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie });
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), paired.session);
  for (const suffix of ['/', '/assets/main-test.js', '/favicon.ico', '/web/session', '/web/pair']) {
    const previous = await f.http(
      oldPath + suffix,
      suffix === '/web/pair' ? 'POST' : 'GET',
      undefined,
      { Origin: 'https://wrong.example', Cookie: paired.cookie },
      true,
    );
    assert.equal(previous.status, 404, suffix);
    assert.equal(await previous.text(), '', suffix);
  }
  assert.deepEqual(
    await rejectedUpgrade(`${f.url}${oldPath}/web/ws`, {
      Host: 'localhost',
      Origin: origin,
      Cookie: paired.cookie,
    }),
    { status: 404, body: '' },
  );
  const rootPair = await f.http('/web/pair', 'POST', { code: pending.pairing!.code });
  assert.equal(rootPair.status, 200);
  const rootCookie = rootPair.headers.get('set-cookie')!.split(';')[0];
  const { client: rootBrowser } = await f.connect(rootCookie);
  assert.equal(rootBrowser.socket.readyState, WebSocket.OPEN);
  const loggedOut = new Promise<number>((resolve) => rootBrowser.socket.once('close', resolve));
  assert.equal((await f.http('/web/logout', 'POST', {}, { Cookie: rootCookie })).status, 200);
  assert.equal(await loggedOut, 4001);
  const { client: retainedBrowser } = await f.connect(paired.cookie);
  const rootClosed = new Promise<number>((resolve) =>
    retainedBrowser.socket.once('close', resolve),
  );
  const prefixed = await desktop.state('web.configure', { enabled: true, path: 'workbench' });
  assert.equal(await rootClosed, 1012);
  assert.equal(prefixed.url, `${origin}/workbench/`);
  for (const path of ['/', '/assets/main-test.js', '/favicon.ico', '/web/session', '/web/pair']) {
    const previous = await f.http(path, 'GET', undefined, { Cookie: paired.cookie }, true);
    assert.equal(previous.status, 404, path);
    assert.equal(await previous.text(), '', path);
  }
  assert.deepEqual(
    await rejectedUpgrade(`${f.url}/web/ws`, {
      Host: 'localhost',
      Origin: origin,
      Cookie: paired.cookie,
    }),
    { status: 404, body: '' },
  );
  assert.equal((await f.http('/')).status, 200);
  assert.equal(
    (await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie })).status,
    200,
  );
  assert.equal((await f.http('/health')).status, 200);
  assert.equal(desktop.socket.readyState, WebSocket.OPEN);
});

test('a root entry preserves domain restrictions and the deployment protocol and port', async (t) => {
  const base = 'https://127.0.0.1:8787';
  const f = await fixture(t, true, true, false, base, true);
  const { client: desktop } = await f.connect();
  const configured = 'https://web.example.com:8787';
  const state = await desktop.state('web.configure', {
    enabled: true,
    domain: 'web.example.com',
    path: '',
  });
  assert.equal(state.path, '');
  assert.equal(state.url, `${configured}/`);
  const headers = { Host: 'web.example.com:8787', Origin: configured };
  for (const path of ['/', '/assets/main-test.js', '/favicon.ico'])
    assert.equal((await f.http(path, 'GET', undefined, headers)).status, 200);
  const pairing = await desktop.state('web.pair');
  const paired = await f.http('/web/pair', 'POST', { code: pairing.pairing!.code }, headers);
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  const browser = new Client(f.url, cookie, '', configured);
  f.clients.push(browser);
  await browser.open(true);
  for (const host of ['127.0.0.1:8787', 'other.example:8787', 'web.example.com']) {
    for (const path of ['/', '/assets/main-test.js', '/favicon.ico', '/web/session', '/web/pair']) {
      const denied = await f.http(path, 'GET', undefined, { Host: host, Cookie: cookie });
      assert.equal(denied.status, 404, `${host}${path}`);
      assert.equal(await denied.text(), '');
    }
    assert.deepEqual(
      await rejectedUpgrade(`${f.url}/web/ws`, { Host: host, Origin: configured, Cookie: cookie }),
      { status: 404, body: '' },
    );
  }
  const reset = await desktop.state('web.configure', { enabled: true, domain: '' });
  assert.equal(reset.path, '');
  assert.equal(reset.url, `${base}/`);
  assert.equal((await f.http('/', 'GET', undefined, { Host: '127.0.0.1:8787' })).status, 200);
  assert.equal((await f.http('/', 'GET', undefined, headers)).status, 404);
});

test('only the current suffix serves pages, assets, API and upgrades; hidden routes return empty 404', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const paired = await f.pair(desktop);
  for (const path of [
    '/',
    '/favicon.ico',
    '/web/session',
    '/web/pair',
    '/assets/main-test.js',
    '/wrong/',
    '/wrong/web/ws',
  ]) {
    const response = await f.http(path, 'GET', undefined, { Cookie: paired.cookie }, true);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), '', path);
  }
  for (const path of ['/', '/assets/main-test.js', '/favicon.ico', '/web/session']) {
    const response = await f.http(path, 'GET', undefined, {
      Host: '127.0.0.1',
      Cookie: paired.cookie,
    });
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), '');
  }
  assert.equal((await f.http('/favicon.ico')).status, 200);
  assert.equal((await f.http('/assets/main-test.js')).status, 200);
  const canonical = await f.http(`${f.path}?q=1`, 'GET', undefined, {}, true);
  assert.equal(canonical.status, 308);
  assert.equal(canonical.headers.get('location'), `${f.path}/?q=1`);
  assert.equal(canonical.headers.get('cache-control'), 'no-store');
  assert.equal((await f.http(f.path, 'HEAD', undefined, {}, true)).status, 308);
  for (const path of ['/web/ws', '/wrong/web/ws', '/ws/'])
    assert.deepEqual(
      await rejectedUpgrade(f.url + path, {
        Host: 'localhost',
        Origin: origin,
        Cookie: paired.cookie,
      }),
      { status: 404, body: '' },
    );
  assert.deepEqual(
    await rejectedUpgrade(`${f.url}${f.path}/web/ws`, {
      Host: 'wrong.example',
      Origin: origin,
      Cookie: paired.cookie,
    }),
    { status: 404, body: '' },
  );
  assert.equal((await f.http('/health')).status, 200);
  assert.equal((await f.http('/client/installer', 'GET', undefined, {}, true)).status, 401);
  assert.equal(
    (await desktop.request({ type: 'session.create', title: '仍在线', projectPath: 'C:\\work' }))
      .ok,
    true,
  );
});

test('path changes and regeneration preserve grants and pending pair codes while closing old browser sockets', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const paired = await f.pair(desktop);
  const pending = await desktop.state('web.pair');
  const { client: browser } = await f.connect(paired.cookie);
  const oldPath = f.path;
  const grantFile = readFileSync(join(f.directory, 'web-grants.json'), 'utf8');
  const closed = new Promise<number>((resolve) => browser.socket.once('close', resolve));
  const state = await desktop.state('web.configure', { enabled: true, path: 'my-workbench' });
  assert.equal(await closed, 1012);
  assert.equal(state.path, 'my-workbench');
  assert.equal(state.url, `${origin}/my-workbench/`);
  assert.equal(state.pairing?.code, pending.pairing!.code);
  assert.equal(readFileSync(join(f.directory, 'web-grants.json'), 'utf8'), grantFile);
  for (const suffix of ['/', '/assets/main-test.js', '/favicon.ico', '/web/session', '/web/pair']) {
    const old = await f.http(oldPath + suffix, 'GET', undefined, { Cookie: paired.cookie }, true);
    assert.equal(old.status, 404);
    assert.equal(await old.text(), '');
  }
  assert.deepEqual(
    await rejectedUpgrade(`${f.url}${oldPath}/web/ws`, {
      Host: 'localhost',
      Origin: origin,
      Cookie: paired.cookie,
    }),
    { status: 404, body: '' },
  );
  const current = await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie });
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), paired.session);
  assert.equal(current.headers.get('set-cookie')!.split(';')[0], paired.cookie);
  const nextBrowser = (await f.connect(paired.cookie)).client;
  const unchanged = await desktop.state('web.configure', { enabled: true, path: 'my-workbench' });
  assert.equal(unchanged.path, 'my-workbench');
  assert.equal(nextBrowser.socket.readyState, WebSocket.OPEN);
  const regenerated = await desktop.state('web.configure', { enabled: true, regeneratePath: true });
  assert.match(regenerated.path!, /^[a-f0-9]{32}$/);
  assert.notEqual(regenerated.path, oldPath.slice(1));
  assert.equal(regenerated.pairing?.code, pending.pairing!.code);
  assert.equal((await f.http('/web/pair', 'POST', { code: pending.pairing!.code })).status, 200);
  assert.equal(desktop.socket.readyState, WebSocket.OPEN);
  const restored = new WebAccess({ origin, directory: f.dist }, f.directory);
  assert.equal(restored.state().path, regenerated.path);
  restored.close();
});

test('failed settings writes leave routes, sockets and pending pairing unchanged', async (t) => {
  const f = await fixture(t);
  const { client: desktop } = await f.connect();
  const paired = await f.pair(desktop);
  const { client: browser } = await f.connect(paired.cookie);
  const pending = await desktop.state('web.pair');
  const file = join(f.directory, 'web-access', 'settings.json');
  const saved = readFileSync(file, 'utf8');
  mkdirSync(`${file}.tmp`);
  const result = await desktop.request({ type: 'web.configure', enabled: true, path: 'new-entry' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'web_settings_failed');
  assert.equal(readFileSync(file, 'utf8'), saved);
  const state = await desktop.state();
  assert.equal(state.path, pending.path);
  assert.equal(state.pairing?.code, pending.pairing!.code);
  assert.equal(browser.socket.readyState, WebSocket.OPEN);
  assert.equal((await f.http('/')).status, 200);
  assert.equal(
    (await f.http('/web/session', 'GET', undefined, { Cookie: paired.cookie })).status,
    200,
  );
});

test('domain settings retain the deployment port, isolate cookie hosts and return empty 404 for IP access', async (t) => {
  const base = 'https://127.0.0.1:8787';
  const f = await fixture(t, true, true, false, base, true);
  const { client: desktop } = await f.connect();
  const state = await desktop.state('web.configure', {
    enabled: true,
    domain: ' WEB.Example.COM ',
  });
  const configured = 'https://web.example.com:8787';
  assert.equal(state.domain, 'web.example.com');
  assert.equal(state.origin, configured);
  assert.equal(state.url, `${configured}${f.path}/`);
  const headers = { Host: 'web.example.com:8787', Origin: configured };
  assert.equal((await f.http('/', 'GET', undefined, headers)).status, 200);
  for (const host of ['127.0.0.1:8787', 'another.example:8787', 'web.example.com']) {
    const rejected = await f.http('/', 'GET', undefined, { Host: host });
    assert.equal(rejected.status, 404);
    assert.equal(await rejected.text(), '');
  }
  const pairing = await desktop.state('web.pair');
  const paired = await f.http('/web/pair', 'POST', { code: pairing.pairing!.code }, headers);
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  assert.match(paired.headers.get('set-cookie')!, /; Secure/);
  const browser = new Client(f.url, cookie, f.path, configured);
  f.clients.push(browser);
  await browser.open(true);
  const closed = new Promise<number>((resolve) => browser.socket.once('close', resolve));
  const reset = await desktop.state('web.configure', { enabled: true, domain: '' });
  assert.equal(await closed, 1012);
  assert.equal(reset.origin, base);
  assert.equal(reset.domain, '');
  assert.equal(reset.grants.length, 1);
  assert.equal((await f.http('/', 'GET', undefined, headers)).status, 404);
  assert.equal(
    (
      await f.http('/web/session', 'GET', undefined, {
        Host: '127.0.0.1:8787',
        Origin: base,
        Cookie: cookie,
      })
    ).status,
    401,
  );
  assert.equal((await f.http('/health')).status, 200);
  assert.equal(desktop.socket.readyState, WebSocket.OPEN);
});

test('invalid and unreadable settings cannot create routes or alter a running configuration', async (t) => {
  const f = await fixture(t, true, false);
  const { client: desktop } = await f.connect();
  const file = join(f.directory, 'web-access', 'settings.json');
  mkdirSync(join(f.directory, 'web-access'));
  writeFileSync(file, '{');
  assert.equal((await desktop.state()).enabled, false);
  assert.equal(
    (await desktop.request({ type: 'web.configure', enabled: true })).code,
    'web_start_failed',
  );
  assert.equal((await f.http('/health')).status, 200);
  rmSync(file);
  await desktop.state('web.configure', { enabled: true });
  const saved = readFileSync(file, 'utf8');
  const failed = await desktop.request({
    type: 'web.configure',
    enabled: true,
    domain: 'web.example.com',
  });
  assert.equal(failed.code, 'web_invalid_settings');
  assert.equal(readFileSync(file, 'utf8'), saved);
  assert.equal((await f.http('/')).status, 200);
  const direct = new WebAccess({ origin, directory: f.dist }, f.directory);
  for (const configuration of [
    { domain: 'https://web.example.com' },
    { domain: 'web.example.com:443' },
    { domain: '127.0.0.1' },
    { domain: '[::1]' },
    { domain: 'foo..example' },
    { path: 'one/two' },
    { path: 'web%2fapi' },
    { path: 'health' },
    { path: '-dash' },
    { path: 'new-entry', regeneratePath: true },
  ])
    assert.throws(() => direct.configure(configuration));
  assert.equal(readFileSync(file, 'utf8'), saved);
  direct.close();
});

test('a path change invalidates an in-flight pairing body without consuming its code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-edit-pair-'));
  const web = new WebAccess({ origin, directory }, directory);
  try {
    const code = web.pair('owner').code;
    const stream = new Readable({ read() {} });
    const request = Object.assign(stream, {
      method: 'POST',
      url: `/${web.state().path}/web/pair`,
      headers: { host: 'localhost', origin, 'content-type': 'application/json' },
    }) as unknown as IncomingMessage;
    let status = 0;
    let body = '';
    const response = {
      setHeader() {},
      writeHead(value: number) {
        status = value;
        return this;
      },
      end(value = '') {
        body = value;
      },
    } as unknown as ServerResponse;
    const pending = web.handle(request, response, 'test');
    stream.push('{"code":"');
    await Promise.resolve();
    web.configure({ path: 'new-entry' });
    stream.push(`${code}"}`);
    stream.push(null);
    await pending;
    assert.equal(status, 404);
    assert.equal(body, '');
    assert.equal(existsSync(join(directory, 'web-grants.json')), false);
    assert.equal(web.state('owner').pairing?.code, code);
    assert.equal((await webRequest(web, code)).status, 200);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('old sockets lose authorization immediately and their late close cannot remove a new socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-edit-socket-'));
  const web = new WebAccess({ origin, directory }, directory);
  try {
    const paired = await webRequest(web, web.pair('owner').code);
    const cookie = paired.headers.get('Set-Cookie')!.split(';')[0];
    const grant = web.authenticate({ headers: { cookie } } as IncomingMessage)!;
    const previous = fakeSocket();
    previous.close = (code) => {
      previous.codes.push(code);
    };
    assert.equal(web.attach(grant, previous as unknown as WebSocket), true);
    web.configure({ path: 'new-entry' });
    assert.deepEqual(previous.codes, [1012]);
    assert.equal(web.active(grant.id), true);
    assert.equal(web.active(grant.id, previous as unknown as WebSocket), false);
    const next = fakeSocket();
    assert.equal(web.attach(grant, next as unknown as WebSocket), true);
    previous.emit('close');
    assert.equal(web.active(grant.id, next as unknown as WebSocket), true);
  } finally {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
