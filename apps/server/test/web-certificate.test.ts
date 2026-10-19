import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { connect as connectTls } from 'node:tls';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage, WebState } from '@cc-desk-tunnel/protocol';
import { WebCertificates } from '../src/web-certificate.ts';
import { createProxyServer } from '../src/server.ts';
import {
  ca,
  custom,
  clientOnly,
  anyEku,
  badKeyUsage,
  digitalSignature,
  future,
  defaultCertificate,
  expired,
  renewed,
  wrongDomain,
} from './fixtures/web-certificates.ts';
import {
  criticalExtension,
  outsideNameConstraints,
  pathLengthExceeded,
  validChain,
} from './fixtures/web-certificate-chains.ts';

const domain = 'web.example.test';
const token = 'certificate-test-' + randomUUID();
const material = { domain, ...custom };
const fingerprint = (cert: string) => new X509Certificate(cert).fingerprint256;
function directory(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'cc-web-cert-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('no custom certificate creates no storage; reverse proxy and plain HTTP cannot install', async (t) => {
  for (const transport of [{ tls: true }, { reverseProxy: true }, {}]) {
    const dir = directory(t);
    const manager = new WebCertificates(dir, transport);
    assert.equal(existsSync(join(dir, 'web-access')), false);
    assert.equal(manager.context(domain), undefined);
    if ('tls' in transport) {
      assert.equal(manager.state().mode, 'default');
      manager.reset(manager.state().revision);
      assert.equal(existsSync(join(dir, 'web-access')), false);
    } else {
      assert.equal(manager.state().revision, '');
      await assert.rejects(manager.set('', material), /TLS|反向代理/);
      assert.throws(() => manager.reset(''), /TLS|反向代理/);
    }
  }
});

test('atomic certificate store retains previous version, exposes public metadata only, and restores across restart', async (t) => {
  const dir = directory(t);
  const manager = new WebCertificates(dir, { tls: true });
  const initialRevision = manager.state().revision;
  await manager.set(initialRevision, material);
  const first = manager.state();
  assert.equal(first.mode, 'custom');
  assert.equal(first.details?.domain, domain);
  assert.equal(first.details?.fingerprint, fingerprint(custom.cert));
  assert.notEqual(first.revision, initialRevision);
  assert.doesNotMatch(JSON.stringify(first), /BEGIN|PRIVATE KEY/);
  assert.ok(manager.context(domain));
  assert.ok(manager.context(domain.toUpperCase()));
  assert.equal(manager.context('other.example.test'), undefined);
  assert.throws(() => manager.validateDomain(''), /恢复默认/);
  assert.throws(() => manager.validateDomain('other.example.test'), /恢复默认/);
  manager.validateDomain(domain);
  const file = join(dir, 'web-access', 'certificate.json');
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(persisted.current, material);
  assert.equal(persisted.previous, null);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'web-access')).mode & 0o777, 0o700);
  }
  await assert.rejects(manager.set(initialRevision, { domain, ...renewed }), /已发生变化/);
  assert.throws(() => manager.reset(initialRevision), /已发生变化/);
  await manager.set(first.revision, { domain, ...renewed });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).previous, material);
  const restarted = new WebCertificates(dir, { tls: true });
  await restarted.initialize();
  assert.deepEqual(restarted.state(), manager.state());
  assert.ok(restarted.context(domain));
  restarted.reset(restarted.state().revision);
  assert.equal(restarted.state().mode, 'default');
  assert.equal(restarted.context(domain), undefined);
  assert.equal(new WebCertificates(dir, { tls: true }).state().mode, 'default');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).previous, { domain, ...renewed });
});

