import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';
import { matches, Plugins } from '../src/plugins.ts';
import { EVENTS_VERSION, ServiceEvents } from '../src/service-events.ts';
import type { ServiceEvent } from '../src/service-events.ts';

test('a matcher is names or a regular expression, as in Claude Code', () => {
  assert.ok(matches(undefined, 'Bash') && matches('*', 'Bash') && matches('Edit | Bash', 'Bash'));
  assert.ok(!matches('Bash', 'BashOutput'));
  assert.ok(matches('^mcp__.*', 'mcp__memory__read') && !matches('^mcp__.*', 'Bash'));
});

test('a broken plugin and one that does not end leave the others and the service alone', async (t) => {
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
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));
  plugins.dispatch({
    version: EVENTS_VERSION,
    hook_event_name: 'RunEnded',
    timestamp: new Date().toISOString(),
    status: 'completed',
  });
  for (const deadline = Date.now() + 10_000; logged.length < 3 && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(logged.join('\n'), /Plugin a-broken, RunEnded: /);
  assert.ok(logged.includes('Plugin b-hangs, RunEnded: stopped after 0.5s'));
  assert.ok(logged.includes('Plugin c-fails, RunEnded: exit 3 no token'));
});

test('every wait is resolved, at the latest by the end of its run', () => {
  const heard: ServiceEvent[] = [];
  const session = { id: randomUUID(), title: '会话', projectPath: 'D:\\p' } as Session;
  const events = new ServiceEvents(
    () => session,
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
});
