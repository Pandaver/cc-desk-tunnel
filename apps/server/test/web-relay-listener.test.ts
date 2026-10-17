import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { connect, createServer, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { createProxyServer } from '../src/server.ts';
import type { ServerOptions } from '../src/server.ts';
import { ClientReleases } from '../src/client-release.ts';

const token = 'relay-listener-test-service-token';
const deviceId = 'ab'.repeat(16);
const relayKey = 'cd'.repeat(32);
const remotePath = `/remote/${deviceId}/`;

async function fixture(t: TestContext, options: Partial<ServerOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-relay-listener-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    webRelay: { port: 0 },
    ...options,
  });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const url = await server.listen(0);
  async function connect(endpoint: string, base = url) {
    const socket = new WebSocket(base.replace('http', 'ws') + endpoint, {
      rejectUnauthorized: !options.tls,
    });
    socket.on('error', () => {});
    sockets.push(socket);
    await once(socket, 'open');
    return socket;
  }
  async function register(hostname = '127.0.0.1') {
    const socket = await connect('/_relay/control');
    const message = once(socket, 'message');
    socket.send(
      JSON.stringify({ type: 'relay.register', version: 2, token, deviceId, relayKey, hostname }),
    );
    const ready = JSON.parse((await message)[0].toString());
    assert.equal(ready.type, 'relay.ready');
    assert.equal(ready.version, 2);
    return { socket, ready };
  }
  async function denied(endpoint: string, base = url, status = 404) {
    const socket = new WebSocket(base.replace('http', 'ws') + endpoint, {
      rejectUnauthorized: !options.tls,
    });
    socket.on('error', () => {});
    sockets.push(socket);
    assert.match((await once(socket, 'error'))[0].message, new RegExp(String(status)));
  }
  return { server, url, connect, register, denied };
}

test('browser relay has its own listener while control and data remain on the original service', async (t) => {
  const f = await fixture(t);
  const relay = f.server.relayAddress!;
  assert.notEqual(new URL(relay).port, new URL(f.url).port);
  assert.equal((await fetch(f.url + '/health')).status, 200);
  for (const route of ['/health', '/client/installer', '/_relay/control', '/_relay/data', '/ws'])
    assert.equal((await fetch(relay + route)).status, 404);
  for (const endpoint of ['/ws', '/_relay/control', '/_relay/data'])
    await f.denied(endpoint, relay);
  assert.equal((await fetch(relay + remotePath)).status, 404);
  const intervals = t.mock.method(globalThis, 'setInterval');
  const control = await f.connect('/_relay/control');
  assert.equal(intervals.mock.callCount(), 0);
  const message = once(control, 'message');
  control.send(
    JSON.stringify({
      type: 'relay.register',
      version: 2,
      token,
      deviceId,
      relayKey,
      hostname: '127.0.0.1',
    }),
  );
  const ready = JSON.parse((await message)[0].toString());
  assert.equal(ready.origin, relay);
  assert.equal(ready.version, 2);
  assert.equal(intervals.mock.callCount(), 1);
  assert.equal((await fetch(f.url + remotePath)).status, 404);
  await f.denied(remotePath + 'api/control', f.url, 403);
  const pending = fetch(relay + remotePath);
  const opening = once(control, 'message');
  assert.equal(JSON.parse((await opening)[0].toString()).type, 'relay.open');
  control.close();
  assert.equal((await pending).status, 503);
});

test('advertised port comes from deployment and the browser entry survives desktop reconnection', async (t) => {
  const f = await fixture(t, { webRelay: { port: 0, publicPort: 18088 } });
  const first = await f.register('proxy.example');
  assert.equal(first.ready.origin, 'http://proxy.example:18088');
  assert.equal(first.ready.path, remotePath);
  const closed = once(first.socket, 'close');
  first.socket.close();
  await closed;
  const second = await f.register('proxy.example');
  assert.equal(second.ready.origin + second.ready.path, first.ready.origin + first.ready.path);
  assert.notEqual(second.ready.connectionId, first.ready.connectionId);
  assert.equal((await fetch(f.url + remotePath)).status, 404);
});

test('explicit reverse-proxy origin overrides protocol, hostname and public port without changing the listener', async (t) => {
  const f = await fixture(t, {
    reverseProxy: true,
    webRelay: { port: 0, publicPort: 18088, origin: 'https://browser.example:9443/' },
  });
  assert.match(f.server.relayAddress!, /^http:\/\/127\.0\.0\.1:/);
  assert.equal((await f.register('service.internal')).ready.origin, 'https://browser.example:9443');
});

async function reserve() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = (listener.address() as { port: number }).port;
  return {
    listener,
    port,
    close: () => new Promise<void>((resolve) => listener.close(() => resolve())),
  };
}

test('a relay port collision reports its port and closes the already-bound service and history store', async (t) => {
  const occupied = await reserve();
  t.after(occupied.close);
  const main = await reserve();
  await main.close();
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-relay-conflict-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    webRelay: { port: occupied.port },
  });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    server.listen(main.port),
    new RegExp(`Web relay.*:${occupied.port}.*EADDRINUSE`),
  );
  assert.equal(server.relayAddress, undefined);
  assert.throws(() => server.store.database.prepare('SELECT 1'), /not open|closed/i);
  assert.equal(occupied.listener.listening, true);
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(main.port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await server.close();
  await assert.rejects(server.listen(0), /closed/);
});

