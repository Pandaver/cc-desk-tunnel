import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const device = { id: '00000000-0000-4000-8000-000000000001', name: '测试浏览器' };
const executor = { id: '00000000-0000-4000-8000-000000000002', name: '开发电脑' };
const now = new Date().toISOString();
const sessions = ['在线会话', '离线会话', '旧版未归属会话'].map((title, index) => ({
  id: `00000000-0000-4000-8000-00000000001${index}`,
  title,
  projectPath: `D:\\Projects\\Project-${index}`,
  ...(index < 2
    ? {
        device:
          index === 0 ? executor : { id: '00000000-0000-4000-8000-000000000003', name: '离线电脑' },
      }
    : {}),
  permissionMode: 'auto',
  model: null,
  effort: null,
  createdAt: now,
  updatedAt: now,
  activeRun: null,
}));

// Serve the built entry, not the development App shortcut: this exercises the production cookie gate.
async function fixture(
  page: Page,
  options: { paired?: boolean; pairFails?: boolean; hold?: boolean } = {},
) {
  let paired = options.paired ?? true;
  let logoutFails = false;
  const requests: Record<string, unknown>[] = [];
  const codes: string[] = [];
  const sockets: WebSocketRoute[] = [];
  const login = { device, expiresAt: null };
  await page.route('**/browser-entry/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/browser-entry/web/session')
      return route.fulfill({ status: paired ? 200 : 401, json: paired ? login : {} });
    if (path === '/browser-entry/web/pair') {
      expect(page.url()).not.toContain('pair=');
      codes.push(route.request().postDataJSON().code);
      if (options.pairFails)
        return route.fulfill({
          status: 401,
          json: { message: '配对码已失效，请生成新的配对码。' },
        });
      paired = true;
      return route.fulfill({ json: login });
    }
    if (path === '/browser-entry/web/logout') {
      if (logoutFails)
        return route.fulfill({ status: 503, json: { message: '退出失败，请重试。' } });
      paired = false;
      return route.fulfill({ status: 204 });
    }
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
    sockets.push(socket);
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      requests.push(command);
      if (command.type === 'web.auth') {
        if (options.hold) return;
        socket.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            connectionId: '00000000-0000-4000-8000-000000000020',
            version: '0.3.4',
            adapter: 'claude-code',
            sessions,
          }),
        );
        socket.send(JSON.stringify({ type: 'devices', devices: [{ ...executor, ready: true }] }));
      } else if (command.type === 'session.subscribe') {
        socket.send(
          JSON.stringify({
            type: 'session.snapshot',
            requestId: command.requestId,
            session: sessions.find((item) => item.id === command.sessionId),
            events: [],
            mode: 'replace',
            firstSequence: 0,
            lastSequence: 0,
            hasEarlier: false,
          }),
        );
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      } else if (command.requestId)
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
    });
  });
  return {
    requests,
    codes,
    sockets,
    failLogout: () => {
      logoutFails = true;
    },
  };
}

async function select(page: Page, title = '在线会话') {
  await page.locator('.session-row').filter({ hasText: title }).getByRole('button').first().click();
}

