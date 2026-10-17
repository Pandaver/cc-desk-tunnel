import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { RelayStatus, RemoteStatus } from '../src/desktop.d.ts';

declare global {
  interface Window {
    relaySettingsFixture: {
      actions: string[];
      fail: boolean;
      hold: boolean;
      release?: () => void;
      publish: (status: RelayStatus) => void;
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
        port: 17890,
        url: null,
        token: null,
        sessions: [],
      };
      let relay: RelayStatus = {
        enabled: false,
        state: 'disabled',
        url: null,
        error: null,
      };
      let listener: ((value: RelayStatus) => void) | undefined;
      window.relaySettingsFixture = {
        actions: [],
        fail: false,
        hold: false,
        publish: (value) => {
          relay = value;
          listener?.({ ...relay });
        },
      };
      const fixture = window.relaySettingsFixture;
      window.desktop = {
        remoteStatus: async () => ({ ...status }),
        configureRemote: async (value) => {
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
            state: 'connecting',
            url: null,
            error: null,
          };
          // Readiness may arrive before the invocation response reaches the renderer.
          fixture.publish({
            ...response,
            state: 'online',
            url: 'http://relay.example:5270/remote/0123456789abcdef0123456789abcdef/',
          });
          return response;
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

test('relay settings are opt-in and commit the Web port before enabling or opening the relay', async ({
  page,
}) => {
  await mount(page);
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '公网协议', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '公网地址', exact: true })).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: '公网端口', exact: true })).toHaveCount(0);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  const port = page.getByRole('spinbutton', { name: '监听端口', exact: true });
  await port.fill('19101');
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText('服务端访问地址', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:17890',
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
  const address = page.locator('.relay-address-row .remote-address');
  const narrowLabel = await label.boundingBox();
  const narrowAddress = await address.boundingBox();
  expect(narrowLabel!.height).toBeLessThan(30);
  expect(narrowAddress!.y).toBeGreaterThanOrEqual(narrowLabel!.y + narrowLabel!.height);
  await page.locator('.remote-control').evaluate((card) => {
    card.style.width = '';
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(toggle).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.local/screenshots/relay-settings-narrow.png', fullPage: true });
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
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

test('queued relay switches keep the latest intent and disable ignores an invalid local port draft', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  const port = page.getByRole('spinbutton', { name: '监听端口', exact: true });
  await page.evaluate(() => {
    window.relaySettingsFixture.hold = true;
  });
  await toggle.click();
  await expect.poll(() => page.evaluate(() => !!window.relaySettingsFixture.release)).toBe(true);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.evaluate(() => {
    window.relaySettingsFixture.hold = false;
    window.relaySettingsFixture.release?.();
  });
  await expect
    .poll(() => page.evaluate(() => window.relaySettingsFixture.actions))
    .toEqual(['web:true:17890', 'relay:true:17890', 'relay:false:17890']);
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('服务端访问地址', { exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(page.getByText('服务端访问地址', { exact: true })).toBeVisible();
  await port.fill('0');
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.relaySettingsFixture.actions.at(-1)))
    .toBe('relay:false:17890');
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
  const port = page.getByRole('spinbutton', { name: '监听端口', exact: true });
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  await port.fill('19111');
  await toggle.click();
  await expect(page.getByRole('alert').first()).toHaveText('EADDRINUSE');
  await expect(toggle).not.toBeChecked();
  await expect(port).toHaveValue('17890');
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:17890',
  ]);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText('服务端访问地址', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.relaySettingsFixture.actions.at(-1))).toBe(
    'relay:true:17890',
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
  const port = page.getByRole('spinbutton', { name: '监听端口', exact: true });
  for (const name of ['打开链接', '打开服务端链接']) {
    await port.fill('0');
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('alert').first()).toHaveText('监听端口无效。');
    await expect(port).toHaveValue('17890');
  }
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:17890',
    'relay:true:17890',
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
  const port = page.getByRole('spinbutton', { name: '监听端口', exact: true });
  const toggle = page.getByRole('switch', { name: '通过服务端访问', exact: true });
  await port.fill('19111');
  await port.press('Tab');
  await expect.poll(() => page.evaluate(() => !!window.relaySettingsFixture.release)).toBe(true);
  await toggle.click();
  await page.evaluate(() => window.relaySettingsFixture.release!());
  await expect(page.getByRole('alert').first()).toHaveText('EADDRINUSE');
  await expect(toggle).not.toBeChecked();
  expect(await page.evaluate(() => window.relaySettingsFixture.actions)).toEqual([
    'web:true:17890',
  ]);
});
