import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { RelayStatus, RemoteStatus } from '../src/desktop.d.ts';

declare global {
  interface Window {
    relaySettingsFixture: {
      actions: string[];
      fail: boolean;
      hold: boolean;
      failRoute: boolean;
      holdRoute: boolean;
      release?: () => void;
      publish: (status: RelayStatus) => void;
      sessions: (sessions: RemoteStatus['sessions']) => void;
    };
  }
}

async function mount(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.evaluate(
    async (paths) => {
      const { createElement } = (await import(paths.react)).default;
      const { createRoot } = (await import(paths.root)).default;
      const { default: RemoteControl } = await import(paths.control);
      await import(paths.style);
      const status: RemoteStatus = {
        enabled: false,
        lan: false,
        port: 5270,
        url: null,
        token: null,
        sessions: [],
      };
      let relay: RelayStatus = {
        enabled: false,
        route: '0123456789abcdef0123456789abcdef',
        state: 'disabled',
        url: null,
        error: null,
      };
      let listener: ((value: RelayStatus) => void) | undefined;
      let sessionListener: ((sessions: RemoteStatus['sessions']) => void) | undefined;
      window.relaySettingsFixture = {
        actions: [],
        fail: false,
        hold: false,
        failRoute: false,
        holdRoute: false,
        sessions: (sessions) => {
          status.sessions = sessions;
          sessionListener?.(sessions);
        },
        publish: (value) => {
          relay = value;
          listener?.({ ...relay });
        },
      };
      const fixture = window.relaySettingsFixture;
      window.desktop = {
        remoteStatus: async () => ({ ...status }),
        configureRemote: async (value) => {
          if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535)
            throw new Error('本地监听端口无效。');
          Object.assign(status, value, {
            url: value.enabled ? `http://127.0.0.1:${value.port}` : null,
            token: value.enabled ? 'test-only-pairing-code' : null,
          });
          fixture.actions.push(`web:${status.enabled}:${status.port}`);
          if (!status.enabled)
            fixture.publish({
              ...relay,
              enabled: false,
              state: 'disabled',
              url: null,
              error: null,
            });
          return { ...status };
        },
        relayStatus: async () => ({ ...relay }),
        configureRelayRoute: async (route) => {
          fixture.actions.push(`route:${route}`);
          if (fixture.holdRoute)
            await new Promise<void>((resolve) => {
              fixture.release = resolve;
            });
          if (fixture.failRoute) throw new Error('访问路径保存失败，请重试。');
          if (route === 'occupied') throw new Error('访问路径已被其他工作台使用，请换一个。');
          if (route && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(route))
            throw new Error('访问路径格式无效。');
          fixture.publish({
            ...relay,
            route: route || '0123456789abcdef0123456789abcdef',
            url:
              relay.state === 'online'
                ? `http://relay.example:5270/remote/${route || '0123456789abcdef0123456789abcdef'}/`
                : null,
          });
          return { ...relay };
        },
        copyText: async (text) => {
          fixture.actions.push(`copy:${text}`);
        },
        resetRemotePairing: async () => {
          fixture.actions.push('reset-pairing');
          status.token = 'new-test-pairing-code';
          status.sessions = [];
          return { ...status };
        },
        revokeRemoteSession: async (id) => {
          fixture.actions.push(`revoke:${id}`);
          status.sessions = status.sessions.filter((s) => s.id !== id);
          return { ...status };
        },
        configureRelay: async (enabled) => {
          fixture.actions.push(`relay:${enabled}:${status.port}`);
          if (fixture.hold)
            await new Promise<void>((resolve) => {
              fixture.release = resolve;
            });
          if (fixture.fail) throw new Error('设置保存失败，请重试。');
          if (!enabled) {
            fixture.publish({
              ...relay,
              enabled: false,
              state: 'disabled',
              url: null,
              error: null,
            });
            return { ...relay };
          }
          const response: RelayStatus = {
            enabled: true,
            route: relay.route,
            state: 'connecting',
            url: null,
            error: null,
          };
          // Readiness may arrive before the invocation response reaches the renderer.
          fixture.publish({
            ...response,
            state: 'online',
            url: `http://relay.example:5270/remote/${relay.route || '0123456789abcdef0123456789abcdef'}/`,
          });
          return response;
        },
        onRemoteSessionsChanged: (callback) => {
          sessionListener = callback;
          return () => {
            sessionListener = undefined;
          };
        },
        onRelayChanged: (callback) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        openRelay: async () => {
          fixture.actions.push('open-relay');
        },
        openRemote: async () => {
          fixture.actions.push('open-local');
        },
      } as Window['desktop'];
      const root = document.getElementById('root')!;
      root.style.cssText =
        'padding: 24px; max-width: 960px; margin: 0 auto; overflow: auto; height: 100%;';
      createRoot(root).render(createElement(RemoteControl));
    },
    {
      react: '/node_modules/.vite/deps/react.js',
      root: '/node_modules/.vite/deps/react-dom_client.js',
      control: '/src/RemoteControl.tsx',
      style: '/src/style.css',
    },
  );
  await expect(page.getByRole('switch', { name: '启用 Web 工作台', exact: true })).toBeEnabled();
}

