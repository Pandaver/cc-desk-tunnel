import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';
import { matches } from '../src/plugin-hooks.ts';
import { readArchive } from '../src/plugin-install.ts';
import { Plugins } from '../src/plugins.ts';
import { EVENTS_VERSION, ServiceEvents } from '../src/service-events.ts';
import type { ServiceEvent } from '../src/service-events.ts';

test('a matcher is names or a regular expression, as in Claude Code', () => {
  assert.ok(matches(undefined, 'Bash') && matches('*', 'Bash') && matches('Edit | Bash', 'Bash'));
  assert.ok(!matches('Bash', 'BashOutput'));
  assert.ok(matches('^mcp__.*', 'mcp__memory__read') && !matches('^mcp__.*', 'Bash'));
});

test('a broken plugin and one that does not end leave the others alone, and each log says how it went', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const add = (name: string, text: string) => {
    mkdirSync(join(directory, 'plugins', name, 'hooks'), { recursive: true });
    writeFileSync(join(directory, 'plugins', name, 'hooks', 'hooks.json'), text);
  };
  const script = (code: string, timeout: number) =>
    JSON.stringify({
      hooks: {
        RunEnded: [
          {
            hooks: [{ type: 'command', command: process.execPath, args: ['-e', code], timeout }],
          },
        ],
      },
    });
  add('a-broken', '{');
  add('b-hangs', script('setInterval(() => {}, 1000)', 0.5));
  add('c-fails', script('console.error("no token"); process.exit(3)', 10));
  add('d-works', script('console.log("sent")', 10));
  const logged = (name: string) => {
    try {
      return readFileSync(join(directory, 'plugin-logs', `${name}.log`), 'utf8');
    } catch {
      return '';
    }
  };
  await plugins.start();
  plugins.dispatch({
    version: EVENTS_VERSION,
    hook_event_name: 'RunEnded',
    timestamp: new Date().toISOString(),
    status: 'completed',
  });
  const all = ['a-broken', 'b-hangs', 'c-fails', 'd-works'];
  for (const deadline = Date.now() + 10_000; !all.every(logged) && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(logged('a-broken'), /加载失败：/);
  assert.match(logged('b-hangs'), /RunEnded → 超时 0\.5s，已结束 \d+ms\n$/);
  assert.match(logged('c-fails'), /RunEnded → 退出 3 \d+ms\n    no token\n$/);
  assert.match(logged('d-works'), /RunEnded → 成功 \d+ms\n    sent\n$/);
});

test('a plugin is set by what its ui file declares and checks, and its secrets go to its commands alone', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const root = join(directory, 'plugins', 'set');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        RunEnded: [{ hooks: [{ type: 'command', command: process.execPath, args: ['told.mjs'] }] }],
      },
    }),
  );
  writeFileSync(
    join(root, 'told.mjs'),
    "import { readFileSync } from 'node:fs';\n" +
      'console.log(JSON.parse(readFileSync(0, "utf8")).config);\n',
  );
  writeFileSync(
    join(root, 'ui.ts'),
    `console.log('loaded');
export const settings = [{ title: '渠道', showWhen: 'on', fields: {
  on: { type: 'boolean', title: '启用', default: true },
  token: { type: 'string', title: 'Token', sensitive: true, required: true,
    validate: (value: string, all: { lines: number }) => ({ valid: value.length > all.lines, message: value + ' 太短' }) },
  lines: { type: 'number', title: '行数', default: 5, max: 9 },
  test: { type: 'button', title: '测试', run: async (all: { token: string }) => ({ ok: true, message: all.token }) },
} }];`,
  );
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await plugins.start();
  assert.equal(plugins.list()[0]!.problem, '待配置：Token');
  assert.deepEqual(await plugins.attempt('set', 'RunEnded'), {
    ok: false,
    message: '待配置：Token',
  });

  const wrong = await plugins.configure('set', { token: 'abcd', lines: 10 }, true);
  assert.deepEqual(wrong, {
    errors: { token: '*** 太短', lines: '不能大于 9' },
    notice: undefined,
    saved: false,
  });
  // A button takes the values of the form, kept or not.
  assert.deepEqual(await plugins.press('set', 'test', { token: 'not-kept-yet' }), {
    ok: true,
    message: '***',
  });
  assert.ok((await plugins.configure('set', { token: 'secret-token' }, true)).saved);
  const [listed] = plugins.list();
  assert.equal(listed!.problem, undefined);
  assert.deepEqual([listed!.values, listed!.secrets], [{ on: true, lines: 5 }, ['token']]);

  // Left empty a secret stays; the command is given it, and the log is not.
  assert.ok((await plugins.configure('set', { token: '', lines: 6 }, true)).saved);
  const tried = await plugins.attempt('set', 'RunEnded');
  assert.ok(tried.ok);
  assert.match(tried.message, /token: '\*\*\*', lines: 6/);
  assert.doesNotMatch(plugins.logOf('set'), /secret-token/);

  await plugins.enable('set', false);
  assert.deepEqual(plugins.list()[0]!.settings, []);
  assert.equal((await plugins.attempt('set', 'RunEnded')).ok, false);
  await plugins.enable('set', true);
  assert.deepEqual(plugins.list()[0]!.secrets, ['token']);
});

