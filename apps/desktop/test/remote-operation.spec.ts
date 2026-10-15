import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { createSession, login, screenshots, send, settled } from './helpers.ts';

test('another computer works on a session while its own is connected; both see the run and either answers', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '远程操作');
  // Another browser profile is another computer to the service.
  const context = await browser.newContext({ baseURL });
  const other = await context.newPage();
  await other.goto('/');
  await login(other);
  await other.getByRole('button', { name: '展开其他设备的会话', exact: true }).click();
  // Computers of earlier tests are gone; the first one of this test is connected.
  await expect(other.locator('.device-state.online')).toHaveCount(1);
  await other.locator('.session-row').filter({ hasText: title }).click();
  const bar = other.locator('.elsewhere-bar');
  await expect(bar).toContainText('在这里发的消息');
  await send(other, '从另一台电脑发的话', 'tool');
  // The run is the first computer's: it shows there as well, and either window answers its approval.
  await expect(page.getByText('从另一台电脑发的话', { exact: true })).toBeVisible();
  const allow = (window: typeof page) => window.getByRole('button', { name: '允许', exact: true });
  await expect(allow(other)).toBeVisible();
  await expect(allow(page)).toBeVisible();
  await other.screenshot({ path: resolve(screenshots, 'desktop-remote.png') });
  await allow(page).click();
  await expect(allow(other)).not.toBeVisible();
  await settled(other);
  await settled(page);
  // With its computer gone, the session can only be read again.
  await page.close();
  await expect(other.locator('.device-state.online')).toHaveCount(0);
  await expect(other.locator('.composer')).toHaveCount(0);
  await expect(bar).toContainText('不在线');
  await context.close();
});
