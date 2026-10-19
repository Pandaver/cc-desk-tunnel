import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const browserId = '00000000-0000-4000-8000-000000000301';
const storageKey = `proxy-latency-result:v2:browser:${browserId}`;

async function fixture(page: Page, supported = true) {
  const state = {
    identity: browserId,
    held: false,
    requests: [] as { socket: WebSocketRoute; requestId: string }[],
    sockets: [] as WebSocketRoute[],
  };
  await page.route('**/browser-entry/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/browser-entry/web/session')
      return route.fulfill({
        json: { device: { id: state.identity, name: '测试浏览器' }, expiresAt: null },
      });
    const file =
      path === '/browser-entry/'
        ? 'index.html'
        : path.startsWith('/browser-entry/assets/')
          ? path.slice('/browser-entry/'.length)
          : null;
    if (!file || file.includes('..')) return route.abort();
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
    };
    return route.fulfill({
      body: await readFile(resolve('apps/desktop/dist', file)),
      contentType: mime[extname(file)] ?? 'application/octet-stream',
    });
  });
  await page.routeWebSocket('**/browser-entry/web/ws', (socket) => {
    state.sockets.push(socket);
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'web.auth') {
        socket.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            connectionId: `00000000-0000-4000-8000-${String(state.sockets.length).padStart(12, '0')}`,
            version: '0.3.4',
            adapter: 'claude-code',
            sessions: [],
            ...(supported ? { diagnostics: true } : {}),
          }),
        );
      } else if (command.type === 'connection.probe') {
        state.requests.push({ socket, requestId: command.requestId });
        if (!state.held)
          socket.send(
            JSON.stringify({ type: 'connection.probe.result', requestId: command.requestId }),
          );
      } else if (command.requestId) {
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      }
    });
  });
  await page.goto('/browser-entry/');
  await expect(page.locator('.connection-status')).toContainText('已连接');
  return state;
}

const panel = (page: Page) => page.getByRole('dialog', { name: '连接诊断' });
async function complete(page: Page) {
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  await panel(page).getByRole('button', { name: '测试延迟', exact: true }).click();
  await expect(panel(page)).toContainText('5/5 次成功');
}
const saved = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), storageKey);

test('diagnostics samples only on demand, expands details, and keeps the latest result after refresh', async ({
  page,
}) => {
  const state = await fixture(page);
  expect(state.requests).toHaveLength(0);
  await complete(page);
  expect(state.requests).toHaveLength(5);
  await expect(panel(page).getByLabel('服务往返延迟')).toContainText('ms');
  await expect(panel(page).locator('.latency-route')).toHaveText('浏览器 ↔ 服务端');
  await panel(page).getByText('采样详情', { exact: true }).click();
  await expect(panel(page).locator('.latency-samples li')).toHaveCount(5);
  await expect(panel(page)).toContainText('最小');
  await expect(panel(page)).toContainText('最大');
  await page.screenshot({ path: test.info().outputPath('diagnostics-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('diagnostics-mobile.png') });
  const previous = await saved(page);
  expect(previous).not.toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '连接诊断', exact: true })).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  await expect(panel(page)).toContainText('5/5 次成功');
  await expect(panel(page).locator('.latency-timestamp')).toContainText('上次连接');
  expect(state.requests).toHaveLength(5);
  expect(await saved(page)).toBe(previous);
});

test('closing, focus loss and cancellation never replace the last complete measurement', async ({
  page,
}) => {
  const state = await fixture(page);
  await complete(page);
  const previous = await saved(page);
  state.held = true;
  for (const action of ['cancel', 'escape', 'outside', 'blur', 'hidden'] as const) {
    if (!(await panel(page).isVisible()))
      await page.getByRole('button', { name: '连接诊断', exact: true }).click();
    const count = state.requests.length;
    await panel(page).getByRole('button', { name: '测试延迟', exact: true }).click();
    await expect.poll(() => state.requests.length).toBe(count + 1);
    await expect(panel(page).getByRole('button', { name: '测试中…' })).toBeDisabled();
    if (action === 'cancel') {
      await panel(page).getByRole('button', { name: '取消测试' }).click();
      await expect(panel(page)).toContainText('测试已取消');
    } else {
      if (action === 'escape') await page.keyboard.press('Escape');
      if (action === 'outside') await page.locator('.titlebar h1').click();
      if (action === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (action === 'hidden')
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
          delete (document as { hidden?: boolean }).hidden;
        });
      await expect(panel(page)).toHaveCount(0);
    }
    const last = state.requests.at(-1)!;
    last.socket.send(
      JSON.stringify({ type: 'connection.probe.result', requestId: last.requestId }),
    );
    expect(await saved(page)).toBe(previous);
  }
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  await expect(panel(page)).toContainText('5/5 次成功');
  expect(state.requests).toHaveLength(10);
});

test('reconnection cancels an active run, preserves the complete result and does not retest', async ({
  page,
}) => {
  const state = await fixture(page);
  await complete(page);
  const previous = await saved(page);
  state.held = true;
  await panel(page).getByRole('button', { name: '测试延迟', exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(6);
  state.sockets.at(-1)!.close({ code: 1012 });
  await expect.poll(() => state.sockets.length).toBe(2);
  await expect(page.locator('.connection-status')).toContainText('已连接');
  if (!(await panel(page).isVisible()))
    await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  await expect(panel(page)).toContainText('5/5 次成功');
  await expect(panel(page).locator('.latency-timestamp')).toContainText('上次连接');
  expect(state.requests).toHaveLength(6);
  expect(await saved(page)).toBe(previous);
});

test('another paired browser identity does not inherit the previous identity result', async ({
  page,
}) => {
  const state = await fixture(page);
  await complete(page);
  state.identity = '00000000-0000-4000-8000-000000000302';
  await page.reload();
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  await expect(panel(page).getByLabel('服务往返延迟')).toHaveText('—');
  await expect(panel(page).locator('.latency-timestamp')).toHaveCount(0);
  expect(state.requests).toHaveLength(5);
});

test('an older service does not advertise a diagnostic action or receive probe traffic', async ({
  page,
}) => {
  const state = await fixture(page, false);
  await expect(page.getByRole('button', { name: '连接诊断', exact: true })).toHaveCount(0);
  expect(state.requests).toHaveLength(0);
});
