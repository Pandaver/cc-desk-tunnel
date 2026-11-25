import { useEffect, useState } from 'react';
import type { ProxyClient } from './client.ts';
import { Modal } from './ui.tsx';

export default function PluginLog({
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
  const read = (clear?: true) =>
    client.fetch({ type: 'plugin.log', name, ...(clear ? { clear } : {}) }).then(
      (reply) => setText(reply.text),
      (error: Error) => setText(error.message),
    );
  useEffect(() => void read(), []);
  // A record is its line, which begins with when it was, and the indented ones under it.
  const records = (text ?? '')
    .split(/\n(?! {4})/)
    .filter(Boolean)
    .map((record) =>
      record.replace(/^\S+Z(?= )/, (at) => new Date(at).toLocaleString('zh-CN', { hour12: false })),
    );
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
