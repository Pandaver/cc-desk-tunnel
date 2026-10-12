import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the release files for the version in apps/desktop/package.json and uploads them to a GitHub release.
// The release stays a draft unless --publish is given; --prerelease selects the preview channel.
// --dry-run only builds. Needs gh (or GH pointing at it) and GH_TOKEN.
//
// The Windows installer and the server bundle are built here. The packages for macOS and Linux cannot be:
// the `package` workflow on GitHub builds them from the same commit and attaches them to the draft, which
// this script starts and waits for. --windows-only leaves them out, for when GitHub's machines are not to
// be waited for.
const root = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const publish = process.argv.includes('--publish');
const prerelease = process.argv.includes('--prerelease');
const windowsOnly = process.argv.includes('--windows-only');
// A word this script does not know is a mistake, not something to release past: `--help` would otherwise publish.
const unknown = process.argv
  .slice(2)
  .filter((word) => !['--dry-run', '--publish', '--prerelease', '--windows-only'].includes(word));
if (unknown.length)
  throw new Error(
    `Unknown argument ${unknown.join(' ')}. Use --dry-run, --prerelease, --publish, --windows-only.`,
  );
const gh = process.env.GH ?? 'gh';
const run = (file, args, options = {}) =>
  execFileSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
const git = (...args) => run('git', args).trim();

