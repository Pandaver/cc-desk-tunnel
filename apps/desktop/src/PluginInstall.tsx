import { useRef, useState } from 'react';
import { PLUGIN_ARCHIVE_LIMIT, PLUGIN_PART_BYTES } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Modal } from './ui.tsx';

type Archive = Extract<ServerMessage, { type: 'plugin.archive' }>;
const said = (error: unknown) => (error instanceof Error ? error.message : '操作失败。');
const base64 = (bytes: Uint8Array) => {
  let text = '';
  for (let at = 0; at < bytes.length; at += 8192)
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
};

// Installs a plugin from a zip archive: the service says what is in it, without running any of it, and it is put in
// place once the user agrees.
export default function PluginInstall({ client }: { client: ProxyClient }) {
  const input = useRef<HTMLInputElement>(null);
  const [found, setFound] = useState<(Archive & { uploadId: string }) | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setFailure(null);
    setBusy(true);
    try {
      if (file.size > PLUGIN_ARCHIVE_LIMIT) throw new Error('压缩包超过 5 MB。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const uploadId = crypto.randomUUID();
      const send = (at: number, last: boolean) => ({
        type: 'plugin.upload' as const,
        uploadId,
        data: base64(bytes.subarray(at, at + PLUGIN_PART_BYTES)),
        last,
      });
      let at = 0;
      for (; at + PLUGIN_PART_BYTES < bytes.length; at += PLUGIN_PART_BYTES)
        await client.request(send(at, false));
      setFound({ ...(await client.fetch(send(at, true))), uploadId });
    } catch (error) {
      setFailure(said(error));
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    setBusy(true);
    try {
      const done = await client.fetch({ type: 'plugin.install', uploadId: found!.uploadId });
      if (!done.ok) setFailure(done.message);
    } catch (error) {
      setFailure(said(error));
    } finally {
      setBusy(false);
      setFound(null);
    }
  }
  return (
    <>
      <div className="plugin-install">
        <input
          ref={input}
          type="file"
          accept=".zip"
          aria-label="插件压缩包"
          hidden
          onChange={({ target }) => {
            const file = target.files?.[0];
            target.value = '';
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => input.current!.click()}
        >
          从压缩包安装…
        </button>
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
      </div>
      {found && (
        <Modal
          title={`${found.replaces ? '更新' : '安装'}“${found.manifest.displayName ?? found.manifest.name}”`}
          onClose={() => setFound(null)}
        >
          {found.manifest.description && <p>{found.manifest.description}</p>}
          <dl className="plugin-facts">
            <dt>版本</dt>
            <dd>
              {found.replaces && `${found.replaces.version ?? '未写明'} → `}
              {found.manifest.version ?? '未写明'}
              {found.replaces && '，设置和数据保留'}
            </dd>
            <dt>订阅的事件</dt>
            <dd>{found.events.join('、') || '无'}</dd>
            <dt>会运行的命令</dt>
            <dd>
              {found.commands.map((command) => (
                <code key={command}>{command}</code>
              ))}
            </dd>
            <dt>文件</dt>
            <dd>{found.files} 个</dd>
          </dl>
          <p className="plugin-notice">
            插件以服务端的身份运行，能读到服务端上的凭据，也能经它在你的电脑上执行命令。只安装信得过的。
          </p>
          <div className="plugin-foot">
            <button type="button" className="button" onClick={() => setFound(null)}>
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void install()}
            >
              {found.replaces ? '更新' : '安装'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
