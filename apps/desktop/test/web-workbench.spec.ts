import { test as base, expect, _electron } from '@playwright/test';
import type {
  Browser,
  BrowserContext,
  ElectronApplication,
  Locator,
  Page,
  WebSocketRoute,
} from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { nativeSettingsSchema, PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { DomainError } from '../../server/src/errors.ts';
import { createProxyServer } from '../../server/src/server.ts';
import { readInstructions, writeInstructions } from '../../server/src/native-instructions.ts';
import { login, send, sessionAction, settled } from './helpers.ts';
import type { LatencyMetric, LatencyResult } from '../src/latency.ts';

type Desktop = {
  application: ElectronApplication;
  page: Page;
  profile: string;
  project: string;
};
const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({}, use) => {
    const profiles = resolve('.local/ui-test');
    const profile = mkdtempSync(join(profiles, 'web-profile-'));
    const project = join(profile, 'project');
    mkdirSync(project);
    // Give each isolated desktop a private loopback port before the first UI enable.
    writeFileSync(
      join(profile, 'settings.json'),
      JSON.stringify({ remoteControl: { port: await unusedPort(), lan: false } }),
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
      ),
    );
    const application = await _electron.launch({
      args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
      env,
    });
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
      await login(page);
      // Only the native directory picker is supplied a test folder. The real renderer, preload,
      // main process, Web listener and the existing development service handle all operations.
      await application.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [folder],
        })) as typeof dialog.showOpenDialog;
      }, project);
      await page.getByRole('button', { name: '添加项目', exact: true }).click();
      await use({ application, page, profile, project });
    } finally {
      await application.close();
      const child = relative(profiles, resolve(profile));
      if (!child || child.startsWith('..') || isAbsolute(child))
        throw new Error('The test profile is not inside the UI test directory.');
      rmSync(profile, { recursive: true, force: true });
    }
  },
});

async function general(page: Page) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '常规', exact: true })
    .click();
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function enable(page: Page) {
  await general(page);
  await expect(page.getByRole('spinbutton', { name: '本地监听端口', exact: true })).toBeHidden();
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await page
    .getByRole('spinbutton', { name: '本地监听端口', exact: true })
    .fill(String(await unusedPort()));
  await page.getByRole('spinbutton', { name: '本地监听端口', exact: true }).blur();
  await expect(page.getByRole('button', { name: '复制本机地址', exact: true })).toBeEnabled();
  const status = await page.evaluate(() => window.desktop!.remoteStatus!());
  expect(status.enabled).toBe(true);
  return { url: status.url!, token: status.token! };
}

