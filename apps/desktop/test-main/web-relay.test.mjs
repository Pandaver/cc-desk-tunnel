import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer as createTcpServer } from 'node:net';
import { randomUUID, randomBytes, createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { startWebRelay } from '../electron/web-relay.mjs';

const deviceId = '12'.repeat(16);
const token = 'test-relay-service-token';
const timing = {
  connect: 1000,
  register: 1000,
  heartbeat: 1000,
  reconnectMin: 20,
  reconnectMax: 40,
};
async function until(check, what = 'condition') {
  for (let attempt = 0; !check(); attempt++) {
    assert.ok(attempt < 800, `timed out waiting for ${what}`);
    await delay(5);
  }
}
async function proxyFixture(t, { silent = false } = {}) {
  const requests = [];
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  };
  const server = createTcpServer((socket) => {
    track(socket);
    socket.once('data', (data) => {
      const line = data.toString().split('\r\n')[0];
      requests.push(line);
      if (silent) return;
      const [, host, port] = /^CONNECT (.+):(\d+) HTTP\/1\.1$/.exec(line);
      const upstream = track(
        connect(Number(port), host, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          socket.pipe(upstream).pipe(socket);
        }),
      );
      upstream.once('close', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, sockets, answer: `PROXY 127.0.0.1:${server.address().port}` };
}
async function fixture(t, options = {}) {
  const service = options.tls ? createHttpsServer(options.tls) : createServer();
  const wss = new WebSocketServer({ noServer: true, autoPong: options.autoPong ?? true });
  const controls = [];
  const channels = [];
  const requests = [];
  const sockets = new Set();
  const controllers = [];
  const upgrades = [];
  const locals = [];
  const local = createServer((request, response) => {
    if (options.request?.(request, response)) return;
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        url: request.url,
        method: request.method,
        body: Buffer.concat(chunks).toString(),
        headers: request.headers,
      });
      response.setHeader('content-type', 'text/plain');
      response.end(`local:${request.url}`);
    });
  });
  const localWs = new WebSocketServer({ noServer: true });
  local.on('upgrade', (request, socket, head) => {
    localWs.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (message) => ws.send(message));
      locals.push(ws);
    });
  });
  for (const server of [service, local]) {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const origin = `${options.tls ? 'https' : 'http'}://127.0.0.1:${service.address().port}`;
  const ready = () => ({
    type: 'relay.ready',
    version: 2,
    connectionId: randomUUID(),
    secret: 'ab'.repeat(32),
    origin,
    path: `/remote/${deviceId}/`,
    ...options.ready,
  });
  service.on('upgrade', (request, socket, head) => {
    upgrades.push({ url: request.url, headers: request.headers });
    if (options.upgrade?.(request, socket) === false) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => {});
      ws.once('message', (data) => {
        const message = JSON.parse(data.toString());
        if (request.url === '/_relay/control') {
          const control = { ws, message, ready: ready() };
          controls.push(control);
          if (options.register) options.register(control);
          else ws.send(JSON.stringify(control.ready));
        } else {
          const channel = { ws, message, data: '' };
          channels.push(channel);
          ws.on('message', (chunk) => (channel.data += chunk.toString()));
          options.channel?.(channel);
        }
      });
    });
  });
  t.after(async () => {
    controllers.forEach((controller) => controller.close());
    for (const ws of [...wss.clients, ...localWs.clients]) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [service, local].map((server) => new Promise((resolve) => server.close(resolve))),
    );
    wss.close();
    localWs.close();
  });
  const f = {
    service,
    wss,
    local,
    locals,
    controls,
    channels,
    requests,
    upgrades,
    origin,
    start(overrides = {}) {
      const statuses = [];
      const controller = startWebRelay({
        config: {
          url: `${options.tls ? 'wss' : 'ws'}://127.0.0.1:${service.address().port}/ws`,
          token,
          ...options.config,
        },
        deviceId,
        port: local.address().port,
        timing,
        onStatus: (status) => statuses.push(status),
        ...overrides,
      });
      controllers.push(controller);
      return { controller, statuses };
    },
    requestContext(key = controls.at(-1)?.message.relayKey, address = '203.0.113.5') {
      return {
        headers: { 'x-ccdt-relay-key': key, 'x-ccdt-relay-address': address },
        socket: { remoteAddress: '127.0.0.1' },
      };
    },
    open() {
      const channelId = randomUUID();
      controls.at(-1).ws.send(JSON.stringify({ type: 'relay.open', channelId }));
      return channelId;
    },
  };
  return f;
}

