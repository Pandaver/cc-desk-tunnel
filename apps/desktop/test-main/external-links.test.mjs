import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { externalLink, webEntry, webOrigin } from '../electron/external-links.cjs';
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

test('service entries require matching canonical origin, path and URL, except for legacy origins', () => {
  const origin = 'https://service.example:8787';
  assert.equal(webEntry({ origin }), `${origin}/`);
  assert.equal(webEntry({ origin }, false), null);
  for (const path of ['', 'a', 'abcde', 'a-longer-path', 'a'.repeat(64)]) {
    const url = `${origin}/${path ? `${path}/` : ''}`;
    assert.equal(webEntry({ origin, path, url }), url);
    assert.equal(webEntry({ origin, path, url }, false), url);
  }
  for (const state of [
    null,
    {},
    { origin: `${origin}/` },
    { origin, path: '' },
    { origin, url: `${origin}/` },
    { origin, path: undefined },
    { origin, url: undefined },
    { origin, path: '', url: `${origin}/other/` },
    { origin, path: 'one', url: `${origin}/two/` },
    { origin, path: 'one', url: 'https://other.example:8787/one/' },
    ...[
      'one',
      'one/?',
      'one/#',
      'one/#pair=0123456789abcdef01234567',
      './one/',
      '%6fne/',
      'one/../one/',
      'one//',
    ].map((path) => ({ origin, path: 'one', url: `${origin}/${path}` })),
    ...[
      '/one',
      'one/',
      '.',
      '..',
      '%2e',
      '%252e',
      'one/two',
      'ONE',
      '-one',
      'one-',
      'a'.repeat(65),
      'ws',
      'health',
      'client',
      'assets',
    ].map((path) => ({ origin, path, url: `${origin}/${path}/` })),
    ...[
      'https://user:pass@service.example:8787/one/',
      'https://SERVICE.example:8787/one/',
      'https://service.example:8787/one/?next=other',
    ].map((url) => ({ origin, path: 'one', url })),
  ])
    assert.equal(webEntry(state), null, JSON.stringify(state));
});

test('browser links match the complete authenticated entry with only an optional pairing fragment', () => {
  const origin = 'https://service.example:8787';
  const code = '0123456789abcdef01234567';
  for (const entry of [`${origin}/`, `${origin}/a/`, `${origin}/abcde/`]) {
    for (const url of [entry, `${entry}#pair=${code}`]) {
      assert.equal(externalLink(url, entry), url);
      assert.throws(() => externalLink(url, null), /Unexpected link/);
      assert.throws(() => externalLink(url, `${origin}/different/`), /Unexpected link/);
    }
  }
  assert.equal(
    externalLink('http://127.0.0.1:8787/', 'http://127.0.0.1:8787/'),
    'http://127.0.0.1:8787/',
  );
  assert.equal(
    externalLink('http://[::1]:8787/one/', 'http://[::1]:8787/one/'),
    'http://[::1]:8787/one/',
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
    `${origin}/#pair=${code.toUpperCase()}`,
    `${origin}/./`,
    `${origin}/one/../`,
    `${origin}/%2e/`,
    `${origin}/%252e/`,
    `${origin}/%2f`,
    `${origin}/\\`,
    ` ${origin}/`,
    `${origin}/\n`,
  ])
    assert.throws(() => externalLink(url, `${origin}/`), /Unexpected link/);
  for (const url of [
    `${origin}/`,
    `${origin}/one`,
    `${origin}/one/child/`,
    `${origin}/one/../one/`,
    `${origin}/%6fne/`,
    `${origin}/one/?`,
    `${origin}/one/#`,
  ])
    assert.throws(() => externalLink(url, `${origin}/one/`), /Unexpected link/);
  for (const entry of [
    origin,
    `${origin}/one`,
    `${origin}/one/?`,
    `${origin}/one/#`,
    `${origin}/%6fne/`,
    `${origin}/../one/`,
    'http://service.example/one/',
  ])
    assert.throws(() => externalLink(entry, entry), /Unexpected link/);
});