test('production pairing consumes the code, reuses the shared workbench and offers no local-only actions', async ({
  page,
}) => {
  const state = await fixture(page, { paired: false });
  await page.goto('/browser-entry/#pair=112233445566778899aabbcc');
  await expect(page.locator('.connection-status')).toContainText('已连接');
  expect(state.codes).toEqual(['112233445566778899aabbcc']);
  expect(state.requests[0]).toEqual({ type: 'web.auth', protocolVersion: PROTOCOL_VERSION });
  await expect(page.getByRole('button', { name: '新建会话', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '定时任务', exact: true })).toHaveCount(0);
  await select(page);
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible();
  await expect(page.getByRole('button', { name: '在本机继续…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /添加文件/ })).toHaveCount(0);
  await page.getByRole('button', { name: '设置与账号' }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '账号与额度', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Claude Code', exact: true })).toHaveCount(0);
  expect(
    state.requests.some(
      (item) =>
        /^(account|settings|service|web)\./.test(String(item.type)) && item.type !== 'web.auth',
    ),
  ).toBe(false);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('112233445566778899aabbcc');
});

test('browser tabs keep independent drafts and never start locally saved schedules', async ({
  page,
  context,
}) => {
  const first = await fixture(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      'proxy-schedules',
      JSON.stringify({
        tasks: [
          {
            id: 'old',
            name: '不应运行',
            enabled: true,
            prompt: '后台发送',
            schedule: { type: 'interval', minutes: 5 },
            target: { type: 'session', sessionId: '00000000-0000-4000-8000-000000000010' },
            model: null,
            effort: null,
          },
        ],
      }),
    ),
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      'proxy-schedule-progress',
      JSON.stringify({
        old: { key: JSON.stringify({ type: 'interval', minutes: 5 }), base: Date.now() - 360000 },
      }),
    ),
  );
  await page.goto('/browser-entry/');
  await select(page);
  await page.getByRole('textbox', { name: '消息' }).fill('第一个标签页的草稿');
  await expect
    .poll(() =>
      page.evaluate(() =>
        sessionStorage.getItem('proxy-drafts:00000000-0000-4000-8000-000000000001'),
      ),
    )
    .toContain('第一个标签页');
  const other = await context.newPage();
  const second = await fixture(other);
  await other.goto('/browser-entry/');
  await select(other);
  await expect(other.getByRole('textbox', { name: '消息' })).toHaveValue('');
  await other.getByRole('textbox', { name: '消息' }).fill('第二个标签页');
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('第一个标签页的草稿');
  await page.reload();
  await select(page);
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('第一个标签页的草稿');
  expect([...first.requests, ...second.requests].some((item) => item.type === 'message.send')).toBe(
    false,
  );
  await other.close();
});

test('offline and legacy sessions stay read-only and do not trigger native status requests', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/browser-entry/');
  for (const title of ['离线会话', '旧版未归属会话']) {
    await select(page, title);
    await expect(page.locator('.elsewhere-bar')).toContainText('当前只能查看');
    await expect(page.getByRole('textbox', { name: '消息' })).toHaveCount(0);
    await page.locator('.session-row.selected').getByRole('button', { name: '会话操作' }).click();
    await expect(page.getByRole('menuitem', { name: '原生终端' })).toBeDisabled();
    await page.keyboard.press('Escape');
  }
  expect(state.requests.some((item) => item.type === 'session.status')).toBe(false);
});

test('revocation returns to pairing, while logout failure preserves the open workbench', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/browser-entry/');
  await select(page);
  state.failLogout();
  await page.getByRole('button', { name: '设置与账号' }).click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page.locator('.error-banner')).toContainText('退出失败');
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible();
  state.sockets.at(-1)!.close({ code: 4001, reason: 'revoked' });
  await expect(page.getByLabel('配对码', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('登录已失效');
  await expect(page.locator('.shell')).toHaveCount(0);
});

test('initial connection has no retry action and narrow login does not overflow', async ({
  page,
}) => {
  await fixture(page, { hold: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/browser-entry/');
  await expect(page.getByRole('heading', { name: '正在连接工作台…' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新连接' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalid pairing remains editable and a successful logout clears the workspace', async ({
  page,
}) => {
  await fixture(page, { paired: false, pairFails: true });
  await page.goto('/browser-entry/');
  await page.getByLabel('配对码', { exact: true }).fill('expired');
  await page.getByRole('button', { name: '配对并进入' }).click();
  await expect(page.getByRole('alert')).toContainText('配对码已失效');
  await expect(page.getByLabel('配对码', { exact: true })).toBeEnabled();
  await page.unrouteAll();
  await fixture(page);
  await page.goto('/browser-entry/');
  await select(page);
  await page.getByRole('button', { name: '设置与账号' }).click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page.getByLabel('配对码', { exact: true })).toBeVisible();
  await expect(page.locator('.shell')).toHaveCount(0);
});

async function desktopFixture(
  page: Page,
  webEnabled: boolean,
  options: {
    holdStatus?: boolean;
    failStatus?: boolean;
    webControl?: boolean;
    webPairing?: boolean;
    webSettings?: boolean;
    clockSkew?: boolean;
    holdPairing?: boolean;
    failPairing?: boolean;
    existingPairing?: boolean;
  } = {},
) {
  // The real App and ProxyClient run unchanged. This fixture provides only OS calls; all management
  // requests still go through the same typed WebSocket reducer as the installed desktop.
  await fixture(page);
  await page.addInitScript(() => {
    const windowWithTest = window as typeof window & { copied?: string[]; opened?: string[] };
    windowWithTest.copied = [];
    windowWithTest.opened = [];
    const nothing = async () => undefined;
    const listen = () => () => {};
    window.desktop = {
      platform: 'win32',
      dev: true,
      boot: { connection: '', shared: { connections: [], busy: [] } },
      version: async () => '0.3.4',
      device: async () => ({ id: '00000000-0000-4000-8000-000000000002', name: '开发电脑' }),
      loadLogin: async () => ({
        url: 'ws://127.0.0.1:18889/desktop-control/ws',
        token: 'test-only-control-token-with-enough-length',
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
      copyText: async (text: string) => {
        windowWithTest.copied!.push(text);
      },
      openExternal: async (url: string) => {
        windowWithTest.opened!.push(url);
      },
    } as unknown as NonNullable<typeof window.desktop>;
  });
  const commands: Record<string, unknown>[] = [];
  const sockets: WebSocketRoute[] = [];
  const webControl = options.webControl ?? webEnabled;
  const pairing = {
    code: '00112233445566778899aabb',
    expiresAt: new Date(Date.now() + (options.clockSkew ? -300000 : 300000)).toISOString(),
    remainingMs: 300000,
  };
  let activePairing: typeof pairing | undefined = options.existingPairing ? pairing : undefined;
  let enabled = webEnabled;
  let domain = '';
  let path = 'fixture-entry';
  let grants = [
    {
      id: '00000000-0000-4000-8000-000000000030',
      name: '手机浏览器',
      createdAt: now,
      expiresAt: null,
    },
  ];
  let hold = !!options.holdPairing;
  let pairFailures = options.failPairing ? 1 : 0;
  let release = () => {};
  let holdStatus = !!options.holdStatus;
  let failStatus = !!options.failStatus;
  let releaseStatus = () => {};
  let holdRevoke = false;
  let releaseRevoke = () => {};
  let revokeFailures = 0;
  let configureFailures = 0;
  let holdConfigure = false;
  let releaseConfigure = () => {};
  const current = () => ({
    enabled,
    origin: `https://${domain || 'web.example.test'}:8787`,
    ...(options.webSettings === false
      ? {}
      : {
          domain,
          path,
          url: `https://${domain || 'web.example.test'}:8787/${path ? `${path}/` : ''}`,
        }),
    grants,
    ...(activePairing ? { pairing: activePairing } : {}),
  });
  const publish = () => {
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: 'web.changed', ...current() }));
  };
  await page.routeWebSocket('ws://127.0.0.1:18889/desktop-control/ws', (socket) => {
    sockets.push(socket);
    const send = (message: unknown) => socket.send(JSON.stringify(message));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      commands.push(message);
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          connectionId: `00000000-0000-4000-8000-${String(sockets.length).padStart(12, '0')}`,
          version: '0.3.4',
          adapter: 'simulation',
          sessions: [],
          ...(enabled ? { web: true } : {}),
          ...(webControl ? { webControl: true } : {}),
          ...((options.webSettings ?? webControl) ? { webSettings: true } : {}),
          ...((options.webPairing ?? webControl) ? { webPairing: true } : {}),
        });
        return;
      }
      if (!message.requestId) return;
      const reply = () => {
        if (
          (message.type === 'web.status' && failStatus) ||
          (message.type === 'web.pair' && pairFailures-- > 0) ||
          (message.type === 'web.revoke' && revokeFailures-- > 0) ||
          (message.type === 'web.configure' && configureFailures-- > 0)
        ) {
          send({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            code: 'fixture_failure',
            message:
              message.type === 'web.status'
                ? '读取失败，请重试。'
                : message.type === 'web.configure'
                  ? '开启失败，请重试。'
                  : message.type === 'web.pair'
                    ? '配对码初始化失败，请重试。'
                    : '撤销失败，请重试。',
          });
          return;
        }
        if (message.type === 'web.revoke') grants = [];
        if (message.type === 'web.pair' && (!message.ifAbsent || !activePairing))
          activePairing = pairing;
        if (message.type === 'web.configure') {
          enabled = message.enabled;
          if (message.domain !== undefined) domain = message.domain;
          if (message.path !== undefined) path = message.path;
          if (message.regeneratePath) path = '00112233445566778899aabbccddeeff';
          if (!enabled) activePairing = undefined;
        }
        if (message.type.startsWith('web.'))
          send({
            type: 'web.state',
            requestId: message.requestId,
            ...current(),
          });
        send({ type: 'response', requestId: message.requestId, ok: true });
      };
      if (hold && message.type === 'web.pair') release = reply;
      else if (holdStatus && message.type === 'web.status') releaseStatus = reply;
      else if (holdRevoke && message.type === 'web.revoke') releaseRevoke = reply;
      else if (holdConfigure && message.type === 'web.configure') releaseConfigure = reply;
      else reply();
    });
  });
  return {
    commands,
    pairing,
    holdConfiguration: () => {
      holdConfigure = true;
    },
    releaseConfiguration: () => {
      holdConfigure = false;
      releaseConfigure();
    },
    failNextConfiguration: () => {
      configureFailures = 1;
    },
    externalAddress: (settings: { domain?: string; path?: string }) => {
      if (settings.domain !== undefined) domain = settings.domain;
      if (settings.path !== undefined) path = settings.path;
      publish();
    },
    consumePairing: () => {
      activePairing = undefined;
      grants = [
        ...grants,
        {
          id: '00000000-0000-4000-8000-000000000031',
          name: '新浏览器',
          createdAt: now,
          expiresAt: null,
        },
      ];
      publish();
    },
    expirePairing: () => {
      activePairing = undefined;
      publish();
    },
    externalDisable: () => {
      enabled = false;
      activePairing = undefined;
      publish();
    },
    externalEnable: () => {
      enabled = true;
      publish();
    },
    browserLogout: () => {
      grants = [];
      publish();
    },
    dropConnection: () => sockets.at(-1)!.close({ code: 1012, reason: 'fixture reconnect' }),
    holdPairing: () => {
      hold = true;
    },
    releasePairing: () => {
      hold = false;
      release();
    },
    holdStatus: () => {
      holdStatus = true;
    },
    releaseStatus: () => {
      holdStatus = false;
      releaseStatus();
    },
    allowStatus: () => {
      failStatus = false;
    },
    holdRevocation: () => {
      holdRevoke = true;
    },
    releaseRevocation: () => {
      holdRevoke = false;
      releaseRevoke();
    },
    failNextRevocation: () => {
      revokeFailures = 1;
    },
  };
}

