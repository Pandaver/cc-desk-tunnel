import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Copy, ExternalLink, Eye, EyeOff, RotateCcw } from 'lucide-react';
import type { RemoteStatus } from './desktop.d.ts';
import { remoteSettingsSession } from './remote-settings.ts';
import type { RemoteChange } from './remote-settings.ts';
import { IconButton, Modal, Switch } from './ui.tsx';
import RelayControl from './RelayControl.tsx';

const loadSettings = remoteSettingsSession({
  read: () => window.desktop!.remoteStatus!(),
  configure: (configuration) => window.desktop!.configureRemote!(configuration),
  reset: () => window.desktop!.resetRemotePairing!(),
});
const sessionTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export default function RemoteControl() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [port, setPort] = useState('5270');
  const [enabled, setEnabled] = useState(false);
  const [lan, setLan] = useState(false);
  const [saving, setSaving] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [startupRecovery, setStartupRecovery] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pairingVisible, setPairingVisible] = useState(false);
  const [relayBusy, setRelayBusy] = useState(false);
  const mounted = useRef(true);
  const commitRelay = useRef<(() => Promise<void> | undefined) | null>(null);
  const registerRelayCommit = useCallback((commit: (() => Promise<void> | undefined) | null) => {
    commitRelay.current = commit;
  }, []);
  const onRelayBusy = useCallback((busy: boolean) => {
    if (mounted.current) setRelayBusy(busy);
  }, []);
  const queue = useRef<Awaited<ReturnType<typeof loadSettings>>['queue'] | null>(null);
  const versions = useRef({ port: 0, enabled: 0, lan: 0 });
  const requested = useRef({ enabled: false, lan: false });
  const portInput = useRef('5270');
  const committedPort = useRef(0);
  const pendingPort = useRef<Promise<string> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    if (!window.desktop?.configureRemote) return;
    let active = true;
    const unsubscribe = window.desktop.onRemoteSessionsChanged?.((sessions) => {
      if (active) setStatus((current) => (current ? { ...current, sessions } : current));
    });
    void loadSettings()
      .then(({ queue: shared, status: value, error: failure }) => {
        if (!active) return;
        queue.current = shared;
        setError(failure);
        setStatus(value);
        setPort(String(value.port));
        portInput.current = String(value.port);
        setEnabled(value.enabled);
        setLan(value.lan);
        requested.current = { enabled: value.enabled, lan: value.lan };
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error ? reason.message : '远程控制设置读取失败，请重新打开设置。',
        );
      });
    return () => {
      active = false;
      mounted.current = false;
      unsubscribe?.();
    };
  }, []);
  if (!window.desktop?.configureRemote) return null;

  const settle = (value: RemoteStatus, revision: typeof versions.current) => {
    if (!mounted.current) return;
    setStatus(value);
    // A slow earlier response must not undo a later click or overwrite text still being edited.
    if (versions.current.port === revision.port) {
      setPort(String(value.port));
      portInput.current = String(value.port);
    }
    if (versions.current.enabled === revision.enabled) {
      setEnabled(value.enabled);
      requested.current.enabled = value.enabled;
    }
    if (versions.current.lan === revision.lan) {
      setLan(value.lan);
      requested.current.lan = value.lan;
    }
  };
  const save = (change: RemoteChange) => {
    if (!queue.current || resetting) return;
    const wasEnabled = status?.enabled === true;
    if (change.enabled !== undefined) {
      if (!change.enabled && mounted.current) setPairingVisible(false);
      versions.current.enabled++;
      requested.current.enabled = change.enabled;
      if (mounted.current) setEnabled(change.enabled);
    }
    if (change.lan !== undefined) {
      versions.current.lan++;
      requested.current.lan = change.lan;
      if (mounted.current) setLan(change.lan);
    }
    const revision = { ...versions.current };
    if (mounted.current) {
      setSaving((count) => count + 1);
      setError('');
    }
    return queue.current
      .save(change)
      .then(({ status: next, error: failure }) => {
        settle(next, revision);
        if (mounted.current) {
          setError(failure);
          if (next.enabled || (change.enabled === false && !failure)) setStartupRecovery(false);
          else if (failure && (change.enabled === true || wasEnabled)) setStartupRecovery(true);
        }
        return failure;
      })
      .finally(() => {
        if (mounted.current) setSaving((count) => count - 1);
      });
  };
  const commitPort = () => {
    if (committedPort.current === versions.current.port) return pendingPort.current;
    committedPort.current = versions.current.port;
    const operation = save({ port: Number(portInput.current) });
    pendingPort.current = operation;
    void operation?.finally(() => {
      if (pendingPort.current === operation) pendingPort.current = undefined;
    });
    return operation;
  };
  const commitDrafts = () => {
    // Enqueue both drafts synchronously, before the action following pointerdown is queued.
    const portOperation = commitPort();
    const routeOperation = commitRelay.current?.();
    return Promise.all([portOperation, routeOperation]).then(([failure]) => {
      if (failure) throw new Error(failure);
    });
  };
  const commitBeforeToggle = async (change?: RemoteChange) => {
    setSaving((count) => count + 1);
    try {
      // Settle both drafts first, but do not discard the separate switch intent if either fails.
      await commitDrafts().catch(() => {});
      if (change) await save(change);
    } finally {
      if (mounted.current) setSaving((count) => count - 1);
    }
  };
  const resetPairing = async () => {
    if (!queue.current || resetting) return;
    setResetting(true);
    setError('');
    const revision = { ...versions.current };
    try {
      const result = await queue.current.reset();
      settle(result.status, revision);
      if (!mounted.current) return;
      setError(result.error);
      if (!result.error) {
        setPairingVisible(false);
        setConfirmReset(false);
      }
    } finally {
      if (mounted.current) setResetting(false);
    }
  };
  const openWorkbench = async () => {
    if (!queue.current) return;
    try {
      await commitDrafts();
      const result = await queue.current.refresh();
      if (result.error) throw new Error(result.error);
      await window.desktop!.openRemote!();
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : '打开链接失败，请重试。');
    }
  };
  const copy = async (pairing = false) => {
    if (!queue.current) return;
    try {
      await commitDrafts();
      const result = await queue.current.refresh();
      if (result.error) throw new Error(result.error);
      const value = pairing ? result.status.token : result.status.url;
      if (value) await window.desktop!.copyText(value);
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : '复制失败，请重试。');
    }
  };
  const revokeBrowser = async (id: string) => {
    if (revoking || !window.desktop?.revokeRemoteSession) return;
    setRevoking(id);
    setError('');
    try {
      await commitDrafts();
      const next = await window.desktop.revokeRemoteSession(id);
      if (mounted.current)
        setStatus((current) => (current ? { ...current, sessions: next.sessions } : next));
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : '浏览器授权撤销失败，请重试。');
    } finally {
      if (mounted.current) setRevoking(null);
    }
  };
  const busy = saving > 0 || resetting || revoking !== null || relayBusy;
  const disabled = !status || busy;
  // Reveal settings only once the listener is running. A failed start keeps its port editable
  // through correction and saving, even after the error message has been cleared.
  const showSettings = status?.enabled === true;
  return (
    <>
      <h2 className="page-heading">远程控制</h2>
      <div
        className="card remote-control"
        aria-busy={busy}
        onPointerDown={(event) => {
          // A blur can change the card height before pointerup and move an action away from the
          // pointer. Commit both intentions on click instead; keyboard blur still saves normally.
          const button = (event.target as Element).closest('button');
          if (
            event.button === 0 &&
            (document.activeElement?.id === 'remote-port' ||
              document.activeElement?.id === 'relay-route') &&
            button
          )
            event.preventDefault();
        }}
      >
        <div className="setting-row">
          <span>
            <strong>启用 Web 工作台</strong>
            <small>每次启动桌面程序后默认关闭；网页关闭不会中断任务。连接设置会保留。</small>
          </span>
          <Switch
            label="启用 Web 工作台"
            checked={enabled}
            disabled={disabled}
            onChange={() => {
              void commitBeforeToggle({ enabled: !requested.current.enabled });
            }}
          />
        </div>
        {showSettings && (
          <div className="setting-row">
            <span>
              <strong>允许局域网访问</strong>
              <small>关闭时仅本机可连接；开启后浏览器仍需配对码。</small>
            </span>
            <Switch
              label="允许局域网访问"
              checked={lan}
              disabled={disabled}
              onChange={() => {
                void commitBeforeToggle({ lan: !requested.current.lan });
              }}
            />
          </div>
        )}
        {(showSettings || startupRecovery) && (
          <div className="setting-row">
            <label htmlFor="remote-port">
              本地监听端口
              <small id="remote-port-help">
                移开焦点后自动保存。端口改变后，请使用新地址访问。
              </small>
            </label>
            <input
              id="remote-port"
              aria-label="本地监听端口"
              aria-describedby="remote-port-help"
              className="setting-number"
              type="number"
              min="1024"
              max="65535"
              value={port}
              disabled={disabled}
              onChange={(event) => {
                versions.current.port++;
                portInput.current = event.target.value;
                setPort(event.target.value);
                setError('');
              }}
              onBlur={commitPort}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </div>
        )}
        {status?.enabled && (
          <>
            <div className="setting-row">
              <span>
                <strong>本机访问地址</strong>
                <small>
                  {status.lan
                    ? '其他设备请把 127.0.0.1 换成桌面客户端所在电脑的局域网 IP。'
                    : '在本机浏览器中访问。'}
                </small>
              </span>
              <span className="remote-address">
                <IconButton title="复制本机地址" disabled={disabled} onClick={() => void copy()}>
                  <Copy />
                </IconButton>
                <IconButton
                  title="打开链接"
                  disabled={disabled}
                  onClick={() => void openWorkbench()}
                >
                  <ExternalLink />
                </IconButton>
              </span>
            </div>
            <div className="setting-row remote-pairing-row">
              <span>
                <strong>配对码</strong>
              </span>
              <span className="setting-actions remote-pairing">
                <span className="remote-pairing-value">
                  <code className="remote-pairing-code" aria-label="Web 配对码">
                    {pairingVisible ? status.token : '•'.repeat(status.token?.length ?? 0)}
                  </code>
                  <IconButton
                    title={pairingVisible ? '隐藏配对码' : '显示配对码'}
                    onClick={() => setPairingVisible((visible) => !visible)}
                  >
                    {pairingVisible ? <EyeOff /> : <Eye />}
                  </IconButton>
                </span>
                <IconButton title="复制配对码" disabled={disabled} onClick={() => void copy(true)}>
                  <Copy />
                </IconButton>
                <IconButton
                  title="重置配对码"
                  disabled={disabled || !window.desktop?.resetRemotePairing}
                  onClick={() => {
                    void commitBeforeToggle();
                    setError('');
                    setConfirmReset(true);
                  }}
                >
                  <RotateCcw />
                </IconButton>
              </span>
            </div>
          </>
        )}
        {showSettings && (
          <RelayControl
            enabled={enabled}
            disabled={disabled}
            onBusyChange={onRelayBusy}
            registerCommit={registerRelayCommit}
            prepare={async () => {
              if (!queue.current) throw new Error('设置尚未读取完成，请稍后重试。');
              await commitDrafts();
              const result = await queue.current.refresh();
              if (result.error) throw new Error(result.error);
            }}
          />
        )}
        {showSettings && status && (
          <details className="remote-sessions">
            <summary className="setting-row">
              <span>
                <strong>已配对浏览器</strong>
              </span>
              <span className="remote-sessions-summary">
                <span className="setting-value">{status.sessions.length}</span>
                <ChevronRight aria-hidden="true" />
              </span>
            </summary>
            <div className="remote-sessions-list">
              <p className="remote-sessions-help">登录有效期为 30 天，到期后重新配对。</p>
              {status.sessions.length === 0 && (
                <p className="remote-sessions-empty">暂无已配对浏览器</p>
              )}
              {status.sessions.map((session) => (
                <div className="setting-row remote-session-row" key={session.id}>
                  <span>
                    <strong>{session.label}</strong>
                    <small>
                      {sessionTime.format(session.createdAt)} 登录 ·{' '}
                      {sessionTime.format(session.expiresAt)} 到期
                    </small>
                  </span>
                  <button
                    className="button secondary"
                    aria-label={`撤销 ${session.label} 于 ${sessionTime.format(session.createdAt)} 登录的授权`}
                    disabled={disabled}
                    onClick={() => void revokeBrowser(session.id)}
                  >
                    {revoking === session.id ? '正在撤销…' : '撤销'}
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
        {error && !confirmReset && (
          <p role="alert" className="remote-error">
            {error}
          </p>
        )}
      </div>
      {confirmReset && (
        <Modal
          title="重置配对码"
          onClose={() => {
            if (!resetting) {
              setConfirmReset(false);
              setError('');
            }
          }}
        >
          <p className="delete-question">重置后，所有已配对浏览器将立即失效。</p>
          <p className="muted">请用新的配对码重新连接。桌面客户端与正在运行的任务不受影响。</p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmReset(false)}
            >
              取消
            </button>
            <button className="button danger" disabled={busy} onClick={() => void resetPairing()}>
              {resetting ? '正在重置…' : '重置配对码'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
