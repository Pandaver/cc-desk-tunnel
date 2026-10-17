import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createWebSocketStream, WebSocket, WebSocketServer } from 'ws';
import { WebRelay } from '../src/web-relay.ts';
import { createProxyServer } from '../src/server.ts';

const token = 'relay-test-' + randomUUID();
const deviceId = 'a'.repeat(32);
const relayKey = 'b'.repeat(64);
const origin = 'http://relay.example';
const path = `/remote/${deviceId}`;

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Timed out waiting for relay state');
    await setImmediate();
  }
}

type Frame = {
  type: string;
  connectionId: string;
  secret: string;
  origin: string;
  path: string;
  channelId: string;
  capabilities?: string[];
};
async function fixture(
  t: TestContext,
  handler: RequestListener = (_request, response) => response.end('desktop'),
  writeDelayMs = 0,
  browserWriteDelayMs = 0,
  addressOf: (request: IncomingMessage) => string = (request) => request.socket.remoteAddress!,
) {
  const local = createServer(handler);
  const localSockets = new Set<Socket>();
  local.on('connection', (socket) => {
    localSockets.add(socket);
    socket.once('close', () => localSockets.delete(socket));
  });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  const localAddress = local.address();
  assert.ok(localAddress && typeof localAddress !== 'string');
  const localPort = localAddress.port;
  const relay = new WebRelay(
    { protocol: 'http:', publicPort: 80 },
    (value) => value === token,
    addressOf,
  );
  const stalled: {
    socket: Socket;
    response?: ServerResponse;
    resume: () => void;
    step: () => boolean;
  }[] = [];
  const stall = (socket: Socket, response?: ServerResponse) => {
    const write = socket._write.bind(socket);
    const writev = socket._writev!.bind(socket);
    const queued: (() => void)[] = [];
    socket._write = (...args) => {
      queued.push(() => write(...args));
    };
    socket._writev = (...args) => {
      queued.push(() => writev(...args));
    };
    stalled.push({
      socket,
      response,
      step: () => {
        const pending = queued.shift();
        pending?.();
        return !!pending;
      },
      resume: () => {
        socket._write = write;
        socket._writev = writev;
        for (const pending of queued) pending();
      },
    });
  };
  const server = createServer((request, response) => {
    if (browserWriteDelayMs === Infinity && request.headers['x-test-stall'])
      stall(request.socket, response);
    if (!relay.handleRequest(request, response)) response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (browserWriteDelayMs === Infinity && request.headers['x-test-stall'])
      stall(socket as Socket);
    else if (
      browserWriteDelayMs &&
      Number.isFinite(browserWriteDelayMs) &&
      request.url?.startsWith('/remote/')
    ) {
      const write = socket._write.bind(socket);
      socket._write = (chunk, encoding, callback) => {
        setTimeout(() => write(chunk, encoding, callback), browserWriteDelayMs);
      };
    }
    if (!relay.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const clients = new Set<WebSocket>();
  t.after(async () => {
    for (const client of clients) client.terminate();
    await relay.close();
    for (const socket of localSockets) socket.destroy();
    await Promise.all(
      [local, server].map((value) => new Promise<void>((resolve) => value.close(() => resolve()))),
    );
  });
  async function websocket(endpoint: string, headers: Record<string, string> = {}) {
    const socket = new WebSocket(url.replace('http', 'ws') + endpoint, { headers });
    clients.add(socket);
    socket.on('error', () => {});
    await once(socket, 'open');
    return socket;
  }
  async function attach(ready: Frame, channelId: string, secret = ready.secret) {
    const socket = await websocket('/_relay/data');
    socket.send(
      JSON.stringify({ type: 'relay.attach', connectionId: ready.connectionId, channelId, secret }),
    );
    const stream = createWebSocketStream(socket);
    if (writeDelayMs) {
      const write = stream._write.bind(stream);
      stream._write = (chunk, encoding, callback) => {
        setTimeout(() => write(chunk, encoding, callback), writeDelayMs);
      };
    }
    const target = connect(localPort, '127.0.0.1');
    target.on('error', () => stream.destroy());
    stream.on('error', () => target.destroy());
    target.once('close', (hadError) => {
      if (hadError || !target.readableEnded) stream.destroy();
    });
    stream.once('close', () => target.destroy());
    target.pipe(stream).pipe(target);
    return socket;
  }
  async function register(
    automatic = true,
    id = deviceId,
    hostname = 'relay.example',
    route?: string,
  ) {
    const socket = await websocket('/_relay/control');
    const first = once(socket, 'message');
    socket.send(
      JSON.stringify({
        type: 'relay.register',
        version: 2,
        token,
        deviceId: id,
        relayKey,
        hostname,
        route,
      }),
    );
    const ready: Frame = JSON.parse((await first)[0].toString());
    if (automatic)
      socket.on('message', (raw) => {
        const message: Frame = JSON.parse(raw.toString());
        if (message.type === 'relay.open') void attach(ready, message.channelId);
      });
    return { socket, ready };
  }
  function request(
    target = path + '/',
    options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
  ) {
    let client: ReturnType<typeof httpRequest>;
    const result = new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>(
      (resolve, reject) => {
        client = httpRequest(
          url + target,
          {
            method: options.method ?? 'GET',
            headers: { host: 'relay.example', ...options.headers },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () =>
              resolve({
                status: response.statusCode!,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        client.on('error', reject);
        client.end(options.body);
      },
    );
    return { result, abort: () => client.destroy() };
  }
  return { relay, local, url, websocket, register, attach, request, stalled };
}

test('disabled relay preserves the original listener and does not expose relay handshakes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-relay-disabled-'));
  const server = createProxyServer({ token, dataDir: directory });
  const url = await server.listen(0);
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(server.relayAddress, undefined);
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await fetch(url + path + '/')).status, 404);
  const intervals = t.mock.method(globalThis, 'setInterval');
  const socket = new WebSocket(url.replace('http', 'ws') + '/_relay/control');
  socket.on('error', () => {});
  t.after(() => socket.terminate());
  assert.match((await once(socket, 'error'))[0].message, /403/);
  assert.equal(intervals.mock.callCount(), 0);
});

test('relay requires valid registration and keeps the first desktop on a duplicate identity', async (t) => {
  const f = await fixture(t);
  for (const [frame, code] of [
    [
      {
        type: 'relay.register',
        version: 2,
        token: 'wrong',
        deviceId,
        relayKey,
        hostname: 'relay.example',
      },
      4001,
    ],
    [
      { type: 'relay.register', version: 1, token, deviceId, relayKey, hostname: 'relay.example' },
      4002,
    ],
    [
      {
        type: 'relay.register',
        version: 2,
        token,
        deviceId: '../other',
        relayKey,
        hostname: 'relay.example',
      },
      4002,
    ],
  ] as const) {
    const socket = await f.websocket('/_relay/control');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify(frame));
    assert.equal((await closed)[0], code);
  }
  const { ready } = await f.register();
  assert.equal(ready.origin, origin);
  assert.equal(ready.path, path + '/');
  assert.deepEqual(ready.capabilities, ['route']);
  const duplicate = await f.websocket('/_relay/control');
  const closed = once(duplicate, 'close');
  duplicate.send(
    JSON.stringify({
      type: 'relay.register',
      version: 2,
      token,
      deviceId,
      relayKey,
      hostname: 'relay.example',
    }),
  );
  assert.equal((await closed)[0], 4009);
  assert.equal((await f.request().result).body.toString(), 'desktop');
});

test('relay accepts independent canonical routes and redirects only their canonical browser address', async (t) => {
  const f = await fixture(t);
  for (const [index, route] of ['a', 'my-pc', 'a'.repeat(64)].entries()) {
    const registered = await f.register(true, String(index).repeat(32), 'relay.example', route);
    assert.equal(registered.ready.path, `/remote/${route}/`);
    assert.deepEqual(registered.ready.capabilities, ['route']);
    assert.equal((await f.request(registered.ready.path).result).body.toString(), 'desktop');
    const redirect = await f.request(`/remote/${route}?next=test`).result;
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, `/remote/${route}/?next=test`);
    assert.equal((await f.request(`/remote/${String(index).repeat(32)}/`).result).status, 404);
  }
});

