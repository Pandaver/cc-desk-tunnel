import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Route, WebSocketRoute } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const code = '00112233445566778899aabb';
const login = {
  device: { id: '00000000-0000-4000-8000-000000000001', name: '测试浏览器' },
  expiresAt: null,
};

// Exercise the shipped entry and cookie gate, with no service credential or native executor.
async function fixture(context: BrowserContext, paired = false) {
  const state = {
    paired,
    sessions: 0,
    codes: [] as string[],
    sockets: [] as WebSocketRoute[],
    get: null as ((route: Route) => Promise<void>) | null,
    pair: null as ((route: Route) => Promise<void>) | null,
    logout: null as ((route: Route) => Promise<void>) | null,
    authenticate: null as ((socket: WebSocketRoute) => void) | null,
  };
  await context.route('**/browser-entry/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/browser-entry/web/session') {
      state.sessions++;
      if (state.get) return state.get(route);
      return route.fulfill({ status: state.paired ? 200 : 401, json: state.paired ? login : {} });
    }
    if (path === '/browser-entry/web/pair') {
      state.codes.push(route.request().postDataJSON().code);
      if (state.pair) return state.pair(route);
      state.paired = true;
      return route.fulfill({
        headers: { 'Set-Cookie': 'test_web_login=active; Path=/; HttpOnly; SameSite=Strict' },
        json: login,
      });
    }
    if (path === '/browser-entry/web/logout') {
      if (state.logout) return state.logout(route);
      state.paired = false;
      return route.fulfill({ json: { ok: true } });
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
  await context.routeWebSocket('**/browser-entry/web/ws', (socket) => {
    state.sockets.push(socket);
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'web.auth') {
        if (state.authenticate) return state.authenticate(socket);
        socket.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            connectionId: '00000000-0000-4000-8000-000000000020',
            version: '0.3.4',
            adapter: 'claude-code',
            sessions: [],
          }),
        );
      } else if (command.requestId) {
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      }
    });
  });
  return state;
}

async function connected(page: Page) {
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await expect(page.locator('.web-login')).toHaveCount(0);
  expect(page.url()).not.toContain('pair=');
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(code);
}

test('an initial session failure keeps the fragment code for one explicit retry', async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.get = async (route) => {
    state.get = null;
    await route.fulfill({ status: 503, json: { message: '读取登录状态暂时失败。' } });
  };
  await page.goto(`/browser-entry/#pair=${code}`);
  await expect(page.getByRole('alert')).toHaveText('读取登录状态暂时失败。');
  expect(page.url()).not.toContain('pair=');
  expect(state.codes).toEqual([]);
  await page.getByRole('button', { name: '重新检查登录', exact: true }).click();
  await connected(page);
  expect(state.codes).toEqual([code]);
});

test('an unsuccessful automatic pairing preserves the code without silently resending it', async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.pair = async (route) => {
    state.pair = null;
    await route.fulfill({ status: 503, json: { message: '配对暂时失败。' } });
  };
  await page.goto(`/browser-entry/#pair=${code}`);
  await expect(page.getByRole('alert')).toHaveText('配对暂时失败。');
  await expect(page.getByLabel('配对码', { exact: true })).toHaveValue('');
  expect(state.codes).toEqual([code]);
  expect(state.sessions).toBe(2);
  await page.getByRole('button', { name: '重新检查登录', exact: true }).click();
  await connected(page);
  expect(state.codes).toEqual([code, code]);
  expect(state.sessions).toBe(3);
});

test('a lost pairing response recovers the cookie without redeeming the code again', async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.pair = async (route) => {
    state.paired = true;
    await route.abort('connectionreset');
  };
  await page.goto(`/browser-entry/#pair=${code}`);
  await connected(page);
  expect(state.codes).toEqual([code]);
  expect(state.sessions).toBe(2);
});