async function generalSettings(page: Page) {
  await page.goto('/browser-entry/');
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await page.getByRole('button', { name: '设置与账号' }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '常规', exact: true })).toBeVisible();
}

test('desktop hides browser management unless the connected service advertises it', async ({
  page,
}) => {
  const state = await desktopFixture(page, false);
  await generalSettings(page);
  await expect(page.locator('.server-web-access')).toHaveCount(0);
  expect(state.commands.some((command) => String(command.type).startsWith('web.'))).toBe(false);
});

test('desktop browser management masks, copies, opens and confirms revocation with pending controls locked', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await desktopFixture(page, true, { holdPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByLabel('正在准备配对码')).toHaveText('正在准备配对码…');
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('server-web-management-preparing.png') });
  await expect(panel.getByRole('button', { name: '生成配对码', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '打开浏览器', exact: true })).toBeDisabled();
  await expect
    .poll(() => state.commands.filter((command) => command.type === 'web.pair').length)
    .toBe(1);
  state.releasePairing();
  await expect(panel.getByLabel('配对码已隐藏')).toHaveText('•'.repeat(state.pairing.code.length));
  await expect(panel.getByRole('button', { name: '重新生成配对码', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '显示配对码', exact: true }).click();
  await expect(panel.getByLabel('配对码', { exact: true })).toHaveText(state.pairing.code);
  await panel.getByRole('button', { name: '隐藏配对码', exact: true }).click();
  await panel.getByRole('button', { name: '复制配对码', exact: true }).click();
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  await panel.getByRole('button', { name: '打开浏览器', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    state.pairing.code,
    'https://web.example.test:8787/fixture-entry/',
  ]);
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([
    `https://web.example.test:8787/fixture-entry/#pair=${state.pairing.code}`,
  ]);
  await panel.locator('summary').click();
  await panel.getByRole('button', { name: '撤销 手机浏览器' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(state.commands.filter((command) => command.type === 'web.revoke')).toHaveLength(0);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('server-web-management-wide.png') });
  await page.setViewportSize({ width: 750, height: 900 });
  await panel.scrollIntoViewIfNeeded();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const pairingCenters = () =>
    panel
      .locator(
        '.server-web-code, button[aria-label="显示配对码"], button[aria-label="隐藏配对码"], button[aria-label="复制配对码"], button[aria-label="重新生成配对码"]',
      )
      .evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return box.y + box.height / 2;
        }),
      );
  const maskedCenters = await pairingCenters();
  expect(maskedCenters).toHaveLength(4);
  expect(Math.max(...maskedCenters) - Math.min(...maskedCenters)).toBeLessThan(1);
  await expect(panel.getByLabel('配对码已隐藏')).not.toHaveAttribute('title', state.pairing.code);
  await page.screenshot({ path: testInfo.outputPath('server-web-management-narrow.png') });
  await panel.getByRole('button', { name: '显示配对码', exact: true }).click();
  await expect(panel.getByLabel('配对码', { exact: true })).toHaveAttribute(
    'title',
    state.pairing.code,
  );
  const visibleCenters = await pairingCenters();
  expect(visibleCenters).toHaveLength(4);
  expect(Math.max(...visibleCenters) - Math.min(...visibleCenters)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('server-web-management-narrow-visible.png') });
  await panel.getByRole('button', { name: '隐藏配对码', exact: true }).click();
  await panel.getByRole('button', { name: '撤销 手机浏览器' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '撤销登录', exact: true }).click();
  await expect(panel.getByText('暂无已登录浏览器。')).toBeVisible();
  expect(state.commands.filter((command) => command.type === 'web.revoke')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('desktop management reconnect restores its still-valid one-time code', async ({ page }) => {
  const state = await desktopFixture(page, true);
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  state.dropConnection();
  await expect(page.locator('.connection-status')).toContainText('重连中');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await expect(panel.getByRole('button', { name: '重新生成配对码', exact: true })).toBeEnabled();
  await expect(panel.getByLabel('配对码已隐藏')).toHaveText('•'.repeat(state.pairing.code.length));
  expect(state.commands.filter((command) => command.type === 'web.status')).toHaveLength(2);
});

test('desktop browser settings distinguish loading and failure from an empty authorization list', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { holdStatus: true, failStatus: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByRole('status')).toHaveText('正在读取浏览器访问设置…');
  await expect(panel.getByRole('switch', { name: '启用 Web 访问' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '生成配对码', exact: true })).toHaveCount(0);
  await expect(panel.locator('summary')).toHaveCount(0);
  await expect(panel.getByText('暂无已登录浏览器。')).toHaveCount(0);
  state.releaseStatus();
  await expect(panel.getByRole('alert')).toHaveText('读取失败，请重试。');
  await expect(panel.getByRole('button', { name: '重新读取', exact: true })).toBeEnabled();
  await expect(panel.locator('summary')).toHaveCount(0);
  state.allowStatus();
  await panel.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(panel.locator('summary')).toContainText('1');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('details')).not.toHaveAttribute('open');
  for (const keyword of ['浏览器', 'Web', '配对', '授权']) {
    await page.getByRole('textbox', { name: '搜索设置' }).fill(keyword);
    await expect(
      page
        .getByRole('navigation', { name: '设置分类' })
        .getByRole('button', { name: '常规', exact: true }),
    ).toBeVisible();
  }
});

