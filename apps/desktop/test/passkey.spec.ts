import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const origin = 'https://web.example.test';
const entry = `${origin}/entry/`;
const rpID = 'web.example.test';

// Exercise the shipped browser adapter with Chromium's authenticator and real signature verification.
// Only the transport is isolated; the WebAuthn ceremony and UV requirement are not replaced.
async function passkeyFixture(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  let credential: WebAuthnCredential | undefined;
  let authenticated = false;
  let expired = false;
  let registrations = 0;
  let keyName = '旅行备用';
  let freshProof: unknown;
  let registrationStarts = 0;
  let failSettingsGet = false;
  let optionsReady: Promise<void> = Promise.resolve();
  let releaseOptions = () => {};
  let verificationReady: Promise<void> = Promise.resolve();
  let releaseVerification = () => {};
  const challenges = new Map<string, { value: string; kind: string }>();
  const sessionId = randomUUID();
  const serverDeviceId = randomUUID();
  const passkeyId = randomUUID();
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    name: '测试浏览器',
    passkeyId,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: new Date(Date.now() + 7200000).toISOString(),
  };
  const state = () => ({
    authenticated,
    passkeyAvailable: !!credential,
    totpEnabled: true,
    selfSigned: false,
    ...(authenticated ? { session } : {}),
  });
  const requests: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/entry/'.length);
    if (!path.startsWith('api/'))
      return route.fulfill({ path: resolve('apps/desktop/dist', path || 'index.html') });
    const name = path.slice('api/'.length);
    requests.push(name);
    if (name === 'session') return route.fulfill({ json: state() });
    if (name === 'logout') {
      authenticated = false;
      return route.fulfill({ json: state() });
    }
    const body = route.request().postDataJSON();
    if (name.endsWith('/options')) {
      if (expired)
        return route.fulfill({ status: 410, json: { error: '授权已过期，请重新发起。' } });
      const challengeId = randomUUID();
      const kind = name.split('/')[1];
      const options =
        kind === 'register'
          ? await generateRegistrationOptions({
              rpName: 'CC Desk Tunnel',
              rpID,
              userName: 'workbench',
              userID: new Uint8Array(32).fill(7),
              authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            })
          : await generateAuthenticationOptions({ rpID, userVerification: 'required' });
      challenges.set(challengeId, { value: options.challenge, kind });
      await optionsReady;
      return route.fulfill({
        json: {
          challengeId,
          options,
          name: '旅行备用',
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
      });
    }
    if (name.endsWith('/verify')) {
      const challenge = challenges.get(body.challengeId);
      expect(challenge).toBeDefined();
      challenges.delete(body.challengeId);
      if (challenge!.kind === 'register') {
        const result = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: challenge!.value,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
        expect(result.verified).toBe(true);
        credential = result.registrationInfo!.credential;
        registrations++;
        await verificationReady;
        return route.fulfill({ json: { registered: true, id: passkeyId } });
      }
      const result = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challenge!.value,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: credential!,
        requireUserVerification: true,
      });
      expect(result.verified).toBe(true);
      credential!.counter = result.authenticationInfo.newCounter;
      if (challenge!.kind === 'proof') return route.fulfill({ json: { proof: 'p'.repeat(43) } });
      authenticated = true;
      return route.fulfill({ json: state() });
    }
    return route.fulfill({ status: 404, json: { error: '未找到接口。' } });
  });
  await page.routeWebSocket(`${entry.replace('https:', 'wss:')}api/ws`, (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'web.settings.get' && failSettingsGet) {
        failSettingsGet = false;
        socket.send(
          JSON.stringify({
            type: 'response',
            requestId: command.requestId,
            ok: false,
            code: 'read_failed',
            message: '读取失败，请重试。',
          }),
        );
        return;
      }
      if (command.type === 'web.passkeys.start') {
        registrationStarts++;
        keyName = command.name;
        socket.send(
          JSON.stringify({
            type: 'web.passkey.registration',
            requestId: command.requestId,
            registrationId: randomUUID(),
            status: 'pending',
            url: `${entry}#passkey-register=browser-grant`,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          }),
        );
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
        return;
      }
      if (command.type === 'web.auth')
        socket.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.6',
            connectionId: randomUUID(),
            adapter: 'claude-code',
            sessions: [],
            browser: { sessionId, serverDeviceId, selfSigned: false },
          }),
        );
      else if (command.type === 'web.settings.get' || command.type === 'web.passkeys.rename') {
        if (command.type === 'web.passkeys.rename') {
          keyName = command.name;
          freshProof = command.proof;
        }
        socket.send(
          JSON.stringify({
            type: 'web.settings.state',
            requestId: command.requestId,
            values: {
              enabled: true,
              domain: rpID,
              path: 'entry',
              idleMinutes: 120,
              proxyEnabled: false,
              trustedProxies: [],
              selfSigned: false,
              totpEnabled: true,
              passkeyAvailable: true,
              passkeys: [
                { id: passkeyId, name: keyName, rpId: rpID, available: true, createdAt: now },
              ],
              sessions: [session],
              currentSessionId: sessionId,
              url: entry,
            },
          }),
        );
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      } else if (command.requestId)
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
    });
  });
  return {
    requests,
    registrationStarts: () => registrationStarts,
    failNextSettingsGet: () => {
      failSettingsGet = true;
    },
    freshProof: () => freshProof,
    registrations: () => registrations,
    authenticated: () => authenticated,
    expire: () => {
      expired = true;
    },
    holdOptions: () => {
      optionsReady = new Promise<void>((resolve) => {
        releaseOptions = resolve;
      });
    },
    releaseOptions: () => releaseOptions(),
    holdVerification: () => {
      verificationReady = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
    },
    releaseVerification: () => releaseVerification(),
  };
}