async function expectCollapsedSettings(page: Page, recovering = false) {
  const card = page.locator('.remote-control');
  await expect(card.getByRole('switch')).toHaveCount(1);
  await expect(page.getByRole('switch', { name: '通过服务端访问', exact: true })).toBeHidden();
  await expect(page.getByRole('textbox', { name: '服务端访问路径', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '重置配对码', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '复制本机地址', exact: true })).toBeHidden();
  await expect(page.getByLabel('Web 配对码', { exact: true })).toBeHidden();
  await expect(card.locator('details')).toBeHidden();
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  if (recovering) await expect(port).toBeVisible();
  else await expect(port).toBeHidden();
}

test('disabled Web settings collapse and enabling restores saved port, LAN, route and browsers', async ({
  page,
}, testInfo) => {
  await mount(page);
  const toggle = page.getByRole('switch', { name: '启用 Web 工作台', exact: true });
  await expect(toggle).not.toBeChecked();
  await expectCollapsedSettings(page);
  await page.screenshot({ path: testInfo.outputPath('web-disabled-wide.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('web-disabled-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await toggle.click();
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  const lan = page.getByRole('switch', { name: '允许局域网访问', exact: true });
  const route = page.getByRole('textbox', { name: '服务端访问路径', exact: true });
  await expect(port).toHaveValue('5270');
  await port.fill('19131');
  await port.blur();
  await expect(port).toBeEnabled();
  await lan.click();
  await route.fill('saved-workstation');
  await route.blur();
  await expect(route).toBeEnabled();
  await page.evaluate(() =>
    window.relaySettingsFixture.sessions([
      { id: 'one', label: 'Chrome', createdAt: Date.now(), expiresAt: Date.now() + 86400000 },
    ]),
  );
  const group = page.locator('.remote-control details');
  await expect(group.locator('summary')).toContainText('1');
  await page.screenshot({ path: testInfo.outputPath('web-enabled-wide.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('web-enabled-narrow.png'), fullPage: true });
  // Closing commits the last focused draft before removing its input from the page.
  await route.fill('saved-before-close');
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expectCollapsedSettings(page);
  await expect
    .poll(() => page.evaluate(() => window.relaySettingsFixture.actions.slice(-2)))
    .toEqual(['route:saved-before-close', 'web:false:19131']);
  await toggle.click();
  await expect(port).toHaveValue('19131');
  await expect(lan).toBeChecked();
  await expect(route).toHaveValue('saved-before-close');
  await expect(group.locator('summary')).toContainText('1');
  await group.locator('summary').click();
  await expect(group.getByRole('button', { name: /^撤销 Chrome/ })).toBeVisible();
  expect(
    await page.evaluate(() => window.desktop!.remoteStatus!().then((value) => value.sessions)),
  ).toHaveLength(1);
});

test('a pending Web startup locks the master switch without exposing inactive settings', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const configure = window.desktop!.configureRemote!;
    window.desktop!.configureRemote = async (value) => {
      await new Promise<void>((resolve) => {
        window.relaySettingsFixture.release = resolve;
      });
      return configure(value);
    };
  });
  const toggle = page.getByRole('switch', { name: '启用 Web 工作台', exact: true });
  await toggle.click();
  await expect.poll(() => page.evaluate(() => !!window.relaySettingsFixture.release)).toBe(true);
  await expect(toggle).toBeDisabled();
  await expectCollapsedSettings(page);
  await page.evaluate(() => window.relaySettingsFixture.release!());
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('spinbutton', { name: '本地监听端口', exact: true })).toBeVisible();
});

test('failed startup reveals only the port and keeps recovery visible through edit and save until retry', async ({
  page,
}, testInfo) => {
  await mount(page);
  await page.evaluate(() => {
    const configure = window.desktop!.configureRemote!;
    window.desktop!.configureRemote = async (value) => {
      if (value.enabled && value.port === 5270) throw new Error('端口 5270 已被占用，请更换端口。');
      return configure(value);
    };
  });
  const toggle = page.getByRole('switch', { name: '启用 Web 工作台', exact: true });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('alert')).toHaveText('端口 5270 已被占用，请更换端口。');
  await expectCollapsedSettings(page, true);
  await page.screenshot({
    path: testInfo.outputPath('web-startup-error-wide.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('web-startup-error-narrow.png'),
    fullPage: true,
  });
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  await port.fill('19132');
  await expectCollapsedSettings(page, true);
  await port.blur();
  await expect(port).toBeEnabled();
  await expect(port).toHaveValue('19132');
  await expectCollapsedSettings(page, true);
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:false:19132',
  ]);
  expect(
    await page.evaluate(() => window.desktop!.remoteStatus!().then((value) => value.enabled)),
  ).toBe(false);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('switch', { name: '允许局域网访问', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '服务端访问路径', exact: true })).toBeVisible();
  await toggle.click();
  await expectCollapsedSettings(page);
});