test('relay rejects malformed registration routes without reserving the identity or route', async (t) => {
  const f = await fixture(t);
  for (const route of [
    '',
    '-pc',
    'pc-',
    'My-pc',
    'a'.repeat(65),
    '../pc',
    'pc/other',
    'pc%2fother',
    ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((ending) => `my-pc${ending}`),
    null,
    1,
  ]) {
    const socket = await f.websocket('/_relay/control');
    const closed = once(socket, 'close');
    socket.send(
      JSON.stringify({
        type: 'relay.register',
        version: 2,
        token,
        deviceId,
        relayKey,
        hostname: 'relay.example',
        route,
      }),
    );
    assert.equal((await closed)[0], 4002);
  }
  await f.register(true, deviceId, 'relay.example', 'my-pc');
  assert.equal((await f.request('/remote/my-pc/').result).status, 200);
});

test('relay keeps registered routes when an alias, default identity or duplicate desktop conflicts', async (t) => {
  const f = await fixture(t);
  const otherId = 'c'.repeat(32);
  await f.register(true, deviceId, 'relay.example', otherId);
  for (const [id, route, code] of [
    ['d'.repeat(32), otherId, 4010],
    [otherId, undefined, 4010],
    [deviceId, 'new-route', 4009],
  ] as const) {
    const socket = await f.websocket('/_relay/control');
    const closed = once(socket, 'close');
    socket.send(
      JSON.stringify({
        type: 'relay.register',
        version: 2,
        token,
        deviceId: id,
        relayKey,
        hostname: 'relay.example',
        route,
      }),
    );
    assert.equal((await closed)[0], code);
    assert.equal((await f.request(`/remote/${otherId}/`).result).body.toString(), 'desktop');
  }
});

test('relay route updates reject invalid or occupied aliases while preserving both current routes', async (t) => {
  const f = await fixture(t);
  const first = await f.register(true, deviceId, 'relay.example', 'my-pc');
  await f.register(true, 'c'.repeat(32), 'relay.example', 'other-pc');
  for (const [route, error] of [
    ['other-pc', 'route_in_use'],
    ['', 'invalid_route'],
    ['../pc', 'invalid_route'],
    ['a'.repeat(65), 'invalid_route'],
    ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((ending) => [
      `my-pc${ending}`,
      'invalid_route',
    ]),
    [null, 'invalid_route'],
  ]) {
    const id = randomUUID();
    const received = once(first.socket, 'message');
    first.socket.send(JSON.stringify({ type: 'relay.route', id, route }));
    assert.deepEqual(JSON.parse((await received)[0].toString()), {
      type: 'relay.route-result',
      id,
      ok: false,
      error,
    });
    assert.equal(first.socket.readyState, WebSocket.OPEN);
    assert.equal((await f.request('/remote/my-pc/').result).body.toString(), 'desktop');
    assert.equal((await f.request('/remote/other-pc/').result).body.toString(), 'desktop');
  }
});

test('relay rejects malformed route control frames and releases their routes', async (t) => {
  const f = await fixture(t);
  for (const frame of [
    'not-json',
    JSON.stringify({ type: 'relay.route', id: 'invalid', route: 'new-route' }),
    JSON.stringify({ type: 'relay.route', id: randomUUID() + '\n', route: 'new-route' }),
    Buffer.from(JSON.stringify({ type: 'relay.route', id: randomUUID(), route: 'new-route' })),
  ]) {
    const registered = await f.register(true, deviceId, 'relay.example', 'my-pc');
    const closed = once(registered.socket, 'close');
    registered.socket.send(frame);
    assert.equal((await closed)[0], 4002);
    assert.equal((await f.request('/remote/my-pc/').result).status, 404);
    assert.equal((await f.request('/remote/new-route/').result).status, 404);
  }
});

test('relay route updates preserve identity and credentials while moving HTTP and WebSocket access', async (t) => {
  const f = await fixture(t, (request, response) => {
    assert.equal(request.headers['x-ccdt-relay-key'], relayKey);
    response.end(request.url);
  });
  const wss = new WebSocketServer({ noServer: true });
  f.local.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/api/control');
    assert.equal(request.headers['x-ccdt-relay-key'], relayKey);
    wss.handleUpgrade(request, socket, head, (client) =>
      client.on('message', (message) => client.send(message)),
    );
  });
  const registered = await f.register();
  for (const route of ['a'.repeat(64), 'my-pc', 'my-pc']) {
    const id = randomUUID();
    const received = once(registered.socket, 'message');
    registered.socket.send(JSON.stringify({ type: 'relay.route', id, route }));
    assert.deepEqual(JSON.parse((await received)[0].toString()), {
      type: 'relay.route-result',
      id,
      ok: true,
      path: `/remote/${route}/`,
    });
    assert.equal((await f.request().result).status, 404);
    assert.equal(
      (await f.request(`/remote/${route}/api/status?test=1`).result).body.toString(),
      '/api/status?test=1',
    );
  }
  const stale = new WebSocket(f.url.replace('http', 'ws') + path + '/api/control', {
    headers: { host: 'relay.example', origin },
  });
  stale.on('error', () => {});
  t.after(() => stale.terminate());
  assert.match((await once(stale, 'error'))[0].message, /404/);
  const browser = await f.websocket('/remote/my-pc/api/control', { host: 'relay.example', origin });
  const received = once(browser, 'message');
  browser.send('after-rename');
  assert.equal((await received)[0].toString(), 'after-rename');
  const duplicate = await f.websocket('/_relay/control');
  const closed = once(duplicate, 'close');
  duplicate.send(
    JSON.stringify({
      type: 'relay.register',
      version: 2,
      token,
      deviceId,
      relayKey,
      hostname: 'relay.example',
      route: 'different-route',
    }),
  );
  assert.equal((await closed)[0], 4009);
});

test('relay releases only the current route and does not remove a reassigned old route on close', async (t) => {
  const f = await fixture(t);
  const first = await f.register(true, deviceId, 'relay.example', 'first-pc');
  const received = once(first.socket, 'message');
  first.socket.send(JSON.stringify({ type: 'relay.route', id: randomUUID(), route: 'renamed-pc' }));
  assert.equal(JSON.parse((await received)[0].toString()).ok, true);
  await f.register(true, 'c'.repeat(32), 'relay.example', 'first-pc');
  const closed = once(first.socket, 'close');
  first.socket.close();
  await closed;
  assert.equal((await f.request('/remote/renamed-pc/').result).status, 404);
  assert.equal((await f.request('/remote/first-pc/').result).body.toString(), 'desktop');
  const replacement = await f.register(true, deviceId, 'relay.example', 'renamed-pc');
  assert.equal(replacement.ready.path, '/remote/renamed-pc/');
  assert.equal((await f.request(replacement.ready.path).result).body.toString(), 'desktop');
});

