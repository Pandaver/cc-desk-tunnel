import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, Copy, ExternalLink, RotateCcw, Trash2 } from 'lucide-react';
import type {
  WebCertificateState,
  WebProof,
  WebSettingsState,
  WebTotpSetup,
} from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { IconButton, Modal, Switch } from './ui.tsx';
import { CopyButton } from './copy.tsx';
import ReverseProxyHelp from './ReverseProxyHelp.tsx';

function Row({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {children}
    </div>
  );
}
function ProofFields({
  proof,
  change,
  totp,
}: {
  proof: WebProof;
  change: (value: WebProof) => void;
  totp: boolean;
}) {
  return (
    <>
      <label>
        服务凭据
        <input
          type="password"
          autoComplete="current-password"
          required
          value={proof.password}
          onChange={(event) => change({ ...proof, password: event.target.value })}
        />
      </label>
      {totp && (
        <label>
          当前验证器动态码
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={proof.code ?? ''}
            onChange={(event) => change({ ...proof, code: event.target.value })}
          />
        </label>
      )}
    </>
  );
}
type Action = 'access' | 'setup' | 'disable' | 'certificate' | 'reset' | { revoke: string };
const message = (error: unknown) => (error instanceof Error ? error.message : '请求失败，请重试。');
export function displayWebAddress(value: string) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    return `${url.origin}/${path.length > 5 ? `${path.slice(0, 5)}…` : path}`;
  } catch {
    return value;
  }
}

