import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { pushDefaults } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { Pushes, pushRequest } from '../src/push.ts';
import type { PushValues } from '../src/push.ts';

const values: PushValues = {
  event: '任务完成',
  session: '"引号" <b>',
  device: 'A',
  error: undefined,
  url: 'https://h/#session=1',
};
const body = (request: { init: RequestInit }) => JSON.parse(String(request.init.body));

test('each channel sends its own template: a webhook its JSON, a card its button, HTML with the values escaped', () => {
  const webhook = pushRequest(
    { kind: 'webhook', url: 'https://h/a', body: '{"title":"{session}","error":"{error}"}' },
    values,
  );
  assert.deepEqual(body(webhook), { title: values.session, error: '' });
  const fetched = pushRequest({ kind: 'webhook', url: 'https://h/{session}', body: '' }, values);
  assert.equal(fetched.url, `https://h/${encodeURIComponent(values.session!)}`);

  const dingtalk = {
    kind: 'dingtalk' as const,
    url: 'https://oapi.dingtalk.com/robot/send?access_token=k',
    secret: 's',
    ...(pushDefaults('dingtalk') as {
      format: 'actionCard';
      title: string;
      body: string;
      button: string;
      buttonUrl: string;
    }),
  };
  const card = pushRequest(dingtalk, values, 1000);
  assert.equal(body(card).actionCard.singleURL, values.url);
  assert.equal(
    new URL(card.url).searchParams.get('sign'),
    createHmac('sha256', 's').update('1000\ns').digest('base64'),
  );
  // No page to go to: the card has no button to offer, and its text goes as markdown; the line of the error is left out.
  const markdown = body(pushRequest(dingtalk, { ...values, url: undefined }));
  assert.equal(markdown.msgtype, 'markdown');
  assert.equal(markdown.markdown.text.includes('错误'), false);

  const telegram = body(
    pushRequest(
      {
        kind: 'telegram',
        token: '1:a',
        chatId: '2',
        ...(pushDefaults('telegram') as { format: 'html'; title: string; body: string }),
        body: '<i>{session}</i>',
      },
      values,
    ),
  );
  assert.equal(telegram.text.split('\n')[1], '<i>&quot;引号&quot; &lt;b&gt;</i>');
});

test('a channel is changed without what it sends with, which is kept unless taken away and never read back', (t) => {
  const { pushes } = setup(t);
  const [bark] = pushes.state().channels;
  assert.deepEqual(bark.secrets, ['url']);
  assert.equal(JSON.stringify(pushes.state()).includes('api.day.app'), false);
  pushes.put(bark.id, '改名', { kind: 'bark', ...pushDefaults('bark'), title: '{session}' });
  const changed = pushes.settings.channels[0];
  assert.deepEqual(
    [changed.name, changed.config.kind === 'bark' && changed.config.url],
    ['改名', 'https://api.day.app/k'],
  );
  const dingtalk = {
    kind: 'dingtalk',
    url: 'https://oapi.dingtalk.com/robot/send?access_token=k',
    ...pushDefaults('dingtalk'),
  };
  const { id } = pushes.put(undefined, '钉钉', { ...dingtalk, secret: 's' }).channels[1];
  pushes.put(id, '钉钉', { ...dingtalk, url: '', secret: null });
  assert.deepEqual(pushes.state().channels[1].secrets, ['url']);
  assert.throws(() => pushes.put(undefined, '缺地址', { kind: 'wecom', ...pushDefaults('wecom') }));
});

// A session pushed to one Bark channel; what it sends is the titles in `sent`.
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'push-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = {
    id: randomUUID(),
    title: '会话',
    projectPath: 'D:\\工作\\项目',
    device: { id: randomUUID(), name: 'A' },
    activeRun: null,
  } as unknown as Session;
  const sent: string[] = [];
  const pushes = new Pushes(directory, {
    session: () => session,
    facts: () => ({}),
    page: () => undefined,
    ended: () => delete session.push,
    changed: () => {},
    deliver: async (_config, { event, session }) => void sent.push(`【${event}】${session}`),
  });
  t.after(() => pushes.close());
  pushes.put(undefined, 'Bark', {
    kind: 'bark',
    url: 'https://api.day.app/k',
    ...pushDefaults('bark'),
  });
  pushes.update({ enabled: true });
  const status = (status: 'running' | 'awaiting_approval' | 'completed', waiting?: 'background') =>
    pushes.observe(session.id, {
      type: 'run.status',
      status,
      connectionId: randomUUID(),
      ...(waiting ? { waiting } : {}),
    });
  return { session, sent, pushes, status };
}

test('an approval of a session not subscribed to is pushed after the delay, unless answered first', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, sent, pushes, status } = setup(t);
  pushes.update({ fallback: true, delayMinutes: 5 });
  const waiting = () => {
    session.activeRun = {
      id: randomUUID(),
      status: 'awaiting_approval',
      connectionId: randomUUID(),
    };
    status('awaiting_approval');
  };

  waiting();
  t.mock.timers.tick(4 * 60_000);
  pushes.observe(session.id, {
    type: 'approval.resolved',
    approvalId: randomUUID(),
    allowed: true,
  });
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(sent, []);

  waiting();
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(sent, ['【等待审批】会话']);
});

// Claude waits there for a build or tests and goes on once they end: a push for one turn is kept for the run's end.
test('a run waiting only on background tasks is not done: a subscription for one turn lasts to its end', (t) => {
  const { session, sent, status } = setup(t);
  session.push = 'once';
  status('running', 'background');
  status('running');
  status('running', 'background');
  assert.deepEqual(sent, []);
  assert.equal(session.push, 'once');
  status('completed');
  assert.deepEqual(sent, ['【任务完成】会话']);
  assert.equal(session.push, undefined);
});
