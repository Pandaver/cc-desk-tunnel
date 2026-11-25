import { useState } from 'react';
import { ChevronRight, ScrollText, Trash2 } from 'lucide-react';
import { COMPOSER_SLOTS } from '@cc-desk-tunnel/protocol';
import type { Plugin } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import PluginInstall from './PluginInstall.tsx';
import PluginLog from './PluginLog.tsx';
import PluginPage, { titleOf, troubleOf } from './PluginPage.tsx';
import { IconButton, Page, Switch } from './ui.tsx';

// The service's plugins, each opening a page of its own.
export default function PluginSettings({
  client,
  plugins,
  shown,
  open,
  browser,
}: {
  client: ProxyClient;
  plugins: Plugin[];
  shown?: string;
  open: (name: string | undefined) => void;
  // Where plugins are set but neither installed nor removed.
  browser: boolean;
}) {
  const [failure, setFailure] = useState<{ name: string; message: string }>();
  const [logging, setLogging] = useState<Plugin>();
  const plugin = plugins.find(({ name }) => name === shown);
  const act = async (name: string, work: Promise<unknown>) => {
    setFailure(undefined);
    try {
      await work;
    } catch (error) {
      setFailure({ name, message: error instanceof Error ? error.message : '操作失败。' });
    }
  };
  const enable = (name: string, enabled: boolean) =>
    void act(name, client.request({ type: 'plugin.enable', name, enabled }));
  if (plugin)
    return (
      <PluginPage
        key={plugin.name}
        client={client}
        plugin={plugin}
        enable={(enabled) => enable(plugin.name, enabled)}
        failure={failure?.name === plugin.name ? failure.message : undefined}
        back={() => open(undefined)}
      />
    );
  return (
    <Page
      title="插件"
      intro={
        <>
          保存在服务端，对所有连接到它的设备生效。
          <span className="plugin-tags">
            <span className="badge" title={`输入框旁的插件按钮，最多同时 ${COMPOSER_SLOTS} 个`}>
              输入框插槽 {plugins.filter(({ composerSlot }) => composerSlot).length}/
              {COMPOSER_SLOTS}
            </span>
          </span>
        </>
      }
      actions={
        !browser && (
          <PluginInstall
            client={client}
            failed={(message) => setFailure(message ? { name: '', message } : undefined)}
          />
        )
      }
    >
      {/* What its row says already is not said twice. */}
      {failure && !plugins.some(({ problem }) => problem === failure.message) && (
        <p className="error-text" role="alert">
          {failure.message}
        </p>
      )}
      <div className="settings-list card">
        {!plugins.length && (
          <p className="muted plugin-empty">
            还没有插件。插件也可以直接放进服务端数据目录的 plugins，放进去就会出现在这里。
          </p>
        )}
        {plugins.map((item) => {
          const title = titleOf(item);
          const trouble = troubleOf(item);
          return (
            <div className="setting-row plugin-row" key={item.name}>
              <button type="button" className="plugin-open" onClick={() => open(item.name)}>
                <strong>
                  {title}
                  {trouble && <i className="badge plugin-badge">{trouble.word}</i>}
                  <ChevronRight />
                </strong>
                {item.description && <small>{item.description}</small>}
                {trouble && <small className="plugin-trouble">{trouble.text}</small>}
              </button>
              <span className="plugin-controls">
                <IconButton title={`${title}：日志`} onClick={() => setLogging(item)}>
                  <ScrollText />
                </IconButton>
                {!browser && (
                  <IconButton
                    title={`删除 ${title}`}
                    onClick={() =>
                      window.confirm(`删除“${title}”，连同它的设置、数据和日志？`) &&
                      void act(
                        item.name,
                        client.request({ type: 'plugin.remove', name: item.name }),
                      )
                    }
                  >
                    <Trash2 />
                  </IconButton>
                )}
                <Switch
                  label={`启用 ${title}`}
                  checked={item.enabled}
                  onChange={(enabled) => enable(item.name, enabled)}
                />
              </span>
            </div>
          );
        })}
      </div>
      {logging && (
        <PluginLog
          client={client}
          name={logging.name}
          title={titleOf(logging)}
          close={() => setLogging(undefined)}
        />
      )}
    </Page>
  );
}
