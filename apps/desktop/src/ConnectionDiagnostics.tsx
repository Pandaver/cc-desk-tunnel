import { useEffect, useId, useRef, useState } from 'react';
import { Activity, ChevronRight, CircleAlert, X } from 'lucide-react';
import { LATENCY_ROUNDS, median, readLatencyResult, runLatencyTest } from './latency.ts';
import type { LatencyClient, LatencyResult, LatencyRoute } from './latency.ts';
import { IconButton } from './ui.tsx';
import './connection-diagnostics.css';

const routes: Record<LatencyRoute, string> = {
  browser: '浏览器 ↔ 服务端',
  'desktop-bridge': '桌面 ↔ 本地桥 ↔ 服务端',
  'desktop-direct': '桌面 ↔ 服务端',
};
const format = (value: number) => (value < 1 ? '<1' : String(Math.round(value)));

export default function ConnectionDiagnostics({
  client,
  connectionId,
  connected,
  route,
  storageKey,
}: {
  client: LatencyClient;
  connectionId: string | null;
  connected: boolean;
  route: LatencyRoute;
  storageKey: string;
}) {
  const [result, setResult] = useState<LatencyResult | null>(() => {
    try {
      return readLatencyResult(sessionStorage.getItem(storageKey), route);
    } catch {
      return null;
    }
  });
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const run = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const id = useId();
  const samples = result?.samples;
  const middle = median(samples?.values ?? []);
  const stale = result && (result.connectionId !== connectionId || !connected);
  const issues = samples
    ? [
        samples.timeouts > 0 && `${samples.timeouts} 次超时`,
        samples.failures > 0 && `${samples.failures} 次失败`,
      ].filter(Boolean)
    : [];

  const close = () => {
    run.current?.abort();
    setOpen(false);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current?.abort();
    };
  }, []);
  useEffect(() => {
    run.current?.abort();
    return () => run.current?.abort();
  }, [client, connectionId, connected, route, storageKey]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const hidden = () => {
      if (document.hidden) close();
    };
    const blurred = () => close();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', blurred);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', blurred);
    };
  }, [open]);

  const start = async () => {
    if (run.current || !connected || document.hidden) return;
    panel.current?.focus();
    const controller = new AbortController();
    run.current = controller;
    setNotice('');
    try {
      const next = await runLatencyTest({
        client,
        connectionId,
        route,
        signal: controller.signal,
        onProgress: (completed) => {
          if (mounted.current && run.current === controller) setProgress(completed);
        },
      });
      controller.signal.throwIfAborted();
      if (!mounted.current || run.current !== controller) return;
      setResult(next);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage may be disabled or full; this page still keeps its result.
      }
    } catch (error) {
      if (mounted.current && run.current === controller)
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
        if (mounted.current) setProgress(null);
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
          <p className="latency-route">{routes[route]}</p>
          <dl className="latency-results">
            <div>
              <dt>服务往返</dt>
              <dd>
                <output aria-label="服务往返延迟">
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
          </dl>
          {result && samples && (
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
                <div className="latency-detail">
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
                        <span id={`${id}-samples`}>成功采样 (ms)</span>
                        <ul aria-labelledby={`${id}-samples`}>
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
                </div>
              </details>
            </>
          )}
          <div className="latency-feedback" role="status" aria-live="polite">
            {progress !== null
              ? `正在测试 ${progress}/${LATENCY_ROUNDS}`
              : !connected
                ? '连接后可测试'
                : notice ||
                  (result ? '往返延迟中位数' : '手动采样 5 次，不包含模型生成和工具执行耗时')}
          </div>
          <div className="latency-actions">
            {progress !== null && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  run.current?.abort();
                  panel.current?.focus();
                }}
              >
                取消测试
              </button>
            )}
            <button
              type="button"
              className="button primary"
              disabled={!connected || progress !== null}
              onClick={() => void start()}
            >
              {progress !== null ? '测试中…' : '测试延迟'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