test(
  'a TLS bridge authorizes the current authenticated entry and invalidates old links on state changes',
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
    assert.equal(bridge.webUrl(), null);
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
    const pathState = (path = 'abcde', origin = 'https://service.example') => ({
      ...state(origin),
      path,
      url: `${origin}/${path ? `${path}/` : ''}`,
    });
    const allowed = (url) => assert.equal(externalLink(url, bridge.webUrl()), url);
    const denied = (url) =>
      assert.throws(() => externalLink(url, bridge.webUrl()), /Unexpected link/);
    await exchange(state());
    assert.equal(bridge.webUrl(), null);
    denied('https://service.example/');
    const auth = once(remote, 'message');
    local.send(JSON.stringify({ type: 'auth', token: 'fixture-service-token' }));
    assert.equal(JSON.parse(String((await auth)[0])).type, 'auth');
    await exchange(ready(false));
    await exchange(state());
    assert.equal(bridge.webUrl(), null);
    await exchange({ ...ready(false), webControl: true });
    assert.equal(bridge.webUrl(), null);
    await exchange({
      type: 'web.changed',
      enabled: true,
      origin: 'https://service.example',
      grants: [],
    });
    assert.equal(bridge.webUrl(), 'https://service.example/');
    allowed('https://service.example/');
    await exchange({ type: 'web.changed', enabled: false, grants: [] });
    assert.equal(bridge.webUrl(), null);
    denied('https://service.example/');
    await exchange({ ...ready(true), webSettings: true });
    await exchange(pathState());
    assert.equal(bridge.webUrl(), 'https://service.example/abcde/');
    allowed('https://service.example/abcde/');
    allowed('https://service.example/abcde/#pair=0123456789abcdef01234567');
    denied('https://service.example/');
    denied('https://service.example/another/');
    denied('https://service.example/abcde/child/');
    for (const code of ['terminal_inactive', 'invalid_command']) {
      await exchange({ type: 'connection.error', code, message: 'non-fatal fixture' });
      allowed('https://service.example/abcde/');
    }
    const rendererMessage = once(remote, 'message');
    local.send(JSON.stringify(pathState('injected', 'https://renderer.example')));
    await rendererMessage;
    allowed('https://service.example/abcde/');
    denied('https://renderer.example/injected/');
    await exchange({ ...pathState('updated'), type: 'web.changed' });
    allowed('https://service.example/updated/');
    denied('https://service.example/abcde/');
    await exchange(pathState('', 'https://web.example:8787'));
    allowed('https://web.example:8787/');
    denied('https://service.example/updated/');
    for (const invalid of [
      state(),
      { ...pathState('one'), url: 'https://service.example/two/' },
      { ...pathState('one'), url: 'https://other.example/one/' },
      { ...state(), url: 'https://service.example/' },
      { ...state(), path: '' },
      { ...pathState('one'), url: 'https://service.example/one/../one/' },
      { ...pathState('one'), url: 'https://service.example/one/?redirect=other' },
      { ...pathState('one'), url: 'https://user:pass@service.example/one/' },
      { ...pathState('one'), url: 'https://service.example/%6fne/' },
    ]) {
      await exchange(pathState());
      await exchange(invalid);
      assert.equal(bridge.webUrl(), null);
      denied('https://service.example/');
      denied('https://service.example/abcde/');
    }
    await exchange(state('https://service.example/path'));
    assert.equal(bridge.webUrl(), null);
    await exchange(state());
    await exchange(state(undefined, false));
    assert.equal(bridge.webUrl(), null);
    for (const code of [
      'unauthorized',
      'version_mismatch',
      'tunnel_failed',
      'ssh_failed',
      'connection_lost',
      'client_failed',
    ]) {
      await exchange(ready(true));
      await exchange(pathState());
      await exchange({ type: 'connection.error', code, message: 'fixture' });
      assert.equal(bridge.webUrl(), null);
      denied('https://service.example/abcde/');
      await exchange(pathState());
      assert.equal(bridge.webUrl(), null);
    }
    await exchange(ready(true));
    await exchange(state('http://127.0.0.1:8787'));
    assert.equal(bridge.webUrl(), 'http://127.0.0.1:8787/');
    allowed('http://127.0.0.1:8787/');
    await exchange(ready(true));
    denied('http://127.0.0.1:8787/');
    await exchange(pathState());
    const closed = once(local, 'close');
    remote.close();
    await closed;
    assert.equal(bridge.webUrl(), null);
    denied('https://service.example/abcde/');
    const replacement = await openProxyBridge(config, {});
    bridges.push(replacement);
    assert.equal(replacement.webUrl(), null);
  },
);
