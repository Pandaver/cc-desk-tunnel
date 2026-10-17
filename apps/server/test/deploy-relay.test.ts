import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const shellPath = (value: string) =>
  process.platform === 'win32'
    ? value
        .replaceAll('\\', '/')
        .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    : value;

test(
  'deployment selects the relay overlay only when opted in, including standalone and upgrade commands',
  { skip: !existsSync(bash) },
  (t) => {
    const temporary = mkdtempSync(join(tmpdir(), 'ccdt-deploy-relay-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const config = join(temporary, 'docker.env');
    const log = join(temporary, 'docker.log');
    // Only Docker and ownership are replaced. The real manager parses flags, validates settings,
    // writes its private configuration and builds the command used with the real Compose CLI.
    const run = (args: string[], environment: Record<string, string> = {}) =>
      execFileSync(
        bash,
        [
          '-c',
          `
    set -euo pipefail
    manager="$1"; export PROXY_DEPLOY_CONFIG="$2"; export DEPLOY_TEST_LOG="$3"; shift 3
    docker() {
      printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
      if [[ "$1" = inspect ]]; then printf 'healthy\\n'
      elif [[ "$1" = compose && " $* " = *' ps '* && "\${DEPLOY_TEST_RUNNING:-1}" = 1 ]]; then printf 'fixture-container\\n'; fi
      return 0
    }
    id() { if [[ "$*" = -u ]]; then printf '0\\n'; else command id "$@"; fi; }
    chown() { :; }
    export -f docker id chown
    bash "$manager" "$@"
  `,
          'deployment-test',
          shellPath(environment.DEPLOY_TEST_MANAGER ?? join(root, 'deploy/manage.sh')),
          shellPath(config),
          shellPath(log),
          ...args,
        ],
        {
          cwd: root,
          env: { ...process.env, ...environment },
          encoding: 'utf8',
          windowsHide: true,
        },
      );
    const initial = [
      'init',
      '--host',
      'proxy.example',
      '--mode',
      'nginx',
      '--data',
      shellPath(join(temporary, 'data')),
      '--token',
      '00112233445566778899aabbccddeeff',
    ];
    for (const [options, error] of [
      [['--web-relay', '1'], /public HTTP\(S\) entrance/],
      [['--web-relay', '1', '--web-relay-port', '8787'], /different host ports/],
      [['--web-relay-port', '5270'], /--web-relay 1/],
      [['--web-relay', 'yes'], /must be 0 or 1/],
      [['--web-relay', '1', '--web-relay-port', '0'], /must be 1\.\.65535/],
      [['--web-relay', '1', '--web-relay-port', '65536'], /must be 1\.\.65535/],
      [['--web-relay', '1', '--web-relay-bind', 'localhost'], /0\.0\.0\.0 or 127\.0\.0\.1/],
      [['--web-relay', '1', '--web-relay-origin', 'https://browser.example/path'], /origin/],
      [['--web-relay', '1', '--web-relay-origin', 'https://browser.example:0'], /origin port/],
      [['--token', 'short'], /24\.\.512 characters/],
      [['--token', 'a'.repeat(513)], /24\.\.512 characters/],
      [['--token', `${'a'.repeat(24)} space`], /24\.\.512 characters/],
    ] as const) {
      assert.throws(() => run([...initial, ...options]), error);
      assert.equal(existsSync(config), false);
      assert.equal(
        existsSync(join(temporary, 'data')),
        false,
        'invalid input must allow init retry',
      );
    }
    run(initial);
    const original = readFileSync(config, 'utf8');
    assert.ok(!original.includes('WEB_RELAY'));
    writeFileSync(log, '');
    run(['up']);
    assert.ok(!readFileSync(log, 'utf8').includes('compose.relay.yml'));
    assert.ok(!run(['summary']).includes('Web 中继'));
    // An ambient shell opt-in must not silently expose an existing, disabled deployment.
    writeFileSync(log, '');
    run(['up'], { WEB_RELAY_ENABLED: '1', WEB_RELAY_PORT: '9999' });
    assert.ok(!readFileSync(log, 'utf8').includes('compose.relay.yml'));

    writeFileSync(
      config,
      `${original}WEB_RELAY_ENABLED='1'\nWEB_RELAY_PORT='80'\nWEB_RELAY_ORIGIN='https://browser.example:9443'\n`,
    );
    const standalone = join(root, 'deploy/compose.yml');
    writeFileSync(log, '');
    run(['up'], { PROXY_COMPOSE_FILE: shellPath(standalone) });
    const commands = readFileSync(log, 'utf8');
    assert.match(commands, /-f .*deploy\/compose\.yml -f .*deploy\/compose\.relay\.yml up -d/);
    const summary = run(['summary']);
    assert.ok(summary.includes('127.0.0.1:80 → 容器 5270'));
    assert.ok(summary.includes('9443/TCP'));
    assert.ok(!summary.includes('80/TCP（Web 中继）'));
    const relayConfig = readFileSync(config, 'utf8');
    writeFileSync(config, `${relayConfig}WEB_RELAY_BIND='0.0.0.0'\n`);
    const externallyBound = run(['summary']);
    assert.ok(externallyBound.includes('80/TCP（Web 中继）'));
    assert.ok(externallyBound.includes('9443/TCP（中继反代入口）'));
    writeFileSync(
      config,
      `${relayConfig.replace('https://browser.example:9443', 'https://browser.example:80')}WEB_RELAY_BIND='0.0.0.0'\n`,
    );
    assert.equal((run(['summary']).match(/80\/TCP/g) ?? []).length, 1);
    writeFileSync(
      config,
      `${relayConfig.replace('wss://proxy.example/ws', 'wss://proxy.example:80/ws')}WEB_RELAY_BIND='0.0.0.0'\n`,
    );
    const sharedControlPort = run(['summary']);
    assert.equal((sharedControlPort.match(/80\/TCP/g) ?? []).length, 1);
    assert.equal((sharedControlPort.match(/9443\/TCP/g) ?? []).length, 1);
    writeFileSync(
      config,
      relayConfig.replace('wss://proxy.example/ws', 'wss://proxy.example:9443/ws'),
    );
    assert.equal((run(['summary']).match(/9443\/TCP/g) ?? []).length, 1);
    writeFileSync(config, relayConfig);
    run(['upgrade']);
    assert.match(readFileSync(log, 'utf8'), /compose\.relay\.yml build --pull/);
    assert.match(readFileSync(config, 'utf8'), /WEB_RELAY_ENABLED='1'/);
    // Execute the archive-upgrade re-entry against an isolated program tree, never this checkout.
    const installed = join(temporary, 'installed');
    const update = join(temporary, 'update');
    for (const destination of [installed, update]) {
      mkdirSync(join(destination, 'deploy/docker'), { recursive: true });
      for (const file of ['manage.sh', 'compose.yml', 'compose.relay.yml', 'docker/compose.yaml'])
        copyFileSync(join(root, 'deploy', file), join(destination, 'deploy', file));
    }
    writeFileSync(join(update, 'deploy/upgrade-marker'), 'new-release');
    const upgradeArchive = join(temporary, 'upgrade.tar.gz');
    execFileSync(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-czf', upgradeArchive, '-C', update, 'deploy'],
      { windowsHide: true },
    );
    const beforeUpgrade = readFileSync(config, 'utf8');
    run(['upgrade', '--from', shellPath(upgradeArchive)], {
      DEPLOY_TEST_MANAGER: join(installed, 'deploy/manage.sh'),
    });
    assert.equal(readFileSync(join(installed, 'deploy/upgrade-marker'), 'utf8'), 'new-release');
    assert.equal(readFileSync(config, 'utf8'), beforeUpgrade);
    const archive = join(temporary, 'backup.tar.gz');
    run(['backup', shellPath(archive)]);
    assert.ok(existsSync(archive));
    assert.match(readFileSync(config, 'utf8'), /WEB_RELAY_ENABLED='1'/);
    run(['restore', shellPath(archive)], { DEPLOY_TEST_RUNNING: '0' });
    assert.match(readFileSync(config, 'utf8'), /WEB_RELAY_ENABLED='1'/);
    assert.match(
      readFileSync(join(temporary, 'data/config/service.env'), 'utf8'),
      /PROXY_PORT='8787'/,
    );
    for (const command of ['build', 'status', 'stop', 'restart', 'uninstall']) {
      writeFileSync(log, '');
      run([command]);
      assert.match(readFileSync(log, 'utf8'), /compose\.relay\.yml/, command);
    }
    for (const token of ['a'.repeat(24), 'a'.repeat(512), 'Abcd0123._~+/=-'.repeat(3)]) {
      run(['token', token]);
      assert.ok(readFileSync(join(temporary, 'data/config/service.env'), 'utf8').includes(token));
    }
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace("WEB_RELAY_ENABLED='1'", "WEB_RELAY_ENABLED='0'"),
    );
    writeFileSync(log, '');
    run(['up']);
    assert.ok(!readFileSync(log, 'utf8').includes('compose.relay.yml'));
    assert.ok(!run(['summary']).includes('Web 中继'));
  },
);

const composeVersion = spawnSync('docker', ['compose', 'version'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 10_000,
});

test(
  'real Compose merges keep the business port, fix relay container 5270 and honor default/empty host settings',
  { skip: composeVersion.status !== 0 },
  (t) => {
    const temporary = mkdtempSync(join(tmpdir(), 'ccdt-relay-compose-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const config = join(temporary, 'compose.env');
    const environment = { ...process.env };
    for (const name of Object.keys(environment))
      if (/^(?:COMPOSE_|WEB_RELAY_|CONTROL_|PROXY_IMAGE$|PROJECT_NAME$|DATA_DIR$)/.test(name))
        delete environment[name];
    const baseConfig =
      "PROJECT_NAME='relay-config-test'\nPROXY_IMAGE='cc-desk-tunnel:local'\nDATA_DIR='/fixture/data'\n";
    const render = (base: string, overlay: boolean, extra = '') => {
      writeFileSync(config, baseConfig + extra);
      const args = ['compose', '--env-file', config, '-f', join(root, base)];
      if (overlay) args.push('-f', join(root, 'deploy/compose.relay.yml'));
      args.push('config', '--format', 'json');
      return JSON.parse(
        execFileSync('docker', args, {
          cwd: root,
          env: environment,
          encoding: 'utf8',
          windowsHide: true,
        }),
      ).services.proxy;
    };
    for (const base of ['deploy/compose.yml', 'deploy/docker/compose.yaml']) {
      for (const optIn of ['', "WEB_RELAY_ENABLED='1'\n"]) {
        // A bare Compose invocation never opts in from the environment alone.
        const proxy = render(base, false, optIn);
        assert.deepEqual(
          proxy.ports.map((port: { target: number }) => port.target),
          [8787],
        );
        assert.equal(proxy.environment?.PROXY_WEB_RELAY_ENABLED, undefined);
      }
      for (const empty of ['', "WEB_RELAY_PORT=''\nWEB_RELAY_BIND=''\nWEB_RELAY_ORIGIN=''\n"]) {
        const proxy = render(base, true, empty);
        assert.equal(proxy.ports.length, 2);
        assert.deepEqual(
          proxy.ports.map((port: { target: number; published: string; host_ip: string }) => [
            port.target,
            port.published,
            port.host_ip,
          ]),
          [
            [8787, '8787', '0.0.0.0'],
            [5270, '5270', '0.0.0.0'],
          ],
        );
        assert.deepEqual(proxy.environment, {
          PROXY_WEB_RELAY_ENABLED: '1',
          PROXY_WEB_RELAY_PUBLIC_PORT: '5270',
          PROXY_WEB_RELAY_ORIGIN: '',
        });
      }
      const nginx = render(
        base,
        true,
        "CONTROL_BIND='127.0.0.1'\nCONTROL_PORT='19873'\nWEB_RELAY_PORT='80'\nWEB_RELAY_ORIGIN='https://browser.example:9443'\n",
      );
      assert.deepEqual(
        nginx.ports.map((port: { target: number; published: string; host_ip: string }) => [
          port.target,
          port.published,
          port.host_ip,
        ]),
        [
          [8787, '19873', '127.0.0.1'],
          [5270, '80', '127.0.0.1'],
        ],
      );
      assert.equal(nginx.environment.PROXY_WEB_RELAY_PUBLIC_PORT, '80');
      assert.equal(nginx.environment.PROXY_WEB_RELAY_ORIGIN, 'https://browser.example:9443');
      const explicit = render(
        base,
        true,
        "CONTROL_BIND='127.0.0.1'\nWEB_RELAY_BIND='0.0.0.0'\nWEB_RELAY_PORT='65535'\n",
      );
      assert.equal(
        explicit.ports.find((port: { target: number }) => port.target === 5270).published,
        '65535',
      );
      assert.equal(
        explicit.ports.find((port: { target: number }) => port.target === 5270).host_ip,
        '0.0.0.0',
      );
    }
  },
);

test('server source packages include the optional overlay while both base compose files stay opt-in', (t) => {
  for (const file of ['deploy/compose.yml', 'deploy/docker/compose.yaml']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.ok(!source.includes('WEB_RELAY'));
    assert.ok(!source.includes(':5270'));
  }
  const temporary = mkdtempSync(join(tmpdir(), 'ccdt-relay-package-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const archive = join(temporary, 'server.tar.gz');
  execFileSync(process.execPath, [join(root, 'scripts/package-server.mjs'), archive], {
    cwd: root,
    windowsHide: true,
  });
  const files = execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-tzf', archive], {
    encoding: 'utf8',
    windowsHide: true,
  }).split(/\r?\n/);
  for (const file of [
    'deploy/compose.relay.yml',
    'deploy/compose.yml',
    'deploy/docker/compose.yaml',
    'deploy/manage.sh',
  ])
    assert.ok(files.includes(file), `The server archive must include ${file}`);
});
