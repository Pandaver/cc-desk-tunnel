import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  commandSchema,
  PROTOCOL_VERSION,
  serverMessageSchema,
  webAuthSchema,
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
