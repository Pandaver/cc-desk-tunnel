import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connectionProbeSchema, PROTOCOL_VERSION, serverMessageSchema } from '../src/index.ts';

test('connection diagnostics accepts only bounded UUID correlation frames', () => {
  const requestId = randomUUID();
  const probe = { type: 'connection.probe', requestId };
  const reply = { type: 'connection.probe.result', requestId };
  assert.deepEqual(connectionProbeSchema.parse(probe), probe);
  assert.deepEqual(serverMessageSchema.parse(reply), reply);
  for (const extra of [{ token: 'secret' }, { elapsed: 10 }, { sessionId: randomUUID() }]) {
    assert.equal(connectionProbeSchema.safeParse({ ...probe, ...extra }).success, false);
    assert.equal(serverMessageSchema.safeParse({ ...reply, ...extra }).success, false);
  }
  for (const invalid of ['', 'not-a-uuid', 'x'.repeat(10000), 1, null]) {
    assert.equal(connectionProbeSchema.safeParse({ ...probe, requestId: invalid }).success, false);
    assert.equal(serverMessageSchema.safeParse({ ...reply, requestId: invalid }).success, false);
  }
});

test('diagnostic capability is additive and absent on older ready frames', () => {
  const ready = {
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: randomUUID(),
    adapter: 'simulation',
    version: '0.3.5',
    sessions: [],
  };
  assert.ok(serverMessageSchema.safeParse(ready).success);
  assert.ok(serverMessageSchema.safeParse({ ...ready, diagnostics: true }).success);
  assert.equal(serverMessageSchema.safeParse({ ...ready, diagnostics: 'yes' }).success, false);
});