test('desktop pairing regeneration confirms once and locks dismissal until the request completes', async ({
  page,
}) => {
  const state = await desktopFixture(page, true);
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await panel.getByRole('button', { name: '重新生成配对码', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('已登录的浏览器不受影响。');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(state.commands.filter((command) => command.type === 'web.pair')).toHaveLength(1);
  await panel.getByRole('button', { name: '重新生成配对码', exact: true }).click();
  state.holdPairing();
  await dialog.getByRole('button', { name: '重新生成配对码', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '打开浏览器', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => state.commands.filter((command) => command.type === 'web.pair').length)
    .toBe(2);
  state.releasePairing();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByLabel('配对码已隐藏')).toHaveText('•'.repeat(state.pairing.code.length));
});

test('desktop revocation retains failure in its confirmation and retries without dropping authorization', async ({
  page,
}) => {
  const state = await desktopFixture(page, true);
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await panel.locator('summary').click();
  await panel.getByRole('button', { name: '撤销 手机浏览器' }).click();
  const dialog = page.getByRole('dialog');
  state.failNextRevocation();
  state.holdRevocation();
  await dialog.getByRole('button', { name: '撤销登录', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '刷新浏览器列表', exact: true })).toBeDisabled();
  state.releaseRevocation();
  await expect(dialog.getByRole('alert')).toHaveText('撤销失败，请重试。');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('summary')).toContainText('1');
  await dialog.getByRole('button', { name: '撤销登录', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByText('暂无已登录浏览器。')).toBeVisible();
  expect(state.commands.filter((command) => command.type === 'web.revoke')).toHaveLength(2);
});

test('Web access is explicitly enabled and the whole settings group locks during transitions', async ({
  page,
}) => {
  const state = await desktopFixture(page, false, { webControl: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const toggle = panel.getByRole('switch', { name: '启用 Web 访问' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(panel.locator('details')).toHaveCount(0);
  expect(state.commands.filter((item) => item.type === 'web.status')).toMatchObject([
    { watch: true },
  ]);
  expect(
    state.commands.some((item) => ['web.configure', 'web.pair'].includes(String(item.type))),
  ).toBe(false);
  state.holdConfiguration();
  await toggle.click();
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByRole('button', { name: '生成配对码', exact: true })).toHaveCount(0);
  state.holdPairing();
  state.releaseConfiguration();
  await expect(toggle).toBeChecked();
  await expect(panel.getByLabel('正在准备配对码')).toHaveText('正在准备配对码…');
  await expect(toggle).toBeDisabled();
  await expect(panel.getByRole('button', { name: '显示配对码', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '复制配对码', exact: true })).toBeDisabled();
  state.releasePairing();
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  await expect(panel.getByRole('button', { name: '重新生成配对码', exact: true })).toBeEnabled();
  await toggle.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('会话任务与桌面连接不受影响');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(toggle).toBeChecked();
  await toggle.click();
  state.holdConfiguration();
  await dialog.getByRole('button', { name: '关闭 Web 访问', exact: true }).click();
  for (const button of await panel.getByRole('button').all()) await expect(button).toBeDisabled();
  await expect(toggle).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  state.releaseConfiguration();
  await expect(dialog).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(panel.locator('details')).toHaveCount(0);
  expect(
    state.commands.filter((item) => item.type === 'web.configure').map((item) => item.enabled),
  ).toEqual([true, false]);
});

test('failed Web startup keeps the switch off and can be retried without exposing inactive controls', async ({
  page,
}) => {
  const state = await desktopFixture(page, false, { webControl: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const toggle = panel.getByRole('switch', { name: '启用 Web 访问' });
  state.failNextConfiguration();
  await toggle.click();
  await expect(panel.getByRole('alert')).toContainText('开启失败，请重试。');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(panel.getByRole('button')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('settings navigation preserves a valid pairing code and locks actions while its original request settles', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { holdPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const categories = page.getByRole('navigation', { name: '设置分类' });
  await expect(panel.getByLabel('正在准备配对码')).toBeVisible();
  await categories.getByRole('button', { name: '通知', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await categories.getByRole('button', { name: '常规', exact: true }).click();
  await expect(panel.getByRole('button', { name: '生成配对码', exact: true })).toBeDisabled();
  state.releasePairing();
  await expect(panel.getByLabel('配对码已隐藏')).toHaveText('•'.repeat(state.pairing.code.length));
  await categories.getByRole('button', { name: '通知', exact: true }).click();
  await categories.getByRole('button', { name: '常规', exact: true }).click();
  await expect(panel.getByLabel('配对码已隐藏')).toHaveText('•'.repeat(state.pairing.code.length));
  await panel.getByRole('button', { name: '显示配对码', exact: true }).click();
  await expect(panel.getByLabel('配对码', { exact: true })).toHaveText(state.pairing.code);
  expect(state.commands.filter((item) => item.type === 'web.pair')).toHaveLength(1);
});

test('pairing consumption, browser logout and another desktop toggle synchronize without refreshing', async ({
  page,
}) => {
  const state = await desktopFixture(page, true);
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.locator('summary')).toContainText('1');
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  state.consumePairing();
  await expect(panel.locator('summary')).toContainText('2');
  await expect(panel.getByLabel('配对码未生成')).toHaveText('—');
  await expect(panel.getByRole('button', { name: '显示配对码', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '复制配对码', exact: true })).toBeDisabled();
  state.browserLogout();
  await expect(panel.locator('summary')).toContainText('0');
  state.externalDisable();
  await expect(panel.getByRole('switch')).not.toBeChecked();
  await expect(panel.locator('details')).toHaveCount(0);
  state.externalEnable();
  await expect(panel.getByRole('switch')).toBeChecked();
  await expect(panel.locator('summary')).toContainText('0');
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  expect(state.commands.filter((item) => item.type === 'web.status')).toHaveLength(2);
  expect(state.commands.filter((item) => item.type === 'web.pair')).toHaveLength(2);
});

test('pairing validity follows server duration instead of a skewed desktop wall clock', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { clockSkew: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByLabel('配对码已隐藏')).toHaveText('•'.repeat(state.pairing.code.length));
  await panel.getByRole('button', { name: '复制配对码', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    state.pairing.code,
  ]);
  state.expirePairing();
  await expect(panel.getByLabel('配对码未生成')).toHaveText('—');
  await expect(panel.getByRole('button', { name: '复制配对码', exact: true })).toBeDisabled();
  expect(state.commands.filter((item) => item.type === 'web.pair')).toHaveLength(1);
});

test('legacy browser-enabled services retain management without receiving unsupported switch commands', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { webControl: false });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByRole('switch')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '生成配对码', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '生成配对码', exact: true }).click();
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  expect(
    state.commands.filter((item) => item.type === 'web.status').every((item) => !('watch' in item)),
  ).toBe(true);
  expect(state.commands.some((item) => item.type === 'web.configure')).toBe(false);
});

test('a failed change remains visible after leaving and reopening settings while it is pending', async ({
  page,
}) => {
  const state = await desktopFixture(page, false, { webControl: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const categories = page.getByRole('navigation', { name: '设置分类' });
  state.holdConfiguration();
  state.failNextConfiguration();
  await panel.getByRole('switch').click();
  await categories.getByRole('button', { name: '通知', exact: true }).click();
  await categories.getByRole('button', { name: '常规', exact: true }).click();
  await expect(panel.getByRole('switch')).toBeDisabled();
  state.releaseConfiguration();
  await expect(panel.getByRole('alert')).toHaveText('开启失败，请重试。');
  await expect(panel.getByRole('switch')).toBeEnabled();
  await expect(panel.getByRole('switch')).not.toBeChecked();
  await panel.getByRole('switch').click();
  await expect(panel.getByRole('switch')).toBeChecked();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('entering enabled browser settings initializes a missing code once without an extra click', async ({
  page,
}) => {
  const state = await desktopFixture(page, true);
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByLabel('配对码已隐藏')).toHaveText('•'.repeat(state.pairing.code.length));
  expect(state.commands.filter((item) => item.type === 'web.pair')).toMatchObject([
    { ifAbsent: true },
  ]);
});

test('existing pairing is reused on entry and list refresh without generating a replacement', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByLabel('配对码已隐藏')).toHaveText('•'.repeat(state.pairing.code.length));
  await panel.locator('summary').click();
  await panel.getByRole('button', { name: '刷新浏览器列表', exact: true }).click();
  await expect(panel.getByRole('button', { name: '显示配对码', exact: true })).toBeEnabled();
  expect(state.commands.filter((item) => item.type === 'web.pair')).toHaveLength(0);
});

test('failed automatic initialization stops and has an explicit retry without replacing the Web switch state', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { failPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByRole('alert')).toHaveText('配对码初始化失败，请重试。');
  await expect(panel.getByRole('switch')).toBeChecked();
  await expect(panel.getByRole('switch')).toBeEnabled();
  await expect(panel.getByRole('button', { name: '显示配对码', exact: true })).toBeDisabled();
  expect(state.commands.filter((item) => item.type === 'web.pair')).toHaveLength(1);
  await panel.getByRole('button', { name: '重试配对码初始化', exact: true }).click();
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(state.commands.filter((item) => item.type === 'web.pair')).toMatchObject([
    { ifAbsent: true },
    { ifAbsent: true },
  ]);
});

test('an opted-in older service without conditional pairing stays read-only until manual generation', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { webPairing: false });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByLabel('配对码未生成')).toHaveText('—');
  expect(state.commands.filter((item) => item.type === 'web.pair')).toHaveLength(0);
  await panel.getByRole('button', { name: '生成配对码', exact: true }).click();
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  expect(state.commands.filter((item) => item.type === 'web.pair')).toHaveLength(1);
  expect(state.commands.find((item) => item.type === 'web.pair')).not.toHaveProperty('ifAbsent');
});

test('entering settings during a list refresh prepares a consumed code after the read settles', async ({
  page,
}) => {
  const state = await desktopFixture(page, true);
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  state.consumePairing();
  await expect(panel.getByLabel('配对码未生成')).toBeVisible();
  await panel.locator('summary').click();
  state.holdStatus();
  await panel.getByRole('button', { name: '刷新浏览器列表', exact: true }).click();
  const categories = page.getByRole('navigation', { name: '设置分类' });
  // Settings navigation remains outside the disabled Web control group.
  await categories.getByRole('button', { name: '通知', exact: true }).click();
  await categories.getByRole('button', { name: '常规', exact: true }).click();
  await expect(panel.getByRole('switch')).toBeDisabled();
  state.releaseStatus();
  await expect(panel.getByLabel('配对码已隐藏')).toBeVisible();
  expect(state.commands.filter((item) => item.type === 'web.pair')).toHaveLength(2);
});

test('desktop edits hostname and root suffix immediately and uses the effective URL for copy and open', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const domain = panel.getByRole('textbox', { name: '访问域名', exact: true });
  const path = panel.getByRole('textbox', { name: '服务端访问路径', exact: true });
  const address = panel.getByLabel('服务端访问地址', { exact: true });
  await expect(panel.getByText('留空使用部署地址；填写后仅允许指定域名访问。')).toBeVisible();
  await expect(panel.getByText('留空使用根路径。', { exact: true })).toBeVisible();
  await expect(domain).toHaveValue('');
  await expect(path).toHaveValue('fixture-entry');
  await expect(address).toHaveText('https://web.example.test:8787/fixtu...');
  await expect(address).not.toHaveAttribute('title');
  await panel.scrollIntoViewIfNeeded();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('web-address-settings-desktop.png') });
  await page.setViewportSize({ width: 750, height: 900 });
  await panel.scrollIntoViewIfNeeded();
  expect(await domain.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(
    200,
  );
  expect(
    await panel.locator('.server-web-address-actions').evaluate((element) => {
      const centers = [...element.children].map((child) => {
        const rect = child.getBoundingClientRect();
        return rect.y + rect.height / 2;
      });
      return Math.max(...centers) - Math.min(...centers);
    }),
  ).toBeLessThan(1);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('web-address-settings-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await domain.fill('work.example.test');
  await domain.blur();
  await expect
    .poll(() => state.commands.filter((item) => item.type === 'web.configure'))
    .toEqual([expect.objectContaining({ enabled: true, domain: 'work.example.test' })]);
  await expect(domain).toBeEnabled();
  await expect(address).toHaveText('https://work.example.test:8787/fixtu...');
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  await panel.getByRole('button', { name: '打开浏览器', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    'https://work.example.test:8787/fixture-entry/',
  ]);
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([
    `https://work.example.test:8787/fixture-entry/#pair=${state.pairing.code}`,
  ]);
  await path.fill('my-workbench');
  await path.blur();
  await expect
    .poll(() => state.commands.filter((item) => item.type === 'web.configure'))
    .toHaveLength(2);
  expect(state.commands.filter((item) => item.type === 'web.configure')[1]).toMatchObject({
    enabled: true,
    path: 'my-workbench',
  });
  await expect(address).toHaveText('https://work.example.test:8787/my-wo...');
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  await panel.getByRole('button', { name: '打开浏览器', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    'https://work.example.test:8787/fixture-entry/',
    'https://work.example.test:8787/my-workbench/',
  ]);
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([
    `https://work.example.test:8787/fixture-entry/#pair=${state.pairing.code}`,
    `https://work.example.test:8787/my-workbench/#pair=${state.pairing.code}`,
  ]);
  await domain.fill('');
  await domain.blur();
  await expect
    .poll(() => state.commands.filter((item) => item.type === 'web.configure'))
    .toHaveLength(3);
  expect(state.commands.filter((item) => item.type === 'web.configure')[2]).toMatchObject({
    domain: '',
  });
  await expect(address).toHaveText('https://web.example.test:8787/my-wo...');
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  await panel.getByRole('button', { name: '打开浏览器', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1))).toBe(
    'https://web.example.test:8787/my-workbench/',
  );
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened.at(-1))).toBe(
    `https://web.example.test:8787/my-workbench/#pair=${state.pairing.code}`,
  );
});