test('a failed Web shutdown keeps confirmed settings visible and a retry can collapse them', async ({
  page,
}) => {
  await mount(page);
  const toggle = page.getByRole('switch', { name: '启用 Web 工作台', exact: true });
  await toggle.click();
  await page.evaluate(() => {
    const configure = window.desktop!.configureRemote!;
    window.relaySettingsFixture.fail = true;
    window.desktop!.configureRemote = async (value) => {
      if (!value.enabled && window.relaySettingsFixture.fail) throw new Error('停止失败，请重试。');
      return configure(value);
    };
  });
  await toggle.click();
  await expect(page.getByRole('alert')).toHaveText('停止失败，请重试。');
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('spinbutton', { name: '本地监听端口', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: '允许局域网访问', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '服务端访问路径', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制本机地址', exact: true })).toBeEnabled();
  await expect(page.locator('.remote-control details')).toBeVisible();
  await page.evaluate(() => {
    window.relaySettingsFixture.fail = false;
  });
  await toggle.click();
  await expectCollapsedSettings(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('relay settings are opt-in and commit the Web port before enabling or opening the relay', async ({
  page,
}) => {
  await mount(page);
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  await expect(toggle).toBeHidden();
  await expect(page.getByRole('combobox', { name: '公网协议', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '公网地址', exact: true })).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: '公网端口', exact: true })).toHaveCount(0);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  await port.fill('19101');
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText('服务端访问地址', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:5270',
    'web:true:19101',
    'relay:true:19101',
  ]);
  await port.fill('19102');
  await page.getByRole('button', { name: '打开服务端链接', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.relaySettingsFixture.actions.slice(-2)))
    .toEqual(['web:true:19102', 'open-relay']);
  await page.screenshot({ path: '.local/screenshots/relay-settings-desktop.png', fullPage: true });
  // A settings sidebar can leave a narrow card even when the window itself is wide.
  await page.locator('.remote-control').evaluate((card) => {
    card.style.width = '300px';
  });
  const label = page.getByText('服务端访问地址', { exact: true });
  const address = page.locator('.setting-row').filter({ has: label }).locator('.remote-address');
  const narrowLabel = await label.boundingBox();
  const narrowAddress = await address.boundingBox();
  expect(narrowLabel!.height).toBeLessThan(30);
  expect(
    Math.abs(
      narrowAddress!.y + narrowAddress!.height / 2 - narrowLabel!.y - narrowLabel!.height / 2,
    ),
  ).toBeLessThan(10);
  await page.locator('.remote-control').evaluate((card) => {
    card.style.width = '';
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(toggle).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.local/screenshots/relay-settings-narrow.png', fullPage: true });
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await expect(toggle).toBeHidden();
  await expect(page.getByText('服务端访问地址', { exact: true })).toHaveCount(0);
});

test('relay setup errors leave local Web enabled and can be retried', async ({ page }) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await page.evaluate(() => {
    window.relaySettingsFixture.fail = true;
  });
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  await toggle.click();
  await expect(page.getByRole('alert')).toHaveText('设置保存失败，请重试。');
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('switch', { name: '启用 Web 工作台', exact: true })).toBeChecked();
  await page.evaluate(() => {
    window.relaySettingsFixture.fail = false;
  });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('relay transactions lock controls briefly and disable ignores an invalid local port draft', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  await page.evaluate(() => {
    window.relaySettingsFixture.hold = true;
  });
  await toggle.click();
  await expect.poll(() => page.evaluate(() => !!window.relaySettingsFixture.release)).toBe(true);
  await expect(toggle).toBeDisabled();
  await expect(port).toBeDisabled();
  await expect(page.getByRole('button', { name: '复制本机地址', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    window.relaySettingsFixture.hold = false;
    window.relaySettingsFixture.release?.();
  });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => window.relaySettingsFixture.actions))
    .toEqual(['web:true:5270', 'relay:true:5270', 'relay:false:5270']);
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('服务端访问地址', { exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(page.getByText('服务端访问地址', { exact: true })).toBeVisible();
  await port.fill('0');
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.relaySettingsFixture.actions.at(-1)))
    .toBe('relay:false:5270');
  await expect(page.getByRole('switch', { name: '启用 Web 工作台', exact: true })).toBeChecked();
});

test('failed port commit blocks relay enable and the restored port allows retry', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await page.evaluate(() => {
    const configure = window.desktop!.configureRemote!;
    window.desktop!.configureRemote = async (value) => {
      if (value.port === 19111) throw new Error('EADDRINUSE');
      return configure(value);
    };
  });
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  await port.fill('19111');
  await toggle.click();
  await expect(page.getByRole('alert').first()).toHaveText('EADDRINUSE');
  await expect(toggle).not.toBeChecked();
  await expect(port).toHaveValue('5270');
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual(['web:true:5270']);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText('服务端访问地址', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.relaySettingsFixture.actions.at(-1))).toBe(
    'relay:true:5270',
  );
});