test('certificate validation rejects malformed, encrypted, mismatched, expired and wrong-domain material without leaking input', async (t) => {
  const dir = directory(t);
  const manager = new WebCertificates(dir, { tls: true });
  const revision = manager.state().revision;
  const bad = [
    { ...material, cert: 'SECRET BAD CERT' },
    { ...material, key: 'SECRET BAD KEY' },
    { ...material, key: custom.key.replaceAll('PRIVATE KEY', 'ENCRYPTED PRIVATE KEY') },
    { ...material, key: defaultCertificate.key },
    { domain, ...expired },
    { domain, ...future },
    { domain, ...clientOnly },
    { domain, ...anyEku },
    { domain, ...badKeyUsage },
    { ...material, cert: '-----BEGIN CERTIFICATE-----\nMII=\n-----END CERTIFICATE-----' },
    { ...material, key: custom.key + custom.key },
    { domain, ...wrongDomain },
    { ...material, cert: ca + custom.cert },
    { ...material, cert: custom.cert + ca },
    { ...material, cert: custom.cert.replace(ca, defaultCertificate.cert) },
    { ...material, cert: 'x'.repeat(65537) },
    { ...material, key: 'x'.repeat(16385) },
    { ...material, cert: custom.cert + 'TRAILING SECRET' },
  ];
  for (const item of bad) {
    await assert.rejects(manager.set(revision, item), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /SECRET|BEGIN|PRIVATE KEY|TRAILING/);
      return true;
    });
    assert.equal(manager.state().mode, 'default');
    assert.equal(manager.state().revision, revision);
    assert.equal(existsSync(join(dir, 'web-access')), false);
  }
  await manager.set(revision, material);
  const installed = manager.state();
  const context = manager.context(domain);
  for (const item of bad) {
    await assert.rejects(manager.set(installed.revision, item));
    assert.deepEqual(manager.state(), installed);
    assert.equal(manager.context(domain), context);
  }
});

test('a digitalSignature KeyUsage certificate remains valid', async (t) => {
  const manager = new WebCertificates(directory(t), { tls: true });
  await manager.set(manager.state().revision, { domain, ...digitalSignature });
  assert.equal(manager.state().mode, 'custom');
});

test('wildcard coverage is limited to one DNS label and only the configured domain receives SNI', async (t) => {
  const manager = new WebCertificates(directory(t), { tls: true });
  await manager.set(manager.state().revision, { ...material, domain: 'one.wild.example.test' });
  assert.ok(manager.context('one.wild.example.test'));
  assert.equal(manager.context('two.wild.example.test'), undefined);
  await assert.rejects(
    manager.set(manager.state().revision, { ...material, domain: 'two.one.wild.example.test' }),
    /未覆盖/,
  );
});

test('failed atomic replacement preserves old context, revision and recovery copy', async (t) => {
  const dir = directory(t);
  const manager = new WebCertificates(dir, { tls: true });
  await manager.set(manager.state().revision, material);
  const previous = manager.state();
  const context = manager.context(domain);
  const file = join(dir, 'web-access', 'certificate.json');
  renameSync(file, `${file}.before`);
  mkdirSync(file);
  await assert.rejects(manager.set(previous.revision, { domain, ...renewed }), /原证书保持不变/);
  assert.throws(() => manager.reset(previous.revision), /原证书保持不变/);
  assert.deepEqual(manager.state(), previous);
  assert.equal(manager.context(domain), context);
  rmSync(file, { recursive: true });
  renameSync(`${file}.before`, file);
  const restored = new WebCertificates(dir, { tls: true });
  await restored.initialize();
  assert.deepEqual(restored.state(), previous);
});

test('bad extension storage fails closed to original TLS without preventing startup; reset recovers', async (t) => {
  for (const value of [
    '{SECRET',
    JSON.stringify({ revision: randomUUID(), current: { domain, ...expired }, previous: null }),
    'x'.repeat(1_000_000),
  ]) {
    const dir = directory(t);
    mkdirSync(join(dir, 'web-access'));
    writeFileSync(join(dir, 'web-access', 'certificate.json'), value);
    const manager = new WebCertificates(dir, { tls: true });
    await manager.initialize();
    assert.equal(manager.state().mode, 'unavailable');
    assert.notEqual(manager.state().revision, '');
    assert.equal(manager.context(domain), undefined);
    assert.doesNotMatch(JSON.stringify(manager.state()), /SECRET|BEGIN/);
    await assert.rejects(manager.set(manager.state().revision, material), /恢复默认/);
    manager.reset(manager.state().revision);
    assert.equal(manager.state().mode, 'default');
    await manager.set(manager.state().revision, material);
    const restored = new WebCertificates(dir, { tls: true });
    await restored.initialize();
    assert.equal(restored.state().mode, 'custom');
  }
});

