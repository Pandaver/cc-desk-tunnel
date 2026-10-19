import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { ConnectionOptions } from 'node:tls';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../../server/src/server.ts';
import {
  ca,
  custom,
  defaultCertificate,
  wrongDomain,
} from '../../server/test/fixtures/web-certificates.ts';
import { send, settled } from './helpers.ts';

// Only OS calls and local renderer assets are substituted. The desktop's real ProxyClient talks to
// the same server as the browser, including conditional pairing and live status subscriptions.
async function desktopSettings(
  page: Page,
  origin: string,
  token: string,
  device: { id: string; name: string },
  tls?: ConnectionOptions,
) {
  await page.route('**/desktop-settings/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/desktop-settings/'.length);
    const file = path || 'index.html';
    if (file.includes('..')) return route.abort();
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
  // Installed desktop uses a Node WebSocket bridge, not a renderer-origin connection. Forward raw
  // frames through the same kind of transport so the server's browser-origin rejection stays intact.
  const rendererUrl = origin.replace(/^https?:/, 'ws:') + '/ws';
  await page.routeWebSocket(rendererUrl, (socket) => {
    const proxy = new WebSocket(origin.replace('http', 'ws') + '/ws', tls);
    const pending: (string | Buffer)[] = [];
    socket.onMessage((raw) => {
      if (proxy.readyState === WebSocket.OPEN) proxy.send(raw);
      else pending.push(raw);
    });
    proxy.on('open', () => {
      for (const raw of pending) proxy.send(raw);
      pending.length = 0;
    });
    proxy.on('message', (raw) => socket.send(String(raw)));
    proxy.on('error', () => socket.close({ code: 1011 }));
    proxy.on('close', (code, reason) =>
      socket.close({ code: code === 1005 || code === 1006 ? 1000 : code, reason: String(reason) }),
    );
    socket.onClose(() => proxy.close());
  });
  await page.addInitScript(
    ({ rendererUrl, token, device }) => {
      const nothing = async () => undefined;
      const listen = () => () => {};
      window.desktop = {
        platform: 'win32',
        dev: true,
        boot: { connection: '', shared: { connections: [], busy: [] } },
        version: async () => '0.3.4',
        device: async () => device,
        loadLogin: async () => ({
          url: rendererUrl,
          token,
          fingerprint: '',
          mode: 'local',
          remember: true,
          autoLogin: true,
        }),
        saveLogin: nothing,
        disconnectProxy: nothing,
        onSharedChanged: listen,
        onUpdateProgress: listen,
        onNotifyClicked: listen,
        onSchedulesChanged: listen,
        saveShared: nothing,
        loadDrafts: async () => ({}),
        saveDrafts: nothing,
        setBusy: nothing,
        notify: nothing,
        workspaceRoots: async () => [],
        foldersExist: async (paths: string[]) => paths.map(() => true),
        loadSchedules: async () => ({ path: '', text: '{"tasks":[]}' }),
        windowSettings: async () => ({ closeToTray: true }),
        connections: async () => [{ id: '', name: '当前连接', current: true, open: true }],
        copyText: nothing,
        openExternal: nothing,
      } as unknown as NonNullable<typeof window.desktop>;
    },
    { rendererUrl, token, device },
  );
  await page.goto('/desktop-settings/');
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await page.getByRole('button', { name: '设置与账号' }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  return page.locator('.server-web-access');
}

// Unlike the UI fixtures, this uses the real HTTP cookie exchange, WebSocket authentication and
// session core, with the existing model-free adapter and an isolated data directory.
test('desktop settings initialize pairing and the production browser controls an existing device session', async ({
  page,
  context,
}, info) => {
  test.setTimeout(60000);
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((done, fail) =>
    reservation.close((error) => (error ? fail(error) : done())),
  );
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-ui-'));
  const token = randomUUID();
  const executor = { id: randomUUID(), name: '在线开发电脑' };
  const server = createProxyServer({
    token,
    dataDir: directory,
    stepMs: 40,
    web: { origin, directory: resolve('apps/desktop/dist') },
  });
  const messages: ServerMessage[] = [];
  let desktop: WebSocket | undefined;
  const controlPage = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  controlPage.on('pageerror', (error) => errors.push(error.message));
  async function wait(predicate: (message: ServerMessage) => boolean) {
    await expect.poll(() => messages.findIndex(predicate)).toBeGreaterThanOrEqual(0);
    return messages.splice(messages.findIndex(predicate), 1)[0];
  }
  async function request(command: object) {
    const requestId = randomUUID();
    desktop!.send(JSON.stringify({ ...command, requestId }));
    const response = await wait((m) => m.type === 'response' && m.requestId === requestId);
    if (response.type !== 'response' || !response.ok) throw new Error(JSON.stringify(response));
    return response;
  }
  async function select(target: Page, name = '浏览器验收会话') {
    await target
      .locator('.session-row')
      .filter({ hasText: name })
      .getByRole('button')
      .first()
      .click();
    await expect(target.getByRole('textbox', { name: '消息' })).toBeVisible();
  }
  try {
    await server.listen(address.port);
    desktop = new WebSocket(origin.replace('http', 'ws') + '/ws');
    desktop.on('message', (raw) =>
      messages.push(serverMessageSchema.parse(JSON.parse(String(raw)))),
    );
    await new Promise<void>((done, fail) => {
      desktop!.once('open', done);
      desktop!.once('error', fail);
    });
    desktop.send(
      JSON.stringify({
        type: 'auth',
        token,
        protocolVersion: PROTOCOL_VERSION,
        deviceName: executor.name,
      }),
    );
    desktop.send(JSON.stringify({ type: 'device', id: executor.id }));
    await wait((m) => m.type === 'ready');
    const created = await request({
      type: 'session.create',
      title: '浏览器验收会话',
      projectPath: 'C:\\test-project',
    });
    await request({
      type: 'session.create',
      title: '另一个会话',
      projectPath: 'C:\\another-project',
    });
    expect((await fetch(origin)).status).toBe(404);
    await request({ type: 'web.status', watch: true });
    const panel = await desktopSettings(controlPage, origin, token, executor);
    await expect(panel.getByRole('switch')).not.toBeChecked();
    await expect(panel.getByRole('button')).toHaveCount(0);
    await panel.getByRole('switch').click();
    await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
    await panel.getByRole('button', { name: '显示配对码', exact: true }).click();
    const code = await panel.getByLabel('配对码', { exact: true }).innerText();
    expect(code).toMatch(/^[a-f0-9]{24}$/);
    const categories = controlPage.getByRole('navigation', { name: '设置分类' });
    await categories.getByRole('button', { name: '通知', exact: true }).click();
    await categories.getByRole('button', { name: '常规', exact: true }).click();
    await panel.getByRole('button', { name: '显示配对码', exact: true }).click();
    await expect(panel.getByLabel('配对码', { exact: true })).toHaveText(code);
    const enabledStatus = await request({ type: 'web.status' });
    const enabledState = await wait(
      (m) => m.type === 'web.state' && m.requestId === enabledStatus.requestId,
    );
    if (enabledState.type !== 'web.state' || !enabledState.url || !enabledState.path)
      throw new Error('Missing enabled browser address');
    let entry = enabledState.url;
    expect(entry).toBe(`${origin}/${enabledState.path}/`);
    expect(enabledState.path).toMatch(/^[a-f0-9]{32}$/);
    await expect(panel.getByRole('textbox', { name: '服务端访问路径', exact: true })).toHaveValue(
      enabledState.path,
    );
    await expect(panel.getByLabel('服务端访问地址', { exact: true })).toHaveText(
      `${origin}/${enabledState.path.slice(0, 5)}...`,
    );
    const servedRequests: string[] = [];
    const browserSockets: string[] = [];
    page.on('request', (request) => servedRequests.push(request.url()));
    page.on('websocket', (socket) => browserSockets.push(socket.url()));
    await page.goto(`${entry}#pair=${code}`);
    await expect(page.locator('.connection-status')).toContainText('已连接');
    expect(new URL(page.url()).hash).toBe('');
    expect(
      servedRequests.filter((url) => url.startsWith(origin)).every((url) => url.startsWith(entry)),
    ).toBe(true);
    expect(servedRequests.some((url) => url.startsWith(`${entry}assets/`))).toBe(true);
    expect(servedRequests).toContain(`${entry}web/session`);
    expect(servedRequests).toContain(`${entry}web/pair`);
    expect(browserSockets).toContain(`${entry.replace('http', 'ws')}web/ws`);
    await expect(panel.locator('summary')).toContainText('1');
    await expect(panel.getByLabel('配对码未生成')).toHaveText('—');
    await page.getByRole('button', { name: '连接诊断', exact: true }).click();
    const diagnostics = page.getByRole('dialog', { name: '连接诊断' });
    await diagnostics.getByRole('button', { name: '测试延迟', exact: true }).click();
    await expect(diagnostics).toContainText('5/5 次成功');
    await expect(diagnostics.locator('.latency-route')).toContainText('浏览器');
    await page.keyboard.press('Escape');
    await expect(diagnostics).toHaveCount(0);
    await select(page);
    await send(page, '从浏览器操作现有会话');
    await settled(page);
    await expect(page.locator('.message.assistant strong')).toContainText('离线模拟回复');
    expect(server.store.get(created.sessionId!).session.device?.id).toBe(executor.id);
    expect(desktop.readyState).toBe(WebSocket.OPEN);
    const pairedState = await wait((m) => m.type === 'web.changed' && m.grants.length === 1);
    expect(pairedState.type === 'web.changed' && pairedState.pairing).toBeUndefined();
    const cookies = await context.cookies(origin);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(cookies[0].name).toMatch(/^cc_web_session_[a-f0-9]{16}$/);
    const storage = await page.evaluate(
      () => `${document.cookie}\n${JSON.stringify({ ...localStorage, ...sessionStorage })}`,
    );
    for (const secret of [token, code, cookies[0].value]) expect(storage).not.toContain(secret);
    await page.screenshot({ path: info.outputPath('server-web-desktop.png') });
    await categories.getByRole('button', { name: '通知', exact: true }).click();
    await categories.getByRole('button', { name: '常规', exact: true }).click();
    await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
    await panel.getByRole('button', { name: '显示配对码', exact: true }).click();
    await expect(panel.getByLabel('配对码', { exact: true })).not.toHaveText(code);
    expect((await context.cookies(origin))[0].value).toBe(cookies[0].value);

    const other = await context.newPage();
    await other.goto(entry);
    await select(other, '另一个会话');
    await expect(page.locator('.session-row.selected strong')).toHaveText('浏览器验收会话');
    await expect(other.locator('.session-row.selected strong')).toHaveText('另一个会话');
    await other.close();

    // A path update changes every browser endpoint, but not its cookie, grant, or desktop socket.
    const oldEntry = entry;
    const oldAsset = servedRequests.find((url) => url.startsWith(`${oldEntry}assets/`));
    expect(oldAsset).toBeTruthy();
    const beforePath = await (await context.request.get(`${entry}web/session`)).json();
    const changing = panel.getByRole('textbox', { name: '服务端访问路径', exact: true });
    await changing.fill('updated-workbench');
    await changing.blur();
    await expect(changing).toBeEnabled();
    const update = await wait((m) => m.type === 'web.changed' && m.path === 'updated-workbench');
    if (update.type !== 'web.changed' || !update.url)
      throw new Error('Missing updated browser address');
    entry = update.url;
    expect(entry).toBe(`${origin}/updated-workbench/`);
    await expect(page.locator('.connection-status')).not.toContainText('已连接');
    await expect(
      page.getByText('访问地址不可用，请从桌面设置获取当前地址。', { exact: true }),
    ).toBeVisible();
    for (const target of [
      origin,
      oldEntry,
      `${oldEntry}web/session`,
      oldAsset!,
      `${origin}/web/session`,
    ]) {
      const response = await context.request.get(target);
      expect(response.status()).toBe(404);
      expect(await response.text()).toBe('');
      expect(response.headers().location).toBeUndefined();
    }
    expect(desktop.readyState).toBe(WebSocket.OPEN);
    expect((await context.cookies(origin))[0].value).toBe(cookies[0].value);
    await page.goto(entry);
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await expect(page.getByLabel('配对码', { exact: true })).toHaveCount(0);
    const afterPath = await (await context.request.get(`${entry}web/session`)).json();
    expect(afterPath.device.id).toBe(beforePath.device.id);

    // Clearing a live custom suffix moves the complete browser surface to root without logging out.
    const customEntry = entry;
    const customAsset = servedRequests.find((url) => url.startsWith(`${customEntry}assets/`));
    expect(customAsset).toBeTruthy();
    await changing.fill('');
    await changing.blur();
    await expect(changing).toBeEnabled();
    const rootUpdate = await wait((m) => m.type === 'web.changed' && m.path === '');
    if (rootUpdate.type !== 'web.changed' || !rootUpdate.url)
      throw new Error('Missing root browser address');
    entry = rootUpdate.url;
    expect(entry).toBe(`${origin}/`);
    await expect(changing).toHaveValue('');
    await expect(panel.getByLabel('服务端访问地址', { exact: true })).toHaveText(entry);
    await expect(
      page.getByText('访问地址不可用，请从桌面设置获取当前地址。', { exact: true }),
    ).toBeVisible();
    for (const target of [customEntry, `${customEntry}web/session`, customAsset!]) {
      const response = await context.request.get(target);
      expect(response.status()).toBe(404);
      expect(await response.text()).toBe('');
      expect(response.headers().location).toBeUndefined();
    }
    expect((await context.request.get(`${origin}/health`)).status()).toBe(200);
    expect(desktop.readyState).toBe(WebSocket.OPEN);
    expect((await context.cookies(origin))[0].value).toBe(cookies[0].value);
    await page.goto(entry);
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await expect(page.getByLabel('配对码', { exact: true })).toHaveCount(0);
    expect(servedRequests.some((url) => url.startsWith(`${origin}/assets/`))).toBe(true);
    expect(servedRequests).toContain(`${origin}/web/session`);
    expect(browserSockets).toContain(`${origin.replace('http', 'ws')}/web/ws`);
    const rootSession = await (await context.request.get(`${entry}web/session`)).json();
    expect(rootSession.device.id).toBe(beforePath.device.id);
    await select(page);
    await request({
      type: 'session.rename',
      sessionId: created.sessionId,
      title: '路径更新后桌面仍可操作',
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await send(page, '审批链路', 'tool');
    await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('server-web-mobile-approval.png') });
    await page.getByRole('button', { name: '允许', exact: true }).click();
    await settled(page);
    await send(page, '停止链路', 'tool');
    await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '停止运行', exact: true }).click();
    await settled(page);
    expect(server.store.get(created.sessionId!).session.activeRun).toBeNull();
    const session = await (await context.request.get(`${entry}web/session`)).json();
    await request({ type: 'web.revoke', grantId: session.device.id });
    await expect(page.getByLabel('配对码', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('登录已失效');
    await page.screenshot({ path: info.outputPath('server-web-mobile-login.png') });
    await expect(page.locator('.shell')).toHaveCount(0);
    expect(desktop.readyState).toBe(WebSocket.OPEN);
    await request({ type: 'session.rename', sessionId: created.sessionId, title: '桌面仍可操作' });
    const pairRequest = await request({ type: 'web.pair' });
    const nextPairing = await wait(
      (m) => m.type === 'web.state' && m.requestId === pairRequest.requestId && !!m.pairing,
    );
    if (nextPairing.type !== 'web.state' || !nextPairing.pairing)
      throw new Error('Missing new pairing code');
    await page.goto(`${entry}#pair=${nextPairing.pairing.code}`);
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await request({ type: 'web.configure', enabled: false });
    await expect(
      page.getByText('访问地址不可用，请从桌面设置获取当前地址。', { exact: true }),
    ).toBeVisible();
    expect((await fetch(origin)).status).toBe(404);
    expect((await fetch(`${entry}web/session`)).status).toBe(404);
    expect(desktop.readyState).toBe(WebSocket.OPEN);
    await request({
      type: 'session.rename',
      sessionId: created.sessionId,
      title: '关闭 Web 后桌面仍可操作',
    });
    await request({ type: 'web.configure', enabled: true });
    expect((await fetch(entry)).status).toBe(200);
    await page.reload();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await expect(page.getByLabel('配对码', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await controlPage.close();
    desktop?.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('desktop certificate form configures real SNI while preserving the IP certificate', async ({
  page,
}) => {
  test.setTimeout(60000);
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((done, fail) =>
    reservation.close((error) => (error ? fail(error) : done())),
  );
  const port = address.port;
  const origin = `https://127.0.0.1:${port}`;
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-certificate-ui-'));
  const token = randomUUID();
  const defaultPin = new X509Certificate(defaultCertificate.cert).fingerprint256;
  const customPin = new X509Certificate(custom.cert).fingerprint256;
  const defaultTls: ConnectionOptions = {
    ca: defaultCertificate.cert,
    rejectUnauthorized: true,
    checkServerIdentity: (_host, certificate) =>
      certificate.fingerprint256 === defaultPin
        ? undefined
        : new Error('Test default certificate changed'),
  };
  const server = createProxyServer({
    token,
    dataDir: directory,
    tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
    web: { origin, directory: resolve('apps/desktop/dist') },
  });
  async function fingerprint(domain?: string) {
    return new Promise<string>((resolve, reject) => {
      const socket = connectTls({
        host: '127.0.0.1',
        port,
        ...(domain ? { servername: domain, ca, rejectUnauthorized: true } : defaultTls),
      });
      socket.setTimeout(5000, () => socket.destroy(new Error('Test TLS timeout')));
      socket.on('error', reject);
      socket.once('secureConnect', () => {
        resolve(socket.getPeerCertificate().fingerprint256);
        socket.destroy();
      });
    });
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await server.listen(port);
    const panel = await desktopSettings(
      page,
      origin,
      token,
      { id: randomUUID(), name: '证书管理测试设备' },
      defaultTls,
    );
    await panel.getByRole('switch', { name: '启用 Web 访问' }).click();
    const domain = panel.getByRole('textbox', { name: '访问域名', exact: true });
    await domain.fill('web.example.test');
    await domain.blur();
    await expect(panel.getByLabel('服务端访问地址', { exact: true })).toContainText(
      'web.example.test',
    );
    await panel.getByRole('button', { name: '管理 HTTPS 证书' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '证书链 PEM', exact: true }).fill(wrongDomain.cert);
    await dialog.getByRole('textbox', { name: '私钥 PEM', exact: true }).fill(wrongDomain.key);
    await dialog.getByRole('button', { name: '保存证书', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('未覆盖');
    expect(await fingerprint()).toBe(defaultPin);
    await dialog.getByRole('textbox', { name: '证书链 PEM', exact: true }).fill(custom.cert);
    await dialog.getByRole('textbox', { name: '私钥 PEM', exact: true }).fill(custom.key);
    await dialog.getByRole('button', { name: '保存证书', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByText('自定义证书', { exact: true })).toBeVisible();
    expect(await fingerprint('web.example.test')).toBe(customPin);
    expect(await fingerprint()).toBe(defaultPin);
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await expect(domain).toBeDisabled();
    await panel.getByRole('button', { name: '管理 HTTPS 证书' }).click();
    await expect(dialog.getByRole('textbox', { name: '私钥 PEM', exact: true })).toHaveValue('');
    await expect(dialog.getByRole('textbox', { name: '证书链 PEM', exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: '恢复默认', exact: true }).click();
    await dialog.getByRole('button', { name: '恢复默认证书', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(domain).toBeEnabled();
    expect(await fingerprint()).toBe(defaultPin);
    await expect(page.locator('.connection-status')).toContainText('已连接');
    const storage = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(storage).not.toContain('PRIVATE KEY');
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