test('relay registers independently, exposes its public URL and forwards HTTP only to the fixed local port', async (t) => {
  const f = await fixture(t);
  const { controller, statuses } = f.start();
  await until(() => controller.status.state === 'online');
  const { relayKey, ...registration } = f.controls[0].message;
  assert.deepEqual(registration, {
    type: 'relay.register',
    version: 2,
    token,
    deviceId,
    hostname: '127.0.0.1',
  });
  assert.match(relayKey, /^[a-f0-9]{64}$/);
  assert.equal(controller.status.url, `${f.origin}/remote/${deviceId}/`);
  assert.deepEqual(
    statuses.map((status) => status.state),
    ['connecting', 'online'],
  );
  const channelId = f.open();
  await until(() => f.channels.length === 1);
  assert.deepEqual(f.channels[0].message, {
    type: 'relay.attach',
    channelId,
    connectionId: f.controls[0].ready.connectionId,
    secret: f.controls[0].ready.secret,
  });
  f.channels[0].ws.send(
    Buffer.from(
      'POST /api/action HTTP/1.1\r\nHost: relay.example\r\nContent-Length: 5\r\n\r\nhello',
    ),
  );
  await until(() => f.channels[0].data.includes('local:/api/action'));
  assert.deepEqual(
    f.requests.map(({ url, method, body }) => ({ url, method, body })),
    [{ url: '/api/action', method: 'POST', body: 'hello' }],
  );
  // The same data connection carries another keep-alive HTTP request, not a new tunnel per asset.
  f.channels[0].ws.send(Buffer.from('GET /favicon.ico HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
  await until(() => f.requests.length === 2);
  assert.equal(f.channels.length, 1);
  for (const upgrade of f.upgrades) {
    assert.ok(['/_relay/control', '/_relay/data'].includes(upgrade.url));
    assert.equal(upgrade.headers.authorization, undefined);
    assert.ok(!JSON.stringify(upgrade).includes(token));
  }
  assert.ok(!JSON.stringify(statuses).includes(token));
  assert.ok(!JSON.stringify(statuses).includes(relayKey));
});

test('relay context requires loopback, active key and a valid visitor IP; ordinary requests stay ordinary', async (t) => {
  const f = await fixture(t);
  const { controller } = f.start();
  await until(() => controller.status.state === 'online');
  assert.equal(controller.context({ headers: {}, socket: { remoteAddress: '192.168.1.4' } }), null);
  assert.deepEqual(controller.context(f.requestContext()), {
    origin: f.origin,
    basePath: `/remote/${deviceId}/`,
    address: '203.0.113.5',
  });
  const valid = f.requestContext();
  const invalid = [
    f.requestContext('00'.repeat(32)),
    f.requestContext(undefined, '127.0.0.1, 203.0.113.5'),
    { ...valid, socket: { remoteAddress: '192.168.1.4' } },
    { ...valid, headers: { ...valid.headers, 'x-ccdt-relay-address': undefined } },
    { ...valid, headers: { ...valid.headers, 'x-ccdt-relay-unknown': 'true' } },
    {
      ...valid,
      headers: { ...valid.headers, 'x-ccdt-relay-key': [valid.headers['x-ccdt-relay-key']] },
    },
  ];
  for (const request of invalid)
    assert.throws(() => controller.context(request), { statusCode: 403 });
  controller.close();
  assert.throws(() => controller.context(valid), { statusCode: 403 });
  assert.deepEqual(controller.status, { state: 'offline', url: null, error: null });
});

test('the server chooses the public origin independently of service credentials and the fixed local port', async (t) => {
  const publicOrigin = 'https://browser.example:10443';
  const f = await fixture(t, { ready: { origin: publicOrigin } });
  const configuration = { url: `ws://127.0.0.1:${f.service.address().port}/ws`, token };
  const { controller } = f.start({ config: configuration });
  // Editing a saved service after enable must not retarget a connection still registering.
  configuration.url = 'ws://other.example:30443/ws';
  configuration.token = 'replacement-token';
  await until(() => controller.status.state === 'online');
  assert.equal(f.controls[0].message.hostname, '127.0.0.1');
  assert.equal('origin' in f.controls[0].message, false);
  assert.equal(f.controls[0].message.token, token);
  assert.equal(controller.status.url, `${publicOrigin}/remote/${deviceId}/`);
  assert.equal(controller.context(f.requestContext()).origin, publicOrigin);
  assert.equal(f.upgrades[0].headers.host, `127.0.0.1:${f.service.address().port}`);
  assert.notEqual(f.service.address().port, f.local.address().port);
  f.open();
  await until(() => f.channels.length === 1);
  f.channels[0].ws.send(
    Buffer.from(
      'GET /independent HTTP/1.1\r\nHost: browser.example:10443\r\nConnection: close\r\n\r\n',
    ),
  );
  await until(() => f.channels[0].data.includes('local:/independent'));
  assert.equal(f.requests[0].url, '/independent');
});

test('changing the local listener port preserves the server-provided public URL', async (t) => {
  const f = await fixture(t, { ready: { origin: 'http://relay.example:5270' } });
  const first = f.start().controller;
  await until(() => first.status.state === 'online');
  const url = first.status.url;
  first.close();
  const local = createServer((_request, response) => response.end('replacement-local-listener'));
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  t.after(() => {
    local.closeAllConnections();
    local.close();
  });
  const second = f.start({ port: local.address().port }).controller;
  await until(() => second.status.state === 'online');
  assert.equal(second.status.url, url);
  assert.notEqual(local.address().port, f.local.address().port);
  f.open();
  await until(() => f.channels.length === 1);
  f.channels[0].ws.send(
    Buffer.from(
      'GET /after-rebind HTTP/1.1\r\nHost: relay.example:5270\r\nConnection: close\r\n\r\n',
    ),
  );
  await until(() => f.channels[0].data.includes('replacement-local-listener'));
  assert.equal(f.requests.length, 0);
  assert.equal(f.controls.length, 2);
  assert.ok(
    f.controls.every(({ message }) => message.hostname === '127.0.0.1' && message.version === 2),
  );
});

test('old relay protocol and disabled endpoints fail without retrying or changing the local listener', async (t) => {
  const old = await fixture(t, { ready: { version: 1 } });
  const client = old.start().controller;
  await until(() => client.status.state === 'error');
  assert.match(client.status.error, /协议版本不兼容/);
  assert.equal(client.status.url, null);
  await delay(80);
  assert.equal(old.controls.length, 1);
  assert.equal(old.local.listening, true);
  const disabled = await fixture(t, {
    upgrade: (_request, socket) => {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return false;
    },
  });
  const refused = disabled.start().controller;
  await until(() => refused.status.state === 'error');
  assert.match(refused.status.error, /未启用或版本不兼容/);
  await delay(80);
  assert.equal(disabled.upgrades.length, 1);
  assert.equal(disabled.local.listening, true);
});

test('normal local HTTP EOF flushes a large binary response through a slow data stream before closing', async (t) => {
  const payload = randomBytes(2 * 1024 * 1024 + 123);
  const f = await fixture(t, {
    request: (_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length,
        Connection: 'close',
      });
      response.end(payload);
      return true;
    },
  });
  // Delay the actual send, not merely the peer's read callback. The final local TCP EOF then arrives
  // while the WebSocket writable still has bytes queued, reproducing a congested outbound path.
  const send = WebSocket.prototype.send;
  t.mock.method(WebSocket.prototype, 'send', function (data, ...args) {
    if (!this._isServer && Buffer.isBuffer(data)) {
      setTimeout(() => send.call(this, data, ...args), 10);
      return;
    }
    return send.call(this, data, ...args);
  });
  const { controller } = f.start();
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => f.channels.length === 1);
  const channel = f.channels[0];
  const chunks = [];
  channel.ws.on('message', (chunk) => {
    chunks.push(chunk);
    channel.ws.pause();
    setTimeout(() => channel.ws.resume(), 2);
  });
  const closed = once(channel.ws, 'close');
  channel.ws.send(
    Buffer.from('GET /large.bin HTTP/1.1\r\nHost: relay.example\r\nConnection: close\r\n\r\n'),
  );
  const [code] = await closed;
  const received = Buffer.concat(chunks);
  const body = received.subarray(received.indexOf('\r\n\r\n') + 4);
  assert.equal(
    body.length,
    payload.length,
    'the final response bytes must survive the local TCP close',
  );
  assert.equal(
    createHash('sha256').update(body).digest('hex'),
    createHash('sha256').update(payload).digest('hex'),
  );
  assert.notEqual(code, 1006, 'clean EOF completes the WebSocket close handshake');
  assert.equal(controller.status.state, 'online');
});