test('full-chain TLS validation rejects path constraints and critical extensions on import and restart', async (t) => {
  for (const value of [pathLengthExceeded, outsideNameConstraints, criticalExtension]) {
    const dir = directory(t);
    const manager = new WebCertificates(dir, { tls: true });
    await manager.set(manager.state().revision, material);
    const original = manager.state();
    const context = manager.context(domain);
    const file = join(dir, 'web-access', 'certificate.json');
    const saved = readFileSync(file, 'utf8');
    await assert.rejects(
      manager.set(original.revision, { domain, cert: value.cert, key: value.key }),
      { code: 'web_certificate_invalid' },
    );
    assert.deepEqual(manager.state(), original);
    assert.equal(manager.context(domain), context);
    assert.equal(readFileSync(file, 'utf8'), saved);

    writeFileSync(
      file,
      JSON.stringify({
        revision: randomUUID(),
        current: { domain, cert: value.cert, key: value.key },
        previous: material,
      }),
    );
    const restored = new WebCertificates(dir, { tls: true });
    assert.equal(restored.context(domain), undefined, 'unvalidated storage is never served');
    const initialization = restored.initialize();
    assert.equal(restored.initialize(), initialization, 'startup validates once');
    await initialization;
    assert.equal(restored.state().mode, 'unavailable');
    assert.equal(restored.context(domain), undefined);
    restored.reset(restored.state().revision);
    await restored.set(restored.state().revision, material);
    assert.equal(restored.state().mode, 'custom');
  }
});

test('valid fullchains may omit their root; constraints on the final supplied CA still apply', async (t) => {
  for (const cert of [validChain.cert, validChain.cert.replace(validChain.ca, '')]) {
    const dir = directory(t);
    const manager = new WebCertificates(dir, { tls: true });
    await manager.set(manager.state().revision, { domain, cert, key: validChain.key });
    assert.equal(manager.state().mode, 'custom');
    const restored = new WebCertificates(dir, { tls: true });
    await restored.initialize();
    assert.deepEqual(restored.state(), manager.state());
  }
  const manager = new WebCertificates(directory(t), { tls: true });
  await assert.rejects(
    manager.set(manager.state().revision, {
      domain,
      cert: outsideNameConstraints.cert.replace(outsideNameConstraints.ca, ''),
      key: outsideNameConstraints.key,
    }),
    { code: 'web_certificate_invalid' },
  );
  await assert.rejects(
    manager.set(manager.state().revision, {
      domain,
      cert: validChain.cert.match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
      )![0],
      key: validChain.key,
    }),
    { code: 'web_certificate_invalid' },
    'a non-self-signed leaf is not silently promoted to a trusted anchor',
  );
});

test('failed reset during initialization preserves the saved certificate and lets startup validation finish', async (t) => {
  const dir = directory(t);
  const manager = new WebCertificates(dir, { tls: true });
  await manager.set(manager.state().revision, material);
  const restored = new WebCertificates(dir, { tls: true });
  const initialization = restored.initialize();
  const file = join(dir, 'web-access', 'certificate.json');
  renameSync(file, `${file}.before`);
  mkdirSync(file);
  assert.throws(() => restored.reset(restored.state().revision), /原证书保持不变/);
  await initialization;
  assert.deepEqual(restored.state(), manager.state());
  assert.ok(restored.context(domain));
  rmSync(file, { recursive: true });
  renameSync(`${file}.before`, file);
});

test('reset cancels startup validation and a pending upload even when already using default', async (t) => {
  const dir = directory(t);
  const manager = new WebCertificates(dir, { tls: true });
  const original = manager.state();
  const upload = manager.set(original.revision, material);
  manager.reset(original.revision);
  await assert.rejects(upload, { code: 'web_certificate_conflict' });
  assert.deepEqual(manager.state(), original);
  assert.equal(existsSync(join(dir, 'web-access')), false);

  await manager.set(original.revision, material);
  const restored = new WebCertificates(dir, { tls: true });
  const initialization = restored.initialize();
  restored.reset(restored.state().revision);
  await initialization;
  assert.equal(restored.state().mode, 'default');
  assert.equal(restored.context(domain), undefined);
  const restarted = new WebCertificates(dir, { tls: true });
  await restarted.initialize();
  assert.equal(restarted.state().mode, 'default');
});