test('a check that hangs keeps nothing from being saved, and a ui file that cannot be loaded is told of', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const add = (name: string, ui: string) => {
    mkdirSync(join(directory, 'plugins', name, 'hooks'), { recursive: true });
    writeFileSync(join(directory, 'plugins', name, 'hooks', 'hooks.json'), '{"hooks":{}}');
    writeFileSync(join(directory, 'plugins', name, 'ui.ts'), ui);
  };
  const field = (more: string) =>
    `export const settings = [{ title: 'A', fields: { a: { type: 'string', title: 'A', ${more} } } }];`;
  add('a-hangs', field('validate: () => { for (;;); }'));
  add('b-throws', 'throw new Error("no luck");');
  add('c-unknown', field('type: "list"'));
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await plugins.start();
  const [, throws, unknown] = plugins.list();
  assert.equal(throws!.problem, '加载失败：no luck');
  assert.match(unknown!.problem!, /^加载失败：settings\.0\.fields\.a/);
  const saved = await plugins.configure('a-hangs', { a: 'x' }, true);
  assert.ok(saved.saved);
  assert.match(saved.notice!, /没跑成：超过 2 秒/);
});

test('an archive is checked before any of it is run, and takes the place of the plugin of its name', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const hooks = {
    RunEnded: [{ hooks: [{ type: 'command', command: 'node', args: ['notify.mjs'] }] }],
  };
  const pack = (version: string, more: Record<string, string> = {}, folder = '') =>
    zipSync(
      Object.fromEntries(
        Object.entries({
          '.claude-plugin/plugin.json': JSON.stringify({ name: 'notify', version }),
          'hooks/hooks.json': JSON.stringify({ hooks }),
          'notify.mjs': version,
          ...more,
        }).map(([name, text]) => [folder + name, strToU8(text)]),
      ),
    );
  for (const [archive, message] of [
    [strToU8('not a zip'), /不是有效的 zip/],
    [zipSync({ 'a.txt': strToU8('a') }), /没有 \.claude-plugin\/plugin\.json/],
    [pack('1', { '../evil.mjs': '' }), /路径不合规/],
    [pack('1', { '.claude-plugin/plugin.json': '{"name":"../x"}' }), /plugin\.json 有误：name/],
    [
      pack('1', { 'hooks/hooks.json': '{"hooks":{"RunEnded":[{"hooks":[{"type":"http"}]}]}}' }),
      /hooks\.json 有误/,
    ],
    [pack('1', { big: 'x'.repeat(21 * 1024 * 1024) }), /超过 20 MB/],
  ] as const)
    assert.throws(() => readArchive(archive), message);

  await plugins.start();
  const archive = readArchive(pack('1.0.0', { '__MACOSX/x': '' }, 'notify-main/'));
  assert.deepEqual([archive.events, archive.commands], [['RunEnded'], ['node notify.mjs']]);
  await plugins.install(archive);
  assert.equal(plugins.list()[0]!.version, '1.0.0');
  await plugins.enable('notify', false);
  await plugins.install(readArchive(pack('2.0.0')));
  assert.deepEqual(
    plugins.list().map(({ name, version, enabled }) => [name, version, enabled]),
    [['notify', '2.0.0', false]],
  );
  await plugins.remove('notify');
  assert.deepEqual(plugins.list(), []);
});

test('every wait is resolved by the end of its run, and a failed run says why and how the quota stands', () => {
  const heard: ServiceEvent[] = [];
  const window = { name: 'five_hour', utilization: 42, resetsAt: '2026-11-25T08:00:00.000Z' };
  const quota = { rateLimits: { available: true, windows: [window] } };
  const session = { id: randomUUID(), title: '会话', projectPath: 'D:\\p' } as Session;
  const events = new ServiceEvents(
    () => ({ session, metrics: null, quota }),
    () => true,
    (event) => heard.push(event),
  );
  const connectionId = randomUUID();
  const observe = (runId: string, payload: EventPayload) =>
    events.observe({
      sessionId: session.id,
      runId,
      sequence: 1,
      createdAt: new Date().toISOString(),
      payload,
    });
  const [run, terminal, approvalId] = [randomUUID(), randomUUID(), randomUUID()];
  observe(run, {
    type: 'tool.requested',
    toolId: 't',
    name: 'AskUserQuestion',
    input: '{}',
    target: 'Linux',
  });
  observe(run, { type: 'approval.requested', approvalId, toolId: 't' });
  observe(run, { type: 'run.status', status: 'running', waiting: 'background', connectionId });
  observe(run, { type: 'run.status', status: 'cancelled', reason: '用户停止', connectionId });
  // Recorded after the run: its wait is resolved already.
  observe(run, { type: 'approval.resolved', approvalId, allowed: false });
  for (const activity of ['waiting', 'working'] as const)
    observe(terminal, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity,
      connectionId,
    });
  assert.deepEqual(
    heard.map((event) => [event.hook_event_name, event.wait_id ?? event.status]),
    [
      ['QuestionAsked', approvalId],
      ['BackgroundOnly', undefined],
      ['WaitResolved', approvalId],
      ['RunEnded', 'cancelled'],
      ['TerminalWaiting', terminal],
      ['WaitResolved', terminal],
    ],
  );
  const failing = randomUUID();
  observe(failing, { type: 'run.error', code: 'cli_process_failed', message: 'boom' });
  observe(failing, { type: 'run.status', status: 'failed', connectionId });
  const ended = heard.at(-1)!;
  assert.deepEqual(ended.error, { code: 'cli_process_failed', message: 'boom' });
  assert.deepEqual(ended.quota, [
    { name: window.name, utilization: 42, resets_at: window.resetsAt },
  ]);
});

test('an event is not made while no plugin is there, and one that cannot be made leaves the run alone', (t) => {
  let wanted = false;
  let asked = 0;
  const events = new ServiceEvents(
    () => {
      asked++;
      throw new Error('no such session');
    },
    () => wanted,
    () => assert.fail('nothing to emit'),
  );
  const failed = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: { type: 'run.error', code: 'c', message: 'm' } as const,
  };
  t.mock.method(console, 'error', () => {});
  events.observe(failed);
  assert.equal(asked, 0);
  wanted = true;
  events.observe(failed);
  assert.equal(asked, 1);
});
