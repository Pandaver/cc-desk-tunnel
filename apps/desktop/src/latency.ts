export type LatencyKind = 'workbench' | 'service';
export type LatencyProbe = { elapsed: number; service?: number };
export type LatencyClient = {
  measureLatency(kind: LatencyKind, signal: AbortSignal): Promise<LatencyProbe>;
};
export type LatencyMetric = 'full' | 'workbench' | 'service';
export type LatencySamples = {
  values: number[];
  attempts: number;
  timeouts: number;
  failures: number;
  error?: string;
};
export type LatencyResult = {
  version: 1;
  remote: boolean;
  connectionId: string | null;
  completedAt: number;
  metrics: Partial<Record<LatencyMetric, LatencySamples>>;
};
export const LATENCY_ROUNDS = 5;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Race cancellation as well as forwarding it: a transport disappearing during an await must
// not publish an incomplete measurement or leave the panel occupied by an old run.
function probe(client: LatencyClient, kind: LatencyKind, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<LatencyProbe>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('测试已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return client.measureLatency(kind, signal);
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function runLatencyTest({
  client,
  remote,
  connectionId,
  signal,
  onProgress,
}: {
  client: LatencyClient;
  remote: boolean;
  connectionId: string | null;
  signal: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}): Promise<LatencyResult> {
  const empty = (): LatencySamples => ({ values: [], attempts: 0, timeouts: 0, failures: 0 });
  const metrics: LatencyResult['metrics'] = remote
    ? { full: empty(), workbench: empty(), service: empty() }
    : { service: empty() };
  const kinds: LatencyKind[] = remote ? ['workbench', 'service'] : ['service'];
  const total = LATENCY_ROUNDS * kinds.length;
  let completed = 0;
  onProgress?.(completed, total);
  for (let round = 0; round < LATENCY_ROUNDS; round++) {
    for (const kind of kinds) {
      signal.throwIfAborted();
      const targets: LatencyMetric[] =
        kind === 'workbench' ? ['workbench'] : remote ? ['full', 'service'] : ['service'];
      for (const target of targets) metrics[target]!.attempts++;
      try {
        const result = await probe(client, kind, signal);
        signal.throwIfAborted();
        if (
          !validDuration(result.elapsed) ||
          (remote && kind === 'service' && !validDuration(result.service))
        ) {
          throw new Error('未收到有效的延迟结果');
        }
        if (kind === 'workbench') metrics.workbench!.values.push(result.elapsed);
        else {
          if (remote) metrics.full!.values.push(result.elapsed);
          metrics.service!.values.push(remote ? result.service! : result.elapsed);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        for (const target of targets) {
          const samples = metrics[target]!;
          const timedOut = error instanceof Error && error.name === 'TimeoutError';
          // A missing nested reply says nothing about whether the service actually answered.
          // Only an explicit service-side timeout can classify that leg as a timeout.
          const serviceUnknown =
            remote &&
            target === 'service' &&
            !(timedOut && 'serviceTimedOut' in error && error.serviceTimedOut === true);
          if (timedOut && !serviceUnknown) samples.timeouts++;
          else samples.failures++;
          const message = error instanceof Error ? error.message : '测试失败';
          samples.error = `${serviceUnknown ? '未获得服务连接结果：' : ''}${message}`.slice(
            0,
            1024,
          );
        }
      }
      onProgress?.(++completed, total);
    }
  }
  signal.throwIfAborted();
  return { version: 1, remote, connectionId, completedAt: Date.now(), metrics };
}

// Saved results are local to this page, never shared through the desktop workbench state.
export function readLatencyResult(raw: string | null, remote: boolean): LatencyResult | null {
  try {
    if (!raw || raw.length > 16384) return null;
    const value = JSON.parse(raw) as LatencyResult;
    if (
      !value ||
      value.version !== 1 ||
      value.remote !== remote ||
      (value.connectionId !== null && typeof value.connectionId !== 'string') ||
      !validDuration(value.completedAt) ||
      value.completedAt > 8640000000000000 ||
      !value.metrics ||
      typeof value.metrics !== 'object'
    )
      return null;
    const keys: LatencyMetric[] = remote ? ['full', 'workbench', 'service'] : ['service'];
    if (Object.keys(value.metrics).length !== keys.length) return null;
    for (const key of keys) {
      const item = value.metrics[key];
      if (
        !item ||
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
    }
    return value;
  } catch {
    return null;
  }
}