test('two tabs opening one code recover the shared login instead of leaving a false pairing error', async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  const held: Route[] = [];
  state.get = async (route) => {
    held.push(route);
    if (held.length === 2) {
      state.get = null;
      await Promise.all(held.map((item) => item.fulfill({ status: 401, json: {} })));
    }
  };
  state.pair = async (route) => {
    if (state.paired)
      return route.fulfill({ status: 401, json: { message: '配对码已失效，请生成新的配对码。' } });
    state.paired = true;
    return route.fulfill({ json: login });
  };
  const second = await context.newPage();
  await Promise.all([
    page.goto(`/browser-entry/#pair=${code}`),
    second.goto(`/browser-entry/#pair=${code}`),
  ]);
  await Promise.all([connected(page), connected(second)]);
  expect(state.codes).toEqual([code, code]);
  await expect(second.getByRole('alert')).toHaveCount(0);
});

for (const delayedFailure of [false, true]) {
  test(`two tabs recover a delayed Set-Cookie ${delayedFailure ? 'during' : 'after'} the failed exchange`, async ({
    page,
    context,
  }) => {
    const state = await fixture(context);
    const lookups: Route[] = [];
    const exchanges: Route[] = [];
    let failedLookup: Route | undefined;
    state.get = async (route) => {
      if (lookups.length < 2) {
        lookups.push(route);
        if (lookups.length === 2)
          await Promise.all(lookups.map((item) => item.fulfill({ status: 401, json: {} })));
        return;
      }
      if (delayedFailure && state.sessions === 3) {
        failedLookup = route;
        return;
      }
      // Authentication starts only when the browser receives Set-Cookie, not when the service commits
      // the grant. A shared fixture boolean would hide the response-ordering bug this test exercises.
      const paired = (await route.request().allHeaders()).cookie?.includes('test_web_login=active');
      return route.fulfill({ status: paired ? 200 : 401, json: paired ? login : {} });
    };
    state.pair = async (route) => {
      exchanges.push(route);
      if (exchanges.length === 2)
        await route.fulfill({ status: 401, json: { error: '配对码已失效。' } });
    };
    const second = await context.newPage();
    await Promise.all([
      page.goto(`/browser-entry/#pair=${code}`),
      second.goto(`/browser-entry/#pair=${code}`),
    ]);
    await expect.poll(() => exchanges.length).toBe(2);
    await expect.poll(() => state.sessions).toBe(3);
    await exchanges[0].fulfill({
      headers: { 'Set-Cookie': 'test_web_login=active; Path=/; HttpOnly; SameSite=Strict' },
      json: login,
    });
    if (delayedFailure) {
      await connected(exchanges[0].request().frame().page());
      await failedLookup!.fulfill({ status: 401, json: {} });
    }
    await Promise.all([connected(page), connected(second)]);
    expect(state.codes).toEqual([code, code]);
    const completed = state.sessions;
    await page.waitForTimeout(100);
    expect(state.sessions).toBe(completed);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(second.getByRole('alert')).toHaveCount(0);
  });
}

async function notifyLogin(page: Page) {
  await page.evaluate(() => {
    const channel = new BroadcastChannel('cc-desk-tunnel:web-login');
    channel.postMessage({ type: 'login' });
    channel.close();
  });
}

test('a cross-tab notice only reads the cookie and cannot override a newer explicit pairing', async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto('/browser-entry/');
  await expect(page.getByLabel('配对码', { exact: true })).toBeEnabled();
  let held: Route | undefined;
  state.get = async (route) => {
    state.get = null;
    held = route;
  };
  await notifyLogin(page);
  await expect.poll(() => !!held).toBe(true);
  expect(state.codes).toEqual([]);
  await page.getByLabel('配对码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '配对并进入', exact: true }).click();
  await connected(page);
  await held!.fulfill({
    json: { ...login, device: { ...login.device, id: '00000000-0000-4000-8000-000000000099' } },
  });
  await connected(page);
  expect(state.codes).toEqual([code]);
  expect(state.sockets).toHaveLength(1);
});

test('a cross-tab notice neither logs an explicitly signed-out tab back in nor redeems a code', async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  await page.goto('/browser-entry/');
  await connected(page);
  await page.getByRole('button', { name: '设置与账号' }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(page.getByLabel('配对码', { exact: true })).toBeEnabled();
  const lookups = state.sessions;
  state.paired = true;
  await notifyLogin(page);
  await page.waitForTimeout(100);
  expect(state.sessions).toBe(lookups);
  expect(state.codes).toEqual([]);
  await expect(page.locator('.shell')).toHaveCount(0);
});