test('access address preserves up to five path characters and only shortens the display', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const path = panel.getByRole('textbox', { name: '服务端访问路径', exact: true });
  const address = panel.getByLabel('服务端访问地址', { exact: true });
  await expect(path).toHaveValue('fixture-entry');
  const cases = [
    { value: '', display: '/' },
    { value: 'a', display: '/a/' },
    { value: 'abcde', display: '/abcde/' },
    { value: 'abcdef', display: '/abcde...' },
    { value: `abcdef${'z'.repeat(58)}`, display: '/abcde...' },
  ];
  for (const { value, display } of cases) {
    await test.step(`path length ${value.length}`, async () => {
      await path.fill(value);
      await path.blur();
      await expect
        .poll(() => state.commands.filter((item) => item.type === 'web.configure').at(-1))
        .toMatchObject({ enabled: true, path: value });
      await expect(path).toBeEnabled();
      await expect(path).toHaveValue(value);
      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(address).toHaveText(`https://web.example.test:8787${display}`);
      await expect(address).not.toHaveAttribute('title');
      await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
      await panel.getByRole('button', { name: '打开浏览器', exact: true }).click();
      const complete = `https://web.example.test:8787/${value ? `${value}/` : ''}`;
      expect(
        await page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1)),
      ).toBe(complete);
      expect(
        await page.evaluate(() => (window as unknown as { opened: string[] }).opened.at(-1)),
      ).toBe(`${complete}#pair=${state.pairing.code}`);
    });
  }
  const domain = panel.getByRole('textbox', { name: '访问域名', exact: true });
  await domain.fill('changed.example.test');
  await domain.blur();
  await expect(address).toHaveText('https://changed.example.test:8787/abcde...');
  await expect(path).toHaveValue(cases.at(-1)!.value);
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  await panel.getByRole('button', { name: '打开浏览器', exact: true }).click();
  const complete = `https://changed.example.test:8787/${cases.at(-1)!.value}/`;
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1))).toBe(
    complete,
  );
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened.at(-1))).toBe(
    `${complete}#pair=${state.pairing.code}`,
  );
});

