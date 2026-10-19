import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { WebCertificateState } from '@cc-desk-tunnel/protocol';

const certPem = '-----BEGIN CERTIFICATE-----\nfixture-certificate-chain\n-----END CERTIFICATE-----';
const keyPem = '-----BEGIN PRIVATE KEY-----\nfixture-private-material\n-----END PRIVATE KEY-----';
const details = {
  domain: 'web.example.test',
  subject: 'CN=web.example.test',
  issuer: 'CN=Fixture Issuer',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2027-01-01T00:00:00.000Z',
  fingerprint:
    'AB:CD:12:34:56:78:90:AB:CD:12:34:56:78:90:AB:CD:12:34:56:78:90:AB:CD:12:34:56:78:90:AB:CD:12:34',
};

async function fixture(
  page: Page,
  options: {
    supported?: boolean;
    enabled?: boolean;
    domain?: string;
    certificate?: WebCertificateState;
    domainConflict?: boolean;
  } = {},
) {
  await page.addInitScript(() => {
    const nothing = async () => undefined;
    const listen = () => () => {};
    window.desktop = {
      platform: 'win32',
      dev: true,
      boot: { connection: '', shared: { connections: [], busy: [] } },
      version: async () => '0.3.4',
      device: async () => ({ id: '00000000-0000-4000-8000-000000000002', name: '开发电脑' }),
      loadLogin: async () => ({
        url: 'ws://127.0.0.1:18889/certificate-control/ws',
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
      copyText: nothing,
      openExternal: nothing,
    } as unknown as NonNullable<typeof window.desktop>;
  });
  const commands: Record<string, unknown>[] = [];
  const sockets: WebSocketRoute[] = [];
  let enabled = options.enabled ?? true;
  let domain = options.domain ?? 'web.example.test';
  let certificate = options.certificate ?? { mode: 'default' as const, revision: 'revision-1' };
  let held = false;
  let fail = false;
  let release = () => {};
  const current = () => ({
    enabled,
    domain,
    path: 'fixture-entry',
    origin: `https://${domain || '192.0.2.10'}:8787`,
    url: `https://${domain || '192.0.2.10'}:8787/fixture-entry/`,
    grants: [],
    ...(options.supported === false ? {} : { certificate }),
    ...(enabled
      ? {
          pairing: {
            code: '00112233445566778899aabb',
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            remainingMs: 300000,
          },
        }
      : {}),
  });
  const publish = () => sockets.at(-1)!.send(JSON.stringify({ type: 'web.changed', ...current() }));
  await page.routeWebSocket('ws://127.0.0.1:18889/certificate-control/ws', (socket) => {
    sockets.push(socket);
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          connectionId: `00000000-0000-4000-8000-${String(sockets.length).padStart(12, '0')}`,
          version: '0.3.4',
          adapter: 'simulation',
          sessions: [],
          web: enabled,
          webControl: true,
          webSettings: true,
          webPairing: true,
          ...(options.supported === false ? {} : { webCertificates: true }),
        });
        return;
      }
      if (!command.requestId) return;
      const reply = () => {
        if (
          command.type === 'web.configure' &&
          command.enabled &&
          options.domainConflict &&
          certificate.mode === 'custom'
        ) {
          send({
            type: 'response',
            requestId: command.requestId,
            ok: false,
            code: 'web_certificate_domain',
            message: '请先将证书恢复默认，再修改访问域名。',
          });
          return;
        }
        if (command.type.startsWith('web.certificate.') && fail) {
          fail = false;
          send({
            type: 'response',
            requestId: command.requestId,
            ok: false,
            code: 'certificate_invalid',
            message: '证书与私钥不匹配，请检查后重试。',
          });
          return;
        }
        if (command.type === 'web.certificate.set')
          certificate = { mode: 'custom', revision: 'revision-2', details: { ...details, domain } };
        if (command.type === 'web.certificate.reset')
          certificate = { mode: 'default', revision: 'revision-3' };
        if (command.type === 'web.configure') {
          enabled = command.enabled;
          if (typeof command.domain === 'string') domain = command.domain;
        }
        if (command.type.startsWith('web.'))
          send({ type: 'web.state', requestId: command.requestId, ...current() });
        send({ type: 'response', requestId: command.requestId, ok: true });
      };
      if (held && command.type.startsWith('web.certificate.')) release = reply;
      else reply();
    });
  });
  await page.goto('/');
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await page.getByRole('button', { name: '设置与账号' }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '常规', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: '启用 Web 访问' })).toBeEnabled();
  return {
    commands,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      release();
    },
    fail: () => {
      fail = true;
    },
    change: (next: { domain?: string; certificate?: WebCertificateState; enabled?: boolean }) => {
      if (next.domain !== undefined) domain = next.domain;
      if (next.certificate) certificate = next.certificate;
      if (next.enabled !== undefined) enabled = next.enabled;
      publish();
    },
    drop: () => sockets.at(-1)!.close({ code: 1012, reason: 'fixture reconnect' }),
  };
}
const panel = (page: Page) => page.getByLabel('浏览器访问', { exact: true });
const dialog = (page: Page) => page.getByRole('dialog');
async function open(page: Page) {
  await page.getByRole('button', { name: '管理 HTTPS 证书' }).click();
  await expect(dialog(page)).toBeVisible();
}
async function fill(page: Page) {
  await dialog(page).getByLabel('证书链 PEM', { exact: true }).fill(certPem);
  await dialog(page).getByLabel('私钥 PEM', { exact: true }).fill(keyPem);
}
const mutations = (state: Awaited<ReturnType<typeof fixture>>) =>
  state.commands.filter((command) => String(command.type).startsWith('web.certificate.'));

