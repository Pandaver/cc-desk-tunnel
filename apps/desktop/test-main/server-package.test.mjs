import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageServer } from '../../../scripts/package-server.mjs';

const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-server-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  for (const name of [
    '.dockerignore',
    'package-lock.json',
    'apps/server/package.json',
    'apps/server/src/main.ts',
    'apps/desktop/package.json',
    'apps/desktop/vite.config.ts',
    'packages/protocol/package.json',
    'packages/protocol/src/index.ts',
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
  ])
    put(name, `fixture ${name}\n`);
  for (const name of ['.dockerignore', 'deploy/docker/Dockerfile', 'CHANGELOG.md'])
    put(name, readFileSync(join(sourceRoot, name)));
  put('package.json', '{"type":"module"}');
  // Stand in for the build executable, not an already-built dist. The archive must request a fresh
  // build and use its output, with nothing from an earlier package or the developer's live app.
  put(
    'node_modules/vite/bin/vite.js',
    `import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const out=process.argv[process.argv.indexOf('--outDir')+1];
mkdirSync(join(out,'assets'),{recursive:true});
writeFileSync(join(out,'index.html'),readFileSync('apps/desktop/src/current.txt'));
writeFileSync(join(out,'assets/main.js'),'shared frontend');
`,
  );
  put('apps/desktop/src/current.txt', 'current shared UI');
  put('apps/desktop/dist/index.html', 'stale desktop UI');
  put('apps/server/web/index.html', 'stale server UI');
  put('.local/credentials.json', 'private credential');
  put('.env', 'private environment');
  put('deploy/private.key', 'private key');
  put('deploy/docker/private.json', 'private local config');
  put('apps/desktop/electron/local.json', 'private desktop config');
  return { root, put, output: join(root, 'artifacts/server.tar.gz') };
}

test('server bundles contain a fresh matching Web build without desktop sources or local data', (t) => {
  const { root, put, output } = fixture(t);
  packageServer(root, output);
  const contents = execFileSync(tar, ['-tzf', output], { encoding: 'utf8' });
  assert.match(contents, /apps\/server\/web\/index\.html/);
  assert.match(contents, /apps\/server\/web\/assets\/main\.js/);
  assert.match(contents, /apps\/server\/src\/main\.ts/);
  assert.match(contents, /docs\/server-web\.md/);
  assert.doesNotMatch(
    contents,
    /private|credentials|node_modules|\.env|\.local|desktop\/src|desktop\/dist|desktop\/electron/,
  );
  assert.equal(
    execFileSync(tar, ['-xOzf', output, 'apps/server/web/index.html'], { encoding: 'utf8' }),
    'current shared UI',
  );
  assert.deepEqual(readdirSync(join(root, '.local')), ['credentials.json']);
  put('apps/desktop/src/current.txt', 'updated shared UI');
  packageServer(root, output);
  assert.equal(
    execFileSync(tar, ['-xOzf', output, 'apps/server/web/index.html'], { encoding: 'utf8' }),
    'updated shared UI',
  );
  assert.equal(
    readFileSync(join(root, 'apps/desktop/dist/index.html'), 'utf8'),
    'stale desktop UI',
  );
  assert.equal(readFileSync(join(root, 'apps/server/web/index.html'), 'utf8'), 'stale server UI');
});

test('a failed Web build creates no release and cleans its private staging directory', (t) => {
  const { root, put, output } = fixture(t);
  put('node_modules/vite/bin/vite.js', 'process.exit(13);');
  assert.throws(
    () => packageServer(root, output),
    (error) => error.status === 13,
  );
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(join(root, '.local')), ['credentials.json']);
});

test('a build without index.html is not packaged as a usable Web release', (t) => {
  const { root, put, output } = fixture(t);
  put('node_modules/vite/bin/vite.js', 'process.exit(0);');
  assert.throws(() => packageServer(root, output), /no index.html/);
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(join(root, '.local')), ['credentials.json']);
});

test('source and release Docker contexts include every COPY input and the carried release notes', (t) => {
  const { root, output } = fixture(t);
  const dockerfile = readFileSync(join(sourceRoot, 'deploy/docker/Dockerfile'), 'utf8');
  // Validate the actual local COPY sources, not only the presence of a build-stage declaration.
  // Stage-to-stage copies are outputs of the build, not files supplied by the Docker context.
  const inputs = dockerfile
    .split(/\r?\n/)
    .filter((line) => /^COPY /.test(line) && !/--from=/.test(line))
    .flatMap((line) =>
      line
        .split(/\s+/)
        .filter((part) => !part.startsWith('--'))
        .slice(1, -1),
    );
  const releaseNotes = join(sourceRoot, 'apps/desktop/src/ReleaseNotes.tsx');
  const imported = readFileSync(releaseNotes, 'utf8').match(/from ['"]([^'"]+)\?raw['"]/);
  assert.ok(imported, 'ReleaseNotes must carry its release notes into the shared frontend');
  const notesPath = relative(sourceRoot, resolve(dirname(releaseNotes), imported[1])).replaceAll(
    '\\',
    '/',
  );
  assert.ok(inputs.includes(notesPath), `${notesPath} must be a Docker COPY input`);
  const ignore = readFileSync(join(sourceRoot, '.dockerignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes(`!${notesPath}`), `${notesPath} must reach the Docker context`);
  for (const input of inputs)
    assert.ok(existsSync(join(sourceRoot, input)), `Source context is missing ${input}`);

  packageServer(root, output);
  const extracted = join(root, 'extracted');
  mkdirSync(extracted);
  execFileSync(tar, ['-xzf', output, '-C', extracted]);
  for (const input of inputs)
    assert.ok(existsSync(join(extracted, input)), `Release context is missing ${input}`);
  assert.deepEqual(
    readFileSync(join(extracted, notesPath)),
    readFileSync(join(sourceRoot, notesPath)),
  );
  assert.equal(existsSync(join(extracted, 'apps/desktop/src')), false);
  assert.ok(existsSync(join(extracted, 'apps/server/web/index.html')));
});

test('Docker keeps frontend tooling in a separate build stage and accepts prebuilt release assets', () => {
  const source = readFileSync(
    new URL('../../../deploy/docker/Dockerfile', import.meta.url),
    'utf8',
  );
  assert.match(source, /FROM build AS web-build/);
  assert.match(source, /if \[ -f apps\/desktop\/src\/main\.tsx \]/);
  assert.match(source, /test -s apps\/server\/web\/index\.html/);
  const runtime = source.slice(source.lastIndexOf('\nFROM base'));
  assert.match(
    runtime,
    /COPY --from=web-build[^\n]*\/app\/apps\/server\/web \/app\/apps\/server\/web/,
  );
  assert.doesNotMatch(runtime, /npm ci|vite build|COPY --from=web-build[^\n]*node_modules/);
  const ignore = readFileSync(new URL('../../../.dockerignore', import.meta.url), 'utf8');
  assert.match(ignore, /!apps\/desktop\/src\/\*\*/);
  assert.match(ignore, /!apps\/server\/web\/\*\*/);
  assert.doesNotMatch(ignore, /!.*(?:\.local|\.env|vendor|test-main|credentials)/);
});