test('login still works when the browser does not provide cross-tab notifications', async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
  });
  const state = await fixture(context);
  await page.goto(`/browser-entry/#pair=${code}`);
  await connected(page);
  expect(state.codes).toEqual([code]);
});

test('manual pairing locks synchronous duplicate submissions and keeps an invalid code editable', async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  let release: Route | undefined;
  state.pair = async (route) => {
    release = route;
  };
  await page.goto('/browser-entry/');
  await page.getByLabel('配对码', { exact: true }).fill(code);
  await page.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => state.codes).toEqual([code]);
  await expect(page.getByLabel('配对码', { exact: true })).toBeDisabled();
  await release!.fulfill({ status: 401, json: { message: '配对码已失效。' } });
  await expect(page.getByRole('alert')).toHaveText('配对码已失效。');
  await expect(page.getByLabel('配对码', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('配对码', { exact: true })).toHaveValue(code);
  expect(state.codes).toEqual([code]);
});

test('a late logout response cannot clear a new login after the old grant was revoked', async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  let release: Route | undefined;
  let cancelled = false;
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/browser-entry/web/logout') cancelled = true;
  });
  state.logout = async (route) => {
    release = route;
  };
  await page.goto('/browser-entry/');
  await connected(page);
  await page.getByRole('button', { name: '设置与账号' }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  state.paired = false;
  state.sockets.at(-1)!.close({ code: 4001, reason: 'revoked' });
  await expect(page.getByRole('alert')).toContainText('登录已失效');
  await expect.poll(() => cancelled).toBe(true);
  await page.getByLabel('配对码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '配对并进入', exact: true }).click();
  await connected(page);
  await release!.fulfill({
    headers: { 'Set-Cookie': 'test_web_login=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict' },
    json: { ok: true },
  });
  await connected(page);
  expect((await context.cookies()).find((cookie) => cookie.name === 'test_web_login')?.value).toBe(
    'active',
  );
  expect(state.codes).toEqual([code]);
});

test('first handshake failure never reveals an empty or Simulation workbench', async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  state.authenticate = (socket) => {
    if (state.sockets.length === 1) socket.close({ code: 1011, reason: 'temporary outage' });
  };
  await page.goto('/browser-entry/');
  await expect.poll(() => state.sockets.length).toBeGreaterThan(1);
  await expect(page.getByRole('heading', { name: '正在连接工作台…' })).toBeVisible();
  await expect(page.locator('.shell')).toHaveCount(0);
  await expect(page.getByText('Simulation', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0);
});

test('reconnecting an established browser keeps the existing workbench visible', async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  await page.goto('/browser-entry/');
  await connected(page);
  state.authenticate = () => {};
  state.sockets.at(-1)!.close({ code: 1011, reason: 'temporary outage' });
  await expect(page.locator('.connection-status')).toContainText('重连中');
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('.web-login')).toHaveCount(0);
});

test('a fresh pairing fragment reuses a revoked tab without requiring a page reload', async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  await page.goto('/browser-entry/');
  await connected(page);
  state.paired = false;
  state.sockets.at(-1)!.close({ code: 4001, reason: 'revoked' });
  await expect(page.getByRole('alert')).toContainText('登录已失效');
  await page.goto(`/browser-entry/#pair=${code}`);
  await connected(page);
  expect(state.codes).toEqual([code]);
});

test('a pairing fragment in an authenticated tab keeps its existing identity and connection', async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  await page.goto('/browser-entry/');
  await connected(page);
  await page.goto(`/browser-entry/#pair=${code}`);
  await expect.poll(() => state.sessions).toBe(2);
  await connected(page);
  expect(state.codes).toEqual([]);
  expect(state.sockets).toHaveLength(1);
});

test('a new explicit pairing fragment supersedes a pending lookup and never submits the old code', async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  let held: Route | undefined;
  state.get = async (route) => {
    state.get = null;
    held = route;
  };
  await page.goto('/browser-entry/#pair=ffeeddccbbaa998877665544');
  await expect.poll(() => !!held).toBe(true);
  await page.goto(`/browser-entry/#pair=${code}`);
  await connected(page);
  await held!.fulfill({ status: 401, json: {} });
  await connected(page);
  expect(state.codes).toEqual([code]);
});
