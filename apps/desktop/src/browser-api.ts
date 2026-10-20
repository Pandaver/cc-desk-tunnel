import { webLoginStateSchema } from '@cc-desk-tunnel/protocol';
import type { WebProof } from '@cc-desk-tunnel/protocol';

// The server redirects an entry without its trailing slash before serving the application.
export function browserEndpoint(name: string) {
  return new URL(`api/${name}`, new URL('./', location.href));
}
export function browserSocket() {
  const url = browserEndpoint('ws');
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
async function request(name: string, body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(browserEndpoint(name), {
      method: body === undefined ? 'GET' : 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const message =
        value && typeof value === 'object' && 'error' in value
          ? String(value.error)
          : '请求失败，请重试。';
      throw new Error(message);
    }
    return value;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接超时，请重试。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export const browserSession = async () => webLoginStateSchema.parse(await request('session'));
export const browserLogin = async (proof: WebProof) =>
  webLoginStateSchema.parse(await request('login', proof));
export const browserLogout = async () => {
  await request('logout', {});
};