const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const protocol = Number(
  /PROTOCOL_VERSION = (\d+)/.exec(
    readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8'),
  )[1],
);
// Raised whenever the image must be rebuilt for a release to run; see deploy/docker/runtime-level.
const runtime = Number(readFileSync(join(root, 'deploy/docker/runtime-level'), 'utf8'));
const tag = `v${version}`;
const section = new RegExp(
  `^## ${version.replaceAll('.', '\\.')}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
  'm',
)
  .exec(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))?.[1]
  .trim();
if (!section) throw new Error(`CHANGELOG.md has no section "## ${version}".`);
const repository = 'https://github.com/sun168567/cc-desk-tunnel';
// Every release reads the same way: what the project is, this version's section of the change log with its
// headings one level up, then how to get and upgrade to it.
const notes = (others) =>
  [
    '> 用桌面客户端驱动云端的 Claude Code，经反向隧道在你的 Windows 本机执行。',
    '',
    section.replace(/^### /gm, '## '),
    '',
    '---',
    '',
    '## 下载与升级',
    '',
    prerelease
      ? '- **预发布版本**：不会通过稳定版的自动更新提供。请手动下载本页的服务端程序包与 Windows 安装包，两端一起升级；部署脚本的 latest 下载入口仍指向稳定版。'
      : `- **已在使用**：在客户端的“设置 → 关于与更新”里先升级服务端，再按提示升级客户端；两端需要同一版本。`,
    `- **Windows 客户端**：下载 \`CC-Desk-Tunnel-Setup-${version}-x64.exe\` 并安装。安装包没有代码签名，SmartScreen 与杀毒软件的提示见[说明](${repository}#杀毒软件与-smartscreen)。`,
    prerelease
      ? `- **服务端**：下载本页的 \`cc-desk-tunnel-server-${version}.tar.gz\`，按[部署手册](${repository}/blob/main/deploy/README.md)的手动准备步骤校验、解压并运行安装脚本。`
      : `- **服务端**：新部署按[快速开始](${repository}#快速开始)用一条命令安装；\`cc-desk-tunnel-server-${version}.tar.gz\` 是它下载的程序包。`,
    ...(others.length
      ? [
          `- **macOS 与 Linux 客户端（实验性）**：${others.map((name) => `\`${name}\``).join('、')}。没有签名，也不带应用内更新，升级时重新下载安装；安装与首次打开见 [macOS 说明](${repository}/blob/main/docs/macos.md)与 [Linux 说明](${repository}/blob/main/docs/linux.md)。`,
        ]
      : []),
    '- **校验**：各文件的 SHA256 在 `SHA256SUMS` 与 `release.json` 中。',
    '',
    `文档：[部署手册](${repository}/blob/main/deploy/README.md) · [变更记录](${repository}/blob/main/CHANGELOG.md) · [安全须知](${repository}#安全须知)`,
  ].join('\n');

// A release is cut from exactly what the main branch on GitHub holds, so the tag matches the files.
const commit = git('rev-parse', 'HEAD');
if (!dryRun) {
  if (git('status', '--porcelain')) throw new Error('Commit or discard local changes first.');
  const remote = run(gh, ['api', 'repos/{owner}/{repo}/commits/main', '--jq', '.sha']).trim();
  if (remote !== commit) throw new Error('Check out the current main branch from GitHub first.');
  let exists = true;
  try {
    run(gh, ['release', 'view', tag], { stdio: 'pipe' });
  } catch {
    exists = false;
  }
  if (exists) throw new Error(`Release ${tag} already exists; raise the version.`);
}

const output = join(root, 'artifacts/release');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const installer = `CC-Desk-Tunnel-Setup-${version}-x64.exe`;
const server = `cc-desk-tunnel-server-${version}.tar.gz`;
// Packaging now and then fails on a file another program holds open for a moment; waiting is enough.
for (let attempt = 1; ; attempt++) {
  try {
    run(process.execPath, ['scripts/package-windows.mjs'], { stdio: 'inherit' });
    break;
  } catch (error) {
    if (attempt === 3) throw error;
    console.log('Packaging failed; trying again in a minute.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
}
copyFileSync(join(root, 'artifacts/windows', installer), join(output, installer));
run(process.execPath, ['scripts/package-server.mjs', join(output, server)], { stdio: 'inherit' });

const local = [installer, server].map((name) => ({
  name,
  size: statSync(join(output, name)).size,
  sha256: createHash('sha256')
    .update(readFileSync(join(output, name)))
    .digest('hex'),
}));
// release.json is what programs read; SHA256SUMS is the same hashes for `sha256sum -c`.
function describe(files) {
  writeFileSync(
    join(output, 'release.json'),
    JSON.stringify({ version, protocol, runtime, commit, files }, null, 2) + '\n',
  );
  writeFileSync(
    join(output, 'SHA256SUMS'),
    files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
  );
  const others = files.slice(local.length).map((file) => file.name);
  writeFileSync(join(output, 'notes.md'), notes(others) + '\n');
  for (const file of files) console.log(`${file.sha256}  ${file.name}  (${file.size} bytes)`);
}

// The packages of the other systems go from GitHub's machines straight to the release: the `package`
// workflow builds and starts them from this commit and attaches the disk images for macOS and the .deb to
// the draft. Their sizes and hashes are then read from the release itself.
function otherSystems() {
  const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const runs = () =>
    JSON.parse(
      run(gh, [
        'run',
        'list',
        '--workflow',
        'package.yml',
        '--event',
        'workflow_dispatch',
        '--commit',
        commit,
        '--json',
        'databaseId,createdAt',
      ]),
    );
  const before = new Set(runs().map((item) => item.databaseId));
  run(gh, ['workflow', 'run', 'package.yml', '--ref', 'main', '-f', `release=${tag}`]);
  let started;
  for (let attempt = 0; !started && attempt < 30; attempt++) {
    wait(5_000);
    started = runs().find((item) => !before.has(item.databaseId));
  }
  if (!started) throw new Error('The package workflow did not start on GitHub.');
  console.log(`GitHub run ${started.databaseId} builds the macOS and Linux packages.`);
  // Fails when the run does: a release does not go out with a package that did not start.
  run(gh, ['run', 'watch', String(started.databaseId), '--exit-status', '--interval', '30'], {
    stdio: 'inherit',
  });
  const id = run(gh, ['release', 'view', tag, '--json', 'databaseId', '--jq', '.databaseId']);
  const assets = JSON.parse(
    run(gh, ['api', `repos/{owner}/{repo}/releases/${id.trim()}`, '--jq', '.assets']),
  );
  const pattern = new RegExp(
    `^CC-Desk-Tunnel-${version.replaceAll('.', '\\.')}-(mac-arm64\\.dmg|mac-x64\\.dmg|linux-amd64\\.deb)$`,
  );
  const files = assets
    .filter((asset) => pattern.test(asset.name))
    .map((asset) => ({
      name: asset.name,
      size: asset.size,
      sha256: /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (files.length !== 3 || files.some((file) => !file.sha256))
    throw new Error(`The draft ${tag} does not hold the three packages with their hashes.`);
  return files;
}

if (dryRun) {
  describe(local);
  console.log(`Built ${tag} in ${output}; nothing uploaded, macOS and Linux left to GitHub.`);
} else {
  // Always a draft first: what is published is complete.
  describe(local);
  const url = run(gh, [
    'release',
    'create',
    tag,
    '--draft',
    ...(prerelease ? ['--prerelease', '--latest=false'] : []),
    '--target',
    commit,
    '--title',
    `CC Desk Tunnel ${version}`,
    '--notes-file',
    join(output, 'notes.md'),
    ...[installer, server].map((name) => join(output, name)),
  ]).trim();
  try {
    describe(windowsOnly ? local : [...local, ...otherSystems()]);
  } catch (error) {
    console.log(
      `The draft ${url} is left as it is. Delete it (gh release delete ${tag}) to try again.`,
    );
    throw error;
  }
  run(gh, ['release', 'upload', tag, join(output, 'release.json'), join(output, 'SHA256SUMS')]);
  run(gh, [
    'release',
    'edit',
    tag,
    '--notes-file',
    join(output, 'notes.md'),
    ...(publish ? ['--draft=false'] : []),
  ]);
  console.log(`${publish ? 'Published' : 'Draft'} release: ${url}`);
}