test('certificate controls are capability gated and disabled Web stays minimal', async ({
  page,
}) => {
  const state = await fixture(page, { supported: false });
  await expect(panel(page).getByText('HTTPS 证书', { exact: true })).toHaveCount(0);
  expect(mutations(state)).toHaveLength(0);
  state.change({ enabled: false });
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
  expect(mutations(state)).toHaveLength(0);
});

test('certificate UI remains absent when supported service has Web turned off', async ({
  page,
}) => {
  const state = await fixture(page, { enabled: false });
  await expect(panel(page).getByText('HTTPS 证书', { exact: true })).toHaveCount(0);
  state.change({ certificate: { mode: 'external', revision: '' } });
  await expect(panel(page).getByText('HTTPS 证书', { exact: true })).toHaveCount(0);
  state.change({ certificate: { mode: 'unavailable', revision: '', error: '未启用 TLS。' } });
  await expect(panel(page).getByText('HTTPS 证书', { exact: true })).toHaveCount(0);
  expect(mutations(state)).toHaveLength(0);
});

test('disabled Web offers confirmed custom certificate recovery without exposing upload settings', async ({
  page,
}) => {
  const state = await fixture(page, {
    enabled: false,
    domain: '',
    certificate: { mode: 'custom', revision: 'revision-2', details },
  });
  const restore = panel(page).getByRole('button', { name: '恢复默认证书', exact: true });
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '管理 HTTPS 证书' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('certificate-disabled.png') });
  await restore.click();
  await expect(dialog(page)).toContainText('web.example.test');
  await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: '保存证书' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath('certificate-recovery-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(mutations(state)).toHaveLength(0);
  await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(restore).toBeEnabled();
  expect(mutations(state)).toHaveLength(0);
  await restore.click();
  state.fail();
  await dialog(page).getByRole('button', { name: '恢复默认证书', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: '恢复默认证书' })).toBeEnabled();
  state.hold();
  await dialog(page).getByRole('button', { name: '恢复默认证书', exact: true }).click();
  await expect(dialog(page).locator('button:not(:disabled)')).toHaveCount(0);
  await expect(panel(page).locator('button:not(:disabled)')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  state.release();
  await expect(dialog(page)).toHaveCount(0);
  await expect(restore).toHaveCount(0);
  await expect(panel(page).getByText('HTTPS 证书', { exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole('switch', { name: '启用 Web 访问' })).not.toBeChecked();
  expect(mutations(state)).toHaveLength(2);
  expect(mutations(state).every((command) => command.type === 'web.certificate.reset')).toBe(true);
  expect(state.commands.filter((command) => command.type === 'web.configure')).toHaveLength(0);
});

test('a stored domain conflict can be recovered before enabling Web', async ({ page }) => {
  const state = await fixture(page, {
    enabled: false,
    domain: '',
    domainConflict: true,
    certificate: { mode: 'custom', revision: 'revision-2', details },
  });
  const enable = panel(page).getByRole('switch', { name: '启用 Web 访问' });
  await enable.click();
  await expect(panel(page).getByRole('alert')).toContainText('请先将证书恢复默认');
  await expect(enable).not.toBeChecked();
  await panel(page).getByRole('button', { name: '恢复默认证书', exact: true }).click();
  await dialog(page).getByRole('button', { name: '恢复默认证书', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '恢复默认证书' })).toHaveCount(0);
  await enable.click();
  await expect(enable).toBeChecked();
  await expect(panel(page).getByText('默认证书', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('textbox', { name: '访问域名', exact: true })).toHaveValue('');
  expect(mutations(state)).toEqual([
    expect.objectContaining({ type: 'web.certificate.reset', revision: 'revision-2' }),
  ]);
});

test('disabled Web can recover invalid custom storage without enabling its listener', async ({
  page,
}) => {
  const state = await fixture(page, {
    enabled: false,
    certificate: {
      mode: 'unavailable',
      revision: 'broken-store',
      error: '证书配置损坏，请恢复默认。',
    },
  });
  await expect(panel(page)).toContainText('证书配置损坏');
  await panel(page).getByRole('button', { name: '恢复默认证书', exact: true }).click();
  await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '恢复默认证书', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(panel(page).getByText('HTTPS 证书', { exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole('switch', { name: '启用 Web 访问' })).not.toBeChecked();
  expect(mutations(state)[0]).toMatchObject({
    type: 'web.certificate.reset',
    revision: 'broken-store',
  });
});

test('changing Web availability or certificate identity discards upload and recovery dialogs', async ({
  page,
}) => {
  const state = await fixture(page, {
    certificate: { mode: 'custom', revision: 'revision-2', details },
  });
  await open(page);
  await fill(page);
  state.change({ enabled: false });
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
  const restore = panel(page).getByRole('button', { name: '恢复默认证书', exact: true });
  await restore.click();
  await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
  state.change({
    certificate: { mode: 'custom', revision: 'another-revision', details },
  });
  await expect(dialog(page)).toHaveCount(0);
  await restore.click();
  state.change({ enabled: true });
  await expect(dialog(page)).toHaveCount(0);
  await open(page);
  await expect(dialog(page).getByLabel('私钥 PEM', { exact: true })).toHaveValue('');
  await expect(dialog(page).getByLabel('证书链 PEM', { exact: true })).toHaveValue('');
  expect(mutations(state)).toHaveLength(0);
});

test('empty domain prompts the existing setting without saving its uncommitted draft', async ({
  page,
}) => {
  const state = await fixture(page, { domain: '' });
  const domain = panel(page).getByRole('textbox', { name: '访问域名', exact: true });
  await domain.fill('unsaved.example.test');
  await open(page);
  await expect(dialog(page)).toContainText('请先填写访问域名');
  await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
  expect(state.commands.filter((command) => command.type === 'web.configure')).toHaveLength(0);
  await dialog(page).getByRole('button', { name: '设置访问域名' }).click();
  await expect(domain).toBeFocused();
  await expect(domain).toHaveValue('');
});

test('certificate upload is explicit, serialized, and clears private input after success', async ({
  page,
}) => {
  const state = await fixture(page);
  await expect(panel(page)).toContainText('默认证书');
  await open(page);
  await expect(dialog(page)).toContainText('web.example.test');
  await fill(page);
  await dialog(page).getByText('绑定域名', { exact: true }).click();
  expect(mutations(state)).toHaveLength(0);
  state.hold();
  await dialog(page).getByRole('button', { name: '保存证书', exact: true }).click();
  await expect.poll(() => mutations(state).length).toBe(1);
  expect(mutations(state)[0]).toMatchObject({
    type: 'web.certificate.set',
    revision: 'revision-1',
    domain: 'web.example.test',
    cert: certPem,
    key: keyPem,
  });
  await expect(dialog(page).locator('button:not(:disabled), textarea:not(:disabled)')).toHaveCount(
    0,
  );
  await expect(panel(page).locator('button:not(:disabled), input:not(:disabled)')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  state.release();
  await expect(dialog(page)).toHaveCount(0);
  await expect(panel(page)).toContainText('自定义证书');
  await expect(panel(page).getByRole('textbox', { name: '访问域名', exact: true })).toBeDisabled();
  await expect(
    panel(page).getByRole('textbox', { name: '服务端访问路径', exact: true }),
  ).toBeEnabled();
  await open(page);
  await expect(dialog(page).getByLabel('私钥 PEM', { exact: true })).toHaveValue('');
  await expect(dialog(page).getByLabel('证书链 PEM', { exact: true })).toHaveValue('');
  await dialog(page).getByText('当前证书信息', { exact: true }).click();
  await expect(dialog(page)).toContainText('Fixture Issuer');
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(storage).not.toContain('fixture-private-material');
  expect(storage).not.toContain('BEGIN PRIVATE KEY');
});

test('validation failures retain editable input but closing the dialog clears it', async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page);
  await fill(page);
  state.fail();
  await dialog(page).getByRole('button', { name: '保存证书', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('证书与私钥不匹配');
  await expect(dialog(page).getByLabel('私钥 PEM', { exact: true })).toHaveValue(keyPem);
  await expect(dialog(page).getByRole('button', { name: '保存证书', exact: true })).toBeEnabled();
  await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await open(page);
  await expect(dialog(page).getByLabel('私钥 PEM', { exact: true })).toHaveValue('');
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  expect(mutations(state)).toHaveLength(1);
});

test('restoring default requires confirmation and preserves domain and access settings', async ({
  page,
}) => {
  const state = await fixture(page, {
    certificate: { mode: 'custom', revision: 'revision-2', details },
  });
  await open(page);
  await fill(page);
  await dialog(page).getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(dialog(page)).toContainText('通过此域名连接的桌面客户端需重新确认指纹');
  await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
  expect(mutations(state)).toHaveLength(0);
  await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  expect(mutations(state)).toHaveLength(0);
  await open(page);
  await expect(dialog(page).getByLabel('私钥 PEM', { exact: true })).toHaveValue('');
  await dialog(page).getByRole('button', { name: '恢复默认', exact: true }).click();
  await dialog(page).getByRole('button', { name: '恢复默认证书', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(mutations(state)).toHaveLength(1);
  expect(mutations(state)[0]).toMatchObject({
    type: 'web.certificate.reset',
    revision: 'revision-2',
  });
  await expect(panel(page)).toContainText('默认证书');
  await expect(panel(page).getByRole('textbox', { name: '访问域名', exact: true })).toHaveValue(
    'web.example.test',
  );
  await expect(panel(page).getByRole('textbox', { name: '访问域名', exact: true })).toBeEnabled();
});

test('external and plain HTTP certificate states do not offer unsupported actions', async ({
  page,
}) => {
  const state = await fixture(page, { certificate: { mode: 'external', revision: '' } });
  await expect(panel(page)).toContainText('反向代理管理');
  await expect(page.getByRole('button', { name: '管理 HTTPS 证书' })).toHaveCount(0);
  state.change({
    certificate: { mode: 'unavailable', revision: '', error: '当前入口未启用 TLS。' },
  });
  await expect(panel(page)).toContainText('当前入口未启用 TLS');
  await expect(page.getByRole('button', { name: '管理 HTTPS 证书' })).toHaveCount(0);
  expect(mutations(state)).toHaveLength(0);
});

test('invalid custom storage offers confirmed recovery, not a certificate upload', async ({
  page,
}) => {
  const state = await fixture(page, {
    certificate: {
      mode: 'unavailable',
      revision: 'broken-store',
      error: '证书配置损坏，请恢复默认。',
    },
  });
  await open(page);
  await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '恢复默认证书', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(mutations(state)[0]).toMatchObject({
    type: 'web.certificate.reset',
    revision: 'broken-store',
  });
});

test('server domain, revision, disable and reconnection changes discard sensitive drafts', async ({
  page,
}) => {
  const state = await fixture(page);
  for (const change of [
    () => state.change({ domain: 'other.example.test' }),
    () => state.change({ certificate: { mode: 'default', revision: 'external-revision' } }),
    () => state.change({ enabled: false }),
    () => state.drop(),
  ]) {
    await open(page);
    await fill(page);
    change();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveCount(0);
    state.change({ enabled: true });
    await expect(page.getByRole('button', { name: '管理 HTTPS 证书' })).toBeEnabled();
    await open(page);
    await expect(dialog(page).getByLabel('私钥 PEM', { exact: true })).toHaveValue('');
    await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  }
  expect(mutations(state)).toHaveLength(0);
});

test('certificate dialog has bounded desktop and narrow layouts with real metadata', async ({
  page,
}) => {
  await fixture(page, { certificate: { mode: 'custom', revision: 'revision-2', details } });
  await open(page);
  await dialog(page).getByText('当前证书信息', { exact: true }).click();
  await fill(page);
  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['narrow', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await expect(dialog(page)).toBeVisible();
    expect(
      await dialog(page).evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`certificate-${name}.png`) });
  }
});