test('local and relay links wait for their port commit and do not open after failure', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await page.getByRole('switch', { name: '通过服务端访问', exact: true }).click();
  await expect(page.getByText('服务端访问地址', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const configure = window.desktop!.configureRemote!;
    window.desktop!.configureRemote = async (value) => {
      if (value.port === 0) throw new Error('监听端口无效。');
      return configure(value);
    };
  });
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  for (const name of ['打开链接', '打开服务端链接']) {
    await port.fill('0');
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('alert').first()).toHaveText('监听端口无效。');
    await expect(port).toHaveValue('5270');
  }
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:5270',
    'relay:true:5270',
  ]);
  await page.getByRole('button', { name: '打开服务端链接', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.relaySettingsFixture.actions.at(-1)))
    .toBe('open-relay');
});

test('relay enable waits for a port blur already in flight and preserves its failure', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await page.evaluate(() => {
    const configure = window.desktop!.configureRemote!;
    window.desktop!.configureRemote = async (value) => {
      if (value.port === 19111) {
        await new Promise<void>((resolve) => (window.relaySettingsFixture.release = resolve));
        throw new Error('EADDRINUSE');
      }
      return configure(value);
    };
  });
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  await port.fill('19111');
  await port.press('Tab');
  await expect.poll(() => page.evaluate(() => !!window.relaySettingsFixture.release)).toBe(true);
  await expect(toggle).toBeDisabled();
  await page.evaluate(() => window.relaySettingsFixture.release!());
  await expect(page.getByRole('alert').first()).toHaveText('EADDRINUSE');
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual(['web:true:5270']);
});