async function pair(
  browser: Browser,
  access: { url: string; token: string },
  other = false,
  prepare?: (context: BrowserContext) => Promise<void>,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(other
      ? { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' }
      : {}),
  });
  try {
    await prepare?.(context);
    const page = await context.newPage();
    await page.goto(access.url);
    await page.getByLabel('配对码', { exact: true }).fill(access.token);
    await page.getByRole('button', { name: '连接工作台', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function create(page: Page, project: string, title: string) {
  await page.getByRole('button', { name: `新建会话 · ${project}`, exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText('新会话');
  await sessionAction(page, '重命名');
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(title);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText(title);
}

async function select(page: Page, title: string) {
  await page
    .locator('.session-row')
    .filter({ has: page.getByText(title, { exact: true }) })
    .locator('.session-select')
    .click();
}

// Only the remote service is a test fixture. The application uses its real TLS bridge and
// pinned-certificate check; browser probes pass through its real Web listener and preload.
async function latencyService() {
  const script = `$key = [Security.Cryptography.RSA]::Create(2048)
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, 'SHA256', [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
    @{ cert = $certificate.ExportCertificatePem(); key = $key.ExportPkcs8PrivateKeyPem() } | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)(
    'pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true },
  );
  const tls = JSON.parse(stdout) as { cert: string; key: string };
  const server = createHttpsServer(tls);
  const sockets = new WebSocketServer({ server, autoPong: false });
  const token = 'test-only-latency-service-credential';
  const state = { probes: 0, authentications: 0, answer: true };
  sockets.on('connection', (socket) => {
    socket.on('error', () => {});
    socket.on('ping', (payload) => {
      if (String(payload).startsWith('latency:')) {
        state.probes++;
        if (!state.answer) return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.pong(payload);
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'auth') return;
      if (message.token !== token) return socket.close(1008, 'Invalid test token');
      state.authentications++;
      socket.send(
        JSON.stringify({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'simulation',
          sessions: [],
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    state,
    token,
    url: `wss://127.0.0.1:${(server.address() as { port: number }).port}/ws`,
    fingerprint: new X509Certificate(tls.cert).fingerprint256,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectLatencyService(
  page: Page,
  service: Awaited<ReturnType<typeof latencyService>>,
) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
  await page.getByRole('button', { name: '远程代理', exact: true }).click();
  await page.getByLabel('服务地址', { exact: true }).fill(service.url);
  await page.getByLabel('服务凭据', { exact: true }).fill(service.token);
  await page.getByLabel('服务证书指纹', { exact: true }).fill(service.fingerprint);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
}

async function diagnostics(page: Page) {
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  return page.getByRole('dialog', { name: '连接诊断', exact: true });
}

async function latencyResult(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) => key.endsWith('proxy-latency-result'));
    return key ? sessionStorage.getItem(key) : null;
  });
}

async function expectLatencyDetails(page: Page, panel: Locator, remote: boolean) {
  const saved: LatencyResult = JSON.parse((await latencyResult(page))!);
  const metrics: [LatencyMetric, string][] = remote
    ? [
        ['full', '完整链路'],
        ['workbench', '工作台'],
        ['service', '服务连接'],
      ]
    : [['service', '服务连接']];
  const format = (value: number) => (value < 1 ? '<1' : String(Math.round(value)));
  await expect(panel.locator('.latency-detail')).toHaveCount(metrics.length);
  for (const [key, label] of metrics) {
    const detail = panel.getByRole('region', { name: label, exact: true });
    const { values } = saved.metrics[key]!;
    await expect(detail.locator('.latency-range dd')).toHaveText([
      `${format(Math.min(...values))} ms`,
      `${format(Math.max(...values))} ms`,
    ]);
    await expect(
      detail.getByRole('list', { name: '成功采样 (ms)' }).getByRole('listitem'),
    ).toHaveText(values.map(format));
    await expect(detail.locator('.latency-issues')).toHaveCount(0);
  }
}

test.describe('Electron Web workbench', () => {
  test.skip(process.platform !== 'win32', 'Windows Electron integration');
  test.setTimeout(120_000);

  test('browser connection states distinguish pending, failed, retry and automatic recovery', async ({
    desktop,
    browser,
  }, testInfo) => {
    await create(desktop.page, desktop.project, '连接状态回归');
    const access = await enable(desktop.page);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      await page.clock.install();
      let hold = true;
      let snapshot:
        { revision: number; state: Record<string, unknown>; [key: string]: unknown } | undefined;
      const transports: { route: WebSocketRoute; server: WebSocketRoute; release: () => void }[] =
        [];
      // Delay real desktop snapshots, not application state. All RPCs still use the real listener.
      await page.routeWebSocket(/\/api\/control(?:\?|$)/, (route) => {
        const server = route.connectToServer();
        const pending: (string | Buffer)[] = [];
        let chunks: string[] = [];
        server.onMessage((message) => {
          let value = JSON.parse(String(message));
          if (value.type === 'client:chunk') {
            if (value.index === 0) chunks = [];
            chunks.push(value.text);
            if (value.index === value.total - 1) value = JSON.parse(chunks.join(''));
          }
          if (value.type === 'client:state' && value.full) snapshot = value;
          if (hold) pending.push(message);
          else route.send(message);
        });
        transports.push({
          route,
          server,
          release: () => pending.splice(0).forEach((message) => route.send(message)),
        });
      });
      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations++;
      });
      await page.goto(access.url);
      await page.getByLabel('配对码', { exact: true }).fill(access.token);
      await page.getByRole('button', { name: '连接工作台', exact: true }).click();
      const waiting = page.locator('.login-content');
      await expect(waiting.getByRole('status')).toHaveText('正在连接桌面客户端的工作台…');
      await expect(waiting.getByRole('button')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('web-connecting-wide.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath('web-connecting-narrow.png') });
      const navigationCount = navigations;
      await page.clock.fastForward(51000);
      await expect(waiting.getByRole('alert')).toContainText('超时');
      await expect(waiting.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath('web-connection-failed.png') });
      await page.clock.fastForward(10000);
      expect(transports.length).toBe(1);
      await waiting.getByRole('button', { name: '重试', exact: true }).click();
      await expect(waiting.getByRole('status')).toHaveText('正在连接桌面客户端的工作台…');
      await expect(waiting.getByRole('button')).toHaveCount(0);
      await expect.poll(() => transports.length).toBe(2);
      hold = false;
      transports.at(-1)!.release();
      await expect(page.locator('.connection-status')).toContainText('已连接');
      expect(navigations).toBe(navigationCount);
      await page.setViewportSize({ width: 1280, height: 900 });
      const draft = '连接恢复时保留未发送的草稿';
      await page.getByRole('textbox', { name: '消息', exact: true }).fill(draft);
      hold = true;
      await transports.at(-1)!.route.close({ code: 1012, reason: 'test reconnect' });
      await transports.at(-1)!.server.close();
      await expect(
        page.getByText('与桌面客户端的连接已断开，正在自动重连…', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: /^(重试|重新连接|断开并回到登录页)$/ }),
      ).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(draft);
      await page.screenshot({ path: testInfo.outputPath('web-reconnecting.png') });
      await page.clock.fastForward(1100);
      await expect.poll(() => transports.length).toBe(3);
      hold = false;
      transports.at(-1)!.release();
      await expect(page.locator('.connection-status')).toContainText('已连接');
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(draft);
      expect(navigations).toBe(navigationCount);
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');
      // The Web transport is healthy in these states; only the desktop's service status changes.
      // Derive complete frames from the real snapshot so HTTP polling cannot race the UI assertions.
      hold = true;
      expect(snapshot).toBeDefined();
      let revision = snapshot!.revision + 100;
      for (const [status, text] of [
        ['connecting', '桌面客户端正在连接代理服务…'],
        ['disconnected', '请先在桌面客户端连接代理服务。'],
        ['reconnecting', '桌面客户端正在重新连接代理服务…'],
      ]) {
        transports.at(-1)!.route.send(
          JSON.stringify({
            ...snapshot,
            revision: revision++,
            state: { ...snapshot!.state, status, error: '代理服务认证失败' },
          }),
        );
        await expect(page.getByText(text, { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /^(重试|重新连接)$/ })).toHaveCount(0);
        if (status === 'disconnected')
          await expect(page.getByRole('alert')).toHaveText('代理服务：代理服务认证失败');
      }
      expect(transports.length).toBe(3);
    } finally {
      await context.close();
    }
  });

  test('connection diagnostics reuse the real business bridge through local and relayed browsers', async ({
    desktop,
    browser,
  }, testInfo) => {
    const service = await latencyService();
    const contexts: BrowserContext[] = [];
    const relay = createProxyServer({
      token: 'test-only-latency-relay-credential',
      dataDir: join(desktop.profile, 'latency-relay'),
      webRelay: { port: await unusedPort() },
    });
    try {
      await connectLatencyService(desktop.page, service);
      const local = await enable(desktop.page);
      const first = await pair(browser, local);
      const second = await pair(browser, local, true);
      contexts.push(first.context, second.context);
      const desktopPanel = await diagnostics(desktop.page);
      await expect(
        desktopPanel.getByRole('button', { name: '测试延迟', exact: true }),
      ).toBeEnabled();
      expect(service.state.probes).toBe(0);
      await desktopPanel.getByRole('button', { name: '测试延迟', exact: true }).click();
      await expect(desktopPanel.locator('[data-metric="service"]')).toContainText('5/5');
      await expect(desktopPanel.getByLabel('服务连接延迟', { exact: true })).toHaveText(/ms$/);
      expect(service.state.probes).toBe(5);
      const desktopSummary = desktopPanel.locator('summary');
      await desktopSummary.focus();
      await desktop.page.keyboard.press('Enter');
      await expect(desktopPanel.locator('details')).toHaveJSProperty('open', true);
      await expectLatencyDetails(desktop.page, desktopPanel, false);
      await desktop.page.keyboard.press('Space');
      await expect(desktopPanel.locator('details')).toHaveJSProperty('open', false);
      await desktop.page.keyboard.press('Enter');
      await expect(desktopPanel.locator('details')).toHaveJSProperty('open', true);
      await expect(desktopSummary.locator('svg')).toHaveCSS(
        'transform',
        'matrix(0, 1, -1, 0, 0, 0)',
      );
      expect(service.state.probes).toBe(5);
      await desktop.page.screenshot({ path: testInfo.outputPath('desktop-latency.png') });
      await desktop.page.getByRole('button', { name: '连接诊断', exact: true }).click();

      const firstPanel = await diagnostics(first.page);
      await firstPanel.getByRole('button', { name: '测试延迟', exact: true }).click();
      for (const metric of ['full', 'workbench', 'service'])
        await expect(firstPanel.locator(`[data-metric="${metric}"]`)).toContainText('5/5');
      expect(service.state.probes).toBe(10);
      const saved = await latencyResult(first.page);
      expect(saved).not.toBeNull();
      await firstPanel.locator('summary').click();
      await expectLatencyDetails(first.page, firstPanel, true);
      await first.page.screenshot({ path: testInfo.outputPath('browser-latency.png') });
      await first.page.setViewportSize({ width: 390, height: 844 });
      await expect(firstPanel).toBeVisible();
      expect(
        await first.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      expect(await firstPanel.evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(
        true,
      );
      await first.page.screenshot({ path: testInfo.outputPath('browser-latency-narrow.png') });
      await first.page.setViewportSize({ width: 1280, height: 900 });
      await first.page.keyboard.press('Escape');
      await expect(firstPanel).not.toBeVisible();
      await expect(first.page.getByRole('button', { name: '连接诊断', exact: true })).toBeFocused();
      await first.page.keyboard.press('Enter');
      await expect(firstPanel).toBeVisible();
      expect(await latencyResult(first.page)).toBe(saved);
      const otherPanel = await diagnostics(second.page);
      await expect(otherPanel.locator('[data-metric="workbench"]')).not.toContainText('5/5');
      expect(await latencyResult(second.page)).toBeNull();
      await first.page.reload();
      await expect(first.page.locator('.connection-status')).toContainText('已连接');
      const restored = await diagnostics(first.page);
      await expect(restored.locator('[data-metric="workbench"]')).toContainText('5/5');
      expect(await latencyResult(first.page)).toBe(saved);
      expect(service.state.probes).toBe(10);

      // An independent real relay forwards the same browser control channel. Changing the
      // saved relay target must not replace the existing, measured business connection.
      const relayOrigin = await relay.listen(0);
      await desktop.page.evaluate(async (origin) => {
        await window.desktop!.saveLogin({
          mode: 'remote',
          url: `${origin.replace('http:', 'ws:')}/ws`,
          token: 'test-only-latency-relay-credential',
          fingerprint: '',
          remember: false,
          autoLogin: false,
        });
        await window.desktop!.configureRelay!(true);
      }, relayOrigin);
      await expect
        .poll(() =>
          desktop.page.evaluate(() => window.desktop!.relayStatus!().then((s) => s.state)),
        )
        .toBe('online');
      const relayStatus = await desktop.page.evaluate(() => window.desktop!.relayStatus!());
      const remote = await pair(browser, { url: relayStatus.url!, token: local.token });
      contexts.push(remote.context);
      const remotePanel = await diagnostics(remote.page);
      await remotePanel.getByRole('button', { name: '测试延迟', exact: true }).click();
      for (const metric of ['full', 'workbench', 'service'])
        await expect(remotePanel.locator(`[data-metric="${metric}"]`)).toContainText('5/5');
      expect(service.state.probes).toBe(15);
      expect(service.state.authentications).toBe(1);
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');
    } finally {
      await Promise.allSettled(contexts.map((context) => context.close()));
      await desktop.page.evaluate(() => window.desktop!.configureRelay!(false)).catch(() => {});
      await relay.close();
      await service.close();
    }
  });

  test('connection diagnostics cancel and time out without reconnecting or replacing previous results', async ({
    desktop,
    browser,
  }, testInfo) => {
    const service = await latencyService();
    let context: BrowserContext | undefined;
    try {
      await connectLatencyService(desktop.page, service);
      const access = await enable(desktop.page);
      const paired = await pair(browser, access);
      context = paired.context;
      const page = paired.page;
      let panel = await diagnostics(page);
      await panel.getByRole('button', { name: '测试延迟', exact: true }).click();
      await expect(panel.locator('[data-metric="service"]')).toContainText('5/5');
      const saved = await latencyResult(page);
      expect(service.state.probes).toBe(5);

      service.state.answer = false;
      await panel.getByRole('button', { name: '测试延迟', exact: true }).click();
      await expect.poll(() => service.state.probes).toBe(6);
      await page.getByRole('button', { name: '连接诊断', exact: true }).click();
      await expect(panel).not.toBeVisible();
      expect(await latencyResult(page)).toBe(saved);
      panel = await diagnostics(page);
      await expect(panel.getByRole('button', { name: '测试延迟', exact: true })).toBeEnabled();
      await expect(panel.locator('[data-metric="service"]')).toContainText('5/5');

      await panel.getByRole('button', { name: '测试延迟', exact: true }).click();
      await expect.poll(() => service.state.probes).toBe(7);
      await panel.getByRole('button', { name: '取消测试', exact: true }).click();
      await expect(panel.getByRole('button', { name: '测试延迟', exact: true })).toBeEnabled();
      expect(await latencyResult(page)).toBe(saved);

      await panel.getByRole('button', { name: '测试延迟', exact: true }).click();
      await expect.poll(() => service.state.probes).toBe(8);
      // Exercise the native page-visibility handler without depending on headless Chromium's
      // window manager. The pending probe still uses the real IPC, bridge and remote socket.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Reflect.deleteProperty(document, 'hidden');
      });
      await expect(panel).not.toBeVisible();
      expect(await latencyResult(page)).toBe(saved);
      panel = await diagnostics(page);
      await panel.getByRole('button', { name: '测试延迟', exact: true }).click();
      await expect(panel.locator('[data-metric="service"]')).toContainText('0/5', {
        timeout: 40000,
      });
      await expect(panel.locator('[data-metric="workbench"]')).toContainText('5/5');
      await panel.locator('summary').click();
      const serviceDetail = panel.getByRole('region', { name: '服务连接', exact: true });
      await expect(serviceDetail).toContainText('没有成功的探测');
      await expect(serviceDetail.locator('.latency-issues')).toContainText('5 次超时');
      await expect(serviceDetail.locator('.latency-range')).toHaveCount(0);
      await expect(serviceDetail.getByRole('list')).toHaveCount(0);
      await expect(
        panel.getByRole('region', { name: '工作台', exact: true }).getByRole('listitem'),
      ).toHaveCount(5);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await panel.evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('browser-latency-timeout.png') });
      await page.setViewportSize({ width: 1280, height: 900 });
      expect(service.state.probes).toBe(13);
      expect(service.state.authentications).toBe(1);
      await expect(page.locator('.connection-status')).toContainText('已连接');
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');

      service.state.answer = true;
      await panel.getByRole('button', { name: '测试延迟', exact: true }).click();
      await expect(panel.locator('[data-metric="service"]')).toContainText('5/5');
      await expectLatencyDetails(page, panel, true);
      expect(service.state.probes).toBe(18);
      expect(service.state.authentications).toBe(1);

      const previous = await latencyResult(page);
      service.state.answer = false;
      await panel.getByRole('button', { name: '测试延迟', exact: true }).click();
      await expect.poll(() => service.state.probes).toBe(19);
      await desktop.page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await desktop.page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
      await expect(
        desktop.page.getByRole('heading', { name: '连接代理服务', exact: true }),
      ).toBeVisible();
      await expect(panel).not.toBeVisible();
      expect(await latencyResult(page)).toBe(previous);
      // Opening the native window's menu may outlast one probe's timeout. Only probes
      // after the completed disconnect would mean the cancelled run resumed itself.
      const stopped = service.state.probes;
      service.state.answer = true;
      await desktop.page.getByLabel('服务地址', { exact: true }).fill(service.url);
      await desktop.page.getByLabel('服务凭据', { exact: true }).fill(service.token);
      await desktop.page.getByLabel('服务证书指纹', { exact: true }).fill(service.fingerprint);
      await desktop.page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('.connection-status')).toContainText('已连接');
      panel = await diagnostics(page);
      await expect(panel).toContainText('上次连接');
      expect(await latencyResult(page)).toBe(previous);
      expect(service.state.authentications).toBe(2);
      expect(service.state.probes).toBe(stopped);
    } finally {
      await context?.close();
      await service.close();
    }
  });

  test('connection diagnostics keep partial samples and long errors readable in a small viewport', async ({
    desktop,
    browser,
  }, testInfo) => {
    const access = await enable(desktop.page);
    const { page, context } = await pair(browser, access);
    try {
      const result: LatencyResult = {
        version: 1,
        remote: true,
        connectionId: 'previous-connection',
        completedAt: Date.now(),
        metrics: {
          full: {
            values: [0.25, 1234.6],
            attempts: 5,
            timeouts: 1,
            failures: 2,
            error: '探测失败',
          },
          workbench: { values: [0, 0.5, 1, 2, 3], attempts: 5, timeouts: 0, failures: 0 },
          service: {
            values: [],
            attempts: 5,
            timeouts: 0,
            failures: 5,
            error: `未获得服务连接结果：${'connection_closed_'.repeat(30)}`,
          },
        },
      };
      // Exercise persisted-result rendering without depending on network timing for edge values.
      await page.evaluate(
        (saved) => sessionStorage.setItem('proxy-latency-result', JSON.stringify(saved)),
        result,
      );
      await page.reload();
      await expect(page.locator('.connection-status')).toContainText('已连接');
      await page.setViewportSize({ width: 320, height: 568 });
      const panel = await diagnostics(page);
      await panel.locator('summary').click();
      await expect(panel).toContainText('上次连接');
      const full = panel.getByRole('region', { name: '完整链路', exact: true });
      await expect(full.locator('.latency-range dd')).toHaveText(['<1 ms', '1235 ms']);
      await expect(full.getByRole('listitem')).toHaveText(['<1', '1235']);
      await expect(full.locator('.latency-issues')).toContainText('1 次超时 · 2 次失败');
      const failed = panel.getByRole('region', { name: '服务连接', exact: true });
      await expect(failed).toContainText('没有成功的探测');
      await expect(failed.locator('.latency-issues')).toContainText(result.metrics.service!.error!);
      await expect(failed.getByRole('list')).toHaveCount(0);
      for (const element of [panel, ...(await panel.locator('.latency-detail').all())])
        expect(
          await element.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('browser-latency-partial.png') });
      await panel.getByRole('button', { name: '测试延迟', exact: true }).focus();
      await expect(panel.getByRole('button', { name: '测试延迟', exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('browser-latency-long-error.png') });
      await page.keyboard.press('Escape');
      await expect(panel).not.toBeVisible();
      await expect(page.getByRole('button', { name: '连接诊断', exact: true })).toBeFocused();
      expect(JSON.parse((await latencyResult(page))!)).toEqual(result);
    } finally {
      await context.close();
    }
  });

  test('optional service relay serves the real shared workbench and leaves local access intact', async ({
    desktop,
    browser,
  }, testInfo) => {
    const port = await unusedPort();
    const relayPort = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const token = 'test-only-relay-service-credential';
    // An ephemeral TCP mapping represents a deployment-selected public port in front of the fixed
    // relay listener. Control/data connections still use the original service listener.
    const sockets = new Set<Socket>();
    const entry = createServer((socket) => {
      const upstream = connect(relayPort, '127.0.0.1');
      for (const connection of [socket, upstream]) {
        sockets.add(connection);
        connection.on('error', () => {
          socket.destroy();
          upstream.destroy();
        });
        connection.once('close', (hadError) => {
          sockets.delete(connection);
          if (hadError || !connection.readableEnded) {
            socket.destroy();
            upstream.destroy();
          }
        });
      }
      socket.pipe(upstream).pipe(socket);
    });
    let service: ReturnType<typeof createProxyServer> | undefined;
    const contexts: BrowserContext[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        entry.once('error', reject);
        entry.listen(0, '127.0.0.1', resolve);
      });
      const publicPort = (entry.address() as { port: number }).port;
      service = createProxyServer({
        token,
        dataDir: join(desktop.profile, 'relay-service'),
        webRelay: { port: relayPort, publicPort },
      });
      await service.listen(port);
      await create(desktop.page, desktop.project, '中继工作台');
      // Only the saved service choice changes. The established business connection remains the
      // existing test service; the separate relay is a real server on its own ephemeral port.
      await desktop.page.evaluate(
        async ({ origin, token }) => {
          await window.desktop!.saveLogin({
            mode: 'remote',
            url: `${origin.replace('http:', 'ws:')}/ws`,
            token,
            fingerprint: '',
            remember: false,
            autoLogin: false,
          });
        },
        { origin, token },
      );
      const local = await enable(desktop.page);
      const direct = await pair(browser, local);
      contexts.push(direct.context);
      await expect(
        desktop.page.getByRole('spinbutton', { name: '公网端口', exact: true }),
      ).toHaveCount(0);
      await expect(
        desktop.page.getByRole('textbox', { name: '公网地址', exact: true }),
      ).toHaveCount(0);
      await expect(
        desktop.page.getByRole('combobox', { name: '公网协议', exact: true }),
      ).toHaveCount(0);
      await desktop.page.getByRole('switch', { name: '通过服务端访问', exact: true }).click();
      await expect
        .poll(() =>
          desktop.page.evaluate(() => window.desktop!.relayStatus!().then((s) => s.state)),
        )
        .toBe('online');
      let relay = await desktop.page.evaluate(() => window.desktop!.relayStatus!());
      expect(relay.url).toMatch(
        new RegExp(`^http://127.0.0.1:${publicPort}/remote/[a-f0-9]{32}/$`),
      );
      const generatedUrl = relay.url!;
      const path = desktop.page.getByRole('textbox', { name: '服务端访问路径', exact: true });
      await path.fill('my-desktop');
      await path.blur();
      await expect
        .poll(() =>
          desktop.page.evaluate(() => window.desktop!.relayStatus!().then((s) => s.route)),
        )
        .toBe('my-desktop');
      relay = await desktop.page.evaluate(() => window.desktop!.relayStatus!());
      expect(relay.url).toBe(`http://127.0.0.1:${publicPort}/remote/my-desktop/`);
      expect((await direct.context.request.get(generatedUrl)).status()).toBe(404);
      // A second authenticated desktop owns this alias; editing cannot steal its route.
      const other = new WebSocket(`${origin.replace('http:', 'ws:')}/_relay/control`);
      try {
        await new Promise<void>((resolve, reject) => {
          other.once('error', reject);
          other.once('open', () => {
            other.send(
              JSON.stringify({
                type: 'relay.register',
                version: 2,
                token,
                deviceId: 'f'.repeat(32),
                relayKey: 'e'.repeat(64),
                hostname: '127.0.0.1',
                route: 'occupied',
              }),
            );
          });
          other.once('message', (raw) => {
            if (JSON.parse(String(raw)).type === 'relay.ready') resolve();
            else reject(new Error('Other route did not register'));
          });
        });
        await path.fill('occupied');
        await path.blur();
        await expect(desktop.page.locator('.remote-control').getByRole('alert')).toContainText(
          '已被',
        );
        await expect(path).toHaveValue('my-desktop');
        expect((await desktop.page.evaluate(() => window.desktop!.relayStatus!())).url).toBe(
          relay.url,
        );
      } finally {
        other.terminate();
      }
      await path.fill('workstation');
      await path.blur();
      await expect
        .poll(() =>
          desktop.page.evaluate(() => window.desktop!.relayStatus!().then((s) => s.route)),
        )
        .toBe('workstation');
      expect((await direct.context.request.get(relay.url!)).status()).toBe(404);
      relay = await desktop.page.evaluate(() => window.desktop!.relayStatus!());
      expect(relay.url).toBe(`http://127.0.0.1:${publicPort}/remote/workstation/`);
      await expect(desktop.page.locator('.remote-control').getByRole('alert')).toHaveCount(0);
      expect(new URL(local.url).port).not.toBe(String(publicPort));
      expect(publicPort).not.toBe(port);
      expect(publicPort).not.toBe(relayPort);
      expect(
        (await direct.context.request.get(`${origin}${new URL(relay.url!).pathname}`)).status(),
      ).toBe(404);
      expect(
        (await direct.context.request.get(`http://127.0.0.1:${publicPort}/health`)).status(),
      ).toBe(404);
      await desktop.page
        .locator('.remote-control')
        .screenshot({ path: testInfo.outputPath('relay-settings-wide.png') });
      await desktop.application.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        window.setMinimumSize(640, 600);
        window.setSize(720, 900);
      });
      await desktop.page
        .locator('.remote-control')
        .screenshot({ path: testInfo.outputPath('relay-settings-narrow.png') });
      expect(
        await desktop.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await desktop.application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1280, 900),
      );
      const localCookie = (await direct.context.cookies()).find((cookie) =>
        cookie.name.startsWith('ccdt_web_session_'),
      )!;
      // Browsers protect an existing Secure cookie from an HTTP Set-Cookie with the same name/path.
      // A previous HTTPS entry must not prevent pairing after choosing an HTTP public entry.
      const remote = await pair(
        browser,
        { url: relay.url!, token: local.token },
        false,
        (context) =>
          context.addCookies([
            {
              name: `${localCookie.name}_relay_https`,
              value: 'previous-https-session',
              domain: '127.0.0.1',
              path: new URL(relay.url!).pathname,
              secure: true,
              httpOnly: true,
              sameSite: 'Strict',
            },
          ]),
      );
      contexts.push(remote.context);
      await expect(remote.page.locator('.session-row.selected strong')).toHaveText('中继工作台');
      await remote.page.getByRole('textbox', { name: '消息' }).fill('通过独立中继操作原工作台');
      await remote.page.getByRole('button', { name: '发送消息', exact: true }).click();
      await settled(remote.page);
      await expect(direct.page.locator('.message.user').last()).toContainText(
        '通过独立中继操作原工作台',
      );
      const cookies = await remote.context.cookies();
      expect(cookies.find((cookie) => cookie.name === `${localCookie.name}_relay_http`)?.path).toBe(
        new URL(relay.url!).pathname,
      );
      expect(
        cookies.find((cookie) => cookie.name === `${localCookie.name}_relay_https`)?.value,
      ).toBe('previous-https-session');

      const nextLocalPort = await unusedPort();
      await desktop.page
        .getByRole('spinbutton', { name: '本地监听端口', exact: true })
        .fill(String(nextLocalPort));
      await desktop.page.getByRole('spinbutton', { name: '本地监听端口', exact: true }).blur();
      await expect
        .poll(() =>
          desktop.page.evaluate(() => window.desktop!.remoteStatus!().then((s) => s.port)),
        )
        .toBe(nextLocalPort);
      await expect
        .poll(() =>
          desktop.page.evaluate(() => window.desktop!.relayStatus!().then((s) => s.state)),
        )
        .toBe('online');
      expect((await desktop.page.evaluate(() => window.desktop!.relayStatus!())).url).toBe(
        relay.url,
      );
      await expect
        .poll(() => remote.context.request.get(`${relay.url}api/info`).then((r) => r.status()))
        .toBe(200);
      await remote.page.reload();
      await expect(remote.page.locator('.connection-status')).toContainText('已连接');
      expect(await remote.page.getByRole('textbox', { name: '配对码', exact: true }).count()).toBe(
        0,
      );
      await desktop.page.getByRole('switch', { name: '通过服务端访问', exact: true }).click();
      await expect
        .poll(() =>
          desktop.page.evaluate(() => window.desktop!.relayStatus!().then((s) => s.state)),
        )
        .toBe('disabled');
      await expect
        .poll(() => remote.context.request.get(relay.url!).then((r) => r.status()))
        .toBe(404);
      const nextLocal = await desktop.page.evaluate(() => window.desktop!.remoteStatus!());
      expect(nextLocal.enabled).toBe(true);
      expect((await direct.context.request.get(`${nextLocal.url}/api/info`)).status()).toBe(200);
      await desktop.page.getByRole('button', { name: '会话', exact: true }).click();
      await send(desktop.page, '中继关闭后桌面保持原连接');
      await settled(desktop.page);
    } finally {
      await Promise.allSettled(contexts.map((context) => context.close()));
      await desktop.page.evaluate(() => window.desktop!.configureRelay!(false)).catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => entry.close(() => resolve()));
      await service?.close();
    }
  });

  test('browser session statistics and global instructions use the desktop connection and preserve conflicting drafts', async ({
    desktop,
    browser,
  }) => {
    const contexts: BrowserContext[] = [];
    // Only the service protocol is supplied here, as in settings.spec.ts. Both browsers use the real
    // Electron listener and renderer adapter. Instructions use the real file/CAS implementation,
    // with an explicit path in this test's profile rather than the user's Claude configuration.
    const instructions = join(desktop.profile, 'native-profile', 'CLAUDE.md');
    const original = writeInstructions(
      '回复用中文。\n',
      readInstructions(instructions).version,
      instructions,
    );
    const updates: { text: string; version: string }[] = [];
    let authentications = 0;
    let statistics = 0;
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      title: 'Web 主线功能验收',
      autoTitle: false,
      projectPath: desktop.project,
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    // The desktop page already exists, so use a real listener rather than routeWebSocket's
    // new-document injection. The fixture owns only its ephemeral loopback port.
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
    const address = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
    server.on('connection', (socket) => {
      const reply = (value: unknown) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
      };
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'device' || message.type === 'leave') return;
        if (message.type === 'auth') {
          authentications++;
          reply({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.0.1',
            connectionId: randomUUID(),
            adapter: 'claude-code',
            sessions: [session],
          });
          return;
        }
        try {
          if (message.type === 'session.subscribe')
            reply({
              type: 'session.snapshot',
              requestId: message.requestId,
              session,
              mode: 'replace',
              firstSequence: 0,
              lastSequence: 0,
              hasEarlier: false,
              events: [],
            });
          if (message.type === 'session.stats') {
            statistics++;
            reply({
              type: 'session.stats',
              requestId: message.requestId,
              sessionId: message.sessionId,
              turns: 3,
              requests: 7,
              inputTokens: 100,
              outputTokens: 2000,
              cacheReadTokens: 40000,
              cacheCreationTokens: 8000,
              modelMs: 28200,
              ttftMs: 952,
              outputPerSecond: 99.3,
              firstRecordAt: null,
            });
          }
          if (message.type === 'settings.get')
            reply({
              type: 'settings.state',
              requestId: message.requestId,
              values: Object.fromEntries(
                Object.keys(nativeSettingsSchema.shape).map((key) => [key, null]),
              ),
            });
          if (message.type === 'instructions.update') {
            updates.push({ text: message.text, version: message.version });
            writeInstructions(message.text, message.version, instructions);
          }
          if (message.type.startsWith('instructions.'))
            reply({
              type: 'instructions.state',
              requestId: message.requestId,
              ...readInstructions(instructions),
            });
          reply({ type: 'response', requestId: message.requestId, ok: true });
        } catch (error) {
          reply({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            code: error instanceof DomainError ? error.code : 'fixture_error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });
    try {
      await desktop.page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await desktop.page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
      await desktop.page.getByLabel('服务地址', { exact: true }).fill(address);
      await desktop.page
        .getByLabel('服务凭据', { exact: true })
        .fill('test-only-native-web-token-with-enough-length');
      await desktop.page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');
      await select(desktop.page, session.title);
      const access = await enable(desktop.page);
      const first = await pair(browser, access);
      contexts.push(first.context);
      const second = await pair(browser, access, true);
      contexts.push(second.context);
      for (const page of [first.page, second.page]) {
        await general(page);
        await page.getByRole('switch', { name: '显示会话栏', exact: true }).click();
        await page.getByRole('button', { name: '会话', exact: true }).click();
        await expect(page.locator('.session-bar-part.session > button')).toHaveText(
          '3 轮 · 7 步 · 平均 99 tok/s',
        );
        await page.locator('.session-bar-part.session > button').click();
        await expect(
          page.getByRole('dialog', { name: '会话统计', exact: true }).locator('header'),
        ).toHaveText('会话统计3 轮');
        await page.locator('.session-bar-part.session > button').click();
      }
      expect(statistics).toBeGreaterThanOrEqual(2);
      for (const page of [desktop.page, first.page, second.page]) {
        await general(page);
        await page
          .getByRole('navigation', { name: '设置分类' })
          .getByRole('button', { name: 'Claude Code', exact: true })
          .click();
        await expect(
          page.locator('.instructions-card').getByLabel('全局说明', { exact: true }),
        ).toHaveValue(original.text);
      }
      const firstPanel = first.page.locator('.instructions-card');
      const secondPanel = second.page.locator('.instructions-card');
      const saved = '回复用中文。\n提交信息用中文。\n';
      const draft = '第二个浏览器尚未保存的说明。\n';
      await secondPanel.getByLabel('全局说明', { exact: true }).fill(draft);
      await firstPanel.getByLabel('全局说明', { exact: true }).fill(saved);
      await firstPanel.getByRole('button', { name: '保存', exact: true }).click();
      await expect(firstPanel.getByRole('status')).toHaveText('已保存，从下一次运行起生效');
      expect(readInstructions(instructions).text).toBe(saved);
      await secondPanel.getByRole('button', { name: '保存', exact: true }).click();
      await expect(secondPanel.getByRole('alert')).toContainText('已在别处修改');
      await expect(secondPanel.getByLabel('全局说明', { exact: true })).toHaveValue(draft);
      expect(readInstructions(instructions).text).toBe(saved);
      expect(updates).toEqual([
        { text: saved, version: original.version },
        { text: draft, version: original.version },
      ]);
      for (const page of [desktop.page, second.page]) {
        const panel = page.locator('.instructions-card');
        await panel.getByRole('button', { name: '重新载入', exact: true }).click();
        await expect(panel.getByLabel('全局说明', { exact: true })).toHaveValue(saved);
        await expect(panel.getByRole('alert')).toHaveCount(0);
      }
      expect(authentications).toBe(1);
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');
    } finally {
      try {
        await Promise.all(contexts.map((context) => context.close()));
      } finally {
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });

  test('two browsers share desktop selection and commands without sharing drafts or disconnecting the desktop', async ({
    desktop,
    browser,
  }) => {
    const contexts: BrowserContext[] = [];
    try {
      const suffix = basename(desktop.profile).slice(-6);
      const firstTitle = `桌面会话甲 ${suffix}`;
      const secondTitle = `桌面会话乙 ${suffix}`;
      const createdTitle = `浏览器新建会话 ${suffix}`;
      await create(desktop.page, desktop.project, firstTitle);
      await create(desktop.page, desktop.project, secondTitle);
      const access = await enable(desktop.page);
      const first = await pair(browser, access);
      contexts.push(first.context);
      const second = await pair(browser, access, true);
      contexts.push(second.context);
      await desktop.page.getByRole('button', { name: '会话', exact: true }).click();
      const pages = [desktop.page, first.page, second.page];
      for (const page of pages)
        await expect(page.locator('.session-row.selected strong')).toHaveText(secondTitle);

      for (const [index, page] of pages.entries())
        await page.getByRole('textbox', { name: '消息' }).fill(`设备 ${index} 的未发送草稿`);
      await select(first.page, firstTitle);
      for (const page of pages)
        await expect(page.locator('.session-row.selected strong')).toHaveText(firstTitle);
      await select(second.page, secondTitle);
      for (const [index, page] of pages.entries()) {
        await expect(page.locator('.session-row.selected strong')).toHaveText(secondTitle);
        await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue(
          `设备 ${index} 的未发送草稿`,
        );
      }

      await create(first.page, desktop.project, createdTitle);
      for (const page of pages)
        await expect(page.locator('.session-row.selected strong')).toHaveText(createdTitle);
      await send(first.page, '浏览器发起的工具审批', 'tool');
      await expect(desktop.page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
      await second.page.getByRole('button', { name: '允许', exact: true }).click();
      for (const page of pages) {
        await settled(page);
        await expect(page.locator('.message.user')).toContainText('浏览器发起的工具审批');
      }
      await first.page.reload();
      await expect(first.page.locator('.connection-status')).toContainText('已连接');
      await expect(first.page.locator('.session-row.selected strong')).toHaveText(createdTitle);
      await expect(first.page.locator('.message.user')).toContainText('浏览器发起的工具审批');

      await general(desktop.page);
      await desktop.page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
      await expect(
        desktop.page.getByRole('switch', { name: '启用 Web 工作台', exact: true }),
      ).not.toBeChecked();
      await desktop.page.getByRole('button', { name: '会话', exact: true }).click();
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');
      await send(desktop.page, 'Web 关闭后桌面继续发送');
      await settled(desktop.page);
      await expect(desktop.page.locator('.message.user').last()).toContainText(
        'Web 关闭后桌面继续发送',
      );
      await expect(desktop.page.locator('.message.assistant').last()).toContainText('离线模拟回复');
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });

  test('tabs in one browser keep independent drafts after reload and recover other sessions in a new tab', async ({
    desktop,
    browser,
  }) => {
    let context: BrowserContext | undefined;
    try {
      const suffix = basename(desktop.profile).slice(-6);
      const one = `标签页草稿甲 ${suffix}`,
        two = `标签页草稿乙 ${suffix}`;
      await create(desktop.page, desktop.project, one);
      await create(desktop.page, desktop.project, two);
      const access = await enable(desktop.page);
      const first = await pair(browser, access);
      context = first.context;
      const second = await context.newPage();
      await second.goto(access.url);
      await expect(second.locator('.connection-status')).toContainText('已连接');
      const persisted = async (page: Page, text: string) => {
        await expect
          .poll(() =>
            page.evaluate(
              (text) =>
                Object.values(JSON.parse(sessionStorage.getItem('remote-drafts') ?? '{}')).includes(
                  text,
                ),
              text,
            ),
          )
          .toBe(true);
      };
      await select(first.page, one);
      for (const page of [first.page, second])
        await expect(page.locator('.session-row.selected strong')).toHaveText(one);
      await first.page.getByRole('textbox', { name: '消息' }).fill('第一页独立草稿');
      await persisted(first.page, '第一页独立草稿');
      await select(second, two);
      for (const page of [first.page, second])
        await expect(page.locator('.session-row.selected strong')).toHaveText(two);
      await second.getByRole('textbox', { name: '消息' }).fill('第二页另一会话草稿');
      await persisted(second, '第二页另一会话草稿');
      await first.page.reload();
      await expect(first.page.locator('.connection-status')).toContainText('已连接');
      await select(first.page, one);
      await expect(first.page.getByRole('textbox', { name: '消息' })).toHaveValue('第一页独立草稿');
      await expect(second.locator('.session-row.selected strong')).toHaveText(one);
      await second.getByRole('textbox', { name: '消息' }).fill('第二页同一会话草稿');
      await persisted(second, '第二页同一会话草稿');
      await first.page.reload();
      await expect(first.page.locator('.connection-status')).toContainText('已连接');
      await expect(first.page.getByRole('textbox', { name: '消息' })).toHaveValue('第一页独立草稿');
      await second.reload();
      await expect(second.locator('.connection-status')).toContainText('已连接');
      await expect(second.getByRole('textbox', { name: '消息' })).toHaveValue('第二页同一会话草稿');
      const recovered = await context.newPage();
      await recovered.goto(access.url);
      await expect(recovered.locator('.connection-status')).toContainText('已连接');
      await expect(recovered.getByRole('textbox', { name: '消息' })).toHaveValue(
        '第二页同一会话草稿',
      );
      await select(recovered, two);
      await expect(recovered.getByRole('textbox', { name: '消息' })).toHaveValue(
        '第二页另一会话草稿',
      );
    } finally {
      await context?.close();
    }
  });

  test('browser grants revoke independently and browser attachments and exports use the real desktop host', async ({
    desktop,
    browser,
  }, testInfo) => {
    const contexts: BrowserContext[] = [];
    try {
      await create(desktop.page, desktop.project, '附件与导出');
      const access = await enable(desktop.page);
      const first = await pair(browser, access);
      contexts.push(first.context);
      const second = await pair(browser, access, true);
      contexts.push(second.context);
      const anotherTab = await first.context.newPage();
      await anotherTab.goto(access.url);
      await expect(anotherTab.locator('.connection-status')).toContainText('已连接');

      const grants = desktop.page
        .locator('.remote-control')
        .getByRole('button', { name: /^撤销 / });
      await desktop.page.locator('.remote-control summary').click();
      await expect(grants).toHaveCount(2);
      await expect(desktop.page.locator('.remote-control')).toContainText('登录有效期为 30 天');
      await desktop.page
        .locator('.remote-control')
        .screenshot({ path: testInfo.outputPath('browser-grants-wide.png') });
      await desktop.application.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        window.setMinimumSize(640, 600);
        window.setSize(720, 900);
      });
      await desktop.page
        .locator('.remote-control')
        .screenshot({ path: testInfo.outputPath('browser-grants-narrow.png') });
      await expect
        .poll(() =>
          grants.first().evaluate((button) => {
            const text = document.createRange();
            text.selectNodeContents(button);
            return text.getClientRects().length;
          }),
        )
        .toBe(1);
      expect(
        await desktop.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await desktop.application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1280, 900),
      );

      await desktop.page.getByRole('button', { name: /^撤销 Chrome / }).click();
      for (const page of [first.page, anotherTab])
        await expect(
          page.getByRole('heading', { name: '连接桌面客户端的工作台', exact: true }),
        ).toBeVisible();
      await expect(grants).toHaveCount(1);
      await expect(second.page.locator('.connection-status')).toContainText('已连接');
      expect((await first.context.request.get(`${access.url}/api/info`)).status()).toBe(401);
      expect((await second.context.request.get(`${access.url}/api/info`)).status()).toBe(200);

      const content = 'Web upload round-trip\n中文附件内容\n';
      const chooser = second.page.waitForEvent('filechooser');
      await second.page.getByRole('button', { name: /^添加文件/ }).click();
      await (
        await chooser
      ).setFiles({
        name: 'web-attachment.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(content),
      });
      const composer = second.page.getByRole('textbox', { name: '消息' });
      await expect(composer).toHaveValue(/web-attachment\.txt/);
      const attached = await composer.inputValue();
      const uploaded = /^"([^"]+)"/.exec(attached)![1];
      const uploadRoot = join(desktop.profile, 'uploads');
      const child = relative(uploadRoot, uploaded);
      expect(child.startsWith('..')).toBe(false);
      expect(isAbsolute(child)).toBe(false);
      expect(readFileSync(uploaded, 'utf8')).toBe(content);
      await composer.fill(`${attached}请检查这个附件`);
      await second.page.getByRole('button', { name: '发送消息', exact: true }).click();
      await settled(second.page);
      const downloaded = second.page.waitForEvent('download');
      await sessionAction(second.page, '导出为 Markdown');
      const file = await downloaded;
      const exported = testInfo.outputPath('conversation.md');
      await file.saveAs(exported);
      expect(file.suggestedFilename()).toBe('附件与导出.md');
      expect(readFileSync(exported, 'utf8')).toContain(uploaded);
      expect(readFileSync(exported, 'utf8')).toContain('请检查这个附件');
      await desktop.page.getByRole('button', { name: '会话', exact: true }).click();
      await expect(desktop.page.locator('.message.user').last()).toContainText('请检查这个附件');
      await send(desktop.page, '撤销其他浏览器后桌面仍可发送');
      await settled(desktop.page);
      await expect(second.page.locator('.message.user').last()).toContainText(
        '撤销其他浏览器后桌面仍可发送',
      );
      await second.page.setViewportSize({ width: 390, height: 844 });
      expect(
        await second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await second.page.screenshot({ path: testInfo.outputPath('browser-workbench-narrow.png') });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
});