// Server settings belong to this page. A disconnected/replaced connection destroys its dialogs and secrets.
export default function WebAccessSettings({
  client,
  browser,
  connectionUrl = '',
}: {
  client: ProxyClient;
  browser: boolean;
  connectionUrl?: string;
}) {
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [values, setValues] = useState<WebSettingsState | null>(null);
  const [certificate, setCertificate] = useState<WebCertificateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const generation = useRef(0);
  const firstLoad = useRef(true);
  const connected = connection.status === 'connected';
  async function load(userInitiated = false) {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await client.fetch({
        type: 'web.settings.get',
        ...(browser && userInitiated ? { userInitiated: true as const } : {}),
      });
      if (current !== generation.current) return;
      setValues(result.values);
      if (!browser) {
        const cert = await client.fetch({ type: 'web.certificate.get' });
        if (current === generation.current) setCertificate(cert);
      }
    } catch (error) {
      if (current === generation.current) setError(message(error));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setValues(null);
    setCertificate(null);
    setAction(null);
    // This page first mounts when opened by the user, but later connection changes are automatic.
    const userInitiated = firstLoad.current;
    firstLoad.current = false;
    if (connected) void load(userInitiated);
    return () => {
      generation.current++;
    };
  }, [connection.connectionId, connected, client, browser]);
  async function toggle(enabled: boolean) {
    if (busy || !connected) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await client.fetch({ type: 'web.settings.update', values: { enabled } });
      if (current === generation.current) setValues(result.values);
    } catch (error) {
      if (current === generation.current) setError(message(error));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function copy(text: string) {
    try {
      if (window.desktop) await window.desktop.copyText(text);
      else await navigator.clipboard.writeText(text);
    } catch {
      setError('复制失败，请选中地址后复制。');
    }
  }
  async function open(url: string) {
    try {
      if (window.desktop) await window.desktop.openWeb(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('打开浏览器失败，请复制地址访问。');
    }
  }
  if (!connected)
    return (
      <>
        <h2 className="page-heading">浏览器访问</h2>
        <p className="muted">连接服务端后管理浏览器访问。</p>
      </>
    );
  const expires =
    certificate?.details &&
    Math.ceil((Date.parse(certificate.details.validTo) - Date.now()) / 86400000);
  return (
    <>
      <h2 className="page-heading">浏览器访问</h2>
      <div className="card web-access-settings" aria-busy={busy}>
        {!values ? (
          <Row title={busy ? '正在读取…' : '读取设置失败'}>
            <button className="button" disabled={busy} onClick={() => void load(true)}>
              重试
            </button>
          </Row>
        ) : (
          <>
            {!browser && (
              <Row title="启用 Web 访问" detail="控制当前服务端的浏览器入口。">
                <Switch
                  label="启用 Web 访问"
                  checked={values.enabled}
                  disabled={busy}
                  onChange={(enabled) => void toggle(enabled)}
                />
              </Row>
            )}
            {values.enabled && (
              <>
                <Row title="服务端访问地址">
                  <div className="web-row-actions">
                    {values.url ? (
                      <>
                        <span className="web-access-address" title={values.url}>
                          {displayWebAddress(values.url)}
                        </span>
                        <IconButton
                          title="复制服务端访问地址"
                          onClick={() => void copy(values.url!)}
                          disabled={busy}
                        >
                          <Copy />
                        </IconButton>
                        <IconButton
                          title="打开服务端访问地址"
                          onClick={() => void open(values.url!)}
                          disabled={busy}
                        >
                          <ExternalLink />
                        </IconButton>
                      </>
                    ) : (
                      <span className="muted">地址未就绪</span>
                    )}
                  </div>
                </Row>
                <Row title="访问设置" detail={values.domain || '使用部署地址'}>
                  <button className="button" disabled={busy} onClick={() => setAction('access')}>
                    设置
                  </button>
                </Row>
                <Row
                  title="两步验证"
                  detail={
                    values.totpEnabled ? '登录时需要验证器动态码。' : '建议开启验证器两步验证。'
                  }
                >
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => setAction(values.totpEnabled ? 'disable' : 'setup')}
                  >
                    {values.totpEnabled ? '关闭' : '设置'}
                  </button>
                </Row>
                <details className="web-sessions">
                  <summary>
                    已登录浏览器{' '}
                    <span>
                      {values.sessions.length}
                      <ChevronRight aria-hidden="true" />
                    </span>
                  </summary>
                  {values.sessions.length === 0 ? (
                    <p className="muted">暂无已登录浏览器</p>
                  ) : (
                    <ul>
                      {values.sessions.map((session) => (
                        <li key={session.id}>
                          <span>
                            <strong>
                              {session.name}
                              {session.id === connection.browser?.sessionId ? '（当前浏览器）' : ''}
                            </strong>
                            <small>
                              最近活动 {new Date(session.lastActiveAt).toLocaleString()}
                            </small>
                          </span>
                          <IconButton
                            title={`退出 ${session.name}`}
                            disabled={busy}
                            onClick={() => setAction({ revoke: session.id })}
                          >
                            <Trash2 />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </>
            )}
            {!browser &&
              certificate &&
              (values.enabled || certificate.mode === 'custom' || certificate.error) && (
                <Row
                  title="HTTPS 证书"
                  detail={
                    certificate.error ??
                    (certificate.mode === 'custom'
                      ? `自定义证书 · ${certificate.details?.domain ?? ''}`
                      : certificate.mode === 'external'
                        ? '由反向代理管理'
                        : certificate.mode === 'unavailable'
                          ? '当前服务未配置 TLS'
                          : certificate.selfSigned
                            ? '使用默认自签名证书'
                            : '使用部署证书')
                  }
                >
                  <div className="web-row-actions">
                    {values.enabled && !['external', 'unavailable'].includes(certificate.mode) && (
                      <button
                        className="button"
                        disabled={busy || !values.domain}
                        title={values.domain ? undefined : '请先设置访问域名'}
                        onClick={() => setAction('certificate')}
                      >
                        导入证书
                      </button>
                    )}
                    {(certificate.mode === 'custom' || certificate.error) && (
                      <IconButton
                        title="恢复默认证书"
                        disabled={busy}
                        onClick={() => setAction('reset')}
                      >
                        <RotateCcw />
                      </IconButton>
                    )}
                  </div>
                </Row>
              )}
            {!browser &&
              certificate?.details &&
              (values.enabled || certificate.mode === 'custom') && (
                <div className="web-certificate-details">
                  <span>签发者：{certificate.details.issuer}</span>
                  <span>有效期至：{new Date(certificate.details.validTo).toLocaleString()}</span>
                </div>
              )}
            {expires !== undefined && expires <= 30 && (
              <p className="web-expiry" role="status">
                {expires < 0
                  ? '证书已过期，请更换证书。'
                  : `证书将在 ${expires} 天内到期，请及时更换。`}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      {values && action && (
        <SettingsDialog
          key={typeof action === 'string' ? action : action.revoke}
          client={client}
          browser={browser}
          connectionUrl={connectionUrl}
          values={values}
          certificate={certificate}
          action={action}
          onClose={() => setAction(null)}
          changed={(next, cert) => {
            if (next) setValues(next);
            if (cert) setCertificate(cert);
          }}
        />
      )}
    </>
  );
}

function SettingsDialog({
  client,
  browser,
  connectionUrl,
  values,
  certificate,
  action,
  onClose,
  changed,
}: {
  client: ProxyClient;
  browser: boolean;
  connectionUrl: string;
  values: WebSettingsState;
  certificate: WebCertificateState | null;
  action: Action;
  onClose: () => void;
  changed: (values?: WebSettingsState, certificate?: WebCertificateState) => void;
}) {
  const [proof, setProof] = useState<WebProof>({ password: '' });
  const [draft, setDraft] = useState({
    domain: values.domain,
    path: values.path,
    idleMinutes: values.idleMinutes,
    proxyEnabled: values.proxyEnabled,
    trustedProxies: values.trustedProxies.join('\n'),
  });
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [setup, setSetup] = useState<WebTotpSetup | null>(null);
  const [now, setNow] = useState(Date.now);
  const expired = setup !== null && now >= Date.parse(setup.expiresAt);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(action === 'setup' && !browser);
  const [error, setError] = useState('');
  const setupRequest = useRef<Promise<WebTotpSetup> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (action !== 'setup' || browser) return;
    let current = true;
    setBusy(true);
    const request = (setupRequest.current ??= client.fetch({ type: 'web.totp.setup' }));
    void request
      .then(
        (result) => {
          if (current) setSetup(result);
        },
        (error) => {
          if (current) setError(message(error));
        },
      )
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [action, browser, client]);
  useEffect(() => {
    if (!setup) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkExpiry = () => {
      const now = Date.now();
      setNow(now);
      clearTimeout(timer);
      const remaining = Date.parse(setup.expiresAt) - now;
      if (remaining > 0) timer = setTimeout(checkExpiry, remaining);
    };
    checkExpiry();
    window.addEventListener('focus', checkExpiry);
    document.addEventListener('visibilitychange', checkExpiry);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', checkExpiry);
      document.removeEventListener('visibilitychange', checkExpiry);
    };
  }, [setup]);
  useEffect(() => {
    if (!setup) return;
    let current = true;
    void import('qrcode')
      .then((module) => module.default.toDataURL(setup.uri, { width: 200, margin: 1 }))
      .then(
        (url) => {
          if (current) setQr(url);
        },
        () => {
          if (current) setError('二维码生成失败，请手动输入密钥。');
        },
      );
    return () => {
      current = false;
    };
  }, [setup]);
  const title =
    typeof action === 'object'
      ? '退出浏览器登录'
      : {
          access: '访问设置',
          setup: '设置两步验证',
          disable: '关闭两步验证',
          certificate: '导入自定义证书',
          reset: '恢复默认证书',
        }[action];
  const needsProof =
    (action === 'access' && browser) ||
    (action === 'setup' && browser) ||
    typeof action === 'object' ||
    (action === 'disable' && browser);
  async function file(file: File | undefined, kind: 'cert' | 'key') {
    if (!file) return;
    if (file.size > (kind === 'cert' ? 65536 : 16384)) {
      setError(kind === 'cert' ? '证书链不得超过 64 KB。' : '私钥不得超过 16 KB。');
      return;
    }
    try {
      const text = await file.text();
      if (mounted.current) (kind === 'cert' ? setCert : setKey)(text);
    } catch {
      if (mounted.current) setError('读取文件失败，请重新选择。');
    }
  }
  async function submit(refreshTotp = false) {
    if (busy) return;
    if (action === 'setup' && setup && !refreshTotp && Date.now() >= Date.parse(setup.expiresAt)) {
      setNow(Date.now());
      return;
    }
    setBusy(true);
    setError('');
    if (refreshTotp) setCode('');
    try {
      if (action === 'setup' && (!setup || refreshTotp)) {
        const result = await client.fetch({
          type: 'web.totp.setup',
          ...(browser ? { proof } : {}),
        });
        if (mounted.current) {
          setQr('');
          setCode('');
          setSetup(result);
        }
        return;
      }
      if (action === 'certificate' || action === 'reset') {
        const result = await client.fetch(
          action === 'reset'
            ? { type: 'web.certificate.reset' }
            : { type: 'web.certificate.set', cert, key },
        );
        if (mounted.current) {
          setKey('');
          setCert('');
          changed(undefined, result);
          onClose();
        }
        return;
      }
      const result = await client.fetch(
        typeof action === 'object'
          ? { type: 'web.sessions.revoke', sessionId: action.revoke, proof }
          : action === 'access'
            ? {
                type: 'web.settings.update',
                values: browser
                  ? { path: draft.path.trim() }
                  : {
                      ...draft,
                      domain: draft.domain.trim(),
                      path: draft.path.trim(),
                      trustedProxies: draft.trustedProxies
                        .split(/[\n,]/)
                        .map((value) => value.trim())
                        .filter(Boolean),
                    },
                ...(browser ? { proof } : {}),
              }
            : action === 'setup'
              ? { type: 'web.totp.enable', code, ...(browser ? { proof } : {}) }
              : { type: 'web.totp.disable', ...(browser ? { proof } : {}) },
      );
      if (browser && action === 'access' && result.values.path !== values.path) {
        const url = new URL(result.values.url ?? '', location.href);
        const expected = result.values.path ? `/${result.values.path}/` : '/';
        if (url.origin !== location.origin || url.pathname !== expected || url.search || url.hash)
          throw new Error('路径已保存，请从桌面端复制新的访问地址。');
        location.assign(url.href);
      }
      if (mounted.current) {
        changed(result.values);
        onClose();
      }
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="web-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy}>
          {action === 'access' && (
            <>
              {!browser && (
                <label>
                  访问域名
                  <input
                    value={draft.domain}
                    disabled={certificate?.mode === 'custom'}
                    placeholder="web.example.com"
                    maxLength={253}
                    onChange={(event) => setDraft({ ...draft, domain: event.target.value })}
                  />
                  <small className="muted">
                    {certificate?.mode === 'custom'
                      ? '请先恢复默认证书，再修改或清空域名。'
                      : '留空使用部署地址；填写后仅允许指定域名访问，其他入口返回 404。'}
                  </small>
                </label>
              )}
              <label>
                服务端访问路径
                <div className="web-path-input">
                  <span>/</span>
                  <input
                    value={draft.path}
                    maxLength={64}
                    pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?|"
                    onChange={(event) => setDraft({ ...draft, path: event.target.value })}
                  />
                </div>
                <small className="muted">
                  留空使用根路径。修改域名或路径后，已登录浏览器需要重新登录。
                </small>
              </label>
              {!browser && (
                <>
                  <label>
                    登录空闲有效期（分钟）
                    <input
                      type="number"
                      min={15}
                      max={1440}
                      required
                      value={draft.idleMinutes}
                      onChange={(event) =>
                        setDraft({ ...draft, idleMinutes: Number(event.target.value) })
                      }
                    />
                  </label>
                  <Row title="信任反向代理">
                    <Switch
                      label="信任反向代理"
                      checked={draft.proxyEnabled}
                      disabled={busy}
                      onChange={(proxyEnabled) => setDraft({ ...draft, proxyEnabled })}
                    />
                  </Row>
                  {draft.proxyEnabled && (
                    <>
                      <label>
                        反向代理 IP
                        <textarea
                          rows={3}
                          required
                          value={draft.trustedProxies}
                          onChange={(event) =>
                            setDraft({ ...draft, trustedProxies: event.target.value })
                          }
                          placeholder="每行一个 IP 地址"
                        />
                        <small className="muted">只信任这些地址转发的客户端 IP 信息。</small>
                      </label>
                      <ReverseProxyHelp
                        connectionUrl={connectionUrl}
                        domain={draft.domain}
                        path={draft.path}
                        certificate={certificate}
                      />
                    </>
                  )}
                </>
              )}
            </>
          )}
          {action === 'certificate' && (
            <>
              <p className="muted">证书用于 {values.domain}。请提供完整证书链与未加密私钥。</p>
              <label>
                证书链 PEM
                <textarea
                  rows={5}
                  value={cert}
                  required
                  maxLength={65536}
                  onChange={(event) => setCert(event.target.value)}
                />
                <input
                  type="file"
                  aria-label="选择证书文件"
                  accept=".pem,.crt,.cer"
                  onChange={(event) => void file(event.target.files?.[0], 'cert')}
                />
              </label>
              <label>
                私钥 PEM
                <textarea
                  rows={5}
                  value={key}
                  required
                  maxLength={16384}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setKey(event.target.value)}
                />
                <input
                  type="file"
                  aria-label="选择私钥文件"
                  accept=".pem,.key"
                  onChange={(event) => void file(event.target.files?.[0], 'key')}
                />
              </label>
            </>
          )}
          {action === 'reset' && (
            <p>
              恢复部署时的默认证书？当前自定义证书将被移除；如果默认证书为自签名，浏览器会重新提示证书确认。
            </p>
          )}
          {action === 'disable' && (
            <p>关闭两步验证后，使用服务凭据即可登录。已登录浏览器将退出。</p>
          )}
          {typeof action === 'object' && (
            <p>退出这个浏览器的登录？它需要重新输入服务凭据和动态码。</p>
          )}
          {action === 'setup' && !setup && !browser && busy && (
            <p role="status">正在生成验证器密钥…</p>
          )}
          {action === 'setup' && setup && (
            <div className="web-totp-setup">
              <div className="web-totp-qr">
                {qr && (
                  <img src={qr} width="200" height="200" alt="验证器二维码" aria-hidden={expired} />
                )}
                {expired && (
                  <div className="web-totp-expired">
                    <strong role="status">已过期</strong>
                    <button type="button" className="button" onClick={() => void submit(true)}>
                      <RotateCcw size={16} />
                      {busy ? '正在刷新…' : '刷新二维码'}
                    </button>
                  </div>
                )}
              </div>
              <div className="web-totp-manual">
                <span>手动设置密钥</span>
                <div className="web-totp-secret-row">
                  {expired ? (
                    <span className="muted">请刷新二维码</span>
                  ) : (
                    <>
                      <code className="web-totp-secret">{setup.secret}</code>
                      <CopyButton key={setup.secret} text={setup.secret} label="复制密钥" />
                    </>
                  )}
                </div>
              </div>
              <label>
                验证新动态码
                <input
                  value={code}
                  required
                  disabled={expired}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
            </div>
          )}
          {needsProof && !setup && (
            <ProofFields proof={proof} change={setProof} totp={values.totpEnabled} />
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || (action === 'setup' && expired)}>
            {action === 'setup' && !setup
              ? busy
                ? '正在准备…'
                : browser
                  ? '下一步'
                  : '重试'
              : busy
                ? action === 'setup' && expired
                  ? '正在准备…'
                  : '正在保存…'
                : '确认'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