test('compact address actions copy plain URLs and paired browsers form a collapsed group', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '本地监听端口', exact: true })).toHaveValue(
    '5270',
  );
  const group = page.locator('.remote-control details');
  await expect(group).not.toHaveAttribute('open', '');
  await expect(group.locator('summary')).toContainText('0');
  await page.getByRole('switch', { name: '通过服务端访问', exact: true }).click();
  await expect(page.locator('.remote-address-text')).toHaveCount(0);
  for (const [copy, open] of [
    ['复制本机地址', '打开链接'],
    ['复制服务端地址', '打开服务端链接'],
  ]) {
    const copyButton = page.getByRole('button', { name: copy, exact: true });
    const openButton = page.getByRole('button', { name: open, exact: true });
    expect((await copyButton.boundingBox())!.x).toBeLessThan((await openButton.boundingBox())!.x);
    await copyButton.click();
  }
  const copied = await page.evaluate(() =>
    window.relaySettingsFixture.actions.filter((action) => action.startsWith('copy:')),
  );
  expect(copied).toEqual([
    'copy:http://127.0.0.1:5270',
    'copy:http://relay.example:5270/remote/0123456789abcdef0123456789abcdef/',
  ]);
  expect(copied.join()).not.toContain('test-only-pairing-code');
  const reset = page.getByRole('button', { name: '重置配对码', exact: true });
  await expect(reset).toHaveAttribute('title', '重置配对码');
  await expect(reset).toHaveText('');
  await reset.click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: '重置配对码', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() =>
    window.relaySettingsFixture.sessions([
      { id: 'one', label: 'Chrome', createdAt: Date.now(), expiresAt: Date.now() + 86400000 },
    ]),
  );
  await expect(group.locator('summary')).toContainText('1');
  await expect(page.getByRole('button', { name: /^撤销 Chrome/ })).not.toBeVisible();
  await group.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(group.getByRole('button', { name: /^撤销 Chrome/ })).toBeVisible();
  await group.getByRole('button', { name: /^撤销 Chrome/ }).click();
  await expect(group.locator('summary')).toContainText('0');
});

test('editable relay paths save on blur, preserve the accepted route on conflict, and commit before opening', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  const path = page.getByRole('textbox', { name: '服务端访问路径', exact: true });
  await expect(path).toHaveValue('0123456789abcdef0123456789abcdef');
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual(['web:true:5270']);
  await path.fill('my-desktop');
  await path.blur();
  await expect
    .poll(() => page.evaluate(() => window.desktop!.relayStatus!().then((value) => value.route)))
    .toBe('my-desktop');
  await page.getByRole('switch', { name: '通过服务端访问', exact: true }).click();
  await path.fill('occupied');
  await path.blur();
  await expect(page.getByRole('alert')).toContainText('访问路径已被其他工作台使用');
  await expect(path).toHaveValue('my-desktop');
  await path.fill('office');
  await page.getByRole('button', { name: '打开服务端链接', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.relaySettingsFixture.actions.slice(-2)))
    .toEqual(['route:office', 'open-relay']);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await path.fill('');
  await path.press('Enter');
  await expect
    .poll(() => page.evaluate(() => window.desktop!.relayStatus!().then((value) => value.route)))
    .toBe('0123456789abcdef0123456789abcdef');
  await expect(path).toHaveValue('0123456789abcdef0123456789abcdef');
  await path.fill('../bad');
  await path.blur();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(path).toHaveValue('0123456789abcdef0123456789abcdef');
});

