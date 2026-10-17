import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { RelayStatus } from './desktop.d.ts';
import { IconButton, Switch } from './ui.tsx';

const descriptions: Record<RelayStatus['state'], string> = {
  disabled: '使用本连接的代理服务。',
  connecting: '正在连接服务端…',
  online: '已连接，关闭桌面业务连接仍可访问。',
  offline: '连接已断开，正在重连…',
  error: '中继连接失败。',
};

export default function RelayControl({
  enabled,
  disabled,
  prepare,
}: {
  enabled: boolean;
  disabled: boolean;
  prepare: () => Promise<void>;
}) {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState('');
  const latest = useRef<RelayStatus | null>(null);
  const requested = useRef(false);
  const revision = useRef(0);
  const pending = useRef(0);
  const tasks = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const adopt = (value: RelayStatus) => {
    latest.current = value;
    if (!mounted.current) return;
    setStatus(value);
    if (!pending.current) {
      requested.current = value.enabled;
      setChecked(value.enabled);
    }
  };
  useEffect(() => {
    if (!window.desktop?.relayStatus) return;
    mounted.current = true;
    const initial = revision.current;
    const unsubscribe = window.desktop.onRelayChanged?.((value) => {
      revision.current++;
      adopt(value);
    });
    void window.desktop.relayStatus().then(
      (value) => {
        if (initial === revision.current) adopt(value);
      },
      (reason: unknown) => {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : '中继状态读取失败。');
      },
    );
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, []);
  if (!window.desktop?.configureRelay) return null;
  const enqueue = (operation: () => Promise<void>) => {
    pending.current++;
    setSaving(pending.current);
    setError('');
    const result = tasks.current.then(async () => {
      if (mounted.current) setError('');
      await operation();
    });
    tasks.current = result.catch(() => {});
    void result
      .catch((reason: unknown) => {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : '中继设置保存失败，请重试。');
      })
      .finally(() => {
        pending.current--;
        if (mounted.current) {
          setSaving(pending.current);
          if (!pending.current && latest.current) {
            requested.current = latest.current.enabled;
            setChecked(latest.current.enabled);
          }
        }
      });
  };
  const toggle = () => {
    if (!status) return;
    const next = !requested.current;
    requested.current = next;
    setChecked(next);
    enqueue(async () => {
      // Disabling must still work when the local port field has an invalid, unsaved draft.
      if (next) await prepare();
      const initial = revision.current;
      const value = await window.desktop!.configureRelay!(next);
      if (initial === revision.current) adopt(value);
    });
  };
  const open = () => {
    enqueue(async () => {
      await prepare();
      await window.desktop!.openRelay!();
    });
  };
  return (
    <>
      <div className="setting-row" aria-busy={saving > 0}>
        <span>
          <strong>通过服务端访问</strong>
          <small aria-live="polite">
            {!enabled ? '先启用 Web 工作台。' : descriptions[status?.state ?? 'disabled']}
          </small>
        </span>
        <Switch
          label="通过服务端访问"
          checked={checked}
          disabled={disabled || !enabled || !status}
          onChange={toggle}
        />
      </div>
      {enabled && status?.state === 'online' && status.url && (
        <div className="setting-row relay-address-row">
          <span>
            <strong>服务端访问地址</strong>
          </span>
          <span className="remote-address">
            <span className="remote-address-text">{status.url}</span>
            <IconButton title="打开服务端链接" disabled={disabled} onClick={open}>
              <ExternalLink />
            </IconButton>
          </span>
        </div>
      )}
      {(error || status?.error) && (
        <p className="remote-error" role="alert">
          {error || status?.error}
        </p>
      )}
    </>
  );
}
