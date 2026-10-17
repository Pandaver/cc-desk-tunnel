import assert from 'node:assert/strict';
import { test } from 'node:test';
import { median, readLatencyResult, runLatencyTest } from '../src/latency.ts';

const options = (client, remote = false) => ({
  client,
  remote,
  connectionId: 'connection-one',
  signal: new AbortController().signal,
});

test('latency median keeps input order and handles empty, odd, even and zero values', () => {
  const values = [30, 0, 5, 10, 500];
  assert.equal(median(values), 10);
  assert.deepEqual(values, [30, 0, 5, 10, 500]);
  assert.equal(median([10, 0, 20, 30]), 15);
  assert.equal(median([]), null);
  assert.equal(median([0]), 0);
});

test('desktop measurements run five service probes in order without workbench traffic', async () => {
  const calls = [];
  const progress = [];
  const result = await runLatencyTest({
    ...options({
      async measureLatency(kind, signal) {
        calls.push(kind);
        assert.equal(signal.aborted, false);
        return { elapsed: calls.length * 10 };
      },
    }),
    onProgress: (...value) => progress.push(value),
  });
  assert.deepEqual(calls, Array(5).fill('service'));
  assert.deepEqual(result.metrics, {
    service: { values: [10, 20, 30, 40, 50], attempts: 5, timeouts: 0, failures: 0 },
  });
  assert.equal(result.connectionId, 'connection-one');
  assert.ok(result.completedAt > 0);
  assert.deepEqual(progress, [
    [0, 5],
    [1, 5],
    [2, 5],
    [3, 5],
    [4, 5],
    [5, 5],
  ]);
});

test('browser measures complete nested RTT directly rather than adding separate medians', async () => {
  let active = 0;
  const calls = [];
  const result = await runLatencyTest(
    options(
      {
        async measureLatency(kind) {
          assert.equal(++active, 1);
          calls.push(kind);
          await Promise.resolve();
          active--;
          return kind === 'workbench' ? { elapsed: 70 } : { elapsed: 123, service: 45 };
        },
      },
      true,
    ),
  );
  assert.deepEqual(calls, Array.from({ length: 5 }, () => ['workbench', 'service']).flat());
  assert.equal(median(result.metrics.full.values), 123);
  assert.equal(median(result.metrics.workbench.values), 70);
  assert.equal(median(result.metrics.service.values), 45);
  assert.equal(result.metrics.full.attempts, 5);
});

test('timeouts and unavailable transports are counted separately, never as zero latency', async () => {
  let calls = 0;
  const result = await runLatencyTest(
    options({
      async measureLatency() {
        calls++;
        if (calls <= 2) throw new DOMException('探测超时', 'TimeoutError');
        if (calls <= 4) throw new Error('当前连接不支持测试');
        return { elapsed: 18 };
      },
    }),
  );
  assert.deepEqual(result.metrics.service, {
    values: [18],
    attempts: 5,
    timeouts: 2,
    failures: 2,
    error: '当前连接不支持测试',
  });
  assert.equal(median(result.metrics.service.values), 18);
});

test('explicit service timeouts do not discard successful browser-to-workbench measurements', async () => {
  const result = await runLatencyTest(
    options(
      {
        async measureLatency(kind) {
          if (kind === 'service')
            throw Object.assign(new DOMException('服务未响应', 'TimeoutError'), {
              serviceTimedOut: true,
            });
          return { elapsed: 24 };
        },
      },
      true,
    ),
  );
  assert.deepEqual(result.metrics.workbench.values, Array(5).fill(24));
  assert.equal(result.metrics.full.timeouts, 5);
  assert.equal(result.metrics.service.timeouts, 5);
  assert.deepEqual(result.metrics.full.values, []);
  assert.deepEqual(result.metrics.service.values, []);
});

test('a missing nested response is not reported as a measured service timeout', async () => {
  const result = await runLatencyTest(
    options(
      {
        async measureLatency(kind) {
          if (kind === 'service') throw new DOMException('延迟测试超时', 'TimeoutError');
          return { elapsed: 24 };
        },
      },
      true,
    ),
  );
  assert.equal(result.metrics.full.timeouts, 5);
  assert.equal(result.metrics.full.failures, 0);
  assert.equal(result.metrics.service.timeouts, 0);
  assert.equal(result.metrics.service.failures, 5);
  assert.match(result.metrics.service.error, /^未获得服务连接结果/);
  assert.equal(median(result.metrics.service.values), null);
  assert.equal(result.metrics.workbench.values.length, 5);
});

