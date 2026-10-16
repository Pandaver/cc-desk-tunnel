import { test as base, expect, _electron } from '@playwright/test';
import type { Browser, BrowserContext, ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { login, send, sessionAction, settled } from './helpers.ts';

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
  await page
    .getByRole('spinbutton', { name: '监听端口', exact: true })
    .fill(String(await unusedPort()));
  await page.getByRole('spinbutton', { name: '监听端口', exact: true }).blur();
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await expect(page.locator('.remote-address-text')).toHaveText(/^http:\/\/127\.0\.0\.1:/);
  const status = await page.evaluate(() => window.desktop!.remoteStatus!());
  expect(status.enabled).toBe(true);
  return { url: status.url!, token: status.token! };
}

async function pair(browser: Browser, access: { url: string; token: string }, other = false) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(other
      ? { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' }
      : {}),
  });
  try {
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

test.describe('Electron Web workbench', () => {
  test.skip(process.platform !== 'win32', 'Windows Electron integration');
  test.setTimeout(120_000);

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
