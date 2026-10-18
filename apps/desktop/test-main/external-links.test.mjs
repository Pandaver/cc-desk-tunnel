import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { externalLink, webOrigin } from '../electron/external-links.cjs';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';

test('official links retain their existing hosts, subdomains, paths and queries', () => {
  for (const url of [
    'https://claude.ai/login?returnTo=chat',
    'https://accounts.claude.com/signin#login',
    'https://console.anthropic.com/settings',
    'https://github.com/sun168567/cc-desk-tunnel/pull/70',
  ])
    assert.equal(externalLink(url), url);
  for (const url of [
    'http://claude.ai/',
    'https://claude.ai.evil.example/',
    'https://notclaude.ai/',
    'https://user.github.com/',
    'file:///C:/Windows/',
  ])
    assert.throws(() => externalLink(url), /Unexpected link/);
});

test('only exact HTTPS or loopback HTTP origins can authorize browser links', () => {
  for (const origin of [
    'https://service.example',
    'https://198.51.100.10:8787',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
    'http://[::1]:8787',
  ])
    assert.equal(webOrigin(origin), origin);
  for (const origin of [
    undefined,
    null,
    '',
    'not a URL',
    'https://service.example/',
    'https://service.example:443',
    'https://user:pass@service.example',
    'https://service.example/path',
    'https://service.example?query',
    'https://service.example#fragment',
    'http://service.example',
    'http://localhost.evil.example',
    'file://service.example',
  ])
    assert.equal(webOrigin(origin), null);
});

test('browser links stay at the authenticated origin root with only an optional pairing fragment', () => {
  const origin = 'https://service.example:8787';
  const code = '0123456789abcdef01234567';
  for (const url of [`${origin}/`, `${origin}/#pair=${code}`]) {
    assert.equal(externalLink(url, origin), url);
    assert.throws(() => externalLink(url, null), /Unexpected link/);
  }
  assert.equal(
    externalLink('http://127.0.0.1:8787/', 'http://127.0.0.1:8787'),
    'http://127.0.0.1:8787/',
  );
  for (const url of [
    'https://other.example:8787/',
    'https://service.example/',
    'http://service.example:8787/',
    'https://user:pass@service.example:8787/',
    `${origin}/other`,
    `${origin}/?redirect=https://evil.example`,
    `${origin}/?`,
    `${origin}/#`,
    `${origin}/#other=${code}`,
    `${origin}/#pair=short`,
    `${origin}/#pair=${code}&redirect=evil`,
    `${origin}/#pair=${code}00`,
  ])
    assert.throws(() => externalLink(url, origin), /Unexpected link/);
});

test(
  'a TLS bridge remembers only its ready service origin and clears it on disable, error and close',
  { skip: process.platform !== 'win32', timeout: 15000 },
  async (t) => {
    // A disposable certificate in memory, never installed in the system trust store.
    const script = `$key = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
      $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, 'SHA256')
      $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
      @{ cert = $certificate.ExportCertificatePem(); key = $key.ExportPkcs8PrivateKeyPem() } | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)(
      'pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );
    const tls = JSON.parse(stdout);
    const service = createServer(tls);
    const wss = new WebSocketServer({ server: service });
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    const bridges = [];
    t.after(async () => {
      for (const bridge of bridges) await bridge.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      service.closeAllConnections();
      await new Promise((resolve) => service.close(resolve));
    });
    const config = {
      url: `wss://127.0.0.1:${service.address().port}/ws`,
      fingerprint: new X509Certificate(tls.cert).fingerprint256,
    };
    const bridge = await openProxyBridge(config, {});
    bridges.push(bridge);
    assert.equal(bridge.webOrigin(), null);
    const connected = once(wss, 'connection');
    const local = new WebSocket(bridge.url);
    await once(local, 'open');
    const [remote] = await connected;
    const exchange = async (message) => {
      const delivered = once(local, 'message');
      remote.send(JSON.stringify(message));
      await delivered;
    };
    const state = (origin = 'https://service.example', enabled = true) => ({
      type: 'web.state',
      requestId: randomUUID(),
      origin,
      enabled,
      grants: [],
    });
    const ready = (web) => ({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      connectionId: randomUUID(),
      version: '0.3.4',
      adapter: 'simulation',
      sessions: [],
      web,
    });
    await exchange(state());
    assert.equal(bridge.webOrigin(), null);
    const auth = once(remote, 'message');
    local.send(JSON.stringify({ type: 'auth', token: 'fixture-service-token' }));
    assert.equal(JSON.parse(String((await auth)[0])).type, 'auth');
    await exchange(ready(false));
    await exchange(state());
    assert.equal(bridge.webOrigin(), null);
    await exchange({ ...ready(false), webControl: true });
    assert.equal(bridge.webOrigin(), null);
    await exchange({
      type: 'web.changed',
      enabled: true,
      origin: 'https://service.example',
      grants: [],
    });
    assert.equal(bridge.webOrigin(), 'https://service.example');
    await exchange({ type: 'web.changed', enabled: false, grants: [] });
    assert.equal(bridge.webOrigin(), null);
    await exchange(ready(true));
    await exchange(state());
    assert.equal(bridge.webOrigin(), 'https://service.example');
    for (const code of ['terminal_inactive', 'invalid_command']) {
      await exchange({ type: 'connection.error', code, message: 'non-fatal fixture' });
      assert.equal(bridge.webOrigin(), 'https://service.example');
    }
    const rendererMessage = once(remote, 'message');
    local.send(JSON.stringify(state('https://renderer.example')));
    await rendererMessage;
    assert.equal(bridge.webOrigin(), 'https://service.example');
    await exchange(state('https://service.example/path'));
    assert.equal(bridge.webOrigin(), null);
    await exchange(state());
    await exchange(state(undefined, false));
    assert.equal(bridge.webOrigin(), null);
    await exchange(state());
    await exchange({ type: 'connection.error', code: 'client_failed', message: 'fixture' });
    assert.equal(bridge.webOrigin(), null);
    await exchange(state());
    assert.equal(bridge.webOrigin(), null);
    await exchange(ready(true));
    await exchange(state('http://127.0.0.1:8787'));
    assert.equal(bridge.webOrigin(), 'http://127.0.0.1:8787');
    const closed = once(local, 'close');
    remote.close();
    await closed;
    assert.equal(bridge.webOrigin(), null);
    const replacement = await openProxyBridge(config, {});
    bridges.push(replacement);
    assert.equal(replacement.webOrigin(), null);
  },
);
