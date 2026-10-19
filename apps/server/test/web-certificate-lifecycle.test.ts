import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { connect as connectTls } from 'node:tls';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage, WebState } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { WebCertificates } from '../src/web-certificate.ts';
import { custom, defaultCertificate, renewed } from './fixtures/web-certificates.ts';

const domain = 'web.example.test';
const fingerprint = (cert: string) => new X509Certificate(cert).fingerprint256;
type Response = Extract<ServerMessage, { type: 'response' }>;

class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(`${url.replace('https:', 'wss:')}/ws`, {
      rejectUnauthorized: false,
    });
    this.socket.on('message', (raw) =>
      this.messages.push(serverMessageSchema.parse(JSON.parse(String(raw)))),
    );
    this.socket.on('error', () => {});
  }

  async wait(predicate: (message: ServerMessage) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error('Connection closed');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for certificate lifecycle response');
  }

  async open(token: string) {
    await once(this.socket, 'open');
    this.socket.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: PROTOCOL_VERSION,
        token,
        deviceName: '证书测试',
      }),
    );
    this.socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
    await this.wait((message) => message.type === 'ready');
  }

  async request(command: object): Promise<Response> {
    const requestId = randomUUID();
    this.socket.send(JSON.stringify({ ...command, requestId }));
    return (await this.wait(
      (message) => message.type === 'response' && message.requestId === requestId,
    )) as Response;
  }

  async state(type = 'web.status', fields: object = {}): Promise<WebState> {
    const requestId = randomUUID();
    this.socket.send(JSON.stringify({ type, ...fields, requestId }));
    const response = (await this.wait(
      (message) => message.type === 'response' && message.requestId === requestId,
    )) as Response;
    assert.equal(response.ok, true, response.message);
    return (await this.wait(
      (message) => message.type === 'web.state' && message.requestId === requestId,
    )) as WebState;
  }
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-certificate-lifecycle-'));
  const assets = join(directory, 'assets');
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<!doctype html><div>Test Web</div>');
  const options = {
    token: randomUUID(),
    dataDir: directory,
    tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
    web: { origin: 'https://127.0.0.1', directory: assets },
  };
  let server = createProxyServer(options);
  let url = await server.listen(0);
  let stopped = false;
  const clients: Client[] = [];
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.close();
  };
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    certificateFile: join(directory, 'web-access', 'certificate.json'),
    stop,
    async client() {
      const client = new Client(url);
      clients.push(client);
      await client.open(options.token);
      return client;
    },
    async tls(servername = domain) {
      const socket = connectTls({
        host: '127.0.0.1',
        port: Number(new URL(url).port),
        servername,
        rejectUnauthorized: false,
      });
      await once(socket, 'secureConnect');
      const value = socket.getPeerCertificate().fingerprint256;
      socket.destroy();
      return value;
    },
    async restart(edit?: () => void) {
      await stop();
      edit?.();
      server = createProxyServer(options);
      stopped = false;
      url = await server.listen(0);
    },
  };
}

// Hold the async operation after the control handler captured its Web instance and domain, then
// let the real validator and commit guard run. No wall-clock race or production test hook is needed.
function pauseImports(t: TestContext) {
  const original = WebCertificates.prototype.set;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(
    WebCertificates.prototype,
    'set',
    async function (this: WebCertificates, ...args: Parameters<typeof original>) {
      entered();
      await gate;
      return original.apply(this, args);
    },
  );
  t.after(release);
  return { entered: started, release };
}

test('an upgrade after an older release changed the domain can restore its certificate while Web is off', async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const initial = await client.state('web.configure', { enabled: true, domain, path: 'entry' });
  await client.state('web.certificate.set', {
    revision: initial.certificate!.revision,
    domain,
    ...custom,
  });
  // Old releases know Web settings but not certificate storage. Their valid domain edit survives
  // the rollback; upgrading must keep the desktop control channel usable for explicit recovery.
  await f.restart(() => {
    writeFileSync(
      join(f.directory, 'web-access', 'settings.json'),
      JSON.stringify({ domain: '', path: 'entry' }),
    );
  });
  const upgraded = await f.client();
  const state = await upgraded.state();
  assert.equal(state.enabled, false);
  assert.equal(state.certificate?.mode, 'custom');
  assert.equal(state.certificate.details?.domain, domain);
  assert.equal(
    (await upgraded.request({ type: 'web.configure', enabled: true })).code,
    'web_certificate_domain',
  );
  const reset = await upgraded.state('web.certificate.reset', {
    revision: state.certificate.revision,
  });
  assert.equal(reset.enabled, false);
  assert.equal(reset.certificate?.mode, 'default');
  assert.equal(await f.tls(), fingerprint(defaultCertificate.cert));
  const enabled = await upgraded.state('web.configure', { enabled: true });
  assert.equal(enabled.domain, '');
  assert.equal(enabled.path, 'entry');
});

