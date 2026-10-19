import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FocusEvent } from 'react';
import {
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  RefreshCw,
  Settings2,
  X,
} from 'lucide-react';
import {
  webDomainSchema,
  webPathSchema,
  WEB_CERTIFICATE_LIMIT,
  WEB_PRIVATE_KEY_LIMIT,
} from '@cc-desk-tunnel/protocol';
import type { Command, WebState } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { IconButton, Modal, Switch } from './ui.tsx';
import './server-web-access.css';

type WebCommand = Extract<
  Command,
  {
    type:
      | 'web.status'
      | 'web.pair'
      | 'web.revoke'
      | 'web.configure'
      | 'web.certificate.set'
      | 'web.certificate.reset';
  }
>;
type Action = WebCommand extends infer C
  ? C extends WebCommand
    ? Omit<C, 'requestId'>
    : never
  : never;
type Certificate = NonNullable<WebState['certificate']>;
type CertificateTarget = {
  connectionId: string | null;
  domain: string;
  revision: string;
  enabled: boolean;
};
function certificateDomain(state: Pick<WebState, 'enabled' | 'domain' | 'certificate'> | null) {
  return state?.enabled ? (state.domain ?? '') : (state?.certificate?.details?.domain ?? '');
}

export default function ServerWebAccess({ client }: { client: ProxyClient }) {
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [visible, setVisible] = useState(false);
  const [domain, setDomain] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [certificateTarget, setCertificateTarget] = useState<CertificateTarget | null>(null);
  const [confirmation, setConfirmation] = useState<
    | { kind: 'pair' }
    | { kind: 'disable' }
    | { kind: 'path'; path: string | undefined }
    | { kind: 'revoke'; grant: WebState['grants'][number] }
    | null
  >(null);
  const confirmationOpening = useRef(false);
  const generation = useRef(0);
  const prepareIntent = useRef(false);
  const previousEnabled = useRef<boolean | undefined>(undefined);
  const available =
    connection.status === 'connected' && (connection.webControl || connection.webEnabled);
  const status = connection.webState;
  const certificate = status?.certificate;
  const recoverableCertificate =
    certificate?.mode === 'custom' ||
    (certificate?.mode === 'unavailable' && !!certificate.revision);
  const certificateDialog =
    certificateTarget &&
    available &&
    connection.webCertificates &&
    (status?.enabled || recoverableCertificate) &&
    certificate &&
    certificateTarget.connectionId === connection.connectionId &&
    certificateTarget.enabled === (status?.enabled === true) &&
    certificateTarget.domain === certificateDomain(status) &&
    certificateTarget.revision === certificate.revision
      ? certificateTarget
      : null;
  const pairing = status?.pairing;
  const busy = connection.webPending;
  const address = status?.url ?? (status?.origin ? new URL('/', status.origin).href : '');
  const displayAddress =
    address && status?.path && status.path.length > 5
      ? `${new URL(address).origin}/${status.path.slice(0, 5)}...`
      : address;
  const statusCommand = (): Action => ({
    type: 'web.status',
    ...(connection.webControl ? { watch: true } : {}),
  });

  useEffect(() => {
    generation.current++;
    setVisible(false);
    setError('');
    setConfirmation(null);
    setCertificateTarget(null);
    confirmationOpening.current = false;
    prepareIntent.current = available;
    previousEnabled.current = client.getSnapshot().webState?.enabled;
    return () => {
      generation.current++;
    };
  }, [client, available, connection.connectionId, connection.webControl]);

  useEffect(() => {
    setDomain(status?.domain ?? '');
  }, [status?.domain, connection.connectionId]);

  useEffect(() => {
    setPath(status?.path ?? '');
  }, [status?.path, connection.connectionId]);

  useEffect(() => {
    confirmationOpening.current = confirmation !== null || certificateTarget !== null;
  }, [confirmation, certificateTarget]);

  useEffect(() => {
    if (certificateTarget && !certificateDialog) setCertificateTarget(null);
  }, [certificateTarget, certificateDialog]);

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
      (confirmation.kind === 'path' && status.path !== confirmation.path) ||
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

  function showConfirmation(value: NonNullable<typeof confirmation>) {
    if (client.getSnapshot().webPending) return;
    // Set synchronously: the dialog moves focus before effects run, which must not save an input.
    confirmationOpening.current = true;
    setError('');
    setDomain(client.getSnapshot().webState?.domain ?? '');
    setPath(client.getSnapshot().webState?.path ?? '');
    setConfirmation(value);
  }

  async function saveAddress(field: 'domain' | 'path', event: FocusEvent<HTMLInputElement>) {
    const current = client.getSnapshot();
    const original = current.webState?.[field] ?? '';
    const setValue = field === 'domain' ? setDomain : setPath;
    // Choosing a confirmation action supersedes the draft. In particular, opening the path reset
    // dialog must not first save that draft or issue a second configure request.
    if (
      confirmationOpening.current ||
      (event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-web-confirm]'))
    ) {
      setValue(original);
      return;
    }
    if (current.webPending || !current.webSettings || !current.webState?.enabled) return;
    const parsed = (field === 'domain' ? webDomainSchema : webPathSchema).safeParse(
      event.currentTarget.value.trim(),
    );
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      setValue(original);
      return;
    }
    setValue(parsed.data);
    if (parsed.data === original) return;
    const revision = generation.current;
    const succeeded = await act({ type: 'web.configure', enabled: true, [field]: parsed.data });
    if (!succeeded && revision === generation.current)
      setValue(client.getSnapshot().webState?.[field] ?? '');
  }

  function closeConfirmation() {
    if (client.getSnapshot().webPending) return;
    confirmationOpening.current = false;
    setConfirmation(null);
    setError('');
    setDismissedError(client.getSnapshot().webError);
  }

  function showCertificate() {
    const current = client.getSnapshot();
    if (current.webPending || !current.webState?.certificate) return;
    confirmationOpening.current = true;
    setError('');
    setDismissedError(current.webError);
    setDomain(current.webState.domain ?? '');
    setPath(current.webState.path ?? '');
    setCertificateTarget({
      connectionId: current.connectionId,
      domain: certificateDomain(current.webState),
      revision: current.webState.certificate.revision,
      enabled: current.webState.enabled,
    });
  }

  function closeCertificate() {
    if (client.getSnapshot().webPending) return;
    confirmationOpening.current = false;
    setCertificateTarget(null);
    setError('');
    setDismissedError(client.getSnapshot().webError);
  }

  async function saveCertificate(command: Action) {
    const target = certificateTarget;
    const current = client.getSnapshot();
    // A dialog never applies a private key to a different connection or a newer server setting.
    if (
      !target ||
      current.connectionId !== target.connectionId ||
      (current.webState?.enabled === true) !== target.enabled ||
      certificateDomain(current.webState) !== target.domain ||
      current.webState?.certificate?.revision !== target.revision ||
      (command.type === 'web.certificate.set' && !target.enabled)
    )
      return;
    if (await act(command)) setCertificateTarget(null);
  }

  async function confirm() {
    if (!confirmation) return;
    const succeeded = await act(
      confirmation.kind === 'pair'
        ? { type: 'web.pair' }
        : confirmation.kind === 'disable'
          ? { type: 'web.configure', enabled: false }
          : confirmation.kind === 'path'
            ? { type: 'web.configure', enabled: true, regeneratePath: true }
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
    const url = new URL(address);
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
            <span data-web-confirm>
              <Switch
                label="启用 Web 访问"
                checked={status?.enabled === true}
                disabled={busy || !status}
                onChange={(enabled) => {
                  setError('');
                  if (!enabled) showConfirmation({ kind: 'disable' });
                  else void prepare(true);
                }}
              />
            </span>
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
        {!status?.enabled && connection.webCertificates && recoverableCertificate && (
          <div className="setting-row server-web-certificate-setting">
            <span>
              <strong>HTTPS 证书</strong>
              <small>{certificate?.error || '自定义证书仍用于已绑定域名。'}</small>
            </span>
            <span data-web-confirm>
              <IconButton title="恢复默认证书" disabled={busy} onClick={showCertificate}>
                <RefreshCw />
              </IconButton>
            </span>
          </div>
        )}
        {status?.enabled && (
          <>
            {connection.webSettings && (
              <>
                <div className="setting-row server-web-address-setting server-web-domain-setting">
                  <span>
                    <strong>访问域名</strong>
                    <small>
                      {certificate?.mode === 'custom'
                        ? '更改域名前，请先将 HTTPS 证书恢复默认。'
                        : '留空使用部署地址；填写后仅允许指定域名访问。'}
                    </small>
                  </span>
                  <input
                    className="server-web-address-input"
                    aria-label="访问域名"
                    placeholder="web.example.com"
                    value={domain}
                    disabled={busy || certificate?.mode === 'custom'}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={253}
                    onChange={(event) => setDomain(event.target.value)}
                    onBlur={(event) => void saveAddress('domain', event)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing)
                        event.currentTarget.blur();
                    }}
                  />
                </div>
                <div className="setting-row server-web-address-setting">
                  <span>
                    <strong>服务端访问路径</strong>
                    <small>留空使用根路径。</small>
                  </span>
                  <span className="server-web-path-setting">
                    <span className="muted" aria-hidden="true">
                      /
                    </span>
                    <input
                      className="server-web-address-input"
                      aria-label="服务端访问路径"
                      value={path}
                      disabled={busy}
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={64}
                      onChange={(event) => setPath(event.target.value)}
                      onBlur={(event) => void saveAddress('path', event)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing)
                          event.currentTarget.blur();
                      }}
                    />
                    <span data-web-confirm>
                      <IconButton
                        title="重新生成访问路径"
                        disabled={busy}
                        onClick={() => showConfirmation({ kind: 'path', path: status.path })}
                      >
                        <RefreshCw />
                      </IconButton>
                    </span>
                  </span>
                </div>
              </>
            )}
            {connection.webCertificates && certificate && (
              <div className="setting-row server-web-certificate-setting">
                <span>
                  <strong>HTTPS 证书</strong>
                  {certificate.mode === 'external' && <small>证书由外部反向代理管理。</small>}
                  {certificate.error && <small>{certificate.error}</small>}
                </span>
                <span className="setting-actions">
                  <span className="setting-value">
                    {certificate.mode === 'custom'
                      ? '自定义证书'
                      : certificate.mode === 'external'
                        ? '反向代理管理'
                        : certificate.mode === 'unavailable'
                          ? '暂不可用'
                          : '默认证书'}
                  </span>
                  {certificate.mode !== 'external' &&
                    (certificate.mode !== 'unavailable' || certificate.revision) && (
                      <span data-web-confirm>
                        <IconButton
                          title="管理 HTTPS 证书"
                          disabled={busy}
                          onClick={showCertificate}
                        >
                          <Settings2 />
                        </IconButton>
                      </span>
                    )}
                </span>
              </div>
            )}
            <div className="setting-row server-web-url-setting">
              <span>
                <strong>服务端访问地址</strong>
              </span>
              <span className="setting-actions server-web-address-actions">
                <span className="server-web-address" aria-label="服务端访问地址">
                  {displayAddress}
                </span>
                <IconButton
                  title="复制访问地址"
                  disabled={busy || !address}
                  onClick={() => void copy(address)}
                >
                  <Copy />
                </IconButton>
                <IconButton
                  title="打开浏览器"
                  disabled={busy || !address}
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
                <span data-web-confirm>
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
                      if (pairing) showConfirmation({ kind: 'pair' });
                      else if (connection.webPairing) void prepare();
                      else void act({ type: 'web.pair' });
                    }}
                  >
                    <RefreshCw />
                  </IconButton>
                </span>
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
                    <span data-web-confirm>
                      <IconButton
                        title={`撤销 ${grant.name}`}
                        disabled={busy}
                        onClick={() => {
                          setError('');
                          showConfirmation({ kind: 'revoke', grant });
                        }}
                      >
                        <X />
                      </IconButton>
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
        {failure && !confirmation && !certificateDialog && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
      </div>
      {certificateDialog && certificate && (
        <CertificateDialog
          target={certificateDialog}
          certificate={certificate}
          busy={busy}
          failure={failure || ''}
          onClose={closeCertificate}
          onSubmit={saveCertificate}
          onDomain={() => {
            const connectionId = client.getSnapshot().connectionId;
            closeCertificate();
            // Wait until the modal has unmounted; its native focus trap keeps the settings inert.
            requestAnimationFrame(() => {
              if (client.getSnapshot().connectionId === connectionId)
                document
                  .querySelector<HTMLInputElement>('.server-web-domain-setting input')
                  ?.focus();
            });
          }}
        />
      )}
      {confirmation && (
        <Modal
          title={
            confirmation.kind === 'pair'
              ? '重新生成配对码'
              : confirmation.kind === 'disable'
                ? '关闭 Web 访问'
                : confirmation.kind === 'path'
                  ? '重新生成访问路径'
                  : '撤销浏览器登录'
          }
          onClose={closeConfirmation}
        >
          <p className="delete-question">
            {confirmation.kind === 'pair'
              ? '重新生成后，当前配对码将失效。'
              : confirmation.kind === 'disable'
                ? '关闭当前服务端的 Web 访问？'
                : confirmation.kind === 'path'
                  ? '重新生成当前服务端的访问路径？'
                  : `撤销“${confirmation.grant.name}”的登录？`}
          </p>
          <p className="muted">
            {confirmation.kind === 'pair'
              ? '已登录的浏览器不受影响。'
              : confirmation.kind === 'disable'
                ? '所有浏览器将断开，浏览器终端会关闭；会话任务与桌面连接不受影响。'
                : confirmation.kind === 'path'
                  ? '旧地址将失效，已有浏览器连接将断开。配对码与浏览器授权保留，请使用新地址访问。'
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
                  : confirmation.kind === 'path'
                    ? busy
                      ? '正在生成…'
                      : '重新生成访问路径'
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

function CertificateDialog({
  target,
  certificate,
  busy,
  failure,
  onClose,
  onDomain,
  onSubmit,
}: {
  target: CertificateTarget;
  certificate: Certificate;
  busy: boolean;
  failure: string;
  onClose: () => void;
  onDomain: () => void;
  onSubmit: (command: Action) => Promise<void>;
}) {
  // PEM contents exist only in this mounted dialog. Closing it, changing its target or a successful
  // update unmounts the form; no key is read back from the server or copied to a persistent store.
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [reset, setReset] = useState(!target.enabled || certificate.mode === 'unavailable');
  const details = certificate.details;
  const resetting = reset && certificate.mode !== 'default';
  const date = (value: string) => new Date(value).toLocaleDateString();
  return (
    <Modal title={resetting ? '恢复默认证书' : 'HTTPS 证书'} onClose={onClose} closeDisabled={busy}>
      <div className="server-web-certificate-dialog" aria-busy={busy}>
        {resetting ? (
          <>
            {target.domain && (
              <p className="server-web-certificate-domain">
                <span className="muted">绑定域名</span>
                <strong>{target.domain}</strong>
              </p>
            )}
            <p className="delete-question">移除自定义证书，恢复服务端的默认证书？</p>
            <p className="muted">
              通过此域名连接的桌面客户端需重新确认指纹；通过 IP 连接的桌面不受影响。
            </p>
          </>
        ) : !target.domain ? (
          <p className="delete-question">请先填写访问域名，再为该域名设置自定义证书。</p>
        ) : (
          <>
            <p className="server-web-certificate-domain">
              <span className="muted">绑定域名</span>
              <strong>{target.domain}</strong>
            </p>
            {details && (
              <details className="server-web-certificate-details">
                <summary>当前证书信息</summary>
                <dl>
                  <dt>域名</dt>
                  <dd>{details.domain}</dd>
                  <dt>主题</dt>
                  <dd>{details.subject}</dd>
                  <dt>签发者</dt>
                  <dd>{details.issuer}</dd>
                  <dt>有效期</dt>
                  <dd>
                    {date(details.validFrom)} – {date(details.validTo)}
                  </dd>
                  <dt>指纹</dt>
                  <dd className="server-web-certificate-fingerprint">{details.fingerprint}</dd>
                </dl>
              </details>
            )}
            <form
              className="server-web-certificate-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && cert.trim() && key.trim())
                  void onSubmit({
                    type: 'web.certificate.set',
                    revision: target.revision,
                    domain: target.domain,
                    cert,
                    key,
                  });
              }}
              id="web-certificate-form"
            >
              <label>
                <span>证书链 PEM</span>
                <textarea
                  aria-label="证书链 PEM"
                  value={cert}
                  onChange={(event) => setCert(event.target.value)}
                  disabled={busy}
                  rows={4}
                  maxLength={WEB_CERTIFICATE_LIMIT}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  aria-describedby="web-certificate-chain-hint"
                />
                <small className="muted" id="web-certificate-chain-hint">
                  粘贴域名证书及中间证书，域名证书放在最前。
                </small>
              </label>
              <label>
                <span>私钥 PEM</span>
                <textarea
                  aria-label="私钥 PEM"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  disabled={busy}
                  rows={3}
                  maxLength={WEB_PRIVATE_KEY_LIMIT}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                />
              </label>
            </form>
            <p className="muted server-web-certificate-note">
              保存后立即用于该域名。通过此域名连接的桌面需重新确认指纹，通过 IP 连接不受影响。
            </p>
          </>
        )}
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
        <div className="dialog-actions server-web-certificate-actions">
          {!resetting && certificate.mode === 'custom' && (
            <button
              className="button secondary server-web-certificate-reset"
              disabled={busy}
              onClick={() => {
                setCert('');
                setKey('');
                setReset(true);
              }}
            >
              恢复默认
            </button>
          )}
          <button className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          {resetting ? (
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void onSubmit({ type: 'web.certificate.reset', revision: target.revision })
              }
            >
              {busy ? '正在恢复…' : '恢复默认证书'}
            </button>
          ) : !target.domain ? (
            <button className="button" disabled={busy} onClick={onDomain}>
              设置访问域名
            </button>
          ) : (
            <button
              className="button"
              type="submit"
              form="web-certificate-form"
              disabled={busy || !cert.trim() || !key.trim()}
            >
              {busy ? '正在保存…' : '保存证书'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