test('regenerating a relay path requires confirmation and preserves paired browsers', async ({
  page,
}, testInfo) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  const path = page.getByRole('textbox', { name: '服务端访问路径', exact: true });
  const original = '0123456789abcdef0123456789abcdef';
  await expect(path).toHaveValue(original);
  const refresh = page.getByRole('button', { name: '重新生成访问路径', exact: true });
  await expect(refresh).toHaveAttribute('title', '重新生成访问路径');
  await expect(refresh).toHaveText('');
  await refresh.click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: '重新生成访问路径', exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText(/(?:旧|原).*地址.*(?:失效|不再|不可|无法)/);
  await expect(dialog).toContainText('配对码保持不变，请使用新地址重新配对。');
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual(['web:true:5270']);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(path).toHaveValue(original);
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual(['web:true:5270']);

  await page.evaluate(() =>
    window.relaySettingsFixture.sessions([
      { id: 'one', label: 'Chrome', createdAt: Date.now(), expiresAt: Date.now() + 86400000 },
    ]),
  );
  await refresh.click();
  await dialog.getByRole('button', { name: '重新生成访问路径', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const generated = await path.inputValue();
  expect(generated).toMatch(/^[a-f0-9]{32}$/);
  expect(generated).not.toBe(original);
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:5270',
    `route:${generated}`,
  ]);
  expect(
    await page.evaluate(() => window.desktop!.remoteStatus!().then((value) => value.sessions)),
  ).toHaveLength(1);
  await page.getByRole('switch', { name: '通过服务端访问', exact: true }).click();
  await expect(page.getByRole('switch', { name: '通过服务端访问', exact: true })).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath('settings-wide.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('settings-narrow.png'),
    fullPage: true,
  });
  await refresh.click();
  await page.screenshot({
    path: testInfo.outputPath('confirmation-narrow.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: testInfo.outputPath('confirmation-wide.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('refresh confirmation never saves a focused path draft before confirmation', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  const path = page.getByRole('textbox', { name: '服务端访问路径', exact: true });
  const refresh = page.getByRole('button', { name: '重新生成访问路径', exact: true });
  await path.fill('unsaved-workstation');
  await refresh.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual(['web:true:5270']);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(path).toHaveValue('unsaved-workstation');
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual(['web:true:5270']);
  await path.focus();
  await refresh.click();
  await dialog.getByRole('button', { name: '重新生成访问路径', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const generated = await path.inputValue();
  expect(generated).toMatch(/^[a-f0-9]{32}$/);
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:5270',
    `route:${generated}`,
  ]);
});

test('a pending path regeneration locks controls and failed regeneration can be retried or cancelled', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await page.getByRole('switch', { name: '通过服务端访问', exact: true }).click();
  await page.evaluate(() => {
    window.relaySettingsFixture.holdRoute = true;
    window.relaySettingsFixture.failRoute = true;
  });
  const path = page.getByRole('textbox', {
    name: '服务端访问路径',
    exact: true,
    includeHidden: true,
  });
  const original = await path.inputValue();
  const refresh = page.getByRole('button', { name: '重新生成访问路径', exact: true });
  await refresh.click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: '重新生成访问路径', exact: true });
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  await confirm.click();
  await expect.poll(() => page.evaluate(() => !!window.relaySettingsFixture.release)).toBe(true);
  await expect(confirm).toBeDisabled();
  await expect(cancel).toBeDisabled();
  await expect(path).toBeDisabled();
  for (const label of ['启用 Web 工作台', '允许局域网访问', '通过服务端访问'])
    await expect(
      page.getByRole('switch', { name: label, exact: true, includeHidden: true }),
    ).toBeDisabled();
  for (const name of ['复制本机地址', '打开链接', '复制服务端地址', '打开服务端链接', '重置配对码'])
    await expect(
      page.getByRole('button', { name, exact: true, includeHidden: true }),
    ).toBeDisabled();
  await page.evaluate(() => {
    window.relaySettingsFixture.holdRoute = false;
    window.relaySettingsFixture.release!();
  });
  await expect(dialog.getByRole('alert')).toHaveText('访问路径保存失败，请重试。');
  await expect(path).toHaveValue(original);
  await expect(confirm).toBeEnabled();
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(path).toHaveValue(original);

  await refresh.click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await confirm.click();
  await expect(dialog.getByRole('alert')).toHaveText('访问路径保存失败，请重试。');
  await page.evaluate(() => {
    window.relaySettingsFixture.failRoute = false;
  });
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(path).not.toHaveValue(original);
  expect(await path.inputValue()).toMatch(/^[a-f0-9]{32}$/);
  await expect(page.getByRole('switch', { name: '通过服务端访问', exact: true })).toBeEnabled();
});