test('clearing the access path uses the root URL and regeneration restores a shortened address', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const domain = panel.getByRole('textbox', { name: '访问域名', exact: true });
  const path = panel.getByRole('textbox', { name: '服务端访问路径', exact: true });
  const address = panel.getByLabel('服务端访问地址', { exact: true });
  await expect(path).toHaveValue('fixture-entry');
  await path.fill('');
  await path.blur();
  await expect
    .poll(() => state.commands.filter((item) => item.type === 'web.configure'))
    .toEqual([expect.objectContaining({ enabled: true, path: '' })]);
  await expect(path).toBeEnabled();
  await expect(path).toHaveValue('');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(address).toHaveText('https://web.example.test:8787/');
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  await panel.getByRole('button', { name: '打开浏览器', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    'https://web.example.test:8787/',
  ]);
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([
    `https://web.example.test:8787/#pair=${state.pairing.code}`,
  ]);

  await domain.fill('root.example.test');
  await domain.blur();
  await expect(address).toHaveText('https://root.example.test:8787/');
  await expect(path).toHaveValue('');
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  await panel.getByRole('button', { name: '打开浏览器', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1))).toBe(
    'https://root.example.test:8787/',
  );
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened.at(-1))).toBe(
    `https://root.example.test:8787/#pair=${state.pairing.code}`,
  );

  const categories = page.getByRole('navigation', { name: '设置分类' });
  await categories.getByRole('button', { name: '通知', exact: true }).click();
  await categories.getByRole('button', { name: '常规', exact: true }).click();
  await expect(path).toHaveValue('');
  await expect(address).toHaveText('https://root.example.test:8787/');
  await panel.getByRole('button', { name: '重新生成访问路径', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: '重新生成访问路径', exact: true }),
  });
  await dialog.getByRole('button', { name: '重新生成访问路径', exact: true }).click();
  await expect(path).toHaveValue('00112233445566778899aabbccddeeff');
  await expect(address).toHaveText('https://root.example.test:8787/00112...');
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1))).toBe(
    'https://root.example.test:8787/00112233445566778899aabbccddeeff/',
  );
});

