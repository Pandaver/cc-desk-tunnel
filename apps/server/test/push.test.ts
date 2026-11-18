import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Session } from '@cc-desk-tunnel/protocol';
import { Pushes, pushRequest } from '../src/push.ts';
import type { PushMessage } from '../src/push.ts';

const message: PushMessage = {
  title: '【任务完成】"引号"',
  text: '设备：A\n错误：x',
  url: 'https://h/#session=1',
};

test('a webhook gets its body filled in as JSON, or its URL without one; DingTalk is signed', () => {
  const posted = pushRequest(
    { kind: 'webhook', url: 'https://h/a', body: '{"title":"{{title}}","text":"{{text}}"}' },
    message,
  );
  assert.deepEqual(JSON.parse(String(posted.init.body)), {
    title: message.title,
    text: message.text,
  });
  const fetched = pushRequest({ kind: 'webhook', url: 'https://h/{{title}}', body: '' }, message);
  assert.equal(fetched.url, `https://h/${encodeURIComponent(message.title)}`);
  assert.equal(fetched.init.method, 'GET');

  const signed = new URL(
    pushRequest(
      { kind: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=k', secret: 's' },
      message,
      1000,
    ).url,
  );
  assert.equal(signed.searchParams.get('timestamp'), '1000');
  assert.equal(
    signed.searchParams.get('sign'),
    createHmac('sha256', 's').update('1000\ns').digest('base64'),
  );
});

test('an approval of a session not subscribed to is pushed after the delay, unless answered first', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'push-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = {
    id: randomUUID(),
    title: '会话',
    device: { id: randomUUID(), name: 'A' },
    activeRun: null,
  } as unknown as Session;
  const sent: string[] = [];
  const pushes = new Pushes(directory, {
    session: () => session,
    link: () => undefined,
    ended: () => {},
    changed: () => {},
    deliver: async (_config, { title }) => void sent.push(title),
  });
  pushes.add('A', { kind: 'bark', url: 'https://api.day.app/k' });
  pushes.update({ enabled: true, fallback: true, delayMinutes: 5 });
  const waiting = () => {
    session.activeRun = {
      id: randomUUID(),
      status: 'awaiting_approval',
      connectionId: randomUUID(),
    };
    pushes.observe(
      session.id,
      { type: 'run.status', status: 'awaiting_approval', connectionId: randomUUID() },
      null,
    );
  };

  waiting();
  t.mock.timers.tick(4 * 60_000);
  pushes.observe(
    session.id,
    { type: 'approval.resolved', approvalId: randomUUID(), allowed: true },
    null,
  );
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(sent, []);

  waiting();
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(sent, ['【等待审批】会话']);
  pushes.close();
});