test('concurrent desktop imports commit one revision and a stale reset cannot replace the winner', async (t) => {
  const f = await fixture(t);
  const first = await f.client();
  const second = await f.client();
  const initial = await first.state('web.configure', { enabled: true, domain });
  const revision = initial.certificate!.revision;
  const results = await Promise.all([
    first.request({ type: 'web.certificate.set', revision, domain, ...custom }),
    second.request({ type: 'web.certificate.set', revision, domain, ...renewed }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok)?.code, 'web_certificate_conflict');
  const winner = await first.state();
  assert.equal(winner.certificate?.mode, 'custom');
  assert.equal(
    (await second.request({ type: 'web.certificate.reset', revision })).code,
    'web_certificate_conflict',
  );
  assert.equal(await f.tls(), winner.certificate.details?.fingerprint);
});

for (const change of ['disable', 'domain', 'disable-enable'] as const) {
  test(
    `an in-flight certificate import cannot commit after ${change}`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const first = await f.client();
      const second = await f.client();
      const initial = await first.state('web.configure', { enabled: true, domain, path: 'entry' });
      const gate = pauseImports(t);
      const importing = first.request({
        type: 'web.certificate.set',
        revision: initial.certificate!.revision,
        domain,
        ...custom,
      });
      try {
        await gate.entered;
        if (change === 'disable' || change === 'disable-enable') {
          await second.state('web.configure', { enabled: false });
          if (change === 'disable-enable') await second.state('web.configure', { enabled: true });
        } else {
          await second.state('web.configure', { enabled: true, domain: 'other.example.test' });
        }
      } finally {
        gate.release();
      }
      const result = await importing;
      assert.equal(result.ok, false);
      assert.equal(result.code, change === 'domain' ? 'web_certificate_domain' : 'web_disabled');
      const current = await second.state();
      assert.equal(current.certificate?.mode, 'default');
      assert.equal(current.certificate.revision, initial.certificate!.revision);
      assert.equal(existsSync(f.certificateFile), false);
      assert.equal(await f.tls(), fingerprint(defaultCertificate.cert));
    },
  );
}

test(
  'stopping the service prevents an in-flight certificate import from writing storage',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const client = await f.client();
    const initial = await client.state('web.configure', { enabled: true, domain });
    const gate = pauseImports(t);
    const importing = client
      .request({
        type: 'web.certificate.set',
        revision: initial.certificate!.revision,
        domain,
        ...custom,
      })
      .catch(() => undefined);
    let stopping: Promise<void> | undefined;
    try {
      await gate.entered;
      stopping = f.stop();
    } finally {
      gate.release();
    }
    await stopping;
    await importing;
    assert.equal(existsSync(f.certificateFile), false);
  },
);

test('a default reset during asynchronous validation cancels a pending import without persisting keys', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-certificate-reset-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = new WebCertificates(directory, { tls: true });
  const revision = manager.state().revision;
  const importing = manager.set(revision, { domain, ...custom });
  manager.reset(revision);
  await assert.rejects(importing, { code: 'web_certificate_conflict' });
  assert.equal(manager.state().mode, 'default');
  assert.equal(existsSync(join(directory, 'web-access', 'certificate.json')), false);
});

test('a pending replacement cannot restore a certificate after another desktop reset it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-certificate-replace-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = new WebCertificates(directory, { tls: true });
  await manager.set(manager.state().revision, { domain, ...custom });
  const revision = manager.state().revision;
  const importing = manager.set(revision, { domain, ...renewed });
  manager.reset(revision);
  await assert.rejects(importing, { code: 'web_certificate_conflict' });
  assert.equal(manager.state().mode, 'default');
  assert.equal(
    JSON.parse(readFileSync(join(directory, 'web-access', 'certificate.json'), 'utf8')).current,
    null,
  );
});