test('disconnect invalidates context and active channels, reconnect rotates key and never replays requests', async (t) => {
  const f = await fixture(t);
  const { controller } = f.start();
  await until(() => controller.status.state === 'online');
  const oldContext = f.requestContext();
  f.open();
  await until(() => f.channels.length === 1);
  f.channels[0].ws.send(
    Buffer.from('POST /run HTTP/1.1\r\nHost: relay.example\r\nContent-Length: 0\r\n\r\n'),
  );
  await until(() => f.requests.length === 1);
  f.controls[0].ws.terminate();
  await until(() => f.controls.length === 2 && controller.status.state === 'online');
  assert.notEqual(f.controls[0].message.relayKey, f.controls[1].message.relayKey);
  assert.throws(() => controller.context(oldContext), { statusCode: 403 });
  assert.equal(f.requests.length, 1);
  assert.equal(f.channels.length, 1);
  assert.equal(f.channels[0].ws.readyState, 3);
  assert.equal(controller.context(f.requestContext()).address, '203.0.113.5');
});

test('an outbound stream that never drains is released after the normal EOF deadline', async (t) => {
  const f = await fixture(t);
  const send = WebSocket.prototype.send;
  t.mock.method(WebSocket.prototype, 'send', function (data, ...args) {
    if (!this._isServer && Buffer.isBuffer(data)) return;
    return send.call(this, data, ...args);
  });
  const { controller } = f.start({ timing: { ...timing, drain: 40, maxChannels: 1 } });
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => f.channels.length === 1);
  const channel = f.channels[0];
  channel.ws.send(
    Buffer.from('GET /stalled HTTP/1.1\r\nHost: relay.example\r\nConnection: close\r\n\r\n'),
  );
  await until(
    () => channel.ws.readyState === WebSocket.CLOSED,
    'the stalled response drain deadline',
  );
  assert.equal(controller.status.state, 'online');
  f.open();
  await until(() => f.channels.length === 2, 'the released channel slot');
});

