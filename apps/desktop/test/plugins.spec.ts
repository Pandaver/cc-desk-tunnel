import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { login, screenshots } from './helpers.ts';

const shots = resolve(screenshots, 'plugins');
mkdirSync(shots, { recursive: true });
const plugins = resolve('.local/ui-test/sessions/plugins');
const ui = `
export const settings = [
  { title: '钉钉', showWhen: 'on', fields: {
    on: { type: 'boolean', title: '启用钉钉' },
    url: { type: 'string', title: '机器人地址', sensitive: true, required: true,
      validate: (value: string) => ({ valid: value.startsWith('https://'), message: '要以 https:// 开头' }) },
    format: { type: 'string', title: '格式', options: ['卡片', '文本'], default: '卡片' },
    body: { type: 'string', title: '模板', multiline: true, default: '{session}' },
    test: { type: 'button', title: '发送测试消息', run: async (all: { url: string }) => ({ ok: true, message: '已发送到 ' + all.url }) },
  } },
];`;
function add(name: string) {
  const root = resolve(plugins, name);
  mkdirSync(resolve(root, '.claude-plugin'), { recursive: true });
  mkdirSync(resolve(root, 'hooks'), { recursive: true });
  writeFileSync(
    resolve(root, '.claude-plugin/plugin.json'),
    JSON.stringify({ name, displayName: '通知', version: '0.1.0', description: '推送到钉钉' }),
  );
  writeFileSync(
    resolve(root, 'hooks/hooks.json'),
    JSON.stringify({
      hooks: {
        RunEnded: [
          { hooks: [{ type: 'command', command: 'node', args: ['-e', 'console.log("收到")'] }] },
        ],
      },
    }),
  );
  writeFileSync(resolve(root, 'ui.ts'), ui);
}
// The service watches the directory itself, which stays.
test.afterEach(() =>
  rmSync(resolve(plugins, 'notify'), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  }),
);

test('a plugin put in place is set up, tried and switched off without a reload', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await expect(page.getByText('还没有插件')).toBeVisible();
  add('notify');
  const card = page.getByRole('region', { name: '通知', exact: true });
  await expect(card).toContainText('正常');
  await expect(card.getByLabel('机器人地址')).toHaveCount(0);

  await card.getByRole('switch', { name: '启用钉钉' }).click();
  await card.getByLabel('机器人地址').fill('http://x');
  await card.getByLabel('机器人地址').blur();
  await expect(card).toContainText('要以 https:// 开头');
  await card.getByRole('button', { name: '保存' }).click();
  await expect(card.getByRole('button', { name: '保存' })).toBeEnabled();
  await card.getByLabel('机器人地址').fill('https://example.com/robot');
  await card.getByRole('button', { name: '发送测试消息' }).click();
  await expect(card.getByRole('status')).toHaveText('已发送到 ***');
  await card.getByRole('button', { name: '保存' }).click();
  await expect(card.getByLabel('机器人地址')).toHaveAttribute('placeholder', '已设置，留空沿用');
  await expect(card.getByLabel('机器人地址')).toHaveValue('');
  await card.getByRole('button', { name: '试跑' }).click();
  await expect(card.locator('pre')).toContainText('收到');
  await page.screenshot({ path: resolve(shots, 'settings.png'), fullPage: true });

  await card.getByRole('button', { name: '日志' }).click();
  await expect(page.locator('.plugin-log')).toContainText('[试跑] RunEnded → 成功');
  await expect(page.locator('.plugin-log')).not.toContainText('example.com');
  await page.screenshot({ path: resolve(shots, 'log.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await card.getByRole('switch', { name: '启用 通知' }).click();
  await expect(card).toContainText('已停用');
  await expect(card.getByLabel('机器人地址')).toHaveCount(0);
});