test('unavailable service results remain bounded and distinct from successful full-path samples', async () => {
  const result = await runLatencyTest(
    options(
      {
        async measureLatency(kind) {
          if (kind === 'service') throw new Error('x'.repeat(3000));
          return { elapsed: 24 };
        },
      },
      true,
    ),
  );
  assert.equal(result.metrics.service.error.length, 1024);
  assert.equal(result.metrics.full.error.length, 1024);
  assert.match(result.metrics.service.error, /^未获得服务连接结果/);
  assert.deepEqual(readLatencyResult(JSON.stringify(result), true), result);
});

test('invalid durations and absent nested service timing are rejected', async () => {
  const values = [NaN, -1, Infinity, '4', undefined];
  let at = 0;
  const result = await runLatencyTest(
    options({
      async measureLatency() {
        return { elapsed: values[at++] };
      },
    }),
  );
  assert.equal(result.metrics.service.failures, 5);
  assert.deepEqual(result.metrics.service.values, []);
  const browser = await runLatencyTest(
    options(
      {
        async measureLatency() {
          return { elapsed: 10 };
        },
      },
      true,
    ),
  );
  assert.equal(browser.metrics.full.failures, 5);
  assert.equal(browser.metrics.service.failures, 5);
  assert.equal(browser.metrics.workbench.values.length, 5);
});

test('cancelled measurements stop immediately even if the transport never settles', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = runLatencyTest({
    ...options({
      async measureLatency() {
        calls++;
        return new Promise(() => {});
      },
    }),
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('already cancelled measurements send nothing and do not emit a final result', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    runLatencyTest({
      ...options({
        async measureLatency() {
          calls++;
          return { elapsed: 1 };
        },
      }),
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});

test('cancellation between probes and transport cancellation preserve the previous completed result', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    runLatencyTest({
      ...options({
        async measureLatency() {
          calls++;
          return { elapsed: 1 };
        },
      }),
      signal: controller.signal,
      onProgress(completed) {
        if (completed === 2) controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 2);
  await assert.rejects(
    runLatencyTest(
      options({
        async measureLatency() {
          throw new DOMException('连接已变化', 'AbortError');
        },
      }),
    ),
    { name: 'AbortError' },
  );
});

test('saved results require the current page type and a complete, bounded measurement shape', async () => {
  const result = await runLatencyTest(
    options({
      async measureLatency() {
        return { elapsed: 10 };
      },
    }),
  );
  const raw = JSON.stringify(result);
  assert.deepEqual(readLatencyResult(raw, false), result);
  assert.equal(readLatencyResult(raw, true), null);
  for (const input of [null, '', 'null', '{', '0', '[]', ' '.repeat(16385)]) {
    assert.equal(readLatencyResult(input, false), null);
  }
  for (const alter of [
    (value) => {
      value.version = 2;
    },
    (value) => {
      delete value.connectionId;
    },
    (value) => {
      value.completedAt = -1;
    },
    (value) => {
      value.completedAt = 8640000000000001;
    },
    (value) => {
      value.metrics.service.values[0] = -1;
    },
    (value) => {
      value.metrics.service.values[0] = null;
    },
    (value) => {
      value.metrics.service.attempts = 4;
    },
    (value) => {
      value.metrics.service.timeouts = 1;
    },
    (value) => {
      value.metrics.service.failures = -1;
    },
    (value) => {
      value.metrics.service.error = 'x'.repeat(1025);
    },
    (value) => {
      value.metrics.full = value.metrics.service;
    },
    (value) => {
      delete value.metrics.service;
    },
  ]) {
    const invalid = structuredClone(result);
    alter(invalid);
    assert.equal(readLatencyResult(JSON.stringify(invalid), false), null);
  }
});

test('browser results retain the exact per-connection metrics independently of later runs', async () => {
  const first = await runLatencyTest(
    options(
      {
        async measureLatency() {
          return { elapsed: 10, service: 4 };
        },
      },
      true,
    ),
  );
  const stored = JSON.stringify(first);
  await runLatencyTest(
    options(
      {
        async measureLatency() {
          return { elapsed: 100, service: 40 };
        },
      },
      true,
    ),
  );
  assert.deepEqual(readLatencyResult(stored, true), first);
  assert.equal(readLatencyResult(stored, true).connectionId, 'connection-one');
});
