import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createProxyServer } from '../../server/src/server.ts';
import { createWebAuthStore } from '../electron/web-auth.cjs';
import { startWebRelay } from '../electron/web-relay.mjs';
import { startWebServer } from '../electron/web-server.mjs';

const serviceToken = 'integration-only-service-token';
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Relay did not reach the expected state');
    await delay(5);
  }
}

// These are the production HTTP listener, relay server and desktop transport together. Only the
// workbench RPC/WS callbacks are supplied here; Electron rendering has its own end-to-end tests.
async function fixture(t, entrance) {
  const directory = await mkdtemp(join(tmpdir(), 'ccdt-relay-integration-'));
  const service = createProxyServer({
    token: serviceToken,
    dataDir: join(directory, 'service'),
    webRelay: { port: 0, ...(entrance ? { origin: entrance } : {}) },
  });
  const desktops = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const desktop of desktops) desktop.relay?.close();
    await Promise.all(desktops.map((desktop) => desktop.local?.close()));
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const controlUrl = await service.listen(0);
  const connectUrl = service.relayAddress;
  const origin = new URL(entrance ?? connectUrl);
  async function desktop(letter) {
    const id = letter.repeat(32);
    const dist = join(directory, letter);
    await mkdir(dist);
    await writeFile(join(dist, 'index.html'), `<!doctype html><title>${id}</title>`);
    const asset = Buffer.alloc(64 * 1024, letter.charCodeAt(0));
    await writeFile(join(dist, 'asset.png'), asset);
    const auth = createWebAuthStore();
    const instance = {
      id,
      auth,
      asset,
      calls: [],
      contexts: [],
      relay: undefined,
      local: undefined,
    };
    desktops.push(instance);
    instance.local = await startWebServer({
      distDirectory: dist,
      authStore: auth,
      // Deliberately use the same cookie name: the route and independent auth stores must still
      // keep workstations separate, even when a caller copies another workstation's cookie.
      cookieName: 'ccdt_integration',
      relayContext: (request) => {
        const context = instance.relay?.context(request);
        if (context) instance.contexts.push(context);
        return context;
      },
      getInfo: async () => ({ id }),
      invoke: async (method, args) => {
        instance.calls.push({ method, args });
        return { id, method, args };
      },
      onConnection: (socket) =>
        socket.on('message', (data, binary) => socket.send(data, { binary })),
    });
    instance.start = async () => {
      instance.relay = startWebRelay({
        config: { url: controlUrl.replace('http:', 'ws:') + '/ws', token: serviceToken },
        deviceId: id,
        port: instance.local.port,
        timing: { reconnectMin: 20, reconnectMax: 40 },
      });
      await until(() => instance.relay.status.state === 'online');
    };
    await instance.start();
    return instance;
  }
  async function request(desktop, path, { method = 'GET', body, cookie, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = httpRequest(
        `${connectUrl}/remote/${desktop.id}/${path}`,
        {
          method,
          agent: false,
          headers: {
            Host: origin.host,
            Origin: origin.origin,
            ...(cookie ? { Cookie: cookie } : {}),
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
            ...headers,
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  }
  async function pair(desktop) {
    const result = await request(desktop, 'api/login', {
      method: 'POST',
      body: { token: desktop.auth.token },
    });
    assert.equal(result.status, 200);
    const setCookie = result.headers['set-cookie'][0];
    assert.ok(setCookie.includes(`Path=/remote/${desktop.id}/;`));
    assert.ok(!setCookie.includes(serviceToken));
    return { cookie: setCookie.split(';')[0], setCookie };
  }
  async function websocket(desktop, cookie) {
    const socket = new WebSocket(
      `${connectUrl.replace('http:', 'ws:')}/remote/${desktop.id}/api/control`,
      {
        origin: origin.origin,
        headers: { Host: origin.host, Cookie: cookie },
      },
    );
    clients.push(socket);
    socket.on('error', () => {});
    await once(socket, 'open');
    return socket;
  }
  return { service, controlUrl, connectUrl, desktop, request, pair, websocket };
}

test(
  'real relay routes two workstations independently and streams simultaneous assets and large RPC bodies',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.desktop('a');
    const second = await f.desktop('b');
    const one = await f.pair(first);
    const two = await f.pair(second);
    for (const [desktop, cookie] of [
      [first, one.cookie],
      [second, two.cookie],
    ]) {
      const info = await f.request(desktop, 'api/info', { cookie });
      assert.equal(info.status, 200);
      assert.deepEqual(JSON.parse(info.body), { id: desktop.id });
    }
    assert.equal((await f.request(second, 'api/info', { cookie: one.cookie })).status, 401);
    assert.equal((await f.request(first, 'api/info', { cookie: two.cookie })).status, 401);
    const assets = await Promise.all(
      Array.from({ length: 12 }, () => f.request(first, 'asset.png', { cookie: one.cookie })),
    );
    for (const response of assets) {
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, first.asset);
    }
    const payload = '传输内容😀'.repeat(100_000);
    const rpc = await f.request(first, 'api/rpc', {
      method: 'POST',
      cookie: one.cookie,
      body: { method: 'files:upload', args: [payload] },
    });
    assert.equal(rpc.status, 200);
    assert.equal(JSON.parse(rpc.body).result.args[0], payload);
    assert.equal(first.calls.length, 1);
    assert.equal(second.calls.length, 0);
    for (const headers of [
      { Origin: 'https://other.example' },
      { Host: 'other.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ])
      assert.equal(
        (await f.request(first, 'api/info', { cookie: one.cookie, headers })).status,
        403,
      );
    const forged = await f.request(first, 'api/info', {
      cookie: one.cookie,
      headers: {
        'X-CCDT-Relay-Key': 'forged',
        'X-CCDT-Relay-Address': '198.51.100.12',
        'X-Forwarded-For': '198.51.100.12',
      },
    });
    assert.equal(forged.status, 200);
    assert.equal(first.contexts.at(-1).address, '127.0.0.1');
    assert.equal(first.contexts.at(-1).origin, f.connectUrl);
  },
);

test(
  'real relay revocation disconnects only the matching browser and re-registration keeps remaining grants',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const desktop = await f.desktop('c');
    const one = await f.pair(desktop);
    const two = await f.pair(desktop);
    const first = await f.websocket(desktop, one.cookie);
    const second = await f.websocket(desktop, two.cookie);
    const received = once(second, 'message');
    const binary = Buffer.from([0, 255, 1, 128]);
    second.send(binary);
    assert.deepEqual((await received)[0], binary);
    const firstClosed = once(first, 'close');
    desktop.auth.revoke(one.cookie.split('=')[1]);
    await firstClosed;
    assert.equal((await f.request(desktop, 'api/info', { cookie: one.cookie })).status, 401);
    assert.equal((await f.request(desktop, 'api/info', { cookie: two.cookie })).status, 200);
    const url = desktop.relay.status.url;
    const secondClosed = once(second, 'close');
    desktop.relay.close();
    await secondClosed;
    await desktop.start();
    assert.equal(desktop.relay.status.url, url);
    assert.equal((await f.request(desktop, 'api/info', { cookie: two.cookie })).status, 200);
    assert.equal((await f.request(desktop, 'api/info', { cookie: one.cookie })).status, 401);
    const loggedOut = await f.request(desktop, 'api/logout', {
      method: 'POST',
      cookie: two.cookie,
      body: {},
    });
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await f.request(desktop, 'api/info', { cookie: two.cookie })).status, 401);
  },
);

test(
  'real reverse-proxy-origin relay preserves HTTPS cookie and origin rules across internal HTTP',
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t, 'https://browser.example:9443');
    const desktop = await f.desktop('d');
    assert.equal(desktop.relay.status.url, `https://browser.example:9443/remote/${desktop.id}/`);
    const paired = await f.pair(desktop);
    assert.match(paired.setCookie, /^ccdt_integration_relay_https=/);
    assert.match(paired.setCookie, /; Secure$/);
    assert.equal((await f.request(desktop, 'api/info', { cookie: paired.cookie })).status, 200);
    const socket = await f.websocket(desktop, paired.cookie);
    const response = once(socket, 'message');
    socket.send('same workbench');
    assert.equal((await response)[0].toString(), 'same workbench');
    assert.equal(
      (
        await f.request(desktop, 'api/info', {
          cookie: paired.cookie,
          headers: { Origin: 'http://browser.example:9443' },
        })
      ).status,
      403,
    );
    desktop.auth.reset();
    assert.equal((await f.request(desktop, 'api/info', { cookie: paired.cookie })).status, 401);
  },
);
