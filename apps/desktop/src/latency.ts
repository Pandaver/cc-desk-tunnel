export type LatencyRoute = 'browser' | 'desktop-bridge' | 'desktop-direct';
export type LatencyClient = {
  measureLatency(signal: AbortSignal): Promise<{ elapsed: number }>;
};
export type LatencySamples = {
  values: number[];
  attempts: number;
  timeouts: number;
  failures: number;
  error?: string;
};
export type LatencyResult = {
  version: 2;
  route: LatencyRoute;
  connectionId: string | null;
  completedAt: number;
  samples: LatencySamples;
};
export const LATENCY_ROUNDS = 5;
export const LATENCY_TIMEOUT_MS = 5000;

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60000;
}

// The transport owns its normal deadline. This bound also releases a run if the
// transport disappears without settling, and forwards cancellation to its pending probe.
function probe(client: LatencyClient, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<{ elapsed: number }>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (error?: unknown, value?: { elapsed: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error !== undefined) {
        controller.abort(error);
        reject(error);
      } else resolve(value!);
    };
    const abort = () => finish(signal.reason ?? new DOMException('测试已取消', 'AbortError'));
    const timer = setTimeout(
      () => finish(new DOMException('延迟测试超时', 'TimeoutError')),
      LATENCY_TIMEOUT_MS,
    );
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return client.measureLatency(controller.signal);
      })
      .then(
        (value) => finish(undefined, value),
        (error) => finish(error ?? new Error('测试失败')),
      );
  });
}

export async function runLatencyTest({
  client,
  route,
  connectionId,
  signal,
  onProgress,
}: {
  client: LatencyClient;
  route: LatencyRoute;
  connectionId: string | null;
  signal: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}): Promise<LatencyResult> {
  const samples: LatencySamples = { values: [], attempts: 0, timeouts: 0, failures: 0 };
  signal.throwIfAborted();
  onProgress?.(0, LATENCY_ROUNDS);
  for (let round = 0; round < LATENCY_ROUNDS; round++) {
    signal.throwIfAborted();
    samples.attempts++;
    try {
      const value = await probe(client, signal);
      signal.throwIfAborted();
      if (!value || !validDuration(value.elapsed)) throw new Error('未收到有效的延迟结果');
      samples.values.push(value.elapsed);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof Error && error.name === 'TimeoutError') samples.timeouts++;
      else samples.failures++;
      samples.error = (error instanceof Error ? error.message : '测试失败').slice(0, 1024);
    }
    onProgress?.(round + 1, LATENCY_ROUNDS);
  }
  signal.throwIfAborted();
  return { version: 2, route, connectionId, completedAt: Date.now(), samples };
}

// A saved sample belongs to this browser identity or desktop connection, not a
// service credential. Re-pairing cannot inherit the previous browser's result.
export function latencyStorageKey(kind: 'browser' | 'desktop', identity: string) {
  return `proxy-latency-result:v2:${kind}:${encodeURIComponent(identity)}`;
}

function exactKeys(value: object, required: string[], optional: string[] = []) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

export function readLatencyResult(raw: string | null, route: LatencyRoute): LatencyResult | null {
  try {
    if (!raw || raw.length > 4096) return null;
    const value = JSON.parse(raw) as LatencyResult;
    if (
      !value ||
      typeof value !== 'object' ||
      !exactKeys(value, ['version', 'route', 'connectionId', 'completedAt', 'samples']) ||
      value.version !== 2 ||
      value.route !== route ||
      (value.connectionId !== null &&
        (typeof value.connectionId !== 'string' ||
          !value.connectionId.length ||
          value.connectionId.length > 128)) ||
      !Number.isSafeInteger(value.completedAt) ||
      value.completedAt <= 0 ||
      value.completedAt > 8640000000000000
    )
      return null;
    const item = value.samples;
    if (
      !item ||
      typeof item !== 'object' ||
      !exactKeys(item, ['values', 'attempts', 'timeouts', 'failures'], ['error']) ||
      !Array.isArray(item.values) ||
      item.attempts !== LATENCY_ROUNDS ||
      !item.values.every(validDuration) ||
      !Number.isInteger(item.timeouts) ||
      item.timeouts < 0 ||
      !Number.isInteger(item.failures) ||
      item.failures < 0 ||
      item.values.length + item.timeouts + item.failures !== item.attempts ||
      (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > 1024))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
