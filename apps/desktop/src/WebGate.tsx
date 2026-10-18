import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { App } from './App.tsx';
import { getWebSession, logoutWeb, pairWeb } from './browser-api.ts';
import type { WebSession } from './browser-api.ts';
import { takePairingCode } from './host-capabilities.ts';

// The HTTP-only session cookie authenticates this browser; the service credential is never requested.
export default function WebGate() {
  const pendingCode = useRef<string | null>(null);
  if (pendingCode.current === null) pendingCode.current = takePairingCode(window.location, history);
  const [session, setSession] = useState<WebSession | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loginNotice, setLoginNotice] = useState(0);
  const handledNotice = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const signedOut = useRef(false);
  const generation = useRef(0);
  const running = useRef(true);
  const checking = useRef<Promise<WebSession | null> | null>(null);
  const request = useRef<AbortController | null>(null);
  const check = useCallback((pairingCode?: string) => {
    generation.current++;
    signedOut.current = false;
    request.current?.abort();
    request.current = null;
    checking.current = null;
    if (pairingCode !== undefined) {
      pendingCode.current = pairingCode;
      setCode('');
    }
    running.current = true;
    setError('');
    setBusy(true);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    // Same-origin tabs share the HttpOnly cookie, but its successful response may arrive after another
    // tab has already checked a failed exchange. Announce only that a login completed, never its code
    // or identity. Browsers without this API retain the explicit login recheck.
    try {
      const current = new BroadcastChannel('cc-desk-tunnel:web-login');
      channel.current = current;
      current.onmessage = ({ data }) => {
        if (data?.type === 'login' && !signedOut.current) setLoginNotice((value) => value + 1);
      };
      return () => {
        channel.current = null;
        current.close();
      };
    } catch {
      return;
    }
  }, []);
  useEffect(() => {
    let current = true;
    const started = generation.current;
    const pairingCode = pendingCode.current;
    const { signal } = (request.current ??= new AbortController());
    // StrictMode may subscribe twice to this operation, but must never redeem the same code twice.
    checking.current ??= getWebSession(signal).then(async (saved) => {
      if (saved || !pairingCode || generation.current !== started) return saved;
      const announce = (value: WebSession) => {
        if (generation.current === started)
          try {
            channel.current?.postMessage({ type: 'login' });
          } catch {
            // Optional tab coordination must not turn a successful login into an error.
          }
        return value;
      };
      try {
        return announce(await pairWeb(pairingCode, signal));
      } catch (failure) {
        if (generation.current !== started) return null;
        // A sibling tab may already have redeemed the code, or the successful response was lost.
        // Only read the cookie here; another mutation requires an explicit retry.
        const recovered = await getWebSession(signal).catch(() => null);
        if (recovered) return announce(recovered);
        throw failure;
      }
    });
    const active = () => current && generation.current === started;
    void checking.current
      .then(
        (saved) => {
          if (!active()) return;
          if (saved) {
            pendingCode.current = '';
            setCode('');
          }
          // Reopening a pairing link in an already logged-in tab must not reset its workbench.
          setSession((current) =>
            saved && current?.device.id === saved.device.id ? current : saved,
          );
        },
        (failure) =>
          active() &&
          setError(failure instanceof Error ? failure.message : '读取登录状态失败，请重试。'),
      )
      .finally(() => {
        if (!active()) return;
        running.current = false;
        setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (
      !loginNotice ||
      handledNotice.current === loginNotice ||
      busy ||
      session ||
      signedOut.current
    )
      return;
    handledNotice.current = loginNotice;
    const started = generation.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    let current = true;
    // Wait for the explicit attempt to settle; a notice never interrupts or resends its mutation. A
    // subsequent explicit attempt or logout aborts this read and owns the resulting state instead.
    void getWebSession(controller.signal)
      .then((saved) => {
        if (!current || generation.current !== started || signedOut.current || !saved) return;
        pendingCode.current = '';
        setCode('');
        setError('');
        setSession(saved);
      })
      .catch(() => {
        // A notice is not authentication. Keep the existing error and manual retry on lookup failure.
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [loginNotice, busy, session]);
  useEffect(() => {
    const follow = () => {
      const pairingCode = takePairingCode(window.location, history);
      if (pairingCode) check(pairingCode);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [check]);
  const retry = () => {
    if (running.current) return;
    check();
  };
  const expired = useCallback(() => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    checking.current = null;
    pendingCode.current = '';
    running.current = false;
    setSession(null);
    setCode('');
    setBusy(false);
    setError('登录已失效，请重新配对。');
  }, []);
  const logout = useCallback(async () => {
    const started = ++generation.current;
    signedOut.current = true;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    checking.current = null;
    pendingCode.current = '';
    running.current = true;
    try {
      await logoutWeb(controller.signal);
      if (generation.current !== started) return;
      setSession(null);
      setCode('');
      setError('');
    } finally {
      if (generation.current === started) {
        running.current = false;
        setBusy(false);
      }
    }
  }, []);
  if (session) return <App webSession={session} onWebLogout={logout} onWebExpired={expired} />;
  return (
    <main className="login-page web-login">
      <div className="login-content">
        <span className="brand">CC Desk Tunnel</span>
        <h1 className="login-title">Web 工作台</h1>
        <p className="muted">在已连接的桌面客户端中生成配对码，访问在线设备的会话。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (running.current || !code.trim()) return;
            pendingCode.current = code.trim();
            retry();
          }}
        >
          <label className="field">
            <span>配对码</span>
            <input
              aria-label="配对码"
              type="password"
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={256}
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {error && !busy && !code && (
            <button type="button" className="button" onClick={retry}>
              重新检查登录
            </button>
          )}
          <button
            className="button primary login-submit"
            type="submit"
            disabled={busy || !code.trim()}
          >
            {busy && <LoaderCircle className="web-loading" aria-hidden="true" />}
            {busy ? '正在连接…' : '配对并进入'}
          </button>
        </form>
      </div>
    </main>
  );
}