test('authentication and protocol failures stop without reconnect or exposing server-provided text', async (t) => {
  for (const code of [4001, 4002]) {
    const f = await fixture(t, { register: ({ ws }) => ws.close(code, `secret=${token}`) });
    const { controller, statuses } = f.start();
    await until(() => controller.status.state === 'error');
    await delay(80);
    assert.equal(f.controls.length, 1);
    assert.ok(!JSON.stringify(statuses).includes(token));
  }
  for (const ready of [
    { version: 1 },
    { origin: 'https://relay.example/path' },
    { path: '/remote/other/' },
    { connectionId: 'bad' },
  ]) {
    const f = await fixture(t, { ready });
    const { controller } = f.start();
    await until(() => controller.status.state === 'error');
    await delay(80);
    assert.equal(f.controls.length, 1);
  }
});

test('noncanonical server public origins are rejected before granting relay context', async (t) => {
  for (const origin of [
    null,
    123,
    'ftp://browser.example',
    'https://user:password@browser.example',
    'https://browser.example/',
    'https://browser.example/remote/',
    'https://browser.example?token=secret',
    'https://browser.example#pair=secret',
    ' https://browser.example',
    'https://browser.example\n',
    'https://Browser.Example',
    'http://browser.example:80',
    'https://browser.example:443',
    'http://browser.example:0',
    'https://browser.example\\evil',
  ]) {
    const f = await fixture(t, { ready: { origin } });
    const controller = f.start().controller;
    await until(() => controller.status.state === 'error');
    assert.equal(controller.status.url, null);
    assert.throws(() => controller.context(f.requestContext()), { statusCode: 403 });
  }
});

test('a stale registration is retried until the server releases it', async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    register: ({ ws, ready }) =>
      ++attempts < 3 ? ws.close(4009, 'Occupied') : ws.send(JSON.stringify(ready)),
  });
  const { controller } = f.start();
  await until(() => controller.status.state === 'online');
  assert.equal(f.controls.length, 3);
});

test('data handshake capacity is retried before attach; an expired channel does not end registration', async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    upgrade: (request, socket) => {
      if (request.url === '/_relay/data' && ++attempts < 3) {
        socket.end(
          'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return false;
      }
    },
  });
  const { controller } = f.start();
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => f.channels.length === 1);
  assert.equal(attempts, 3);
  assert.equal(f.requests.length, 0);
  f.channels[0].ws.close(4004, 'Expired');
  await until(() => f.channels[0].ws.readyState === 3);
  assert.equal(controller.status.state, 'online');
});

test('closing during asynchronous proxy lookup opens no late connection and schedules no retry', async (t) => {
  const f = await fixture(t);
  let finish;
  let lookedUp = false;
  const { controller } = f.start({
    resolveProxy: () => {
      lookedUp = true;
      return new Promise((resolve) => (finish = resolve));
    },
  });
  await until(() => lookedUp);
  controller.close();
  finish('DIRECT');
  await delay(100);
  assert.equal(f.upgrades.length, 0);
  assert.equal(controller.status.state, 'offline');
});

test('late data-channel proxy lookup is cancelled when remote access is disabled', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let finish;
  const { controller } = f.start({
    resolveProxy: () => (++calls === 1 ? 'DIRECT' : new Promise((resolve) => (finish = resolve))),
  });
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => finish);
  controller.close();
  finish('DIRECT');
  await delay(100);
  assert.equal(f.channels.length, 0);
  assert.equal(f.upgrades.length, 1);
});