test('concurrent imports do not overwrite the first committed certificate; caller guard runs before persistence', async (t) => {
  const dir = directory(t);
  const manager = new WebCertificates(dir, { tls: true });
  const revision = manager.state().revision;
  const results = await Promise.allSettled([
    manager.set(revision, material),
    manager.set(revision, { domain, ...renewed }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected');
  assert.ok(failure?.status === 'rejected');
  assert.equal(failure.reason.code, 'web_certificate_conflict');
  const installed = manager.state();
  const file = join(dir, 'web-access', 'certificate.json');
  const saved = readFileSync(file, 'utf8');
  let checked = false;
  await assert.rejects(
    manager.set(installed.revision, material, () => {
      checked = true;
      throw new Error('Caller configuration changed');
    }),
    /Caller configuration changed/,
  );
  assert.equal(checked, true);
  assert.deepEqual(manager.state(), installed);
  assert.equal(readFileSync(file, 'utf8'), saved);
});

test('unused certificate support creates no verification timer; stalled verification times out and releases its slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timer = t.mock.method(globalThis, 'setTimeout');
  const manager = new WebCertificates(directory(t), { tls: true });
  await manager.initialize();
  manager.reset(manager.state().revision);
  assert.equal(timer.mock.callCount(), 0);

  const originalPush = Duplex.prototype.push;
  const push = t.mock.method(
    Duplex.prototype,
    'push',
    function (this: Duplex, ...args: Parameters<typeof originalPush>) {
      // Keep only the verification transport from transferring bytes; no listening socket exists.
      return this.constructor === Duplex ? false : originalPush.apply(this, args);
    },
  );
  const revision = manager.state().revision;
  const uploading = manager.set(revision, material);
  await Promise.resolve();
  const rejected = assert.rejects(uploading, /验证超时/);
  t.mock.timers.tick(5000);
  await rejected;
  push.mock.restore();
  assert.equal(manager.state().mode, 'default');
  await manager.set(revision, material);
  assert.equal(manager.state().mode, 'custom');
});

test('verification concurrency is bounded and cancellation releases all in-memory transports', async (t) => {
  const manager = new WebCertificates(directory(t), { tls: true });
  await manager.initialize();
  const originalPush = Duplex.prototype.push;
  const push = t.mock.method(
    Duplex.prototype,
    'push',
    function (this: Duplex, ...args: Parameters<typeof originalPush>) {
      return this.constructor === Duplex ? false : originalPush.apply(this, args);
    },
  );
  const revision = manager.state().revision;
  const result = Promise.allSettled(
    Array.from({ length: 5 }, () => manager.set(revision, material)),
  );
  await Promise.resolve();
  manager.reset(revision);
  const outcomes = await result;
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 0);
  const codes = outcomes.map((value) => value.status === 'rejected' && value.reason.code);
  assert.equal(codes.filter((code) => code === 'web_certificate_busy').length, 1);
  assert.equal(codes.filter((code) => code === 'web_certificate_conflict').length, 4);
  push.mock.restore();
  await manager.set(revision, material);
  assert.equal(manager.state().mode, 'custom');
});

class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  constructor(url: string, cookie?: string) {
    this.socket = new WebSocket(url.replace('https:', 'wss:') + (cookie ? '/web/ws' : '/ws'), {
      rejectUnauthorized: false,
      ...(cookie ? { origin: `https://${domain}`, headers: { Host: domain, Cookie: cookie } } : {}),
    });
    this.socket.on('message', (raw) =>
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
    );
    this.socket.on('error', () => {});
  }
  async open(browser = false) {
    await once(this.socket, 'open');
    this.socket.send(
      JSON.stringify(
        browser
          ? { type: 'web.auth', protocolVersion: PROTOCOL_VERSION }
          : { type: 'auth', protocolVersion: PROTOCOL_VERSION, token, deviceName: '证书测试设备' },
      ),
    );
    if (!browser) this.socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
    return this.wait((m) => m.type === 'ready');
  }
  async wait(predicate: (message: ServerMessage) => boolean) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for certificate message');
  }
  async request(command: object) {
    const requestId = randomUUID();
    this.socket.send(JSON.stringify({ ...command, requestId }));
    const result = await this.wait((m) => m.type === 'response' && m.requestId === requestId);
    assert.equal(result.type, 'response');
    return result;
  }
  async state(type = 'web.status', fields: object = {}) {
    const requestId = randomUUID();
    this.socket.send(JSON.stringify({ type, requestId, ...fields }));
    return (await this.wait(
      (m) => m.type === 'web.state' && m.requestId === requestId,
    )) as WebState;
  }
}
async function fixture(t: TestContext, corrupt = false, reverseProxy = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-web-cert-server-'));
  const dist = join(dir, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div>Test web</div>');
  if (corrupt) {
    mkdirSync(join(dir, 'web-access'));
    writeFileSync(join(dir, 'web-access', 'certificate.json'), '{');
  }
  const options = {
    token,
    reverseProxy,
    dataDir: dir,
    web: { origin: `https://${domain}`, directory: dist },
    tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
  };
  let server = createProxyServer(options);
  let url = await server.listen(0);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    async client(cookie?: string) {
      const client = new Client(url, cookie);
      clients.push(client);
      const ready = await client.open(!!cookie);
      return { client, ready };
    },
    async tls(servername?: string, trusted = false) {
      const socket = connectTls({
        host: '127.0.0.1',
        port: Number(new URL(url).port),
        servername,
        ...(trusted ? { ca } : { rejectUnauthorized: false }),
      });
      await once(socket, 'secureConnect');
      const value = socket.getPeerCertificate().fingerprint256;
      socket.destroy();
      return value;
    },
    async http(path: string, body?: object) {
      return new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
        const req = request(
          url + path,
          {
            rejectUnauthorized: false,
            method: body ? 'POST' : 'GET',
            headers: {
              Host: domain,
              ...(body ? { Origin: `https://${domain}`, 'Content-Type': 'application/json' } : {}),
            },
          },
          (response) => {
            response.resume();
            response.once('end', () =>
              resolve({
                status: response.statusCode!,
                cookie: response.headers['set-cookie']?.[0]?.split(';')[0],
              }),
            );
          },
        );
        req.once('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    },
    async restart() {
      for (const client of clients) client.socket.terminate();
      await server.close();
      server = createProxyServer(options);
      url = await server.listen(0);
    },
  };
}

test(
  'real TLS SNI rotation leaves IP/default certificate and desktop connection intact, survives disabled Web and restart, resets',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const { client, ready } = await f.client();
    assert.ok(ready.type === 'ready' && ready.webCertificates);
    assert.equal((await client.state()).enabled, false);
    assert.equal(await f.tls(), fingerprint(defaultCertificate.cert));
    assert.equal(await f.tls(domain), fingerprint(defaultCertificate.cert));
    const enabled = await client.state('web.configure', { enabled: true, domain, path: '' });
    const revision = enabled.certificate!.revision;
    assert.equal(
      (await client.request({ type: 'web.certificate.set', revision, ...material })).ok,
      true,
    );
    const installed = await client.state();
    assert.equal(installed.certificate?.mode, 'custom');
    assert.equal(await f.tls(domain, true), fingerprint(custom.cert));
    assert.equal(await f.tls('other.example.test'), fingerprint(defaultCertificate.cert));
    assert.equal(await f.tls(), fingerprint(defaultCertificate.cert));
    assert.equal(
      (await client.request({ type: 'web.configure', enabled: true, domain: 'other.example.test' }))
        .code,
      'web_certificate_domain',
    );
    assert.equal(
      (await client.request({ type: 'web.configure', enabled: true, domain: '' })).code,
      'web_certificate_domain',
    );
    assert.equal((await client.state()).domain, domain);
    assert.equal(
      (await client.request({ type: 'web.certificate.set', revision, ...material })).code,
      'web_certificate_conflict',
    );
    assert.equal(
      (
        await client.request({
          type: 'web.certificate.set',
          revision: installed.certificate!.revision,
          ...material,
          domain: 'other.example.test',
        })
      ).code,
      'web_certificate_domain',
    );
    const rotated = await client.state('web.certificate.set', {
      revision: installed.certificate!.revision,
      domain,
      ...renewed,
    });
    assert.equal(await f.tls(domain, true), fingerprint(renewed.cert));
    assert.equal(client.socket.readyState, WebSocket.OPEN);
    assert.equal((await client.state('web.configure', { enabled: false })).enabled, false);
    assert.equal(await f.tls(domain, true), fingerprint(renewed.cert));
    assert.equal((await f.http('/')).status, 404);
    await f.restart();
    assert.equal(await f.tls(domain, true), fingerprint(renewed.cert));
    assert.equal(await f.tls(), fingerprint(defaultCertificate.cert));
    const restarted = (await f.client()).client;
    const state = await restarted.state();
    assert.equal(state.enabled, false);
    assert.equal(state.certificate?.revision, rotated.certificate?.revision);
    await restarted.state('web.certificate.reset', { revision: state.certificate!.revision });
    assert.equal(await f.tls(domain), fingerprint(defaultCertificate.cert));
    assert.equal((await restarted.state()).certificate?.mode, 'default');
    assert.equal(restarted.socket.readyState, WebSocket.OPEN);
  },
);

test(
  'real TLS browser cannot read, install or reset certificates; authenticated desktop receives changes without private material',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const client = (await f.client()).client;
    await client.state('web.status', { watch: true });
    const state = await client.state('web.configure', { enabled: true, domain, path: '' });
    const paired = await client.state('web.pair');
    const response = await f.http('/web/pair', { code: paired.pairing!.code });
    assert.equal(response.status, 200);
    assert.ok(response.cookie);
    const browser = (await f.client(response.cookie)).client;
    const revision = state.certificate!.revision;
    for (const command of [
      { type: 'web.status' },
      { type: 'web.certificate.set', revision, ...material },
      { type: 'web.certificate.reset', revision },
    ])
      assert.equal((await browser.request(command)).code, 'browser_unavailable');
    assert.equal(
      (await client.request({ type: 'web.certificate.set', revision, ...material })).ok,
      true,
    );
    const changed = await client.wait(
      (message) => message.type === 'web.changed' && message.certificate?.mode === 'custom',
    );
    assert.doesNotMatch(JSON.stringify(changed), /BEGIN|PRIVATE KEY/);
    assert.equal(browser.socket.readyState, WebSocket.OPEN);
    assert.equal(
      browser.messages.some((message) => message.type === 'web.changed'),
      false,
    );
  },
);

test('corrupt certificate storage does not prevent real TLS health or desktop login', async (t) => {
  const f = await fixture(t, true);
  assert.equal(await f.tls(domain), fingerprint(defaultCertificate.cert));
  assert.equal((await f.http('/health')).status, 200);
  const client = (await f.client()).client;
  const state = await client.state();
  assert.equal(state.certificate?.mode, 'unavailable');
  await client.state('web.certificate.reset', { revision: state.certificate!.revision });
  assert.equal((await client.state()).certificate?.mode, 'default');
});

test('reverse-proxy deployment exposes external mode and rejects certificate changes over the control protocol', async (t) => {
  const f = await fixture(t, false, true);
  const client = (await f.client()).client;
  const state = await client.state('web.configure', { enabled: true, domain, path: '' });
  assert.equal(state.certificate?.mode, 'external');
  for (const command of [
    { type: 'web.certificate.set', revision: 'unused', ...material },
    { type: 'web.certificate.reset', revision: 'unused' },
  ])
    assert.equal((await client.request(command)).code, 'web_certificate_unavailable');
  assert.equal(await f.tls(domain), fingerprint(defaultCertificate.cert));
  assert.equal(existsSync(join(f.dir, 'web-access', 'certificate.json')), false);
});
