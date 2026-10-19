import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  commandSchema,
  PROTOCOL_VERSION,
  serverMessageSchema,
  webAuthSchema,
  webDomainSchema,
  webPathSchema,
  webStateSchema,
} from '../src/index.ts';

test('optional browser capability preserves protocol 19 and rejects device credentials in browser authentication', () => {
  assert.equal(PROTOCOL_VERSION, 19);
  assert.ok(webAuthSchema.safeParse({ type: 'web.auth', protocolVersion: 19 }).success);
  for (const extra of [
    { token: 'a'.repeat(32) },
    { deviceName: 'desktop' },
    { tunnel: true },
    { device: randomUUID() },
  ])
    assert.equal(
      webAuthSchema.safeParse({ type: 'web.auth', protocolVersion: 19, ...extra }).success,
      false,
    );
  const ready = {
    type: 'ready',
    protocolVersion: 19,
    connectionId: randomUUID(),
    adapter: 'simulation',
    version: '0.3.5',
    sessions: [],
  };
  assert.ok(serverMessageSchema.safeParse(ready).success);
  assert.ok(serverMessageSchema.safeParse({ ...ready, web: true }).success);
});

test('browser address settings accept a hostname and an optional root path segment, not a URL', () => {
  assert.equal(webDomainSchema.parse(' Web.Example.COM '), 'web.example.com');
  for (const domain of ['', 'example.com', 'xn--fsqu00a.xn--0zwm56d'])
    assert.ok(webDomainSchema.safeParse(domain).success, domain);
  for (const domain of [
    'https://example.com',
    'example.com:8787',
    'example.com/path',
    'user@example.com',
    '127.0.0.1',
    '127.0.0x1',
    '0x7f.0.0.0x1',
    '[::1]',
    '123.456',
    'example.com.',
    'a..com',
    '-a.com',
    'a-.com',
    'a_b.com',
    `${'a'.repeat(64)}.com`,
    'example.com?x=1',
  ])
    assert.equal(webDomainSchema.safeParse(domain).success, false, domain);
  for (const path of ['', 'a', 'a-b', '1', 'a'.repeat(64)])
    assert.ok(webPathSchema.safeParse(path).success, path);
  for (const path of [
    '/',
    'web/nested',
    '..',
    '%2f',
    'CAPS',
    'a-',
    '-a',
    'a'.repeat(65),
    'ws',
    'health',
    'client',
    'assets',
  ])
    assert.equal(webPathSchema.safeParse(path).success, false, path);
  const base = { type: 'web.configure', requestId: randomUUID(), enabled: true };
  for (const change of [
    { domain: '' },
    { domain: 'example.com' },
    { path: '' },
    { path: 'workbench' },
    { regeneratePath: true },
  ])
    assert.ok(commandSchema.safeParse({ ...base, ...change }).success);
  assert.equal(
    commandSchema.safeParse({ ...base, path: 'workbench', regeneratePath: true }).success,
    false,
  );
  const state = {
    type: 'web.changed',
    enabled: true,
    origin: 'https://example.com:8787',
    domain: 'example.com',
    path: 'workbench',
    url: 'https://example.com:8787/workbench/',
    grants: [],
  };
  assert.deepEqual(serverMessageSchema.parse(state), state);
  const rootState = { ...state, path: '', url: 'https://example.com:8787/' };
  assert.deepEqual(serverMessageSchema.parse(rootState), rootState);
  assert.equal(commandSchema.safeParse({ ...base, path: '', regeneratePath: true }).success, false);
  const ready = serverMessageSchema.parse({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: randomUUID(),
    adapter: 'simulation',
    version: '0.3.5',
    sessions: [],
    webSettings: true,
  });
  assert.ok(ready.type === 'ready' && ready.webSettings);
});