test('v2 registration requires a canonical hostname without protocol, credentials, path or port', async (t) => {
  const f = await fixture(t);
  for (const hostname of [
    undefined,
    '',
    'http://relay.example',
    'user@relay.example',
    'relay.example:5270',
    'relay.example:80',
    'relay.example/path',
    'relay.example?',
    'relay.example#fragment',
    'relay.example\\other',
    ' relay.example',
    'Relay.Example',
    '127.1',
    '::1',
    '[::1]:5270',
  ]) {
    const socket = await f.websocket('/_relay/control');
    const closed = once(socket, 'close');
    socket.send(
      JSON.stringify({ type: 'relay.register', version: 2, token, deviceId, relayKey, hostname }),
    );
    assert.equal((await closed)[0], 4002);
    assert.equal((await f.request().result).status, 404);
  }
  const legacy = await f.websocket('/_relay/control');
  const closed = once(legacy, 'close');
  legacy.send(
    JSON.stringify({
      type: 'relay.register',
      version: 2,
      token,
      deviceId,
      relayKey,
      hostname: 'relay.example',
      origin: 'http://other.example',
    }),
  );
  assert.equal((await closed)[0], 4002);
  let index = 0;
  for (const hostname of ['127.0.0.1', 'relay.example', '[::1]', 'xn--bcher-kva.example']) {
    const { ready } = await f.register(false, (++index).toString(16).padStart(32, '0'), hostname);
    assert.equal(ready.origin, new URL(`http://${hostname}`).origin);
  }
});

test('each desktop uses its canonical hostname with the server-owned public port for HTTP routing, forwarded Host and browser upgrades', async (t) => {
  const f = await fixture(t, (request, response) =>
    response.end(
      JSON.stringify({
        host: request.headers.host,
        origin: request.headers.origin,
      }),
    ),
  );
  const secondId = 'c'.repeat(32);
  const secondOrigin = 'http://second.example';
  const secondPath = `/remote/${secondId}/`;
  const first = await f.register();
  const second = await f.register(true, secondId, 'second.example');
  assert.equal(first.ready.origin, origin);
  assert.equal(second.ready.origin, secondOrigin);
  const response = await f.request(secondPath, {
    headers: { host: 'second.example', origin: secondOrigin },
  }).result;
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.toString()), {
    host: 'second.example',
    origin: secondOrigin,
  });
  assert.equal((await f.request(secondPath).result).status, 403);
  assert.equal(
    (
      await f.request(path + '/', {
        headers: { host: 'second.example', origin: secondOrigin },
      }).result
    ).status,
    403,
  );
  assert.equal(
    (await f.request(secondPath, { headers: { host: 'second.example', origin } }).result).status,
    403,
  );
  const browser = new WebSocket(f.url.replace('http', 'ws') + secondPath + 'api/control', {
    headers: { host: 'second.example', origin },
  });
  browser.on('error', () => {});
  t.after(() => browser.terminate());
  const [error] = await once(browser, 'error');
  assert.match(error.message, /403/);
  assert.equal((await f.request().result).status, 200);
});

test('relay streams binary HTTP bodies and preserves status, cookies and trusted browser context', async (t) => {
  const payload = randomBytes(256 * 1024);
  const f = await fixture(t, (request, response) => {
    assert.equal(request.url, '/api/upload?name=test');
    assert.equal(request.headers.host, 'relay.example');
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers.cookie, 'local-session=test');
    assert.equal(request.headers['x-ccdt-relay-key'], relayKey);
    assert.equal(request.headers['x-ccdt-relay-address'], '127.0.0.1');
    assert.equal(request.headers['x-forwarded-for'], undefined);
    assert.equal(request.headers.forwarded, undefined);
    assert.equal(request.headers['x-real-ip'], undefined);
    response.writeHead(201, {
      'Content-Type': 'application/octet-stream',
      'Set-Cookie': [`session=one; Path=${path}/; HttpOnly`, `other=two; Path=${path}/`],
      'X-Result': 'kept',
    });
    request.pipe(response);
  });
  await f.register();
  const response = await f.request(path + '/api/upload?name=test', {
    method: 'POST',
    body: payload,
    headers: {
      origin,
      cookie: 'local-session=test',
      'x-forwarded-for': '203.0.113.1',
      forwarded: 'for=203.0.113.1',
      'x-real-ip': '203.0.113.1',
      'x-ccdt-relay-key': 'forged',
      'x-ccdt-relay-address': '203.0.113.1',
    },
  }).result;
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, payload);
  assert.equal(response.headers['x-result'], 'kept');
  assert.equal(response.headers['set-cookie']?.length, 2);
  assert.equal(
    (await f.request(path + '/', { headers: { origin: 'https://other.example' } }).result).status,
    403,
  );
  assert.equal(
    (await f.request(path + '/', { headers: { host: 'other.example' } }).result).status,
    403,
  );
  assert.equal((await f.request(path).result).headers.location, path + '/');
});

test('browser WebSocket upgrade forwards immediate response and binary messages', async (t) => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ noServer: true });
  f.local.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/api/control');
    assert.equal(request.headers['x-ccdt-relay-key'], relayKey);
    wss.handleUpgrade(request, socket, head, (client) => {
      client.send('ready');
      client.on('message', (message, binary) => client.send(message, { binary }));
    });
  });
  await f.register();
  const browser = new WebSocket(f.url.replace('http', 'ws') + path + '/api/control', {
    headers: { host: 'relay.example', origin },
  });
  browser.on('error', () => {});
  t.after(() => browser.terminate());
  const first = once(browser, 'message');
  await once(browser, 'open');
  assert.equal((await first)[0].toString(), 'ready');
  const payload = randomBytes(128 * 1024);
  const response = once(browser, 'message');
  browser.send(payload);
  const [received, binary] = await response;
  assert.equal(binary, true);
  assert.deepEqual(received, payload);
  browser.close();
  await once(browser, 'close');
});

test('a clean local EOF drains queued WebSocket response bytes before closing the channel', async (t) => {
  const payload = randomBytes(2 * 1024 * 1024);
  const f = await fixture(
    t,
    (_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length,
      });
      response.end(payload);
    },
    3,
  );
  await f.register();
  const response = await f.request().result;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, payload);
});

