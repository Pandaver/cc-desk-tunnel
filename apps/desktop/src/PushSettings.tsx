import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { pushChannelConfigSchema } from '@cc-desk-tunnel/protocol';
import type { PushOptions, PushState } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { DialogForm, IconButton, Row, Switch } from './ui.tsx';

type Kind = PushState['channels'][number]['kind'];
type Field = {
  key: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
  long?: boolean;
};
const url = (placeholder: string): Field => ({ key: 'url', label: 'Webhook 地址', placeholder });
const kinds: Record<Kind, { name: string; fields: Field[] }> = {
  dingtalk: {
    name: '钉钉机器人',
    fields: [
      url('https://oapi.dingtalk.com/robot/send?access_token=…'),
      { key: 'secret', label: '加签密钥（可选）', placeholder: 'SEC…', optional: true },
    ],
  },
  feishu: {
    name: '飞书机器人',
    fields: [
      url('https://open.feishu.cn/open-apis/bot/v2/hook/…'),
      { key: 'secret', label: '签名校验密钥（可选）', optional: true },
    ],
  },
  wecom: {
    name: '企业微信群机器人',
    fields: [url('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…')],
  },
  telegram: {
    name: 'Telegram Bot',
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: '123456:ABC…' },
      { key: 'chatId', label: 'Chat ID' },
    ],
  },
  bark: {
    name: 'Bark',
    fields: [{ key: 'url', label: 'Bark 地址', placeholder: 'https://api.day.app/你的 Key' }],
  },
  webhook: {
    name: '通用 Webhook',
    fields: [
      { key: 'url', label: '地址', placeholder: 'https://…' },
      {
        key: 'body',
        label: '请求体（可选）',
        placeholder: '{"title": "{{title}}", "text": "{{text}}"}',
        optional: true,
        long: true,
      },
    ],
  },
};
const delays = [0, 1, 2, 5, 10, 15, 30, 60];
const events: { key: keyof PushOptions['events']; title: string; detail: string }[] = [
  { key: 'approval', title: '等待审批', detail: '有操作需要你允许或拒绝' },
  { key: 'question', title: 'Claude 提问', detail: 'Claude 需要你回答问题才能继续' },
  { key: 'done', title: '任务完成', detail: 'Claude Code 做完了一轮任务' },
  { key: 'failed', title: '任务失败', detail: '一轮任务因错误而结束' },
];

// The service's pushes to a chat robot or a phone app, for when no window is in front of the user. A browser changes
// what is pushed and switches channels on and off; only the desktop adds or removes them, and what they send with is
// never shown again.
export default function PushSettings({
  client,
  browser,
}: {
  client: ProxyClient;
  browser: boolean;
}) {
  const [values, setValues] = useState<PushState | null>(client.state.push);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'push.get' }).then(
      (reply) => current && setValues(reply.values),
      (error: Error) => current && setFailure(error.message),
    );
    // A test's failure, or another window's change, is told to every window.
    const unsubscribe = client.subscribe(() => current && setValues(client.state.push));
    return () => {
      current = false;
      unsubscribe();
    };
  }, [client]);
  async function run(task: () => Promise<unknown>) {
    setFailure(null);
    setSaving(true);
    try {
      await task();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }
  const save = (change: Partial<PushOptions>) =>
    run(() => client.fetch({ type: 'push.update', values: change }));
  if (!values)
    return failure ? (
      <p className="error-text" role="alert">
        {failure}
      </p>
    ) : null;
  return (
    <>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      <div className="settings-list card">
        <Row title="开启外部推送" detail="关闭后所有会话都不推送，订阅保留">
          <Switch
            label="开启外部推送"
            checked={values.enabled}
            disabled={saving}
            onChange={(enabled) => void save({ enabled })}
          />
        </Row>
        <label>
          <span>
            <strong>新会话默认订阅</strong>
            <small>新建和分叉出的会话从这里开始，之后在输入框旁的铃铛里改</small>
          </span>
          <select
            aria-label="新会话默认订阅"
            disabled={saving}
            value={values.defaultMode}
            onChange={({ target }) => void save({ defaultMode: target.value as 'off' | 'always' })}
          >
            <option value="off">不订阅</option>
            <option value="always">持续</option>
          </select>
        </label>
      </div>

      <h2 className="page-heading">推送哪些事</h2>
      <div className="card">
        {events.map(({ key, title, detail }) => (
          <Row key={key} title={title} detail={detail}>
            <Switch
              label={title}
              checked={values.events[key]}
              disabled={saving}
              onChange={(value) => void save({ events: { ...values.events, [key]: value } })}
            />
          </Row>
        ))}
      </div>

      <h2 className="page-heading">未订阅的会话</h2>
      <div className="settings-list card">
        <Row title="也推送审批和提问" detail="会话卡在等你回答时，即使没有订阅也推送">
          <Switch
            label="未订阅的会话也推送审批和提问"
            checked={values.fallback}
            disabled={saving}
            onChange={(fallback) => void save({ fallback })}
          />
        </Row>
        <label>
          <span>
            <strong>延迟推送</strong>
            <small>等待这么久仍没有在任何窗口处理，才推送</small>
          </span>
          <select
            aria-label="延迟推送"
            disabled={saving || !values.fallback}
            value={String(values.delayMinutes)}
            onChange={({ target }) => void save({ delayMinutes: Number(target.value) })}
          >
            {[...new Set([...delays, values.delayMinutes])]
              .sort((a, b) => a - b)
              .map((value) => (
                <option key={value} value={value}>
                  {value ? `${value} 分钟` : '不延迟'}
                </option>
              ))}
          </select>
        </label>
      </div>

      <h2 className="page-heading">推送渠道</h2>
      <div className="card">
        {values.channels.length === 0 && (
          <p className="muted push-empty">
            {browser ? '还没有推送渠道，请在桌面客户端里添加。' : '还没有推送渠道。'}
          </p>
        )}
        {values.channels.map((channel) => (
          <Row
            key={channel.id}
            title={channel.name}
            detail={
              channel.failure ? (
                <span className="error-text">
                  上次发送失败（{new Date(channel.failure.at).toLocaleString()}）：
                  {channel.failure.message}
                </span>
              ) : tested === channel.id ? (
                '测试推送已发出'
              ) : (
                kinds[channel.kind].name
              )
            }
          >
            <div className="setting-actions">
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() =>
                  void run(async () => {
                    setTested(null);
                    await client.request({ type: 'push.test', channelId: channel.id });
                    setTested(channel.id);
                  })
                }
              >
                测试
              </button>
              {!browser && (
                <IconButton
                  title={`删除 ${channel.name}`}
                  disabled={saving}
                  onClick={() =>
                    void run(() =>
                      client.fetch({ type: 'push.channel.delete', channelId: channel.id }),
                    )
                  }
                >
                  <Trash2 />
                </IconButton>
              )}
              <Switch
                label={`启用 ${channel.name}`}
                checked={channel.enabled}
                disabled={saving}
                onChange={(enabled) =>
                  void run(() =>
                    client.fetch({ type: 'push.channel.enable', channelId: channel.id, enabled }),
                  )
                }
              />
            </div>
          </Row>
        ))}
      </div>
      {!browser && (
        <button type="button" className="button" disabled={saving} onClick={() => setAdding(true)}>
          <Plus />
          添加渠道
        </button>
      )}
      {adding && (
        <AddChannel
          add={async (name, config) => {
            await client.fetch({ type: 'push.channel.add', name, config });
            setAdding(false);
          }}
          close={() => setAdding(false)}
        />
      )}
    </>
  );
}