test('service bind failure and closing before startup clean up an enabled relay safely', async (t) => {
  const occupied = await reserve();
  t.after(occupied.close);
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-relay-main-conflict-'));
  const server = createProxyServer({ token, dataDir: directory, webRelay: { port: 0 } });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(server.listen(occupied.port), /Proxy service.*EADDRINUSE/);
  assert.equal(server.relayAddress, undefined);
  assert.throws(() => server.store.database.prepare('SELECT 1'), /not open|closed/i);
  const unused = createProxyServer({
    token,
    dataDir: join(directory, 'not-started'),
    webRelay: { port: 0 },
  });
  await unused.close();
  await unused.close();
});

test('closing during asynchronous startup prevents either listener from opening afterwards', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-relay-start-close-'));
  const server = createProxyServer({ token, dataDir: directory, webRelay: { port: 0 } });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let resume!: () => void;
  const refresh = new Promise<void>((resolve) => {
    resume = resolve;
  });
  t.mock.method(ClientReleases.prototype, 'refresh', () => refresh);
  const starting = assert.rejects(server.listen(0), /closed/);
  await server.close();
  resume();
  await starting;
  assert.equal(server.relayAddress, undefined);
  assert.throws(() => server.store.database.prepare('SELECT 1'), /not open|closed/i);
  await server.close();
});

test('closing while the main listener is binding settles startup and frees the port', async (t) => {
  const reserved = await reserve();
  await reserved.close();
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-relay-bind-close-'));
  const service = createProxyServer({ token, dataDir: directory, webRelay: { port: 0 } });
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const original = Server.prototype.listen;
  const bind = t.mock.method(
    Server.prototype,
    'listen',
    function (this: Server, ...args: Parameters<typeof original>) {
      const result = Reflect.apply(original, this, args);
      void service.close();
      return result;
    },
  );
  await assert.rejects(service.listen(reserved.port), /closed/);
  await service.close();
  bind.mock.restore();
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(reserved.port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.equal(service.relayAddress, undefined);
});

test('closing an active relay frees both listeners and terminates its registered desktop', async (t) => {
  const f = await fixture(t);
  const addresses = [f.url, f.server.relayAddress!];
  const { socket } = await f.register();
  const closed = once(socket, 'close');
  await f.server.close();
  await closed;
  assert.equal(f.server.relayAddress, undefined);
  for (const address of addresses) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(Number(new URL(address).port), '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
});

test(
  'relay shutdown closes clients stalled before completing HTTP headers',
  { timeout: 2000 },
  async (t) => {
    const f = await fixture(t);
    const socket = connect(Number(new URL(f.server.relayAddress!).port), '127.0.0.1');
    socket.on('error', () => {});
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.write('GET /remote/unfinished HTTP/1.1\r\nHost: relay.example');
    // Resetting an incomplete HTTP request may emit ECONNRESET before close on Windows.
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await f.server.close();
    await closed;
    assert.equal(socket.destroyed, true);
  },
);

test(
  'direct TLS reuses the service certificate on the dedicated browser listener',
  { skip: process.platform !== 'win32', timeout: 30_000 },
  async (t) => {
    const script = `$key = [Security.Cryptography.RSA]::Create(2048)
      $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, 'SHA256', [Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
      @{ cert = $certificate.ExportCertificatePem(); key = $key.ExportPkcs8PrivateKeyPem() } | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)(
      'pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );
    const pem = JSON.parse(stdout);
    const f = await fixture(t, { tls: { cert: Buffer.from(pem.cert), key: Buffer.from(pem.key) } });
    const ready = (await f.register()).ready;
    assert.equal(ready.origin, f.server.relayAddress);
    assert.match(ready.origin, /^https:/);
    async function inspect(url: string) {
      return new Promise<{ status: number; fingerprint: string }>((resolve, reject) => {
        const request = httpsGet(url, { rejectUnauthorized: false }, (response) => {
          const fingerprint = (response.socket as import('node:tls').TLSSocket).getPeerCertificate()
            .fingerprint256;
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode!, fingerprint }));
        });
        request.on('error', reject);
      });
    }
    const main = await inspect(f.url + '/health');
    const relay = await inspect(f.server.relayAddress + '/health');
    assert.equal(main.status, 200);
    assert.equal(relay.status, 404);
    assert.equal(relay.fingerprint, main.fingerprint);
    // A TCP client that never starts TLS is outside the HTTP connection tracker too.
    const pendingTls = connect(Number(new URL(f.server.relayAddress!).port), '127.0.0.1');
    pendingTls.on('error', () => {});
    t.after(() => pendingTls.destroy());
    await once(pendingTls, 'connect');
    const closed = new Promise<void>((resolve) => pendingTls.once('close', () => resolve()));
    await f.server.close();
    await closed;
    assert.equal(pendingTls.destroyed, true);
  },
);