test('applying local settings locks mutations and links but leaves disclosure and pairing visibility available', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await page.getByRole('switch', { name: '通过服务端访问', exact: true }).click();
  await page.evaluate(() => {
    window.relaySettingsFixture.sessions([
      { id: 'one', label: 'Chrome', createdAt: Date.now(), expiresAt: Date.now() + 86400000 },
    ]);
    const configure = window.desktop!.configureRemote!;
    window.desktop!.configureRemote = async (value) => {
      await new Promise<void>((resolve) => {
        window.relaySettingsFixture.release = resolve;
      });
      return configure(value);
    };
  });
  const port = page.getByRole('spinbutton', { name: '本地监听端口', exact: true });
  await port.fill('19123');
  await port.blur();
  await expect.poll(() => page.evaluate(() => !!window.relaySettingsFixture.release)).toBe(true);
  for (const label of ['启用 Web 工作台', '允许局域网访问', '通过服务端访问'])
    await expect(page.getByRole('switch', { name: label, exact: true })).toBeDisabled();
  await expect(port).toBeDisabled();
  await expect(page.getByRole('textbox', { name: '服务端访问路径', exact: true })).toBeDisabled();
  for (const name of ['复制本机地址', '打开链接', '复制服务端地址', '打开服务端链接', '重置配对码'])
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '显示配对码', exact: true }).click();
  await expect(page.getByLabel('Web 配对码', { exact: true })).toHaveText('test-only-pairing-code');
  await page.locator('.remote-control summary').click();
  await expect(page.getByRole('button', { name: /^撤销 Chrome/ })).toBeDisabled();
  await page.evaluate(() => window.relaySettingsFixture.release!());
  await expect(port).toBeEnabled();
  await expect(port).toHaveValue('19123');
  await expect(page.getByRole('button', { name: /^撤销 Chrome/ })).toBeEnabled();
  await page.evaluate(async () =>
    window.relaySettingsFixture.publish({
      ...(await window.desktop!.relayStatus!()),
      state: 'offline',
      url: null,
    }),
  );
  await expect(page.getByRole('switch', { name: '通过服务端访问', exact: true })).toBeEnabled();
  await expect(port).toBeEnabled();
});

test('a pending path save locks the whole section and a switch click commits the path first', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await page.evaluate(() => {
    const configure = window.desktop!.configureRelayRoute!;
    window.desktop!.configureRelayRoute = async (route) => {
      await new Promise<void>((resolve) => {
        window.relaySettingsFixture.release = resolve;
      });
      return configure(route);
    };
  });
  const path = page.getByRole('textbox', { name: '服务端访问路径', exact: true });
  await path.fill('workstation');
  const lan = page.getByRole('switch', { name: '允许局域网访问', exact: true });
  await lan.click();
  await expect.poll(() => page.evaluate(() => !!window.relaySettingsFixture.release)).toBe(true);
  await expect(lan).toBeDisabled();
  await expect(path).toBeDisabled();
  await page.evaluate(() => window.relaySettingsFixture.release!());
  await expect(lan).toBeEnabled();
  await expect(lan).toBeChecked();
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:5270',
    'route:workstation',
    'web:true:5270',
  ]);
});