test('address save locks every Web control and failed changes restore the effective value', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const path = panel.getByRole('textbox', { name: '服务端访问路径', exact: true });
  await expect(path).toHaveValue('fixture-entry');
  state.holdConfiguration();
  state.failNextConfiguration();
  await path.fill('not-saved');
  await path.blur();
  await expect
    .poll(() => state.commands.filter((item) => item.type === 'web.configure'))
    .toHaveLength(1);
  for (const control of await panel.locator('input, button').all())
    await expect(control).toBeDisabled();
  state.releaseConfiguration();
  await expect(panel.getByRole('alert')).toHaveText('开启失败，请重试。');
  await expect(path).toHaveValue('fixture-entry');
  await expect(path).toBeEnabled();
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1))).toBe(
    'https://web.example.test:8787/fixture-entry/',
  );
});

test('path regeneration confirms once, cancels without saving, and retains pairing and grants', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const path = panel.getByRole('textbox', { name: '服务端访问路径', exact: true });
  const regenerate = panel.getByRole('button', { name: '重新生成访问路径', exact: true });
  await expect(path).toHaveValue('fixture-entry');
  const domain = panel.getByRole('textbox', { name: '访问域名', exact: true });
  await domain.fill('uncommitted.example.test');
  await regenerate.click();
  const dialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: '重新生成访问路径', exact: true }),
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(state.commands.filter((item) => item.type === 'web.configure')).toHaveLength(0);
  await expect(domain).toHaveValue('');
  await path.fill('uncommitted-draft');
  await regenerate.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(state.commands.filter((item) => item.type === 'web.configure')).toHaveLength(0);
  await expect(path).toHaveValue('fixture-entry');
  await regenerate.click();
  await dialog.getByRole('button', { name: '重新生成访问路径', exact: true }).click();
  await expect(path).toHaveValue('00112233445566778899aabbccddeeff');
  expect(state.commands.filter((item) => item.type === 'web.configure')).toEqual([
    expect.objectContaining({ enabled: true, regeneratePath: true }),
  ]);
  await panel.getByRole('button', { name: '显示配对码', exact: true }).click();
  await expect(panel.getByLabel('配对码', { exact: true })).toHaveText(state.pairing.code);
  await expect(panel.locator('summary')).toContainText('1');
});

