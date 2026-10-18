import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import {
  LATENCY_ROUNDS,
  LATENCY_TIMEOUT_MS,
  latencyStorageKey,
  median,
  readLatencyResult,
  runLatencyTest,
} from '../src/latency.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));
function run(measureLatency, options = {}) {
  return runLatencyTest({
    client: { measureLatency },
    route: 'browser',
    connectionId: 'connection',
    signal: new AbortController().signal,
    ...options,
  });
}

test('manual latency sampling keeps five actual service replies and reports a median', async () => {
  const values = [20, 2, 70, 4, 6];
  const progress = [];
  const controller = new AbortController();
  const result = await run(async () => ({ elapsed: values.shift() }), {
    signal: controller.signal,
    onProgress: (...item) => progress.push(item),
  });
  assert.equal(result.version, 2);
  assert.deepEqual(result.samples, {
    values: [20, 2, 70, 4, 6],
    attempts: 5,
    timeouts: 0,
    failures: 0,
  });
  assert.equal(median(result.samples.values), 6);
  assert.deepEqual(result.samples.values, [20, 2, 70, 4, 6]);
  assert.equal(median([4, 2]), 3);
  assert.equal(median([]), null);
  assert.deepEqual(
    progress,
    Array.from({ length: 6 }, (_, i) => [i, 5]),
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(readLatencyResult(JSON.stringify(result), 'browser'), result);
});

test('timeouts, transport failures and invalid measurements are counted separately', async () => {
  const responses = [
    new DOMException('timed out', 'TimeoutError'),
    new Error('offline'),
    { elapsed: Infinity },
    { elapsed: -1 },
    { elapsed: 12 },
  ];
  const result = await run(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  assert.deepEqual(result.samples, {
    values: [12],
    attempts: 5,
    timeouts: 1,
    failures: 3,
    error: '未收到有效的延迟结果',
  });
});

test('abort interrupts a never-settling transport, removes listeners and publishes no partial result', async () => {
  const controller = new AbortController();
  let calls = 0;
  let transportSignal;
  const pending = run(
    (signal) => {
      calls++;
      transportSignal = signal;
      return new Promise(() => {});
    },
    { signal: controller.signal },
  );
  await turn();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(transportSignal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('aborting before sampling sends nothing; transport AbortError stops the run', async () => {
  await assert.rejects(
    run(() => assert.fail('must not start'), { signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  let calls = 0;
  await assert.rejects(
    run(async () => {
      calls++;
      throw new DOMException('changed connection', 'AbortError');
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('a missing transport reply has a finite deadline and cancels its pending probe', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const pending = run((signal) => {
    signals.push(signal);
    return new Promise(() => {});
  });
  for (let round = 0; round < LATENCY_ROUNDS; round++) {
    await turn();
    t.mock.timers.tick(LATENCY_TIMEOUT_MS);
  }
  const result = await pending;
  assert.equal(result.samples.timeouts, 5);
  assert.equal(result.samples.failures, 0);
  assert.equal(result.samples.values.length, 0);
  assert.equal(signals.length, 5);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('cancelling between samples cannot store an apparently complete result', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    run(async () => ({ elapsed: ++calls }), {
      signal: controller.signal,
      onProgress: (completed) => {
        if (completed === 5) controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 5);
});

test('stored results reject old routes, old schema, malformed counts, excessive values and extra fields', async () => {
  const result = await run(async () => ({ elapsed: 1 }));
  const bad = [
    null,
    [],
    {},
    { ...result, version: 1 },
    { ...result, route: 'desktop-bridge' },
    { ...result, connectionId: '' },
    { ...result, connectionId: 1 },
    { ...result, connectionId: 'x'.repeat(129) },
    { ...result, completedAt: -1 },
    { ...result, completedAt: 8640000000000001 },
    { ...result, secret: 'ignored' },
    { ...result, samples: null },
    { ...result, samples: { ...result.samples, attempts: 4 } },
    { ...result, samples: { ...result.samples, timeouts: 1 } },
    { ...result, samples: { ...result.samples, failures: -1 } },
    { ...result, samples: { ...result.samples, error: 'x'.repeat(1025) } },
    { ...result, samples: { ...result.samples, extra: 1 } },
    { ...result, samples: { ...result.samples, values: [1, 2, 3, 4, 60001] } },
    { ...result, samples: { ...result.samples, values: [1, 2, 3, 4, null] } },
  ];
  for (const value of bad) assert.equal(readLatencyResult(JSON.stringify(value), 'browser'), null);
  assert.equal(readLatencyResult('{broken', 'browser'), null);
  assert.equal(readLatencyResult(' '.repeat(4097), 'browser'), null);
  assert.notEqual(latencyStorageKey('browser', 'one'), latencyStorageKey('browser', 'two'));
  assert.notEqual(latencyStorageKey('desktop', 'one'), latencyStorageKey('browser', 'one'));
  assert.equal(latencyStorageKey('desktop', 'a:b'), 'proxy-latency-result:v2:desktop:a%3Ab');
});