test('system HTTP proxy carries control and data connections without changing the fixed local destination', async (t) => {
  const proxy = await proxyFixture(t);
  const f = await fixture(t);
  const asked = [];
  const { controller } = f.start({
    resolveProxy: (url) => {
      asked.push(url);
      return proxy.answer;
    },
  });
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => f.channels.length === 1);
  f.channels[0].ws.send(Buffer.from('GET /via-proxy HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
  await until(() => f.channels[0].data.includes('local:/via-proxy'));
  const target = `127.0.0.1:${f.service.address().port}`;
  assert.deepEqual(proxy.requests, Array(2).fill(`CONNECT ${target} HTTP/1.1`));
  assert.deepEqual(asked, Array(2).fill(`http://${target}`));
  assert.equal(f.requests[0].url, '/via-proxy');
  controller.close();
  await until(() => proxy.sockets.size === 0);
});

test('disable cancels pending WS and WSS proxy CONNECT sockets immediately without retrying', async (t) => {
  for (const protocol of ['ws', 'wss']) {
    const proxy = await proxyFixture(t, { silent: true });
    const f = await fixture(t);
    const { controller } = f.start({
      config: { url: `${protocol}://127.0.0.1:${f.service.address().port}/ws`, token },
      resolveProxy: () => proxy.answer,
      timing: { ...timing, connect: 1000 },
    });
    await until(() => proxy.requests.length === 1);
    controller.close();
    await delay(100);
    assert.equal(proxy.sockets.size, 0, `${protocol} CONNECT sockets must close with the relay`);
    assert.equal(proxy.requests.length, 1);
    assert.equal(controller.status.state, 'offline');
    assert.equal(f.upgrades.length, 0);
  }
});

test('WSS proxy CONNECT deadline cancels its transport before reconnecting', async (t) => {
  const proxy = await proxyFixture(t, { silent: true });
  const f = await fixture(t);
  const { controller, statuses } = f.start({
    config: { url: `wss://127.0.0.1:${f.service.address().port}/ws`, token },
    resolveProxy: () => proxy.answer,
    timing: { ...timing, connect: 50, reconnectMin: 400, reconnectMax: 400 },
  });
  await until(() => statuses.some((status) => status.state === 'offline'));
  await delay(50);
  assert.equal(proxy.sockets.size, 0, 'the timed-out TLS route must not keep its CONNECT socket');
  await until(() => proxy.requests.length === 2);
  controller.close();
  await until(() => proxy.sockets.size === 0);
});

test('disable during a silent TLS handshake closes the handed-off TCP socket and does not retry', async (t) => {
  const sockets = new Set();
  const service = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => service.close(resolve));
  });
  const f = await fixture(t);
  const { controller } = f.start({
    config: { url: `wss://127.0.0.1:${service.address().port}/ws`, token },
  });
  await until(() => sockets.size === 1);
  controller.close();
  await delay(100);
  assert.equal(sockets.size, 0);
  assert.equal(controller.status.state, 'offline');
});

test('silent registration times out and reconnects without granting stale request context', async (t) => {
  const f = await fixture(t, { register() {} });
  const { controller, statuses } = f.start({ timing: { ...timing, register: 30 } });
  await until(() => f.controls.length >= 2);
  assert.ok(statuses.some((status) => status.state === 'offline' && /注册超时/.test(status.error)));
  assert.throws(() => controller.context(f.requestContext()), { statusCode: 403 });
  assert.equal(f.controls[0].ws.readyState, WebSocket.CLOSED);
});

test('a failed local connection closes only its channel and frees capacity for recovery', async (t) => {
  const f = await fixture(t);
  const { controller } = f.start({ timing: { ...timing, maxChannels: 1 } });
  await until(() => controller.status.state === 'online');
  const port = f.local.address().port;
  await new Promise((resolve) => f.local.close(resolve));
  f.open();
  await until(() => f.channels.length === 1 && f.channels[0].ws.readyState === WebSocket.CLOSED);
  assert.equal(controller.status.state, 'online');
  f.local.listen(port, '127.0.0.1');
  await once(f.local, 'listening');
  f.open();
  await until(() => f.channels.length === 2);
  f.channels[1].ws.send(Buffer.from('GET /recovered HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
  await until(() => f.channels[1].data.includes('local:/recovered'));
});

test('idle data channels release capacity without disconnecting the control connection', async (t) => {
  const f = await fixture(t);
  const { controller } = f.start({ timing: { ...timing, idle: 40, maxChannels: 1 } });
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => f.channels.length === 1 && f.channels[0].ws.readyState === WebSocket.CLOSED);
  assert.equal(controller.status.state, 'online');
  f.open();
  await until(() => f.channels.length === 2);
});

test('duplicate channel identifiers and oversized data are fatal and invalidate relay context', async (t) => {
  for (const kind of ['duplicate', 'oversized']) {
    const f = await fixture(t);
    const { controller } = f.start();
    await until(() => controller.status.state === 'online');
    const context = f.requestContext();
    const channelId = f.open();
    await until(() => f.channels.length === 1);
    if (kind === 'duplicate')
      f.controls[0].ws.send(JSON.stringify({ type: 'relay.open', channelId }));
    else f.channels[0].ws.send(Buffer.alloc(1024 * 1024 + 1));
    await until(() => controller.status.state === 'error');
    assert.throws(() => controller.context(context), { statusCode: 403 });
    await delay(80);
    assert.equal(f.controls.length, 1);
  }
});

test('pending data channels count toward the bound and closed channels free their slot', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let release;
  const { controller } = f.start({
    timing: { ...timing, maxChannels: 1 },
    resolveProxy: () => (++calls === 2 ? new Promise((resolve) => (release = resolve)) : 'DIRECT'),
  });
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => release);
  f.open();
  await delay(30);
  assert.equal(calls, 2);
  release('DIRECT');
  await until(() => f.channels.length === 1);
  f.channels[0].ws.close();
  await until(() => f.channels[0].ws.readyState === 3);
  f.open();
  await until(() => f.channels.length === 2);
});

