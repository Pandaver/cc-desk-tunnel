import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The runtime updater installs only server dependencies. Bundle a fresh build of the shared frontend so
// an upgrade never needs Vite, Electron or a second UI source tree on the running server.
export function packageServer(root, output) {
  root = resolve(root);
  output = resolve(output);
  mkdirSync(join(root, '.local'), { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(root, '.local', 'server-package-'));
  try {
    const web = join(staging, 'apps/server/web');
    execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/vite/bin/vite.js'),
        'build',
        '--config',
        join(root, 'apps/desktop/vite.config.ts'),
        '--outDir',
        web,
        '--emptyOutDir',
      ],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    if (!existsSync(join(web, 'index.html')))
      throw new Error('The shared Web build has no index.html.');
    execFileSync(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      [
        '-czf',
        output,
        '-C',
        root,
        '.dockerignore',
        'package.json',
        'package-lock.json',
        'CHANGELOG.md',
        'apps/server/package.json',
        'apps/server/src',
        'apps/desktop/package.json',
        'packages/protocol/package.json',
        'packages/protocol/src',
        'scripts/install-linux.sh',
        'deploy/README.md',
        'deploy/compose.yml',
        'deploy/install.sh',
        'deploy/manage.sh',
        'deploy/nginx.conf.example',
        'deploy/nginx.md',
        'deploy/test.sh',
        'deploy/docker/Dockerfile',
        'deploy/docker/compose.yaml',
        'deploy/docker/entrypoint.sh',
        'deploy/docker/healthcheck.mjs',
        'deploy/docker/runtime-level',
        'docs/server-web.md',
        '-C',
        staging,
        'apps/server/web',
      ],
      { windowsHide: true },
    );
  } finally {
    // staging is a fresh child of this source tree's private .local directory, never a supplied path.
    if (dirname(staging) !== join(root, '.local'))
      throw new Error('Invalid server package staging path.');
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`Server source bundle created: ${output}`);
  console.log(
    'Contains the matching shared Web build; no local credentials, histories or dependencies.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  packageServer(root, resolve(process.argv[2] ?? '.local/cc-desk-tunnel-server.tar.gz'));