test('an upgraded response drains its final browser socket writes on a clean relay EOF', async (t) => {
  const payload = randomBytes(1024 * 1024);
  const frame = Buffer.alloc(10);
  frame[0] = 0x82;
  frame[1] = 127;
  frame.writeBigUInt64BE(BigInt(payload.length), 2);
  const body = Buffer.concat([frame, payload, Buffer.from([0x88, 0])]);
  const f = await fixture(t, undefined, 0, 3);
  f.local.on('upgrade', (_request, socket) =>
    socket.end(
      Buffer.concat([
        Buffer.from(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        ),
        body,
      ]),
    ),
  );
  await f.register();
  const browser = connect(Number(new URL(f.url).port), '127.0.0.1');
  t.after(() => browser.destroy());
  const chunks: Buffer[] = [];
  browser.on('data', (chunk) => chunks.push(chunk));
  const ended = once(browser, 'end');
  await once(browser, 'connect');
  browser.write(
    `GET ${path}/api/control HTTP/1.1\r\nHost: relay.example\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  );
  await ended;
  const received = Buffer.concat(chunks);
  const headerEnd = received.indexOf('\r\n\r\n');
  assert.notEqual(headerEnd, -1);
  assert.deepEqual(received.subarray(headerEnd + 4), body);
});

test('an HTTP response that never drains closes exactly at its EOF drain deadline', async (t) => {
  const f = await fixture(t, undefined, 0, Infinity);
  await f.register();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } }).result;
  const rejected = assert.rejects(result, /socket hang up|aborted/);
  await until(() => f.stalled[0]?.response?.writableEnded === true);
  const socket = f.stalled[0].socket;
  t.mock.timers.tick(29_999);
  assert.equal(socket.destroyed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(socket.destroyed, true);
  t.mock.timers.reset();
  assert.equal((await f.request().result).status, 200);
});

test('an upgraded response that never drains closes exactly at its EOF drain deadline', async (t) => {
  const f = await fixture(t, undefined, 0, Infinity);
  f.local.on('upgrade', (_request, socket) =>
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nlast bytes',
    ),
  );
  await f.register();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = connect(Number(new URL(f.url).port), '127.0.0.1');
  browser.on('error', () => {});
  browser.resume();
  t.after(() => browser.destroy());
  const closed = once(browser, 'close');
  await once(browser, 'connect');
  browser.write(
    `GET ${path}/api/control HTTP/1.1\r\nHost: relay.example\r\nOrigin: ${origin}\r\nX-Test-Stall: yes\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  );
  await until(() => f.stalled[0]?.socket.writableEnded === true);
  const socket = f.stalled[0].socket;
  t.mock.timers.tick(29_999);
  assert.equal(socket.destroyed, false);
  t.mock.timers.tick(1);
  await closed;
  assert.equal(socket.destroyed, true);
  t.mock.timers.reset();
});

test('queued browser tails keep their desktop capacity after data channels close and release it on close', async (t) => {
  const f = await fixture(t, undefined, 0, Infinity);
  await f.register();
  const pending: Promise<unknown>[] = [];
  for (let index = 0; index < 64; index++) {
    pending.push(
      f.request(path + '/', { headers: { 'x-test-stall': 'yes' } }).result.catch(() => {}),
    );
    await until(() => f.stalled[index]?.response?.writableEnded === true);
  }
  assert.equal((await f.request().result).status, 503);
  f.stalled[0].socket.destroy();
  await until(() => f.stalled[0].response!.destroyed);
  assert.equal((await f.request().result).status, 200);
  await f.relay.close();
  await Promise.all(pending);
  assert.ok(f.stalled.every(({ socket }) => socket.destroyed));
});

test('relay close cancels outstanding drain deadlines rather than destroying outputs again later', async (t) => {
  const f = await fixture(t, undefined, 0, Infinity);
  await f.register();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(
    f.request(path + '/', { headers: { 'x-test-stall': 'yes' } }).result,
  );
  await until(() => f.stalled[0]?.response?.writableEnded === true);
  const response = f.stalled[0].response!;
  const destroy = t.mock.method(response, 'destroy');
  await f.relay.close();
  await rejected;
  const calls = destroy.mock.callCount();
  assert.ok(calls > 0);
  t.mock.timers.tick(30_000);
  assert.equal(destroy.mock.callCount(), calls);
  t.mock.timers.reset();
});

test('a response finishing before its drain deadline cancels the deadline', async (t) => {
  const f = await fixture(t, undefined, 0, Infinity);
  await f.register();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } }).result;
  await until(() => f.stalled[0]?.response?.writableEnded === true);
  const response = f.stalled[0].response!;
  const destroy = t.mock.method(response, 'destroy');
  t.mock.timers.tick(29_999);
  f.stalled[0].resume();
  assert.equal((await result).body.toString(), 'desktop');
  assert.equal(response.writableFinished, true);
  const calls = destroy.mock.callCount();
  t.mock.timers.tick(1);
  assert.equal(destroy.mock.callCount(), calls);
  t.mock.timers.reset();
});

test('failed attachment does not consume the pending channel and disconnect clears pending requests', async (t) => {
  const f = await fixture(t);
  const { socket, ready } = await f.register(false);
  const opening = once(socket, 'message');
  const response = f.request();
  const channel: Frame = JSON.parse((await opening)[0].toString());
  const bad = await f.websocket('/_relay/data');
  const badClosed = once(bad, 'close');
  bad.send(
    JSON.stringify({
      type: 'relay.attach',
      connectionId: ready.connectionId,
      channelId: channel.channelId,
      secret: '0'.repeat(64),
    }),
  );
  assert.equal((await badClosed)[0], 4001);
  await f.attach(ready, channel.channelId);
  assert.equal((await response.result).status, 200);
  const anotherOpening = once(socket, 'message');
  const pending = f.request();
  await anotherOpening;
  const disconnected = once(socket, 'close');
  socket.close();
  await disconnected;
  assert.equal((await pending.result).status, 503);
  await f.register();
  assert.equal((await f.request().result).status, 200);
});

test('abandoned attachments expire and do not become live later', async (t) => {
  const f = await fixture(t);
  const { socket, ready } = await f.register(false);
  const opening = once(socket, 'message');
  const response = f.request();
  const channel: Frame = JSON.parse((await opening)[0].toString());
  assert.equal((await response.result).status, 503);
  const late = await f.websocket('/_relay/data');
  const closed = once(late, 'close');
  late.send(
    JSON.stringify({
      type: 'relay.attach',
      connectionId: ready.connectionId,
      channelId: channel.channelId,
      secret: ready.secret,
    }),
  );
  assert.equal((await closed)[0], 4004);
});

test('a page can open more than four concurrent data channels from the same desktop address', async (t) => {
  const f = await fixture(t);
  await f.register();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.request().result));
  assert.ok(
    results.every((response) => response.status === 200 && response.body.toString() === 'desktop'),
  );
});

test('browser cancellation rejects only its late data channel, not the registered desktop', async (t) => {
  const f = await fixture(t);
  const { socket, ready } = await f.register(false);
  const opening = once(socket, 'message');
  const request = f.request();
  const aborted = assert.rejects(request.result, /socket hang up/);
  const channel: Frame = JSON.parse((await opening)[0].toString());
  request.abort();
  await aborted;
  const late = await f.websocket('/_relay/data');
  const closed = once(late, 'close');
  late.send(
    JSON.stringify({
      type: 'relay.attach',
      connectionId: ready.connectionId,
      channelId: channel.channelId,
      secret: ready.secret,
    }),
  );
  assert.equal((await closed)[0], 4004);
  const nextOpening = once(socket, 'message');
  const next = f.request();
  const nextChannel: Frame = JSON.parse((await nextOpening)[0].toString());
  await f.attach(ready, nextChannel.channelId);
  assert.equal((await next.result).status, 200);
});

test('pending request capacity is bounded and released when the desktop disconnects', async (t) => {
  const f = await fixture(t);
  const { socket } = await f.register(false);
  const pending: Promise<{ status: number }>[] = [];
  for (let index = 0; index < 16; index++) {
    const opening = once(socket, 'message');
    pending.push(f.request().result);
    await opening;
  }
  assert.equal((await f.request().result).status, 503);
  socket.close();
  const results = await Promise.all(pending);
  assert.ok(results.every((response) => response.status === 503));
  await f.register();
  assert.equal((await f.request().result).status, 200);
});

