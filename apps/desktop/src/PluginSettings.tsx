import { useState } from 'react';
import type { ReactNode } from 'react';
import { shownWhen } from '@cc-desk-tunnel/protocol';
import type {
  Plugin,
  PluginField,
  PluginGroup,
  PluginValue,
  PluginValues,
} from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Modal, Row, SettingText, Switch } from './ui.tsx';

type Draft = Record<string, PluginValue | null>;
type Done = { ok: boolean; message: string };
const eventNames: Record<string, string> = {
  ApprovalRequested: '等待审批',
  QuestionAsked: '等待回答',
  TerminalWaiting: '终端等待确认',
  WaitResolved: '等待已解除',
  BackgroundOnly: '只剩后台任务',
  RunError: '运行出错',
  RunEnded: '一轮结束',
  DeviceOnline: '设备上线',
  DeviceOffline: '设备下线',
};
const failed = (error: unknown): Done => ({
  ok: false,
  message: error instanceof Error ? error.message : '操作失败。',
});

// The service's plugins: each with its switch, the settings it declares, and what any of them has besides: a try of
// an event and its log. The plugin's own code runs at the service; here is only what it declares.
export default function PluginSettings({
  client,
  plugins,
}: {
  client: ProxyClient;
  plugins: Plugin[];
}) {
  if (!plugins.length)
    return (
      <div className="settings-list card">
        <p className="muted plugin-empty">
          还没有插件。插件是服务端数据目录 plugins 下的一个目录，放进去就会出现在这里。
        </p>
      </div>
    );
  return plugins.map((plugin) => <PluginCard key={plugin.name} client={client} plugin={plugin} />);
}

