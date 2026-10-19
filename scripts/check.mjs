import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const files = git('ls-files', '-z').split('\0').filter(Boolean);
const privatePath =
  /(^|\/)(?:\.local|node_modules|dist|coverage)(?:\/|$)|(^|\/)\.env(?:\.|$)|\.local\.json$|\.(?:pem|key|p12|pfx)$/i;
const secretToken = /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/;
const privateKey = /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/;
// Reviewed public, test-only private keys, never deployment credentials. Both the exact path and
// complete indexed content must match. Any fixture edit requires reviewing and updating its hash;
// this exception never applies to API tokens, other files or the surrounding fixtures directory.
const publicTestKeys = new Map([
  [
    'apps/server/test/fixtures/web-certificates.ts',
    '30fc164e084db9599a545e7bf0cdba93fbdd98a16c5c88b2a84c04b91a16c7c6',
  ],
  [
    'apps/server/test/fixtures/web-certificate-chains.ts',
    '017df24722d441bc9d4a070b2de7ac6415c5d89d5cf393301bbfa1ef74dbe02d',
  ],
]);
// These exact literals contain no key: one is an input hint, the other an invalid UI mock. Remove
// only that one literal in its known file; another private-key marker in either file still fails.
const keyPlaceholders = new Map([
  ['apps/desktop/src/ServerWebAccess.tsx', /placeholder="-----BEGIN (PRIVATE KEY)-----"/],
  [
    'apps/desktop/test/web-certificates.spec.ts',
    /'-----BEGIN (PRIVATE KEY)-----\\nfixture-private-material\\n-----END \1-----'/,
  ],
]);

for (const file of files) {
  if (privatePath.test(file) && !file.endsWith('.env.example')) {
    errors.push('禁止跟踪的文件路径：' + file);
  }
  if (!/\.(?:md|mjs|cjs|ts|tsx|html|css|json|txt|sh|ps1)$/.test(file)) continue;
  const content = git('show', ':' + file);
  const placeholder = keyPlaceholders.get(file);
  const keyContent = placeholder ? content.replace(placeholder, '') : content;
  if (
    secretToken.test(content) ||
    (privateKey.test(keyContent) &&
      publicTestKeys.get(file) !== createHash('sha256').update(content).digest('hex'))
  )
    errors.push('疑似秘密：' + file + '（内容不显示）');
  if (file.endsWith('.json')) {
    try {
      JSON.parse(content);
    } catch {
      errors.push('JSON 无效：' + file);
    }
  }
  if (file.endsWith('.md')) {
    for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const link = match[1];
      if (/^(?:[a-z]+:|#)/i.test(link)) continue;
      const target = decodeURIComponent(link.split('#')[0]);
      if (!existsSync(resolve(root, dirname(file), target))) {
        errors.push('本地文档链接失效：' + file + ' → ' + target);
      }
    }
  }
}

for (const path of ['.local/开发调试凭据.txt', '.env', 'config/runtime.local.json']) {
  try {
    git('check-ignore', '--no-index', '--', path);
  } catch {
    errors.push('应被忽略的路径未被忽略：' + path);
  }
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const workspace of manifest.workspaces) {
  const path = resolve(root, workspace, 'package.json');
  if (!existsSync(path)) errors.push('缺少 workspace 清单：' + workspace);
  else if (!JSON.parse(readFileSync(path, 'utf8')).private) {
    errors.push('workspace 应设置 private：' + workspace);
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(
    'PASS：检查 ' + files.length + ' 个索引文件、workspace 清单、文档链接及秘密忽略规则。',
  );
  console.log('此检查不访问模型或虚拟机，也不代表代理产品已实现或实测。');
}