function AddChannel({
  add,
  close,
}: {
  add: (name: string, config: ReturnType<typeof pushChannelConfigSchema.parse>) => Promise<void>;
  close: () => void;
}) {
  const [kind, setKind] = useState<Kind>('dingtalk');
  const [name, setName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    // The service refuses what does not fit; it is checked here first to say so in the dialog.
    const config = pushChannelConfigSchema.safeParse({
      kind,
      ...Object.fromEntries(
        kinds[kind].fields
          .map(({ key }) => [key, (fields[key] ?? '').trim()])
          .filter(([key, value]) => value || key === 'body'),
      ),
    });
    if (!config.success) return setError('请检查填写的内容：地址需以 https:// 或 http:// 开头。');
    setBusy(true);
    setError('');
    try {
      await add(name.trim() || kinds[kind].name, config.data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '添加失败。');
      setBusy(false);
    }
  }
  return (
    <DialogForm
      title="添加推送渠道"
      busy={busy}
      error={error}
      close={close}
      submit={() => void submit()}
    >
      <label>
        类型
        <select
          value={kind}
          onChange={({ target }) => {
            setKind(target.value as Kind);
            setFields({});
          }}
        >
          {Object.entries(kinds).map(([value, { name }]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        名称
        <input
          value={name}
          maxLength={40}
          placeholder={kinds[kind].name}
          onChange={({ target }) => setName(target.value)}
        />
      </label>
      {kinds[kind].fields.map(({ key, label, placeholder, optional, long }) => (
        <label key={`${kind}-${key}`}>
          {label}
          {long ? (
            <textarea
              rows={4}
              value={fields[key] ?? ''}
              placeholder={placeholder}
              onChange={({ target }) => setFields({ ...fields, [key]: target.value })}
            />
          ) : (
            <input
              value={fields[key] ?? ''}
              required={!optional}
              placeholder={placeholder}
              autoComplete="off"
              onChange={({ target }) => setFields({ ...fields, [key]: target.value })}
            />
          )}
        </label>
      ))}
      {kind === 'webhook' && (
        <small className="muted">
          {
            '{{title}}、{{text}}、{{url}} 换成标题、内容和会话链接。有请求体时以 JSON 发送 POST，没有时对地址发 GET。'
          }
        </small>
      )}
      <small className="muted">保存后不再显示这些内容；要修改，删除后重新添加。</small>
    </DialogForm>
  );
}
