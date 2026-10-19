import { deviceSchema } from '@cc-desk-tunnel/protocol';

// Relative to the served entry directory, including a configured suffix. Query parameters and the
// one-use pairing fragment never enter API requests or the WebSocket URL.
export function webEndpoint(endpoint: 'session' | 'pair' | 'logout' | 'ws'): URL {
  return new URL(`web/${endpoint}`, window.location.href);
}

export type WebSession = {
  device: { id: string; name: string };
  expiresAt: null;
};

export class WebAccessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WebAccessError';
    this.status = status;
  }
}

// Browser credentials stay in an HttpOnly cookie. Neither the service secret nor a session token is
// returned to JavaScript, saved in localStorage, or included in a WebSocket URL.
async function access(path: string, body?: object, signal?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      throw new WebAccessError(
        typeof value?.message === 'string'
          ? value.message
          : typeof value?.error === 'string'
            ? value.error
            : '连接服务失败，请稍后重试。',
        response.status,
      );
    }
    return response.status === 204 ? null : await response.json();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (controller.signal.aborted) throw new Error('连接超时，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

function session(value: unknown): WebSession {
  const result = value as WebSession | null;
  const device = deviceSchema.safeParse(result?.device);
  if (!device.success || result?.expiresAt !== null)
    throw new Error('网页登录信息格式不兼容，请刷新页面。');
  return { device: device.data, expiresAt: result.expiresAt };
}

export async function getWebSession(signal?: AbortSignal): Promise<WebSession | null> {
  try {
    return session(await access(webEndpoint('session').pathname, undefined, signal));
  } catch (error) {
    if (error instanceof WebAccessError && error.status === 401) return null;
    throw error;
  }
}

export async function pairWeb(code: string, signal?: AbortSignal): Promise<WebSession> {
  return session(await access(webEndpoint('pair').pathname, { code: code.trim() }, signal));
}

export async function logoutWeb(signal?: AbortSignal): Promise<void> {
  try {
    await access(webEndpoint('logout').pathname, {}, signal);
  } catch (error) {
    if (!(error instanceof WebAccessError && error.status === 401)) throw error;
  }
}
