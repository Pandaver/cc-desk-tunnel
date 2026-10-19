import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';

const token = 'diagnostic-test-' + randomUUID();
const origin = 'http://localhost';

class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  constructor(url: string, cookie?: string, prefix = '') {
    this.socket = new WebSocket(
      url.replace('http', 'ws') + (cookie ? `${prefix}/web/ws` : '/ws'),
      cookie ? { origin, headers: { Host: 'localhost', Cookie: cookie } } : {},
    );
    this.socket.on('message', (raw) =>
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
    );
    this.socket.on('error', () => {});
  }
  send(value: object) {
    this.socket.send(JSON.stringify(value));
  }
  async wait(predicate: (value: ServerMessage) => boolean) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await delay(5);
    }
    throw new Error('Timed out waiting for diagnostic response');
  }
  request(value: object) {
    const requestId = randomUUID();
    this.send({ ...value, requestId });
    return this.wait((message) => message.type === 'response' && message.requestId === requestId);
  }
  async probe() {
    const requestId = randomUUID();
    this.send({ type: 'connection.probe', requestId });
    return this.wait(
      (message) => message.type === 'connection.probe.result' && message.requestId === requestId,
    );
  }
}

async function fixture(t: TestContext, web = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-connection-probe-'));
  const dist = join(directory, 'web');
  if (web) {
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  }
  const server = createProxyServer({
    token,
    dataDir: directory,
    ...(web ? { web: { origin, directory: dist } } : {}),
  });
  const url = await server.listen(0);
  const clients: Client[] = [];
  let prefix = '';
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function connect(cookie?: string, authenticate = true) {
    const client = new Client(url, cookie, prefix);
    clients.push(client);
    await once(client.socket, 'open');
    if (!authenticate) return { client, ready: undefined };
    client.send(
      cookie
        ? { type: 'web.auth', protocolVersion: PROTOCOL_VERSION }
        : { type: 'auth', protocolVersion: PROTOCOL_VERSION, token, deviceName: '测试设备' },
    );
    if (!cookie) client.send({ type: 'device', id: randomUUID() });
    const ready = await client.wait((value) => value.type === 'ready');
    assert.ok(ready.type === 'ready' && ready.diagnostics);
    return { client, ready };
  }
  async function pair(client: Client) {
    const enabled = await client.request({ type: 'web.configure', enabled: true });
    assert.ok(enabled.type === 'response' && enabled.ok);
    const requestId = randomUUID();
    client.send({ type: 'web.pair', requestId });
    const state = await client.wait(
      (value) => value.type === 'web.state' && value.requestId === requestId,
    );
    assert.ok(state.type === 'web.state' && state.pairing);
    const code = state.pairing.code;
    prefix = `/${state.path}`;
    return new Promise<{ cookie: string; grantId: string }>((resolve, reject) => {
      const request = httpRequest(
        url + prefix + '/web/pair',
        {
          method: 'POST',
          headers: { Host: 'localhost', Origin: origin, 'Content-Type': 'application/json' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            if (response.statusCode !== 200) return reject(new Error('Pairing failed'));
            const value = JSON.parse(Buffer.concat(chunks).toString());
            resolve({
              cookie: response.headers['set-cookie']![0].split(';')[0],
              grantId: value.device.id,
            });
          });
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ code }));
    });
  }
  return { directory, server, connect, pair };
}

test('authenticated probes reuse the service connection without creating sessions or files', async (t) => {
  const f = await fixture(t);
  const { client, ready } = await f.connect();
  assert.ok(ready?.type === 'ready' && ready.web === undefined);
  const before = readdirSync(f.directory).sort();
  for (let index = 0; index < 5; index++)
    assert.equal((await client.probe()).type, 'connection.probe.result');
  assert.deepEqual(readdirSync(f.directory).sort(), before);
  const { ready: next } = await f.connect();
  assert.ok(next?.type === 'ready' && next.sessions.length === 0);
  assert.equal(client.socket.readyState, WebSocket.OPEN);
});

test('a diagnostic before authentication is refused rather than echoed', async (t) => {
  const f = await fixture(t);
  const { client } = await f.connect(undefined, false);
  const closed = once(client.socket, 'close');
  client.send({ type: 'connection.probe', requestId: randomUUID() });
  await closed;
  assert.ok(client.messages.some((value) => value.type === 'connection.error'));
  assert.equal(
    client.messages.some((value) => value.type === 'connection.probe.result'),
    false,
  );
});

test('malformed probes never echo caller fields or consume a business request', async (t) => {
  const f = await fixture(t);
  const { client } = await f.connect();
  for (const value of [
    { type: 'connection.probe', requestId: 'wrong' },
    { type: 'connection.probe', requestId: randomUUID(), token: 'private' },
  ]) {
    client.send(value);
    const result = await client.wait((message) => message.type === 'connection.error');
    assert.ok(result.type === 'connection.error' && result.code === 'invalid_command');
  }
  assert.equal(
    client.messages.some((value) => value.type === 'connection.probe.result'),
    false,
  );
  const status = await client.request({ type: 'web.status' });
  assert.ok(status.type === 'response' && status.ok);
  assert.equal((await client.probe()).type, 'connection.probe.result');
});

test('diagnostic replies are rate-limited without ending the connection or blocking business commands', async (t) => {
  const f = await fixture(t);
  const { client } = await f.connect();
  for (let index = 0; index < 20; index++)
    client.send({ type: 'connection.probe', requestId: randomUUID() });
  const status = await client.request({ type: 'web.status' });
  assert.ok(status.type === 'response' && status.ok);
  const replies = client.messages.filter((value) => value.type === 'connection.probe.result');
  assert.equal(replies.length, 10);
  assert.equal(new Set(replies.map((value) => value.requestId)).size, 10);
  assert.equal(client.socket.readyState, WebSocket.OPEN);
  await delay(1050);
  assert.equal((await client.probe()).type, 'connection.probe.result');
});

test('browser diagnostics require an active grant and never register an execution device', async (t) => {
  const f = await fixture(t, true);
  const { client: desktop } = await f.connect();
  const { cookie, grantId } = await f.pair(desktop);
  const { client: browser } = await f.connect(cookie);
  assert.equal((await browser.probe()).type, 'connection.probe.result');
  const devices = await browser.wait((value) => value.type === 'devices');
  assert.ok(devices.type === 'devices');
  assert.equal(
    devices.devices.some((device) => device.id === grantId),
    false,
  );
  const closed = once(browser.socket, 'close');
  const revoked = await desktop.request({ type: 'web.revoke', grantId });
  assert.ok(revoked.type === 'response' && revoked.ok);
  const [code] = await closed;
  assert.equal(code, 4001);
  assert.equal((await desktop.probe()).type, 'connection.probe.result');
});
