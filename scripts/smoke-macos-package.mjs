import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from '@playwright/test';

// Starts a packaged macOS application offline, with a profile of its own: the main process, the preload and
// the page have to come up, and the SSH service has to start from the packaged files alone and run a script
// the way the service sends one. The package's own program serves as the Node that checks the latter.
if (process.platform !== 'darwin' || !process.argv[2]?.endsWith('.app'))
  throw new Error('Usage: node scripts/smoke-macos-package.mjs "/path/to/CC Desk Tunnel.app"');
const bundle = resolve(process.argv[2]);
const executable = join(bundle, 'Contents/MacOS/CC Desk Tunnel');
const root = resolve('.local/macos-package-smoke');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('PROXY_'),
  ),
);
env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const application = await _electron.launch({
  executablePath: executable,
  args: ['--smoke-test', `--user-data-dir=${join(directory, 'profile')}`],
  cwd: directory,
  env,
  timeout: 30_000,
});
try {
  const errors = [];
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: '连接代理服务', exact: true }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await page.evaluate(() => window.desktop.platform), 'darwin');
  execFileSync(
    executable,
    [
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { execFile } from 'node:child_process';
    import { randomUUID } from 'node:crypto';
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.env.CC_PACKAGE_ROOT;
    const directory = process.cwd();
    // The bridge as it is packaged: one file, which starts the SSH service's process from the files beside it.
    const bridge = await import(pathToFileURL(join(root, 'electron/proxy-bridge.mjs')));
    assert.equal(typeof bridge.openProxyBridge, 'function');
    const service = await bridge.startLocalSsh(randomUUID(), {
      shellPath: '/bin/zsh',
      env: { HOME: directory, ZDOTDIR: directory, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      environment: { CC_DESK_TUNNEL_SCHEDULES: join(directory, 'schedules.json') },
      cwd: directory,
    }, new AbortController().signal, (message) => { throw new Error(message); });
    try {
      const identity = join(directory, 'identity');
      const known = join(directory, 'known_hosts');
      await writeFile(identity, service.credentials.privateKey, { mode: 0o600 });
      await writeFile(known, '[127.0.0.1]:' + service.port + ' ' + service.credentials.hostPublicKey + '\n');
      // What the service's SSH configuration has for the host device-script: see scriptCommand in tunnel.ts.
      const output = await new Promise((done, fail) => {
        const child = execFile('/usr/bin/ssh', [
          '-p', String(service.port), '-i', identity, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
          '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + known,
          service.credentials.username + '@127.0.0.1', 'exec "$CC_DESK_TUNNEL_SHELL" -s',
        ], { timeout: 15000 }, (error, stdout) => (error && error.code !== 7 ? fail(error) : done({ stdout, code: error?.code ?? 0 })));
        child.stdin.end('echo "packaged $CC_DESK_TUNNEL_SCHEDULES"\nexit 7\n');
      });
      assert.equal(output.stdout, 'packaged ' + join(directory, 'schedules.json') + '\n');
      assert.equal(output.code, 7);
    } finally { await service.close(); }
  `,
    ],
    {
      cwd: directory,
      timeout: 30_000,
      stdio: 'inherit',
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        CC_PACKAGE_ROOT: join(bundle, 'Contents/Resources/app.asar'),
      },
    },
  );
  assert.deepEqual(errors, []);
  // A picture of the window as the system draws it, for whoever reviews a build without a Mac at hand.
  if (process.env.SMOKE_SCREENSHOT) {
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
    });
    await delay(2000);
    mkdirSync(dirname(resolve(process.env.SMOKE_SCREENSHOT)), { recursive: true });
    try {
      execFileSync('screencapture', ['-x', resolve(process.env.SMOKE_SCREENSHOT)]);
    } catch (error) {
      console.log(`No screenshot: ${error.message}`);
    }
  }
  console.log('PASS: the packaged macOS client starts offline and its SSH service runs a script.');
} finally {
  await application.close();
  rmSync(directory, { recursive: true, force: true });
}
