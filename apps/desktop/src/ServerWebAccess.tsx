import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight, Copy, ExternalLink, Eye, EyeOff, RefreshCw, X } from 'lucide-react';
import type { Command, WebState } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { IconButton, Modal, Switch } from './ui.tsx';
import './server-web-access.css';

type WebCommand = Extract<
  Command,
  { type: 'web.status' | 'web.pair' | 'web.revoke' | 'web.configure' }
>;
type Action = WebCommand extends infer C
  ? C extends WebCommand
    ? Omit<C, 'requestId'>
    : never
  : never;

export default function ServerWebAccess({ client }: { client: ProxyClient }) {
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<
    | { kind: 'pair' }
    | { kind: 'disable' }
    | { kind: 'revoke'; grant: WebState['grants'][number] }
    | null
  >(null);
  const generation = useRef(0);
  const prepareIntent = useRef(false);
  const previousEnabled = useRef<boolean | undefined>(undefined);
  const available =
    connection.status === 'connected' && (connection.webControl || connection.webEnabled);
  const status = connection.webState;
  const pairing = status?.pairing;
  const busy = connection.webPending;
  const statusCommand = (): Action => ({
    type: 'web.status',
    ...(connection.webControl ? { watch: true } : {}),
  });

  useEffect(() => {
    generation.current++;
    setVisible(false);
    setError('');
    setConfirmation(null);
    prepareIntent.current = available;
    previousEnabled.current = client.getSnapshot().webState?.enabled;
    return () => {
      generation.current++;
    };
  }, [client, available, connection.connectionId, connection.webControl]);

  useEffect(() => {
    if (previousEnabled.current === false && status?.enabled) prepareIntent.current = true;
    previousEnabled.current = status?.enabled;
  }, [status?.enabled]);

  useEffect(() => {
    if (!available || !prepareIntent.current) return;
    // Re-entering settings may join an initialization already in flight. Other mutations settle
    // first; their errors stay visible instead of being cleared by an automatic status request.
    if (busy && !connection.webPreparing) return;
    prepareIntent.current = false;
    if (connection.webError && !connection.webPreparing) return;
    const revision = generation.current;
    void client.prepareWebAccess().catch((reason: Error) => {
      if (revision === generation.current) setError(reason.message);
    });
  }, [
    client,
    available,
    connection.connectionId,
    connection.webControl,
    connection.webPreparing,
    connection.webError,
    busy,
    status?.enabled,
  ]);

  useEffect(() => {
    setVisible(false);
  }, [pairing?.code]);

  // Another desktop may close access, consume the code or revoke this browser while a dialog is open.
  useEffect(() => {
    if (busy || !confirmation) return;
    if (
      !status?.enabled ||
      (confirmation.kind === 'pair' && !pairing) ||
      (confirmation.kind === 'revoke' &&
        !status.grants.some((grant) => grant.id === confirmation.grant.id))
    ) {
      setConfirmation(null);
      setError('');
    }
  }, [status, pairing, confirmation, busy]);

  async function act(command: Action) {
    if (client.getSnapshot().webPending || !available) return false;
    const revision = generation.current;
    setError('');
    setDismissedError(null);
    try {
      await client.fetch(command);
      if (revision === generation.current && command.type === 'web.pair') setVisible(false);
      return revision === generation.current;
    } catch (reason) {
      if (revision === generation.current)
        setError(reason instanceof Error ? reason.message : '操作失败，请重试。');
      return false;
    }
  }

  async function prepare(enable = false) {
    if (client.getSnapshot().webPending || !available) return;
    const revision = generation.current;
    prepareIntent.current = false;
    if (enable) previousEnabled.current = true;
    setError('');
    setDismissedError(null);
    try {
      await client.prepareWebAccess(enable);
    } catch (reason) {
      if (enable) previousEnabled.current = client.getSnapshot().webState?.enabled;
      if (revision === generation.current)
        setError(reason instanceof Error ? reason.message : '配对码初始化失败，请重试。');
    }
  }

  function closeConfirmation() {
    if (client.getSnapshot().webPending) return;
    setConfirmation(null);
    setError('');
    setDismissedError(client.getSnapshot().webError);
  }

  async function confirm() {
    if (!confirmation) return;
    const succeeded = await act(
      confirmation.kind === 'pair'
        ? { type: 'web.pair' }
        : confirmation.kind === 'disable'
          ? { type: 'web.configure', enabled: false }
          : { type: 'web.revoke', grantId: confirmation.grant.id },
    );
    if (succeeded) setConfirmation(null);
  }

  async function copy(value: string) {
    const revision = generation.current;
    try {
      await window.desktop!.copyText(value);
    } catch {
      if (revision === generation.current) setError('复制失败，请重试。');
    }
  }

  async function open() {
    const revision = generation.current;
    const url = new URL('/', status!.origin);
    if (pairing) url.hash = `pair=${encodeURIComponent(pairing.code)}`;
    try {
      await window.desktop!.openExternal(url.href);
    } catch {
      if (revision === generation.current) setError('打开浏览器失败，请复制地址访问。');
    }
  }

  if (!window.desktop || !available) return null;
  const failure = error || (connection.webError !== dismissedError ? connection.webError : '');
  const preparing = connection.webPreparing && !pairing;
  const grants = status?.grants ?? [];
  const date = (value: string) => new Date(value).toLocaleString();
  return (
    <>
      <h2 className="page-heading">浏览器访问</h2>
      <div className="card server-web-access" aria-label="浏览器访问" aria-busy={busy}>
        {connection.webControl && (
          <div className="setting-row">
            <span>
              <strong>启用 Web 访问</strong>
              <small>控制当前服务端的浏览器入口。</small>
            </span>
            <Switch
              label="启用 Web 访问"
              checked={status?.enabled === true}
              disabled={busy || !status}
              onChange={(enabled) => {
                setError('');
                if (!enabled) setConfirmation({ kind: 'disable' });
                else void prepare(true);
              }}
            />
          </div>
        )}
        {!status && (
          <div className="server-web-status">
            <span className="muted" role="status">
              {busy ? '正在读取浏览器访问设置…' : '浏览器访问设置尚未读取。'}
            </span>
            {!busy && (
              <button className="button" onClick={() => void prepare()}>
                重新读取
              </button>
            )}
          </div>
        )}
        {status?.enabled && (
          <>
            <div className="setting-row">
              <span>
                <strong>服务端访问地址</strong>
              </span>
              <span className="setting-actions">
                <IconButton
                  title="复制访问地址"
                  disabled={busy || !status.origin}
                  onClick={() => void copy(`${status.origin}/`)}
                >
                  <Copy />
                </IconButton>
                <IconButton
                  title="打开浏览器"
                  disabled={busy || !status.origin}
                  onClick={() => void open()}
                >
                  <ExternalLink />
                </IconButton>
              </span>
            </div>
            <div className="setting-row server-web-pairing">
              <span>
                <strong title="5 分钟内有效，每个码仅登录一个浏览器。">配对码</strong>
              </span>
              <span className="setting-actions">
                <code
                  className="server-web-code"
                  aria-label={
                    preparing
                      ? '正在准备配对码'
                      : !pairing
                        ? '配对码未生成'
                        : visible
                          ? '配对码'
                          : '配对码已隐藏'
                  }
                  role={preparing ? 'status' : undefined}
                  title={visible ? pairing?.code : undefined}
                >
                  {preparing
                    ? '正在准备配对码…'
                    : pairing
                      ? visible
                        ? pairing.code
                        : '•'.repeat(pairing.code.length)
                      : '—'}
                </code>
                <IconButton
                  title={visible ? '隐藏配对码' : '显示配对码'}
                  disabled={busy || !pairing}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff /> : <Eye />}
                </IconButton>
                <IconButton
                  title="复制配对码"
                  disabled={busy || !pairing}
                  onClick={() => pairing && void copy(pairing.code)}
                >
                  <Copy />
                </IconButton>
                <IconButton
                  title={
                    pairing
                      ? '重新生成配对码'
                      : failure && connection.webPairing
                        ? '重试配对码初始化'
                        : '生成配对码'
                  }
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    if (pairing) setConfirmation({ kind: 'pair' });
                    else if (connection.webPairing) void prepare();
                    else void act({ type: 'web.pair' });
                  }}
                >
                  <RefreshCw />
                </IconButton>
              </span>
            </div>
            <details className="server-web-grants">
              <summary className="setting-row">
                <span>
                  <strong>已登录浏览器</strong>
                </span>
                <span className="server-web-grants-summary">
                  <span className="setting-value">{grants.length}</span>
                  <ChevronRight aria-hidden="true" />
                </span>
              </summary>
              <div className="server-web-grants-list">
                <div className="server-web-grants-heading">
                  <span className="muted">已登录的浏览器可单独撤销。</span>
                  <IconButton
                    title="刷新浏览器列表"
                    disabled={busy}
                    onClick={() => void act(statusCommand())}
                  >
                    <RefreshCw />
                  </IconButton>
                </div>
                {!grants.length && <p className="muted">暂无已登录浏览器。</p>}
                {grants.map((grant) => (
                  <div className="setting-row" key={grant.id}>
                    <span>
                      <strong>{grant.name}</strong>
                      <small>登录于 {date(grant.createdAt)}</small>
                    </span>
                    <IconButton
                      title={`撤销 ${grant.name}`}
                      disabled={busy}
                      onClick={() => {
                        setError('');
                        setConfirmation({ kind: 'revoke', grant });
                      }}
                    >
                      <X />
                    </IconButton>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
        {failure && !confirmation && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
      </div>
      {confirmation && (
        <Modal
          title={
            confirmation.kind === 'pair'
              ? '重新生成配对码'
              : confirmation.kind === 'disable'
                ? '关闭 Web 访问'
                : '撤销浏览器登录'
          }
          onClose={closeConfirmation}
        >
          <p className="delete-question">
            {confirmation.kind === 'pair'
              ? '重新生成后，当前配对码将失效。'
              : confirmation.kind === 'disable'
                ? '关闭当前服务端的 Web 访问？'
                : `撤销“${confirmation.grant.name}”的登录？`}
          </p>
          <p className="muted">
            {confirmation.kind === 'pair'
              ? '已登录的浏览器不受影响。'
              : confirmation.kind === 'disable'
                ? '所有浏览器将断开，浏览器终端会关闭；会话任务与桌面连接不受影响。'
                : '该浏览器的所有页面及终端将关闭，会话任务继续。'}
          </p>
          {failure && (
            <p className="error-text" role="alert">
              {failure}
            </p>
          )}
          <div className="dialog-actions" aria-busy={busy}>
            <button className="button secondary" disabled={busy} onClick={closeConfirmation}>
              取消
            </button>
            <button className="button danger" disabled={busy} onClick={() => void confirm()}>
              {confirmation.kind === 'pair'
                ? busy
                  ? '正在生成…'
                  : '重新生成配对码'
                : confirmation.kind === 'disable'
                  ? busy
                    ? '正在关闭…'
                    : '关闭 Web 访问'
                  : busy
                    ? '正在撤销…'
                    : '撤销登录'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