test('an upgrade preserves browser frame bytes arriving in the same packet as HTTP headers', async (t) => {
  const f = await fixture(t);
  const wss = new WebSocketServer({ noServer: true });
  const received = new Promise<string>((resolve) => {
    f.local.on('upgrade', (request, socket, head) =>
      wss.handleUpgrade(request, socket, head, (client) => {
        client.on('message', (message) => resolve(message.toString()));
      }),
    );
  });
  await f.register();
  const raw = connect(Number(new URL(f.url).port), '127.0.0.1');
  raw.on('error', () => {});
  t.after(() => raw.destroy());
  await once(raw, 'connect');
  const text = Buffer.from('already here');
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.concat([
    Buffer.from([0x81, 0x80 | text.length]),
    mask,
    Buffer.from(text.map((value, index) => value ^ mask[index % 4])),
  ]);
  const headers = `GET ${path}/api/control HTTP/1.1\r\nHost: relay.example\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`;
  raw.write(Buffer.concat([Buffer.from(headers), frame]));
  assert.equal(await received, 'already here');
  raw.destroy();
});

test('relay authentication times out without registering a desktop', async (t) => {
  const f = await fixture(t);
  const socket = await f.websocket('/_relay/control');
  assert.equal((await once(socket, 'close'))[0], 1006);
  assert.equal((await f.request().result).status, 404);
  await f.register();
  assert.equal((await f.request().result).status, 200);
});
test('a non-GET WebSocket opening is not rewritten to GET', async (t) => {
  const f = await fixture(t);
  let method: string | undefined;
  const wss = new WebSocketServer({ noServer: true });
  f.local.on('upgrade', (request, socket, head) => {
    method = request.method;
    wss.handleUpgrade(request, socket, head, (client) => client.close());
  });
  await f.register();
  const browser = connect(Number(new URL(f.url).port), '127.0.0.1');
  browser.on('error', () => {});
  t.after(() => browser.destroy());
  await once(browser, 'connect');
  const first = once(browser, 'data');
  browser.write(
    `POST ${path}/api/control HTTP/1.1\r\nHost: relay.example\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  );
  const received = (await first)[0].toString();
  assert.match(received, /^HTTP\/1\.1 (400|404|405) /, `method=${method}; result=${received}`);
});

test('upgraded response strips relay secrets and hop-local nominated headers', async (t) => {
  const f = await fixture(t);
  f.local.on('upgrade', (_request, socket) =>
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade, X-Local\r\nUpgrade: websocket\r\nX-Local: hop-only\r\nX-CCDT-Relay-Key: private-key\r\nSet-Cookie: first=one\r\nSet-Cookie: second=two\r\nSec-WebSocket-Protocol: expected\r\n\r\n',
    ),
  );
  await f.register();
  const browser = connect(Number(new URL(f.url).port), '127.0.0.1');
  t.after(() => browser.destroy());
  const chunks: Buffer[] = [];
  browser.on('data', (chunk) => chunks.push(chunk));
  const ended = once(browser, 'end');
  await once(browser, 'connect');
  browser.write(
    `GET ${path}/api/control HTTP/1.1\r\nHost: relay.example\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  );
  await ended;
  const received = Buffer.concat(chunks).toString();
  assert.doesNotMatch(received, /private-key|x-local/i);
  assert.match(received, /Sec-WebSocket-Protocol: expected/i);
  assert.match(received, /Set-Cookie: first=one/i);
  assert.match(received, /Set-Cookie: second=two/i);
});

test(
  'unsolicited HTTP upgrade returns a failure rather than a hanging browser response',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, (_request, response) =>
      response.writeHead(101, { connection: 'upgrade', upgrade: 'websocket' }).end(),
    );
    await f.register();
    const request = f.request();
    t.after(request.abort);
    assert.equal((await request.result).status, 502);
  },
);

test('HTTP first response deadline returns 502 and releases its channel', async (t) => {
  let localResponse: ServerResponse | undefined;
  const f = await fixture(t, (_request, response) => {
    localResponse = response;
  });
  await f.register();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = f.request().result;
  await until(() => !!localResponse);
  t.mock.timers.tick(59_999);
  assert.equal(localResponse!.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal((await result).status, 502);
  await until(() => localResponse!.destroyed);
  t.mock.timers.reset();
});

test('long HTTP response remains open after its first headers', async (t) => {
  let localResponse: ServerResponse | undefined;
  const f = await fixture(t, (_request, response) => {
    localResponse = response;
    response.writeHead(200);
    response.write('begin:');
  });
  await f.register();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = new Promise<string>((resolve, reject) => {
    const client = httpRequest(
      f.url + path + '/',
      { headers: { host: 'relay.example' } },
      (response) => {
        t.mock.timers.tick(61_000);
        assert.equal(localResponse!.destroyed, false);
        localResponse!.end('long response');
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString()));
        response.on('error', reject);
      },
    );
    client.on('error', reject);
    client.end();
  });
  assert.equal(await result, 'begin:long response');
  t.mock.timers.reset();
});

test('WebSocket upstream handshake deadline closes and releases the browser connection', async (t) => {
  const f = await fixture(t);
  let remote: import('node:stream').Duplex | undefined;
  f.local.on('upgrade', (_request, socket) => {
    remote = socket;
    socket.resume();
  });
  await f.register();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = new WebSocket(f.url.replace('http', 'ws') + path + '/api/control', {
    headers: { host: 'relay.example', origin },
  });
  browser.on('error', () => {});
  t.after(() => browser.terminate());
  const closed = new Promise<void>((resolve) => browser.once('close', () => resolve()));
  await until(() => !!remote);
  t.mock.timers.tick(9_999);
  assert.equal(browser.readyState, WebSocket.CONNECTING);
  t.mock.timers.tick(1);
  await closed;
  assert.equal(browser.readyState, WebSocket.CLOSED);
  await until(() => !!remote?.readableEnded || !!remote?.destroyed);
  t.mock.timers.reset();
});

test('global pending capacity releases after a single cancellation', async (t) => {
  const f = await fixture(t);
  const controls = [];
  for (let i = 1; i <= 9; i++)
    controls.push(await f.register(false, i.toString(16).padStart(32, '0')));
  const pending = [];
  for (let i = 0; i < 128; i++) {
    const control = controls[Math.floor(i / 16)];
    const opening = once(control.socket, 'message');
    const req = f.request(control.ready.path);
    const settled = req.result.catch(() => null);
    pending.push({ req, settled });
    await opening;
  }
  assert.equal((await f.request(controls[8].ready.path).result).status, 503);
  pending[0].req.abort();
  await pending[0].settled;
  const nextOpening = once(controls[8].socket, 'message');
  const next = f.request(controls[8].ready.path);
  const nextSettled = next.result.catch(() => null);
  await nextOpening;
  next.abort();
  for (const { req } of pending) req.abort();
  await Promise.all([nextSettled, ...pending.map(({ settled }) => settled)]);
});

test('registration limit releases after a desktop disconnects', async (t) => {
  const f = await fixture(t);
  const controls = [];
  for (let i = 1; i <= 64; i++)
    controls.push(await f.register(false, i.toString(16).padStart(32, '0')));
  const refused = await f.websocket('/_relay/control');
  const closed = once(refused, 'close');
  refused.send(
    JSON.stringify({
      type: 'relay.register',
      version: 2,
      token,
      deviceId,
      relayKey,
      hostname: 'relay.example',
    }),
  );
  assert.equal((await closed)[0], 1013);
  const released = once(controls[0].socket, 'close');
  controls[0].socket.close();
  await released;
  await f.register();
  assert.equal((await f.request().result).status, 200);
});

test('another desktop cannot attach a channel belonging to the first', async (t) => {
  const f = await fixture(t);
  const first = await f.register(false);
  const second = await f.register(false, 'c'.repeat(32));
  const opening = once(first.socket, 'message');
  const request = f.request();
  const channel = JSON.parse((await opening)[0].toString());
  const bad = await f.websocket('/_relay/data');
  const closed = once(bad, 'close');
  bad.send(
    JSON.stringify({
      type: 'relay.attach',
      connectionId: second.ready.connectionId,
      secret: second.ready.secret,
      channelId: channel.channelId,
    }),
  );
  assert.equal((await closed)[0], 4004);
  await f.attach(first.ready, channel.channelId);
  assert.equal((await request.result).status, 200);
});