test('control and data heartbeat failures release channels and give up silent paths', async (t) => {
  const f = await fixture(t, { autoPong: false });
  const { controller, statuses } = f.start({
    timing: { ...timing, heartbeat: 20, reconnectMin: 1000 },
  });
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => f.channels.length === 1);
  const context = f.requestContext();
  await until(() => statuses.some((status) => status.state === 'offline'));
  assert.throws(() => controller.context(context), { statusCode: 403 });
  await until(() => f.channels[0].ws.readyState === 3);
  controller.close();
});

test('data streams carry a complete browser WebSocket upgrade and frames unchanged', async (t) => {
  const f = await fixture(t);
  const { controller } = f.start();
  await until(() => controller.status.state === 'online');
  f.open();
  await until(() => f.channels.length === 1);
  const channel = f.channels[0];
  channel.ws.send(
    Buffer.from(
      'GET /api/control HTTP/1.1\r\nHost: relay.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    ),
  );
  await until(() => channel.data.includes('101 Switching Protocols'));
  // A masked client text frame, carried as bytes inside the independent relay WebSocket.
  channel.data = '';
  channel.ws.send(
    Buffer.from([0x81, 0x82, 1, 2, 3, 4, 'h'.charCodeAt(0) ^ 1, 'i'.charCodeAt(0) ^ 2]),
  );
  await until(() => channel.data.includes('hi'));
  assert.equal(f.locals.length, 1);
});

test('invalid settings fail before any asynchronous connection starts', () => {
  const base = { config: { url: 'ws://localhost/ws', token }, deviceId, port: 1789 };
  for (const url of [
    'http://localhost/ws',
    'ws://user:pass@localhost/ws',
    'ws://localhost/ws?token=secret',
  ])
    assert.throws(() => startWebRelay({ ...base, config: { ...base.config, url } }));
  assert.throws(() => startWebRelay({ ...base, deviceId: 'other' }));
  assert.throws(() => startWebRelay({ ...base, port: 0 }));
  assert.throws(() =>
    startWebRelay({ ...base, config: { ...base.config, fingerprint: 'ab'.repeat(32) } }),
  );
});

async function selfSigned() {
  const script = `$key = [Security.Cryptography.RSA]::Create(2048)
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, 'SHA256', [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
    @{ cert = $certificate.ExportCertificatePem(); key = $key.ExportPkcs8PrivateKeyPem() } | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)(
    'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  );
  return JSON.parse(stdout);
}

test(
  'TLS validates pinned certificates before credentials; pin or CA failures are fatal',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const tls = await selfSigned();
    const fingerprint = new X509Certificate(tls.cert).fingerprint256;
    const f = await fixture(t, { tls, config: { fingerprint } });
    const { controller } = f.start();
    await until(() => controller.status.state === 'online');
    assert.equal(f.controls.length, 1);
    assert.equal(f.controls[0].message.hostname, '127.0.0.1');
    assert.equal('origin' in f.controls[0].message, false);
    assert.equal(controller.status.url, `${f.origin}/remote/${deviceId}/`);
    controller.close();
    const bad = f.start({
      config: {
        url: `wss://127.0.0.1:${f.service.address().port}/ws`,
        token,
        fingerprint: 'ab'.repeat(32),
      },
    }).controller;
    await until(() => bad.status.state === 'error');
    const ca = f.start({
      config: { url: `wss://127.0.0.1:${f.service.address().port}/ws`, token },
    }).controller;
    await until(() => ca.status.state === 'error');
    await delay(100);
    assert.equal(f.controls.length, 1);
    assert.match(bad.status.error, /指纹/);
    assert.match(ca.status.error, /证书/);
  },
);