test('older services retain Web management without unsupported address controls', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { webSettings: false, existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  await expect(panel.getByRole('textbox', { name: '访问域名', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('textbox', { name: '服务端访问路径', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('服务端访问地址', { exact: true })).toHaveText(
    'https://web.example.test:8787/',
  );
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    'https://web.example.test:8787/',
  ]);
  expect(state.commands.filter((item) => item.type === 'web.configure')).toHaveLength(0);
});

test('address inputs reject URL syntax and malformed or reserved paths without sending changes', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const domain = panel.getByRole('textbox', { name: '访问域名', exact: true });
  const path = panel.getByRole('textbox', { name: '服务端访问路径', exact: true });
  await expect(path).toHaveValue('fixture-entry');
  for (const value of [
    'https://web.example.test',
    'web.example.test:8787',
    'web.example.test/path',
  ]) {
    await domain.fill(value);
    await domain.blur();
    await expect(domain).toHaveValue('');
    await expect(panel.getByRole('alert')).toBeVisible();
  }
  for (const value of ['nested/path', '..', 'ws', 'health', 'client']) {
    await path.fill(value);
    await path.blur();
    await expect(path).toHaveValue('fixture-entry');
    await expect(panel.getByRole('alert')).toBeVisible();
  }
  expect(state.commands.filter((item) => item.type === 'web.configure')).toHaveLength(0);
});

test('another desktop address change preserves the unrelated focused input draft', async ({
  page,
}) => {
  const state = await desktopFixture(page, true, { existingPairing: true });
  await generalSettings(page);
  const panel = page.locator('.server-web-access');
  const domain = panel.getByRole('textbox', { name: '访问域名', exact: true });
  const path = panel.getByRole('textbox', { name: '服务端访问路径', exact: true });
  await expect(path).toHaveValue('fixture-entry');
  await path.fill('my-path-draft');
  state.externalAddress({ domain: 'another.example.test' });
  await expect(domain).toHaveValue('another.example.test');
  await expect(path).toHaveValue('my-path-draft');
  await expect(path).toBeFocused();
  await path.blur();
  await expect
    .poll(() => state.commands.filter((item) => item.type === 'web.configure'))
    .toEqual([expect.objectContaining({ enabled: true, path: 'my-path-draft' })]);
  await expect(domain).toBeEnabled();
  await domain.fill('my-domain.example.test');
  state.externalAddress({ path: 'another-path' });
  await expect(path).toHaveValue('another-path');
  await expect(domain).toHaveValue('my-domain.example.test');
  await expect(domain).toBeFocused();
  await domain.blur();
  await expect
    .poll(() => state.commands.filter((item) => item.type === 'web.configure'))
    .toEqual([
      expect.objectContaining({ enabled: true, path: 'my-path-draft' }),
      expect.objectContaining({ enabled: true, domain: 'my-domain.example.test' }),
    ]);
  await panel.getByRole('button', { name: '复制访问地址', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    'https://my-domain.example.test:8787/another-path/',
  ]);
});