test('cancelled browser upgrade immediately retires its unattached channel', async (t) => {
  const f = await fixture(t);
  const control = await f.register(false);
  const browser = new WebSocket(f.url.replace('http', 'ws') + path + '/api/control', {
    headers: { host: 'relay.example', origin },
  });
  browser.on('error', () => {});
  t.after(() => browser.terminate());
  const channel = JSON.parse((await once(control.socket, 'message'))[0].toString());
  const closed = new Promise<void>((resolve) => browser.once('close', () => resolve()));
  browser.terminate();
  await closed;
  await until(() => (f.relay as unknown as { pendingCount: number }).pendingCount === 0);
  const late = await f.websocket('/_relay/data');
  const lateClosed = once(late, 'close');
  late.send(
    JSON.stringify({
      type: 'relay.attach',
      connectionId: control.ready.connectionId,
      secret: control.ready.secret,
      channelId: channel.channelId,
    }),
  );
  assert.equal((await lateClosed)[0], 4004);
});

test('browser frames arriving after headers but before attachment are retained in order', async (t) => {
  const f = await fixture(t);
  const control = await f.register(false);
  const wss = new WebSocketServer({ noServer: true });
  const received = new Promise<string>((resolve) =>
    f.local.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (client) =>
        client.once('message', (raw) => resolve(raw.toString())),
      );
    }),
  );
  const raw = connect(Number(new URL(f.url).port), '127.0.0.1');
  raw.on('error', () => {});
  t.after(() => raw.destroy());
  await once(raw, 'connect');
  const opening = once(control.socket, 'message');
  raw.write(
    `GET ${path}/api/control HTTP/1.1\r\nHost: relay.example\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  );
  const channel = JSON.parse((await opening)[0].toString());
  const text = Buffer.from('between the handshake and attachment');
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.concat([
    Buffer.from([0x81, 0x80 | text.length]),
    mask,
    Buffer.from(text.map((value, index) => value ^ mask[index % 4])),
  ]);
  raw.write(frame.subarray(0, 8));
  await setImmediate();
  raw.write(frame.subarray(8));
  await f.attach(control.ready, channel.channelId);
  assert.equal(await received, text.toString());
});

test('early browser upgrade data has a bounded buffer and releases its pending channel on overflow', async (t) => {
  const f = await fixture(t);
  const control = await f.register(false);
  const raw = connect(Number(new URL(f.url).port), '127.0.0.1');
  raw.on('error', () => {});
  t.after(() => raw.destroy());
  await once(raw, 'connect');
  const opening = once(control.socket, 'message');
  raw.write(
    `GET ${path}/api/control HTTP/1.1\r\nHost: relay.example\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  );
  const channel = JSON.parse((await opening)[0].toString());
  const closed = new Promise<void>((resolve) => raw.once('close', () => resolve()));
  raw.write(Buffer.alloc(64 * 1024 + 1));
  await closed;
  const late = await f.websocket('/_relay/data');
  const lateClosed = once(late, 'close');
  late.send(
    JSON.stringify({
      type: 'relay.attach',
      connectionId: control.ready.connectionId,
      secret: control.ready.secret,
      channelId: channel.channelId,
    }),
  );
  assert.equal((await lateClosed)[0], 4004);
});

test('two unanswered relay heartbeat pings release the desktop on the following tick', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const control = new WebSocket(f.url.replace('http', 'ws') + '/_relay/control', {
    autoPong: false,
  });
  control.on('error', () => {});
  t.after(() => control.terminate());
  await once(control, 'open');
  const ready = once(control, 'message');
  control.send(
    JSON.stringify({
      type: 'relay.register',
      version: 2,
      token,
      deviceId,
      relayKey,
      hostname: 'relay.example',
    }),
  );
  await ready;
  const closed = once(control, 'close');
  t.mock.timers.tick(44_999);
  assert.equal(control.readyState, WebSocket.OPEN);
  t.mock.timers.tick(1);
  assert.equal((await closed)[0], 1006);
  t.mock.timers.reset();
  assert.equal((await f.request().result).status, 404);
  await f.register();
  assert.equal((await f.request().result).status, 200);
});

test('unauthenticated relay connections have a separate bounded allowance and release it on close', async (t) => {
  const f = await fixture(t);
  const pending = await Promise.all(Array.from({ length: 32 }, () => f.websocket('/_relay/data')));
  const refused = new WebSocket(f.url.replace('http', 'ws') + '/_relay/control');
  refused.on('error', () => {});
  t.after(() => refused.terminate());
  assert.match((await once(refused, 'error'))[0].message, /429/);
  const released = once(pending[0], 'close');
  pending[0].close();
  await released;
  const control = await f.register(false);
  assert.equal(control.ready.type, 'relay.ready');
});

test('HTTP forwarding preserves HEAD, no-body statuses, ranges and end-to-end headers', async (t) => {
  const f = await fixture(t, (request, response) => {
    assert.equal(request.headers['x-hop-request'], undefined);
    assert.equal(request.headers['x-end-to-end'], 'kept');
    const status =
      request.url === '/no-content'
        ? 204
        : request.url === '/not-modified'
          ? 304
          : request.url === '/range'
            ? 206
            : 200;
    response.writeHead(status, {
      Connection: 'close, X-Hop-Response',
      'X-Hop-Response': 'private',
      'X-CCDT-Relay-Address': 'private',
      'X-End-To-End': 'kept',
      ETag: '"revision-one"',
      ...(status === 204 ? {} : { 'Content-Length': status === 206 ? 2 : 4 }),
      ...(status === 206 ? { 'Content-Range': 'bytes 0-1/4' } : {}),
    });
    response.end(status === 206 ? 'bo' : 'body');
  });
  await f.register();
  for (const [endpoint, method, status, body] of [
    ['/head', 'HEAD', 200, ''],
    ['/no-content', 'GET', 204, ''],
    ['/not-modified', 'GET', 304, ''],
    ['/range', 'GET', 206, 'bo'],
  ] as const) {
    const result = await f.request(path + endpoint, {
      method,
      headers: {
        connection: 'close, X-Hop-Request',
        'x-hop-request': 'private',
        'x-end-to-end': 'kept',
      },
    }).result;
    assert.equal(result.status, status);
    assert.equal(result.body.toString(), body);
    assert.equal(result.headers['x-hop-response'], undefined);
    assert.equal(result.headers['x-ccdt-relay-address'], undefined);
    assert.equal(result.headers['x-end-to-end'], 'kept');
    assert.equal(result.headers.etag, '"revision-one"');
    if (status === 206) assert.equal(result.headers['content-range'], 'bytes 0-1/4');
    if (method === 'HEAD') assert.equal(result.headers['content-length'], '4');
  }
});

