import { useEffect, useId, useRef, useState } from 'react';
import { Activity, ChevronRight, CircleAlert, X } from 'lucide-react';
import { browserStorageKey } from './browser-path.ts';
import { LATENCY_ROUNDS, median, readLatencyResult, runLatencyTest } from './latency.ts';
import type { LatencyClient, LatencyMetric, LatencyResult } from './latency.ts';
import { IconButton } from './ui.tsx';

const labels: Record<LatencyMetric, string> = {
  full: '完整链路',
  workbench: '工作台',
  service: '服务连接',
};
const routes: Record<LatencyMetric, string> = {
  full: '浏览器经桌面客户端往返代理服务',
  workbench: '浏览器与桌面客户端之间',
  service: '桌面客户端与代理服务之间',
};
const format = (value: number) => (value < 1 ? '<1' : String(Math.round(value)));

export default function ConnectionDiagnostics({
  client,
  connectionId,
  connected,
  remote,
}: {
  client: LatencyClient;
  connectionId: string | null;
  connected: boolean;
  remote: boolean;
}) {
  const storageKey = browserStorageKey('proxy-latency-result');
  const [result, setResult] = useState<LatencyResult | null>(() => {
    try {
      return readLatencyResult(sessionStorage.getItem(storageKey), remote);
    } catch {
      return null;
    }
  });
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [notice, setNotice] = useState('');
  const run = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const keys: LatencyMetric[] = remote ? ['full', 'workbench', 'service'] : ['service'];
  const stale = result && (result.connectionId !== connectionId || !connected);

  const close = () => {
    run.current?.abort();
    setOpen(false);
  };
  useEffect(() => {
    run.current?.abort();
    return () => run.current?.abort();
  }, [client, connectionId, connected, remote]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        run.current?.abort();
        setOpen(false);
      }
    };
    const hidden = () => {
      if (document.hidden) {
        run.current?.abort();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [open]);

  const start = async () => {
    if (run.current || !connected || document.hidden) return;
    // The start button becomes disabled while sampling; keep Escape and Tab rooted in
    // this non-modal panel without stealing focus again when the result arrives.
    panel.current?.focus();
    const controller = new AbortController();
    run.current = controller;
    setNotice('');
    try {
      const next = await runLatencyTest({
        client,
        connectionId,
        remote,
        signal: controller.signal,
        onProgress: (completed, total) => setProgress({ completed, total }),
      });
      controller.signal.throwIfAborted();
      setResult(next);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage may be disabled or full; the current page still keeps its result.
      }
    } catch (error) {
      setNotice(
        controller.signal.aborted
          ? '测试已取消'
          : error instanceof Error
            ? error.message
            : '测试失败',
      );
    } finally {
      if (run.current === controller) {
        run.current = null;
        setProgress(null);
      }
    }
  };

  return (
    <div
      className="connection-diagnostics"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        title="连接诊断"
        aria-label="连接诊断"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        <Activity />
      </button>
      {open && (
        <div
          id={id}
          className="latency-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${id}-heading`}
          tabIndex={-1}
          ref={panel}
        >
          <div className="latency-heading">
            <h2 id={`${id}-heading`}>连接诊断</h2>
            <IconButton
              title="关闭连接诊断"
              onClick={() => {
                close();
                trigger.current?.focus();
              }}
            >
              <X />
            </IconButton>
          </div>
          <dl className="latency-results">
            {keys.map((key) => {
              const samples = result?.metrics[key];
              const middle = median(samples?.values ?? []);
              return (
                <div key={key} data-metric={key}>
                  <dt>{labels[key]}</dt>
                  <dd>
                    <output aria-label={`${labels[key]}延迟`}>
                      {middle !== null ? (
                        <>
                          {format(middle)} <small>ms</small>
                        </>
                      ) : samples ? (
                        samples.timeouts === LATENCY_ROUNDS ? (
                          '超时'
                        ) : (
                          '不可用'
                        )
                      ) : (
                        '—'
                      )}
                    </output>
                    {samples && (
                      <small>
                        {samples.values.length}/{samples.attempts} 次成功
                      </small>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          {result && (
            <>
              <p className="latency-timestamp">
                {stale ? '上次连接' : '最近测试'} ·{' '}
                <time dateTime={new Date(result.completedAt).toISOString()}>
                  {new Date(result.completedAt).toLocaleString([], {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </p>
              <details className="latency-details">
                <summary>
                  <ChevronRight className="fold-chevron" aria-hidden="true" />
                  采样详情
                </summary>
                {keys.map((key) => {
                  const samples = result.metrics[key]!;
                  const issues = [
                    samples.timeouts > 0 && `${samples.timeouts} 次超时`,
                    samples.failures > 0 && `${samples.failures} 次失败`,
                  ].filter(Boolean);
                  return (
                    <section
                      className="latency-detail"
                      key={key}
                      aria-labelledby={`${id}-${key}-heading`}
                    >
                      <h3 id={`${id}-${key}-heading`}>{labels[key]}</h3>
                      <p className="latency-route">{routes[key]}</p>
                      {samples.values.length ? (
                        <>
                          <dl className="latency-range">
                            <div>
                              <dt>最小</dt>
                              <dd>{format(Math.min(...samples.values))} ms</dd>
                            </div>
                            <div>
                              <dt>最大</dt>
                              <dd>{format(Math.max(...samples.values))} ms</dd>
                            </div>
                          </dl>
                          <div className="latency-samples">
                            <span id={`${id}-${key}-samples`}>成功采样 (ms)</span>
                            <ul aria-labelledby={`${id}-${key}-samples`}>
                              {samples.values.map((value, index) => (
                                <li key={index}>{format(value)}</li>
                              ))}
                            </ul>
                          </div>
                        </>
                      ) : (
                        <p className="latency-no-samples">没有成功的探测</p>
                      )}
                      {(issues.length > 0 || samples.error) && (
                        <div className="latency-issues">
                          <CircleAlert aria-hidden="true" />
                          <div>
                            {issues.length > 0 && <p>{issues.join(' · ')}</p>}
                            {samples.error && <p>{samples.error}</p>}
                          </div>
                        </div>
                      )}
                    </section>
                  );
                })}
              </details>
            </>
          )}
          <div className="latency-feedback" role="status" aria-live="polite">
            {progress
              ? `正在测试 ${progress.completed}/${progress.total}`
              : !connected
                ? '连接后可测试'
                : notice || (result ? '往返延迟中位数' : '尚未测试')}
          </div>
          <div className="latency-actions">
            {progress && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  run.current?.abort();
                  // This button disappears on completion; keep the keyboard in the panel.
                  panel.current?.focus();
                }}
              >
                取消测试
              </button>
            )}
            <button
              type="button"
              className="button primary"
              disabled={!connected || !!progress}
              onClick={() => void start()}
            >
              {progress ? '测试中…' : '测试延迟'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