test(
  'TLS data channels through the system proxy recheck the pin before sending attachment secrets',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const tls = await selfSigned();
    const f = await fixture(t, {
      tls,
      config: { fingerprint: new X509Certificate(tls.cert).fingerprint256 },
    });
    const proxy = await proxyFixture(t);
    const { controller } = f.start({ resolveProxy: () => proxy.answer });
    await until(() => controller.status.state === 'online');
    f.open();
    await until(() => f.channels.length === 1);
    f.channels[0].ws.send(Buffer.from('GET /secure-proxy HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
    await until(() => f.channels[0].data.includes('local:/secure-proxy'));
    const replacement = await selfSigned();
    f.service.setSecureContext(replacement);
    f.open();
    await until(() => controller.status.state === 'error');
    assert.match(controller.status.error, /指纹/);
    assert.equal(f.channels.length, 1, 'a changed certificate never receives relay.attach');
    assert.equal(f.controls.length, 1);
    assert.equal(proxy.requests.length, 3);
  },
);
test(
  'a real backpressured upload survives a pause shorter than the configured idle deadline',
  { timeout: 10000 },
  async (t) => {
    let bytes = 0;
    const digest = createHash('sha256');
    let completed = false;
    let aborted = false;
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const f = await fixture(t, {
      request: (request, response) => {
        request.on('error', () => {});
        request.on('aborted', () => (aborted = true));
        request.on('data', (chunk) => {
          bytes += chunk.length;
          digest.update(chunk);
        });
        request.on('end', () => {
          completed = true;
          response.end('upload-complete');
        });
        request.pause();
        setTimeout(() => request.resume(), 250);
        return true;
      },
    });
    const { controller } = f.start({ timing: { ...timing, heartbeat: 20, idle: 1000 } });
    await until(() => controller.status.state === 'online');
    f.open();
    await until(() => f.channels.length === 1);
    const channel = f.channels[0];
    channel.ws.send(
      Buffer.from(
        `POST /upload HTTP/1.1\r\nHost: relay.example\r\nContent-Length: ${payload.length}\r\n\r\n`,
      ),
    );
    for (let offset = 0; offset < payload.length; offset += 65536)
      channel.ws.send(payload.subarray(offset, offset + 65536));
    await delay(500);
    assert.equal(
      completed,
      true,
      'progress resumes before idle timeout and must not be mistaken for heartbeat failure',
    );
    assert.equal(bytes, payload.length);
    assert.equal(digest.digest('hex'), createHash('sha256').update(payload).digest('hex'));
  },
);

test(
  'a real backpressured download survives a paused peer before the idle deadline',
  { timeout: 10000 },
  async (t) => {
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x42);
    const f = await fixture(t, {
      request: (_request, response) => {
        response.writeHead(200, { 'content-length': payload.length, connection: 'close' });
        response.end(payload);
        return true;
      },
    });
    const { controller } = f.start({
      timing: { ...timing, heartbeat: 20, idle: 1000, drain: 2000 },
    });
    await until(() => controller.status.state === 'online');
    f.open();
    await until(() => f.channels.length === 1);
    const channel = f.channels[0];
    const chunks = [];
    channel.ws.on('message', (chunk) => chunks.push(chunk));
    channel.ws.pause();
    channel.ws.send(
      Buffer.from('GET /download HTTP/1.1\r\nHost: relay.example\r\nConnection: close\r\n\r\n'),
    );
    setTimeout(() => channel.ws.resume(), 250);
    await until(() => channel.ws.readyState === WebSocket.CLOSED);
    const all = Buffer.concat(chunks),
      body = all.subarray(all.indexOf('\r\n\r\n') + 4);
    assert.equal(body.length, payload.length);
    assert.deepEqual(body, payload);
  },
);

