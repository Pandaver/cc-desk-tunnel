import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import type { RelayStatus } from './desktop.d.ts';
import { IconButton, Modal, Switch } from './ui.tsx';

const descriptions: Record<RelayStatus['state'], string> = {
  disabled: '使用本连接的代理服务。',
  connecting: '正在连接服务端…',
  online: '已连接，关闭桌面业务连接仍可访问。',
  offline: '连接已断开，正在重连…',
  error: '中继连接失败。',
};

export default function RelayControl({
  enabled,
  disabled,
  prepare,
  onBusyChange,
  registerCommit,
}: {
  enabled: boolean;
  disabled: boolean;
  prepare: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  registerCommit: (commit: (() => Promise<void> | undefined) | null) => void;
}) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [route, setRoute] = useState('');
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState('');
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const confirmingRefresh = useRef(false);
  const latest = useRef<RelayStatus | null>(null);
  const requested = useRef(false);
  const revision = useRef(0);
  const pending = useRef(0);
  const tasks = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const routeInput = useRef('');
  const routeRevision = useRef(0);
  const committedRoute = useRef(0);
  const pendingRoute = useRef<Promise<void> | undefined>(undefined);
  const commitRef = useRef<() => Promise<void> | undefined>(() => undefined);
  const adopt = (value: RelayStatus) => {
    latest.current = value;
    if (!mounted.current) return;
    setStatus(value);
    if (!pending.current) {
      requested.current = value.enabled;
      setChecked(value.enabled);
    }
    if (!pendingRoute.current && committedRoute.current === routeRevision.current) {
      routeInput.current = value.route ?? '';
      setRoute(routeInput.current);
    }
  };
  useEffect(() => {
    if (!window.desktop?.relayStatus) return;
    mounted.current = true;
    registerCommit(() => commitRef.current());
    const initial = revision.current;
    const unsubscribe = window.desktop.onRelayChanged?.((value) => {
      revision.current++;
      adopt(value);
    });
    void window.desktop.relayStatus().then(
      (value) => {
        if (initial === revision.current) adopt(value);
      },
      (reason: unknown) => {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : '中继状态读取失败。');
      },
    );
    return () => {
      mounted.current = false;
      registerCommit(null);
      onBusyChange(false);
      unsubscribe?.();
    };
  }, [onBusyChange, registerCommit]);
  if (!window.desktop?.configureRelay) return null;
  const enqueue = (operation: () => Promise<void>) => {
    pending.current++;
    setSaving(pending.current);
    onBusyChange(true);
    setError('');
    const result = tasks.current.then(async () => {
      if (mounted.current) setError('');
      await operation();
    });
    tasks.current = result.catch(() => {});
    void result
      .catch((reason: unknown) => {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : '中继设置保存失败，请重试。');
      })
      .finally(() => {
        pending.current--;
        if (mounted.current) {
          setSaving(pending.current);
          onBusyChange(pending.current > 0);
          if (!pending.current && latest.current) {
            requested.current = latest.current.enabled;
            setChecked(latest.current.enabled);
          }
        }
      });
    return result;
  };
  const commitRoute = () => {
    if (committedRoute.current === routeRevision.current) return pendingRoute.current;
    committedRoute.current = routeRevision.current;
    const currentRevision = routeRevision.current;
    const draft = routeInput.current;
    const operation = enqueue(async () => {
      try {
        if (draft && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.exec(draft)?.[0] !== draft)
          throw new Error('访问路径需为 1–64 个小写字母、数字或中横线，首尾使用字母或数字。');
        if (!window.desktop?.configureRelayRoute)
          throw new Error('当前客户端尚不支持修改访问路径，请更新客户端后重试。');
        const initial = revision.current;
        const value = await window.desktop.configureRelayRoute(draft);
        if (initial === revision.current) adopt(value);
        if (mounted.current && currentRevision === routeRevision.current) {
          routeInput.current = value.route ?? '';
          setRoute(routeInput.current);
        }
      } catch (reason) {
        if (mounted.current && currentRevision === routeRevision.current) {
          routeInput.current = latest.current?.route ?? '';
          setRoute(routeInput.current);
        }
        throw reason;
      }
    });
    pendingRoute.current = operation;
    const clear = () => {
      if (pendingRoute.current === operation) pendingRoute.current = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  };
  commitRef.current = commitRoute;
  const closeRefresh = () => {
    if (pending.current || disabled) return;
    confirmingRefresh.current = false;
    setConfirmRefresh(false);
    setError('');
  };
  const refreshRoute = async () => {
    if (pending.current || disabled) return;
    routeRevision.current++;
    routeInput.current = crypto.randomUUID().replaceAll('-', '');
    try {
      await commitRoute();
      if (mounted.current) {
        confirmingRefresh.current = false;
        setConfirmRefresh(false);
      }
    } catch {
      // Keep the confirmation open with the save error and the last effective path.
    }
  };
  const prepareAction = () =>
    prepare().then(
      () => null,
      (reason: unknown) => reason,
    );
  const toggle = () => {
    if (!status) return;
    const next = !requested.current;
    requested.current = next;
    setChecked(next);
    const preparation = prepareAction();
    void enqueue(async () => {
      const failure = await preparation;
      // A failed draft must not prevent switching relay access off.
      if (next && failure) throw failure;
      const initial = revision.current;
      const value = await window.desktop!.configureRelay!(next);
      if (initial === revision.current) adopt(value);
    }).catch(() => {});
  };
  const access = (copy: boolean) => {
    const preparation = prepareAction();
    void enqueue(async () => {
      const failure = await preparation;
      if (failure) throw failure;
      if (copy) {
        const value = await window.desktop!.relayStatus!();
        if (value.state !== 'online' || !value.url)
          throw new Error('服务端访问尚未连接，请连接后重试。');
        await window.desktop!.copyText(value.url);
      } else {
        await window.desktop!.openRelay!();
      }
    }).catch(() => {});
  };
  const controlsDisabled = disabled || saving > 0 || !status;
  return (
    <>
      <div className="setting-row" aria-busy={saving > 0}>
        <span>
          <strong>通过服务端访问</strong>
          <small aria-live="polite">
            {!enabled ? '先启用 Web 工作台。' : descriptions[status?.state ?? 'disabled']}
          </small>
        </span>
        <Switch
          label="通过服务端访问"
          checked={checked}
          disabled={controlsDisabled || !enabled}
          onChange={toggle}
        />
      </div>
      {status && (
        <div className="setting-row relay-route-row">
          <label htmlFor="relay-route">
            服务端访问路径
            <small id="relay-route-help">移开焦点后保存。留空恢复默认路径。</small>
          </label>
          <span className="relay-route-input">
            <span aria-hidden="true">/remote/</span>
            <input
              id="relay-route"
              aria-label="服务端访问路径"
              aria-describedby="relay-route-help"
              type="text"
              value={route}
              maxLength={64}
              placeholder="自动生成"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={controlsDisabled}
              onChange={(event) => {
                routeRevision.current++;
                routeInput.current = event.target.value;
                setRoute(event.target.value);
                setError('');
              }}
              onBlur={() => {
                if (!confirmingRefresh.current) void commitRoute()?.catch(() => {});
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <IconButton
              title="重新生成访问路径"
              disabled={controlsDisabled}
              onClick={() => {
                confirmingRefresh.current = true;
                setError('');
                setConfirmRefresh(true);
              }}
            >
              <RefreshCw />
            </IconButton>
          </span>
        </div>
      )}
      {enabled && status?.state === 'online' && status.url && (
        <div className="setting-row relay-address-row">
          <span>
            <strong>服务端访问地址</strong>
          </span>
          <span className="remote-address">
            <IconButton
              title="复制服务端地址"
              disabled={controlsDisabled}
              onClick={() => access(true)}
            >
              <Copy />
            </IconButton>
            <IconButton
              title="打开服务端链接"
              disabled={controlsDisabled}
              onClick={() => access(false)}
            >
              <ExternalLink />
            </IconButton>
          </span>
        </div>
      )}
      {!confirmRefresh && (error || status?.error) && (
        <p className="remote-error" role="alert">
          {error || status?.error}
        </p>
      )}
      {confirmRefresh && (
        <Modal title="重新生成访问路径" onClose={closeRefresh}>
          <p className="delete-question">重新生成后，原服务端访问地址将失效。</p>
          <p className="muted">配对码保持不变，请使用新地址重新配对。</p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button className="button secondary" disabled={controlsDisabled} onClick={closeRefresh}>
              取消
            </button>
            <button
              className="button danger"
              aria-label="重新生成访问路径"
              disabled={controlsDisabled}
              onClick={() => void refreshRoute()}
            >
              {saving > 0 ? '正在生成…' : '重新生成访问路径'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