function PluginCard({ client, plugin }: { client: ProxyClient; plugin: Plugin }) {
  // What was changed and is not saved.
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>();
  const [results, setResults] = useState<Record<string, Done | 'running'>>({});
  const [logging, setLogging] = useState(false);
  const [busy, setBusy] = useState(false);
  const { name } = plugin;
  const title = plugin.title ?? name;
  const value = (key: string) =>
    draft[key] === undefined ? (plugin.values[key] ?? '') : (draft[key] ?? '');
  const values: PluginValues = { ...plugin.values };
  for (const key of Object.keys(draft)) values[key] = value(key);

  async function act(key: string, work: () => Promise<Done | undefined>) {
    setResults((all) => ({ ...all, [key]: 'running' }));
    const done = await work().catch(failed);
    setResults(({ [key]: _, ...rest }) => (done ? { ...rest, [key]: done } : rest));
  }
  // Leaving a field checks what was changed; saving checks and keeps all of it.
  async function configure(save: boolean) {
    if (save) setBusy(true);
    try {
      const reply = await client.fetch({ type: 'plugin.configure', name, values: draft, save });
      setNotice(reply.notice);
      setErrors(
        save
          ? reply.errors
          : Object.fromEntries(Object.entries(reply.errors).filter(([key]) => key in draft)),
      );
      if (reply.saved) setDraft({});
    } catch (error) {
      setNotice(failed(error).message);
    } finally {
      if (save) setBusy(false);
    }
  }
  const set = (key: string, next: PluginValue | null) => {
    setDraft((all) => ({ ...all, [key]: next }));
    setResults(({ save: _, ...rest }) => rest);
  };
  function press(key: string, field: Extract<PluginField, { type: 'button' }>) {
    if (field.confirm && !window.confirm(field.confirm)) return;
    void act(key, () => client.fetch({ type: 'plugin.press', name, button: key, values: draft }));
  }

  function field(key: string, item: PluginField) {
    const error = errors[key] && <small className="error-text">{errors[key]}</small>;
    if (item.type === 'button')
      return (
        <Row key={key} title={item.title} detail={item.description}>
          <span className="plugin-action">
            <Result done={results[key]} />
            <button
              type="button"
              className="button"
              disabled={results[key] === 'running'}
              onClick={() => press(key, item)}
            >
              {item.title}
            </button>
          </span>
        </Row>
      );
    if (item.type === 'boolean')
      return (
        <Row key={key} title={item.title} detail={item.description}>
          <Switch
            label={item.title}
            checked={!!value(key)}
            onChange={(checked) => set(key, checked)}
          />
        </Row>
      );
    const text = (
      <span>
        <SettingText title={item.title} detail={item.description} />
        {error}
      </span>
    );
    const common = {
      'aria-label': item.title,
      'aria-invalid': !!errors[key],
      value: String(value(key)),
      onBlur: () => key in draft && void configure(false),
    };
    if (item.type === 'number')
      return (
        <label key={key}>
          {text}
          <input
            {...common}
            type="number"
            min={item.min}
            max={item.max}
            step="any"
            onChange={({ target }) => set(key, target.value === '' ? null : Number(target.value))}
          />
        </label>
      );
    if (item.options)
      return (
        <label key={key}>
          {text}
          <select {...common} onChange={({ target }) => set(key, target.value)}>
            {!item.options.includes(String(value(key))) && <option value="" />}
            {item.options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </label>
      );
    if (item.multiline)
      return (
        <label key={key} className="plugin-text">
          {text}
          <textarea {...common} rows={5} onChange={({ target }) => set(key, target.value)} />
        </label>
      );
    const kept = !!item.sensitive && plugin.secrets.includes(key) && draft[key] === undefined;
    return (
      <label key={key} className="plugin-text">
        {text}
        <span className="plugin-action">
          <input
            {...common}
            type={item.sensitive ? 'password' : 'text'}
            autoComplete="off"
            placeholder={kept ? '已设置，留空沿用' : undefined}
            onChange={({ target }) => set(key, target.value)}
          />
          {kept && (
            <button type="button" className="button" onClick={() => set(key, null)}>
              清除
            </button>
          )}
        </span>
      </label>
    );
  }
  function group(item: PluginGroup) {
    const whole = shownWhen(item.showWhen, values);
    const switches = [item.showWhen ?? []].flat();
    const shown = Object.entries(item.fields).filter(([key]) => whole || switches.includes(key));
    if (!shown.length) return null;
    return (
      <div key={item.title} role="group" aria-label={item.title}>
        <h3 className="plugin-group">{item.title}</h3>
        {shown.map(([key, entry]) => field(key, entry))}
      </div>
    );
  }
  const status = !plugin.enabled
    ? '已停用'
    : (plugin.problem ??
      (plugin.failure
        ? `最近一次失败（${new Date(plugin.failure.at).toLocaleString('zh-CN')}）：${plugin.failure.message}`
        : '正常'));
  return (
    <>
      <section className="settings-list card plugin-card" aria-label={title}>
        <Row
          title={plugin.version ? `${title} ${plugin.version}` : title}
          detail={
            <>
              {plugin.description}
              <span
                className={plugin.problem || plugin.failure ? 'plugin-status bad' : 'plugin-status'}
              >
                {status}
              </span>
            </>
          }
        >
          <Switch
            label={`启用 ${title}`}
            checked={plugin.enabled}
            onChange={(enabled) =>
              void act('enable', async () => {
                await client.request({ type: 'plugin.enable', name, enabled });
                setDraft({});
                return undefined;
              })
            }
          />
        </Row>
        {plugin.settings.map(group)}
        {notice && (
          <p className="plugin-notice" role="alert">
            {notice}
          </p>
        )}
        <div className="plugin-foot">
          {plugin.enabled && plugin.events.length > 0 && (
            <Try
              events={plugin.events}
              running={results.try === 'running'}
              run={(event) =>
                void act('try', () => client.fetch({ type: 'plugin.try', name, event }))
              }
            />
          )}
          <button type="button" className="button" onClick={() => setLogging(true)}>
            日志
          </button>
          {plugin.settings.length > 0 && (
            <button
              type="button"
              className="button primary"
              disabled={busy || !Object.keys(draft).length}
              onClick={() => void configure(true)}
            >
              保存
            </button>
          )}
        </div>
        <Result done={results.try} block />
        <Result done={results.enable} block />
      </section>
      {logging && <Log client={client} name={name} title={title} close={() => setLogging(false)} />}
    </>
  );
}

function Result({ done, block = false }: { done?: Done | 'running'; block?: boolean }): ReactNode {
  if (!done) return null;
  if (done === 'running') return <span className="muted">正在运行…</span>;
  const className = done.ok ? 'plugin-result' : 'plugin-result bad';
  const text = done.message || (done.ok ? '成功' : '失败');
  return block ? (
    <pre className={className} role="status">
      {text}
    </pre>
  ) : (
    <span className={className} role="status">
      {text}
    </span>
  );
}

function Try({
  events,
  running,
  run,
}: {
  events: string[];
  running: boolean;
  run: (event: string) => void;
}) {
  const [chosen, setChosen] = useState(events[0]!);
  const event = events.includes(chosen) ? chosen : events[0]!;
  return (
    <span className="plugin-try">
      <select
        aria-label="试跑的事件"
        value={event}
        onChange={({ target }) => setChosen(target.value)}
      >
        {events.map((item) => (
          <option key={item} value={item}>
            {eventNames[item] ?? item}
          </option>
        ))}
      </select>
      <button type="button" className="button" disabled={running} onClick={() => run(event)}>
        试跑
      </button>
    </span>
  );
}

function Log({
  client,
  name,
  title,
  close,
}: {
  client: ProxyClient;
  name: string;
  title: string;
  close: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [asked, setAsked] = useState(false);
  const read = (clear?: true) =>
    client
      .fetch({ type: 'plugin.log', name, ...(clear ? { clear } : {}) })
      .then((reply) => setText(reply.text))
      .catch((error) => setText(failed(error).message));
  if (!asked) {
    setAsked(true);
    void read();
  }
  // A record is its line and the indented ones under it.
  const records = (text ?? '').split(/\n(?! {4})/).filter(Boolean);
  const shown = records.filter(
    (record) =>
      !onlyFailures || /→ (退出|超时|没有启动)|失败|没有运行/.test(record.split('\n')[0]!),
  );
  return (
    <Modal title={`${title}：日志`} onClose={close}>
      <pre className="plugin-log">
        {text === null ? '正在读取…' : shown.join('\n') || '没有记录'}
      </pre>
      <div className="plugin-foot">
        <label className="plugin-only">
          <input
            type="checkbox"
            checked={onlyFailures}
            onChange={({ target }) => setOnlyFailures(target.checked)}
          />
          只看失败
        </label>
        <button
          type="button"
          className="button"
          onClick={() => void navigator.clipboard.writeText(shown.join('\n'))}
        >
          复制
        </button>
        <button type="button" className="button" onClick={() => void read(true)}>
          清空
        </button>
      </div>
    </Modal>
  );
}