test(
  'control loss aborts an incomplete upload, reconnects without replay, and leaves local listener available',
  { timeout: 10000 },
  async (t) => {
    let starts = 0,
      aborted = false,
      complete = false,
      readBytes = 0;
    const f = await fixture(t, {
      request: (request, response) => {
        if (request.url !== '/incomplete') return false;
        starts++;
        request.on('data', (chunk) => (readBytes += chunk.length));
        request.on('error', () => {});
        request.on('aborted', () => (aborted = true));
        request.on('end', () => {
          complete = true;
          response.end('bad');
        });
        return true;
      },
    });
    const { controller } = f.start();
    await until(() => controller.status.state === 'online');
    f.open();
    await until(() => f.channels.length === 1);
    const original = f.channels[0];
    original.ws.send(
      Buffer.from(
        'POST /incomplete HTTP/1.1\r\nHost: relay.example\r\nContent-Length: 8388608\r\n\r\n' +
          'x'.repeat(131072),
      ),
    );
    await until(() => readBytes === 131072);
    f.controls[0].ws.terminate();
    await until(() => aborted && f.controls.length === 2 && controller.status.state === 'online');
    assert.equal(complete, false);
    assert.equal(starts, 1);
    assert.equal(original.ws.readyState, WebSocket.CLOSED);
    f.open();
    await until(() => f.channels.length === 2);
    f.channels[1].ws.send(Buffer.from('GET /after-loss HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
    await until(() => f.channels[1].data.includes('local:/after-loss'));
    assert.equal(starts, 1);
    assert.equal(f.local.listening, true);
  },
);

test(
  'a data TCP FIN aborts only its incomplete local request and frees the channel slot',
  { timeout: 10000 },
  async (t) => {
    let aborted = false,
      bytes = 0;
    const f = await fixture(t, {
      request: (request) => {
        if (request.url !== '/halfclosed') return false;
        request.on('data', (chunk) => (bytes += chunk.length));
        request.on('error', () => {});
        request.on('aborted', () => (aborted = true));
        return true;
      },
    });
    const { controller } = f.start({ timing: { ...timing, maxChannels: 1 } });
    await until(() => controller.status.state === 'online');
    f.open();
    await until(() => f.channels.length === 1);
    f.channels[0].ws.send(
      Buffer.from(
        'POST /halfclosed HTTP/1.1\r\nHost: relay.example\r\nContent-Length: 10000\r\n\r\nx',
      ),
    );
    await until(() => bytes === 1);
    f.channels[0].ws._socket.end();
    await until(() => aborted);
    assert.equal(controller.status.state, 'online');
    f.open();
    await until(() => f.channels.length === 2);
    f.channels[1].ws.send(Buffer.from('GET /after-fin HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
    await until(() => f.channels[1].data.includes('local:/after-fin'));
  },
);

test(
  'control loss aborts an in-flight download and does not replay it after reconnect',
  { timeout: 10000 },
  async (t) => {
    let starts = 0,
      closed = false,
      wrote = 0;
    const f = await fixture(t, {
      request: (request, response) => {
        if (request.url !== '/ongoing') return false;
        starts++;
        response.writeHead(200, { 'content-length': 64 * 1024 * 100 });
        const timer = setInterval(() => {
          response.write(Buffer.alloc(65536, 0x61));
          wrote++;
        }, 5);
        response.on('close', () => {
          clearInterval(timer);
          closed = true;
        });
        return true;
      },
    });
    const { controller } = f.start();
    await until(() => controller.status.state === 'online');
    f.open();
    await until(() => f.channels.length === 1);
    f.channels[0].ws.send(Buffer.from('GET /ongoing HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
    await until(() => f.channels[0].data.length > 65536);
    f.controls[0].ws.terminate();
    await until(() => closed && f.controls.length === 2 && controller.status.state === 'online');
    assert.equal(starts, 1);
    assert.ok(wrote < 100);
    assert.equal(f.channels[0].ws.readyState, WebSocket.CLOSED);
    assert.equal(f.local.listening, true);
  },
);

test(
  'permanently backpressured transfers remain bounded by local idle and release capacity',
  { timeout: 10000 },
  async (t) => {
    for (const direction of ['upload', 'download']) {
      const payload = Buffer.alloc(8 * 1024 * 1024, 0x51);
      let pending;
      const f = await fixture(t, {
        request: (request, response) => {
          request.on('error', () => {});
          if (direction === 'upload') {
            pending = request;
            request.pause();
          } else {
            response.writeHead(200, { 'content-length': payload.length, connection: 'close' });
            response.end(payload);
          }
          return true;
        },
      });
      const { controller } = f.start({
        timing: { ...timing, heartbeat: 20, idle: 100, drain: 1000, maxChannels: 1 },
      });
      await until(() => controller.status.state === 'online');
      f.open();
      await until(() => f.channels.length === 1);
      const channel = f.channels[0];
      if (direction === 'upload') {
        channel.ws.send(
          Buffer.from(
            `POST /idle-upload HTTP/1.1\r\nHost: relay.example\r\nContent-Length: ${payload.length}\r\n\r\n`,
          ),
        );
        for (let offset = 0; offset < payload.length; offset += 65536)
          channel.ws.send(payload.subarray(offset, offset + 65536));
      } else {
        channel.ws.pause();
        channel.ws.send(Buffer.from('GET /idle-download HTTP/1.1\r\nHost: relay.example\r\n\r\n'));
      }
      // Three times the idle deadline, but far shorter than the unchanged EOF drain limit.
      await delay(300);
      f.open();
      await until(() => f.channels.length === 2, `${direction} idle must release capacity`);
      assert.equal(controller.status.state, 'online');
      pending?.resume();
      channel.ws.resume();
      await until(() => channel.ws.readyState === WebSocket.CLOSED);
      controller.close();
    }
  },
);

test(
  'a silent data peer is detected again once a backpressured upload has resumed',
  { timeout: 10000 },
  async (t) => {
    let completed = false;
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x52);
    const f = await fixture(t, {
      request: (request, response) => {
        request.on('error', () => {});
        request.on('data', () => {});
        request.on('end', () => {
          completed = true;
          response.end('resumed');
        });
        request.pause();
        setTimeout(() => request.resume(), 150);
        return true;
      },
    });
    const { controller } = f.start({ timing: { ...timing, heartbeat: 20, idle: 1000 } });
    await until(() => controller.status.state === 'online');
    f.open();
    await until(() => f.channels.length === 1);
    const channel = f.channels[0];
    channel.ws.send(
      Buffer.from(
        `POST /resume HTTP/1.1\r\nHost: relay.example\r\nContent-Length: ${payload.length}\r\n\r\n`,
      ),
    );
    for (let offset = 0; offset < payload.length; offset += 65536)
      channel.ws.send(payload.subarray(offset, offset + 65536));
    await until(() => completed && channel.data.includes('resumed'));
    channel.ws._autoPong = false;
    await delay(150);
    assert.equal(
      channel.ws.readyState,
      WebSocket.CLOSED,
      'normal data heartbeat resumes after backpressure',
    );
    assert.equal(
      controller.status.state,
      'online',
      'the separate control heartbeat remains active',
    );
  },
);