test('Passkey registration and login use the same discoverable key and require explicit user actions', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.goto(`${entry}#passkey-register=short-lived-authorization`);
  await expect(page.getByText('旅行备用', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(entry);
  expect(fixture.registrations()).toBe(0);
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  expect(fixture.registrations()).toBe(1);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    'short-lived-authorization',
  );
  await page.goto(entry);
  await expect(page.getByLabel('服务凭据', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '使用通行密钥登录' }).click();
  await expect(page.locator('.shell')).toBeVisible();
  expect(fixture.authenticated()).toBe(true);
  expect(fixture.requests).not.toContain('login');
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.locator('.web-passkeys summary').click();
  await page.getByRole('button', { name: '重命名 旅行备用' }).click();
  await page.getByLabel('名称', { exact: true }).fill('新的名称');
  await page.getByRole('button', { name: '改用通行密钥验证' }).click();
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.freshProof()).toEqual({ passkey: 'p'.repeat(43) });
  await expect(page.getByRole('button', { name: '重命名 新的名称' })).toBeVisible();
});

test('cancelled system verification stays on the authorization page and can be retried', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.goto(`${entry}#passkey-register=short-lived-authorization`);
  await expect(page.getByText('旅行备用', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const create = navigator.credentials.create.bind(navigator.credentials);
    let cancelled = false;
    navigator.credentials.create = async (options) => {
      if (!cancelled) {
        cancelled = true;
        throw new DOMException('User cancelled', 'NotAllowedError');
      }
      return create(options);
    };
  });
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已取消或超时');
  expect(fixture.registrations()).toBe(0);
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  expect(fixture.registrations()).toBe(1);
});

test('an expired registration never starts a system ceremony or reports a successful setting', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  fixture.expire();
  await page.goto(`${entry}#passkey-register=expired-authorization`);
  await expect(page.getByRole('alert')).toContainText('授权已过期');
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: '设置完成' })).toHaveCount(0);
  expect(fixture.registrations()).toBe(0);
});

test('cancelling while options are loading prevents a late system ceremony and allows retry', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.goto(`${entry}#passkey-register=short-lived-authorization`);
  await expect(page.getByText('旅行备用', { exact: true })).toBeVisible();
  fixture.holdOptions();
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await page.getByRole('button', { name: '取消验证', exact: true }).click();
  fixture.releaseOptions();
  await expect(page.getByRole('alert')).toContainText('已取消等待');
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeEnabled();
  expect(fixture.registrations()).toBe(0);
  expect(fixture.requests).not.toContain('passkey/register/verify');
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  expect(fixture.registrations()).toBe(1);
});

test('a confirmed browser registration only rereads settings after its first refresh fails', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.goto(`${entry}#passkey-register=first-grant`);
  await expect(page.getByText('旅行备用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  await page.goto(entry);
  await page.getByRole('button', { name: '使用通行密钥登录' }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('新的密钥');
  await page.getByRole('button', { name: '改用通行密钥验证' }).click();
  fixture.failNextSettingsGet();
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('通行密钥已创建');
  await expect(page.getByRole('alert')).toContainText('读取失败');
  expect(fixture.registrations()).toBe(2);
  expect(fixture.registrationStarts()).toBe(1);
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.registrations()).toBe(2);
  expect(fixture.registrationStarts()).toBe(1);
});

test('cancelling a submitted verification stops waiting without claiming the server rolled it back', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.goto(`${entry}#passkey-register=short-lived-authorization`);
  await expect(page.getByText('旅行备用', { exact: true })).toBeVisible();
  fixture.holdVerification();
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect.poll(() => fixture.registrations()).toBe(1);
  await page.getByRole('button', { name: '取消验证', exact: true }).click();
  fixture.releaseVerification();
  await expect(page.getByRole('alert')).toHaveText('已取消等待；若已确认，请返回客户端查看结果。');
  await expect(page.getByRole('heading', { name: '设置完成' })).toHaveCount(0);
  expect(fixture.registrations()).toBe(1);
});