test('upstream protocol mismatch is rejected before exposing a browser upgrade', async (t) => {
  const f = await fixture(t);
  f.local.on('upgrade', (_request, socket) =>
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: other-protocol\r\n\r\nprivate bytes',
    ),
  );
  await f.register();
  const raw = connect(Number(new URL(f.url).port), '127.0.0.1');
  raw.on('error', () => {});
  t.after(() => raw.destroy());
  const chunks: Buffer[] = [];
  raw.on('data', (chunk) => chunks.push(chunk));
  const closed = new Promise<void>((resolve) => raw.once('close', () => resolve()));
  await once(raw, 'connect');
  raw.write(
    `GET ${path}/api/control HTTP/1.1\r\nHost: relay.example\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
  );
  await closed;
  assert.equal(Buffer.concat(chunks).length, 0);
});

test('browser cancellation after data attachment ends the unanswered upstream handshake', async (t) => {
  const f = await fixture(t);
  let remote: import('node:stream').Duplex | undefined;
  f.local.on('upgrade', (_request, socket) => {
    remote = socket;
    socket.resume();
  });
  await f.register();
  const browser = new WebSocket(f.url.replace('http', 'ws') + path + '/api/control', {
    headers: { host: 'relay.example', origin },
  });
  browser.on('error', () => {});
  t.after(() => browser.terminate());
  await until(() => !!remote);
  const closed = new Promise<void>((resolve) => browser.once('close', () => resolve()));
  browser.terminate();
  await closed;
  await until(() => !!remote?.readableEnded || !!remote?.destroyed);
  assert.equal((await f.request().result).status, 200);
});
type Counts = {
  signingInCount: number;
  pendingCount: number;
  channelCount: number;
  responseCount: number;
  signingIn: Map<string, number>;
  desktops: Map<string, unknown>;
  connections: Map<string, unknown>;
};
const counts = (relay: WebRelay) => relay as unknown as Counts;

test(
  'global 512 live channels and responses release on cancellation, desktop reconnect, and close',
  { timeout: 90_000 },
  async (t) => {
    const responses: ServerResponse[] = [];
    const f = await fixture(t, (_request, response) => {
      responses.push(response);
      response.writeHead(200);
      response.write('holding');
    });
    const state = counts(f.relay);
    const controls = [];
    for (let device = 1; device <= 9; device++)
      controls.push(await f.register(true, device.toString(16).padStart(32, '0')));
    const requests: { abort: () => void; settled: Promise<unknown> }[] = [];
    const add = async (control: Awaited<ReturnType<typeof f.register>>, amount: number) => {
      const previous = state.channelCount;
      for (let index = 0; index < amount; index++) {
        const request = f.request(control.ready.path);
        requests.push({ abort: request.abort, settled: request.result.catch(() => null) });
      }
      await until(() => state.channelCount === previous + amount);
    };
    for (let device = 0; device < 8; device++)
      for (let batch = 0; batch < 4; batch++) await add(controls[device], 16);
    await until(() => responses.length === 512);
    assert.deepEqual([state.channelCount, state.responseCount, state.pendingCount], [512, 512, 0]);
    assert.equal((await f.request(controls[8].ready.path).result).status, 503);
    requests[0].abort();
    await requests[0].settled;
    await until(() => state.channelCount === 511 && state.responseCount === 511);
    await add(controls[8], 1);
    await until(() => responses.length === 513);
    responses[1].end('finished');
    await requests[1].settled;
    await until(() => state.channelCount === 511 && state.responseCount === 511);
    await add(controls[8], 1);
    const old = controls[1];
    const disconnected = once(old.socket, 'close');
    old.socket.close();
    await disconnected;
    await until(() => state.channelCount === 448 && state.responseCount === 448);
    controls[1] = await f.register(true, '2'.padStart(32, '0'));
    assert.notEqual(controls[1].ready.connectionId, old.ready.connectionId);
    for (let batch = 0; batch < 4; batch++) await add(controls[1], 16);
    assert.deepEqual([state.channelCount, state.responseCount], [512, 512]);
    await Promise.all([f.relay.close(), f.relay.close()]);
    await Promise.all(requests.map(({ settled }) => settled));
    await until(
      () =>
        state.channelCount === 0 &&
        state.responseCount === 0 &&
        state.pendingCount === 0 &&
        state.signingInCount === 0,
    );
    assert.deepEqual(
      [state.desktops.size, state.connections.size, state.signingIn.size],
      [0, 0, 0],
    );
  },
);

test(
  'global 512 queued browser tails stay bounded after channels close and free on disconnect',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t, undefined, 0, Infinity);
    const state = counts(f.relay);
    const controls = [];
    for (let device = 1; device <= 9; device++)
      controls.push(await f.register(true, device.toString(16).padStart(32, '0')));
    const requests = [];
    for (let device = 0; device < 8; device++)
      for (let batch = 0; batch < 4; batch++) {
        for (let index = 0; index < 16; index++) {
          const request = f.request(controls[device].ready.path, {
            headers: { 'x-test-stall': 'yes' },
          });
          requests.push({ abort: request.abort, settled: request.result.catch(() => null) });
        }
        const expected = requests.length;
        await until(
          () =>
            f.stalled.filter(({ response }) => response?.writableEnded).length === expected &&
            state.channelCount === 0,
        );
      }
    assert.deepEqual([state.channelCount, state.responseCount, state.pendingCount], [0, 512, 0]);
    assert.equal((await f.request(controls[8].ready.path).result).status, 503);
    f.stalled[0].socket.destroy();
    await requests[0].settled;
    await until(() => state.responseCount === 511);
    assert.equal((await f.request(controls[8].ready.path).result).status, 200);
    const disconnected = once(controls[1].socket, 'close');
    controls[1].socket.close();
    await disconnected;
    await until(() => state.responseCount === 447);
    await f.relay.close();
    await Promise.all(requests.map(({ settled }) => settled));
    await until(() => state.responseCount === 0 && state.channelCount === 0);
  },
);

test(
  'global 128 unauthenticated connections span source quotas and release on rejection, registration and close',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, undefined, 0, 0, (request) =>
      String(request.headers['x-test-source']),
    );
    const state = counts(f.relay);
    const pending: WebSocket[] = [];
    for (let source = 1; source <= 4; source++)
      pending.push(
        ...(await Promise.all(
          Array.from({ length: 32 }, () =>
            f.websocket('/_relay/control', { 'x-test-source': `192.0.2.${source}` }),
          ),
        )),
      );
    assert.equal(state.signingInCount, 128);
    assert.equal(state.signingIn.size, 4);
    const refused = new WebSocket(f.url.replace('http', 'ws') + '/_relay/control', {
      headers: { 'x-test-source': '192.0.2.5' },
    });
    refused.on('error', () => {});
    t.after(() => refused.terminate());
    assert.match((await once(refused, 'error'))[0].message, /429/);
    const closed = pending.slice(0, 32).map((socket) => {
      const result = once(socket, 'close');
      socket.close();
      return result;
    });
    await Promise.all(closed);
    await until(() => state.signingInCount === 96);
    assert.equal(state.signingIn.has('192.0.2.1'), false);
    pending.push(
      ...(await Promise.all(
        Array.from({ length: 32 }, () =>
          f.websocket('/_relay/control', { 'x-test-source': '192.0.2.5' }),
        ),
      )),
    );
    assert.equal(state.signingInCount, 128);
    const ready = once(pending[32], 'message');
    pending[32].send(
      JSON.stringify({
        type: 'relay.register',
        version: 2,
        token,
        deviceId,
        relayKey,
        hostname: 'relay.example',
      }),
    );
    await ready;
    assert.equal(state.signingInCount, 127);
    const raw = connect(Number(new URL(f.url).port), '127.0.0.1');
    raw.on('error', () => {});
    t.after(() => raw.destroy());
    const rawClosed = new Promise<void>((resolve) => raw.once('close', () => resolve()));
    raw.resume();
    await once(raw, 'connect');
    raw.write(
      'GET /_relay/control HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: invalid\r\nX-Test-Source: 192.0.2.6\r\n\r\n',
    );
    await rawClosed;
    await until(() => state.signingInCount === 127);
    assert.equal(state.signingInCount, 127);
    assert.equal(state.signingIn.has('192.0.2.6'), false);
    await f.relay.close();
    await until(() => state.signingInCount === 0);
    assert.equal(state.signingIn.size, 0);
  },
);

test(
  'backpressured data channel is not mistaken for a missed heartbeat',
  { timeout: 10_000 },
  async (t) => {
    const payload = Buffer.alloc(8 * 1024 * 1024, 9);
    const f = await fixture(t, (_request, response) => response.end(payload), 0, Infinity);
    await f.register();
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const request = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } });
    request.result.catch(() => {});
    const relay = f.relay as unknown as { data: { clients: Set<WebSocket> } };
    await until(() => [...relay.data.clients].some((socket) => socket.isPaused));
    const data = [...relay.data.clients][0];
    assert.equal(data.readyState, WebSocket.OPEN);
    t.mock.timers.tick(45_000);
    assert.equal(
      data.readyState,
      WebSocket.OPEN,
      'paused data must not be terminated just because pong is buffered behind its payload',
    );
    f.stalled[0].resume();
    assert.deepEqual((await request.result).body, payload);
    t.mock.timers.reset();
  },
);

test(
  'a permanently backpressured data channel closes after 120 seconds without progress',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(
      t,
      (_request, response) => response.end(Buffer.alloc(8 * 1024 * 1024)),
      0,
      Infinity,
    );
    await f.register();
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const request = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } });
    const failed = request.result.catch(() => null);
    const relay = f.relay as unknown as { data: { clients: Set<WebSocket> } };
    await until(() => [...relay.data.clients].some((socket) => socket.isPaused));
    const data = [...relay.data.clients][0];
    t.mock.timers.tick(119_999);
    assert.equal(data.readyState, WebSocket.OPEN);
    t.mock.timers.tick(1);
    assert.notEqual(data.readyState, WebSocket.OPEN);
    assert.equal(await failed, null);
    await until(() => counts(f.relay).channelCount === 0 && counts(f.relay).responseCount === 0);
    t.mock.timers.reset();
  },
);

test(
  'backpressure with actual chunk progress survives longer than the stall deadline',
  { timeout: 10_000 },
  async (t) => {
    const payload = Buffer.alloc(8 * 1024 * 1024, 13);
    const f = await fixture(t, (_request, response) => response.end(payload), 0, Infinity);
    await f.register();
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const request = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } });
    request.result.catch(() => {});
    const relay = f.relay as unknown as { data: { clients: Set<WebSocket> } };
    await until(() => [...relay.data.clients].some((socket) => socket.isPaused));
    const data = [...relay.data.clients][0];
    let bytes = 0;
    data.on('message', (raw) => {
      bytes += (raw as Buffer).length;
    });
    for (let round = 0; round < 3; round++) {
      t.mock.timers.tick(90_000);
      assert.equal(data.readyState, WebSocket.OPEN);
      const before = bytes;
      for (let step = 0; step < 8 && bytes === before; step++) {
        f.stalled[0].step();
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await until(() => bytes > before && data.isPaused);
    }
    f.stalled[0].resume();
    assert.deepEqual((await request.result).body, payload);
    t.mock.timers.reset();
  },
);
test(
  'abnormal data transport close releases a stalled browser while control remains connected',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(
      t,
      (_request, response) => response.end(Buffer.alloc(8 * 1024 * 1024)),
      0,
      Infinity,
    );
    const control = await f.register();
    const request = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } });
    request.result.catch(() => {});
    const relay = f.relay as unknown as { data: { clients: Set<WebSocket> } };
    await until(() => [...relay.data.clients].some((socket) => socket.isPaused));
    const data = [...relay.data.clients][0];
    data.terminate();
    await until(() => data.readyState === WebSocket.CLOSED);
    await until(() => f.stalled[0].response!.destroyed);
    assert.equal(control.socket.readyState, WebSocket.OPEN);
  },
);

test(
  'normal data transport EOF starts the browser drain deadline even before HTTP end is consumed',
  { timeout: 10_000 },
  async (t) => {
    let responded = false;
    const f = await fixture(
      t,
      (_request, response) => {
        responded = true;
        response.end(Buffer.alloc(96 * 1024));
      },
      0,
      Infinity,
    );
    await f.register();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const request = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } });
    request.result.catch(() => {});
    const relay = f.relay as unknown as { data: { clients: Set<WebSocket> } };
    await until(() => responded && relay.data.clients.size === 0);
    assert.equal(
      f.stalled[0].response!.writableEnded,
      false,
      'HTTP EOF is still behind the buffered response',
    );
    t.mock.timers.tick(29_999);
    assert.equal(f.stalled[0].response!.destroyed, false);
    t.mock.timers.tick(1);
    await until(() => f.stalled[0].response!.destroyed);
    t.mock.timers.reset();
  },
);

test(
  'normal transport EOF still delivers every buffered byte when the browser resumes before its deadline',
  { timeout: 10_000 },
  async (t) => {
    const payload = Buffer.alloc(96 * 1024, 21);
    let responded = false;
    const f = await fixture(
      t,
      (_request, response) => {
        responded = true;
        response.end(payload);
      },
      0,
      Infinity,
    );
    await f.register();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const request = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } });
    request.result.catch(() => {});
    const relay = f.relay as unknown as { data: { clients: Set<WebSocket> } };
    await until(() => responded && relay.data.clients.size === 0);
    assert.equal(f.stalled[0].response!.writableEnded, false);
    t.mock.timers.tick(29_999);
    f.stalled[0].resume();
    assert.deepEqual((await request.result).body, payload);
    const response = f.stalled[0].response!;
    assert.equal(response.writableFinished, true);
    const destroy = t.mock.method(response, 'destroy');
    t.mock.timers.tick(1);
    assert.equal(destroy.mock.callCount(), 0);
    t.mock.timers.reset();
  },
);

test(
  'a data peer that goes silent after backpressure resumes still expires at the normal heartbeat limit',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(
      t,
      (request, response) => {
        if (request.url === '/quick') response.end('okay');
        else response.write(Buffer.alloc(8 * 1024 * 1024, 3));
      },
      0,
      Infinity,
    );
    const control = await f.register();
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    const request = f.request(path + '/', { headers: { 'x-test-stall': 'yes' } });
    const failed = request.result.catch(() => null);
    const relay = f.relay as unknown as { data: { clients: Set<WebSocket> } };
    await until(() => [...relay.data.clients].some((socket) => socket.isPaused));
    const data = [...relay.data.clients][0];
    t.mock.timers.tick(45_000);
    assert.equal(data.readyState, WebSocket.OPEN);
    f.stalled[0].resume();
    await until(
      () =>
        !data.isPaused && data.bufferedAmount === 0 && f.stalled[0].response!.writableLength === 0,
    );
    t.mock.method(data, 'ping', () => {});
    t.mock.timers.tick(44_999);
    assert.equal(data.readyState, WebSocket.OPEN);
    t.mock.timers.tick(1);
    assert.notEqual(data.readyState, WebSocket.OPEN);
    assert.equal(await failed, null);
    await until(() => counts(f.relay).channelCount === 0 && counts(f.relay).responseCount === 0);
    t.mock.timers.reset();
    assert.equal(control.socket.readyState, WebSocket.OPEN);
    assert.equal((await f.request(path + '/quick').result).status, 200);
  },
);