test('browser grant management is additive with permanent grants and temporary pair deadlines', () => {
  const requestId = randomUUID();
  assert.ok(commandSchema.safeParse({ type: 'web.status', requestId }).success);
  assert.ok(commandSchema.safeParse({ type: 'web.pair', requestId }).success);
  assert.ok(
    commandSchema.safeParse({ type: 'web.revoke', requestId, grantId: randomUUID() }).success,
  );
  assert.equal(
    commandSchema.safeParse({ type: 'web.revoke', requestId, grantId: 'wrong' }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ type: 'web.pair', requestId, expiresAt: 'never' }).success,
    false,
  );
  const state = {
    type: 'web.state',
    requestId,
    enabled: true,
    origin: 'https://service.example',
    pairing: { code: 'a'.repeat(24), expiresAt: new Date().toISOString() },
    grants: [
      {
        id: randomUUID(),
        name: 'Chrome · Windows',
        createdAt: new Date().toISOString(),
        expiresAt: null,
      },
    ],
  };
  assert.ok(webStateSchema.safeParse(state).success);
  assert.ok(serverMessageSchema.safeParse(state).success);
  assert.equal(
    webStateSchema.safeParse({ ...state, pairing: { code: 'a', expiresAt: 'never' } }).success,
    false,
  );
});

test('explicit lifecycle and watched changes are additive protocol capabilities', () => {
  const requestId = randomUUID();
  for (const enabled of [true, false])
    assert.ok(commandSchema.safeParse({ type: 'web.configure', requestId, enabled }).success);
  assert.equal(commandSchema.safeParse({ type: 'web.configure', requestId }).success, false);
  assert.equal(
    commandSchema.safeParse({
      type: 'web.configure',
      requestId,
      enabled: true,
      origin: 'http://attacker.example',
    }).success,
    false,
  );
  for (const watch of [true, false])
    assert.ok(commandSchema.safeParse({ type: 'web.status', requestId, watch }).success);
  const state = {
    type: 'web.changed',
    enabled: true,
    origin: 'https://service.example',
    grants: [],
    pairing: { code: 'a'.repeat(24), expiresAt: new Date().toISOString(), remainingMs: 300_000 },
  };
  assert.ok(serverMessageSchema.safeParse(state).success);
  assert.equal(
    serverMessageSchema.safeParse({ ...state, pairing: { ...state.pairing, remainingMs: -1 } })
      .success,
    false,
  );
  assert.ok(
    serverMessageSchema.safeParse({ type: 'web.changed', enabled: false, grants: [] }).success,
  );
});

test('idempotent pairing initialization is an optional advertised capability', () => {
  const requestId = randomUUID();
  for (const ifAbsent of [undefined, false, true])
    assert.ok(commandSchema.safeParse({ type: 'web.pair', requestId, ifAbsent }).success);
  assert.equal(
    commandSchema.safeParse({ type: 'web.pair', requestId, ifAbsent: 'true' }).success,
    false,
  );
  const ready = serverMessageSchema.parse({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: randomUUID(),
    adapter: 'simulation',
    version: '0.3.5',
    sessions: [],
    webControl: true,
    webPairing: true,
  });
  assert.ok(ready.type === 'ready' && ready.webPairing === true);
});

test('certificate management is additive, bounded and keeps public state separate from upload material', () => {
  const requestId = randomUUID();
  const command = {
    type: 'web.certificate.set',
    requestId,
    revision: randomUUID(),
    domain: 'web.example.test',
    cert: 'PEM',
    key: 'KEY',
  };
  assert.ok(commandSchema.safeParse(command).success);
  assert.equal(commandSchema.safeParse({ ...command, domain: '' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, cert: 'x'.repeat(65537) }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, key: 'x'.repeat(16385) }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, revision: '' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, arbitrary: true }).success, false);
  assert.ok(
    commandSchema.safeParse({
      type: 'web.certificate.reset',
      requestId,
      revision: command.revision,
    }).success,
  );
  const ready = serverMessageSchema.parse({
    type: 'ready',
    protocolVersion: 19,
    connectionId: randomUUID(),
    adapter: 'simulation',
    version: '0.3.5',
    sessions: [],
    webCertificates: true,
  });
  assert.ok(ready.type === 'ready' && ready.webCertificates);
  const state = webStateSchema.parse({
    type: 'web.state',
    requestId,
    enabled: false,
    grants: [],
    certificate: {
      mode: 'custom',
      revision: command.revision,
      details: {
        domain: command.domain,
        subject: 'CN=Test',
        issuer: 'CN=Test CA',
        validFrom: new Date().toISOString(),
        validTo: new Date().toISOString(),
        fingerprint: 'AA:BB',
      },
      cert: 'PRIVATE UPLOAD',
      key: 'PRIVATE KEY',
    },
  });
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE/);
});
