import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushSettingsSchema } from '@cc-desk-tunnel/protocol';
import type {
  EventPayload,
  PushChannel,
  PushChannelConfig,
  PushKind,
  PushOptions,
  PushSettings,
  PushState,
  Session,
} from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';

export const PUSH: PushSettings = {
  enabled: false,
  events: { approval: true, question: true, done: true, failed: true },
  defaultMode: 'off',
  fallback: false,
  delayMinutes: 0,
  channels: [],
};

const file = (directory: string) => join(directory, 'push.json');

// The service's own setting, kept with its sessions; it holds the channels' secrets, so only the service reads it.
// A file it cannot read is the defaults.
export function readPush(directory: string): PushSettings {
  try {
    return pushSettingsSchema.parse({
      ...PUSH,
      ...JSON.parse(readFileSync(file(directory), 'utf8')),
    });
  } catch {
    return structuredClone(PUSH);
  }
}
function writePush(directory: string, settings: PushSettings) {
  const next = pushSettingsSchema.parse(settings);
  writeFileSync(`${file(directory)}.new`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file(directory)}.new`, file(directory));
  return next;
}

export type PushMessage = { title: string; text: string; url?: string };

const headings: Record<PushKind, string> = {
  approval: '等待审批',
  question: 'Claude 有问题要问你',
  done: '任务完成',
  failed: '任务失败',
};
const markdown = ({ title, text, url }: PushMessage) =>
  [`**${title}**`, ...text.split('\n'), ...(url ? [`[打开会话](${url})`] : [])].join('\n\n');
const html = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const json = (url: string, body: unknown) => ({
  url,
  init: {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  },
});

// The request each service takes, as its documentation has it. The link to the session is the text 打开会话 where
// the service shows links, and never its address written out.
export function pushRequest(
  config: PushChannelConfig,
  message: PushMessage,
  now = Date.now(),
): { url: string; init: RequestInit } {
  const { title, text, url: link } = message;
  switch (config.kind) {
    case 'dingtalk': {
      const url = new URL(config.url);
      if (config.secret) {
        url.searchParams.set('timestamp', String(now));
        url.searchParams.set(
          'sign',
          createHmac('sha256', config.secret).update(`${now}\n${config.secret}`).digest('base64'),
        );
      }
      return json(url.toString(), {
        msgtype: 'markdown',
        markdown: { title, text: markdown(message) },
      });
    }
    case 'feishu': {
      // Feishu signs with the timestamp and secret as the key, over nothing.
      const timestamp = String(Math.floor(now / 1000));
      const sign = config.secret
        ? {
            timestamp,
            sign: createHmac('sha256', `${timestamp}\n${config.secret}`).digest('base64'),
          }
        : {};
      const content = [
        ...text.split('\n').map((line) => [{ tag: 'text', text: line }]),
        ...(link ? [[{ tag: 'a', text: '打开会话', href: link }]] : []),
      ];
      return json(config.url, {
        ...sign,
        msg_type: 'post',
        content: { post: { zh_cn: { title, content } } },
      });
    }
    case 'wecom':
      return json(config.url, { msgtype: 'markdown', markdown: { content: markdown(message) } });
    case 'telegram':
      return json(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        chat_id: config.chatId,
        parse_mode: 'HTML',
        text: [
          `<b>${html(title)}</b>`,
          html(text),
          ...(link ? [`<a href="${html(link)}">打开会话</a>`] : []),
        ].join('\n'),
      });
    case 'bark':
      return json(config.url, {
        title,
        body: text,
        group: 'CC Desk Tunnel',
        ...(link ? { url: link } : {}),
      });
    case 'webhook': {
      const fill = (template: string, encode: (value: string) => string) =>
        template.replace(/\{\{(title|text|url)\}\}/g, (_, key: keyof PushMessage) =>
          encode(message[key] ?? ''),
        );
      const url = fill(config.url, encodeURIComponent);
      if (!config.body.trim()) return { url, init: { method: 'GET' } };
      // Filled in as JSON strings are written, so that the body stays the JSON it was.
      const body = fill(config.body, (value) => JSON.stringify(value).slice(1, -1));
      return {
        url,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      };
    }
  }
}

// The robots answer a refused message with HTTP 200 and a code of their own in the body.
async function deliver(config: PushChannelConfig, message: PushMessage) {
  const { url, init } = pushRequest(config, message);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    // The error of a failed fetch names no address, which may hold a key, but its cause says why.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(cause?.code ?? cause?.message ?? (error as Error).message);
  }
  const body = await response.text();
  let reply: { errcode?: number; errmsg?: string; code?: number; msg?: string } | undefined;
  try {
    reply = JSON.parse(body);
  } catch {
    reply = undefined;
  }
  const refused =
    config.kind === 'dingtalk' || config.kind === 'wecom'
      ? reply?.errcode !== 0
      : config.kind === 'feishu' && reply?.code !== 0;
  if (!response.ok || refused)
    throw new Error(
      `${response.ok ? '' : `HTTP ${response.status} `}${reply?.errmsg ?? reply?.msg ?? body.slice(0, 200)}`.trim(),
    );
}

type Hooks = {
  session: (sessionId: string) => Session | undefined;
  // Where a browser opens the session, while the service serves browsers.
  link: (sessionId: string) => string | undefined;
  // A turn ended that a `once` subscription was for; the session is sent on with its run's status.
  ended: (sessionId: string) => void;
  changed: (state: PushState) => void;
  deliver?: typeof deliver;
};

// Watches the runs of the chat for what a user away from every window would want to know — a turn ended, or it waits for
// an answer — and sends it to every channel switched on: for a session subscribed to, at once; for the others, only
// approvals and questions, if the setting asks, and after the delay it sets if no window answered them by then.
export class Pushes {
  settings: PushSettings;
  private failures = new Map<string, { at: string; message: string }>();
  // The last error each session's run reported, which its failure says.
  private errors = new Map<string, string>();
  private waits = new Map<string, NodeJS.Timeout>();
  private directory: string;
  private hooks: Hooks;
  constructor(directory: string, hooks: Hooks) {
    this.directory = directory;
    this.hooks = hooks;
    this.settings = readPush(directory);
  }

  state(): PushState {
    const { channels, ...options } = this.settings;
    return {
      ...options,
      channels: channels.map(({ id, name, enabled, config }) => ({
        id,
        name,
        kind: config.kind,
        enabled,
        ...(this.failures.has(id) ? { failure: this.failures.get(id) } : {}),
      })),
    };
  }
  update(values: Partial<PushOptions>) {
    return this.save({ ...this.settings, ...values });
  }
  add(name: string, config: PushChannelConfig) {
    return this.save({
      ...this.settings,
      channels: [...this.settings.channels, { id: randomUUID(), name, enabled: true, config }],
    });
  }
  enable(channelId: string, enabled: boolean) {
    this.channel(channelId);
    return this.save({
      ...this.settings,
      channels: this.settings.channels.map((channel) =>
        channel.id === channelId ? { ...channel, enabled } : channel,
      ),
    });
  }
  remove(channelId: string) {
    this.failures.delete(channelId);
    return this.save({
      ...this.settings,
      channels: this.settings.channels.filter((channel) => channel.id !== channelId),
    });
  }
  // Sends whether or not pushes or the channel are switched on, and says why it failed.
  async test(channelId: string) {
    const failure = await this.send(this.channel(channelId), {
      title: '【测试推送】CC Desk Tunnel',
      text: '推送渠道工作正常。',
    });
    if (failure) throw new DomainError('push_failed', `发送失败：${failure}`);
  }

  // Each payload a chat run emits, once it is recorded; `before` is the session's run as it was before it.
  observe(sessionId: string, payload: EventPayload, before: Session['activeRun']) {
    if (payload.type === 'run.error') this.errors.set(sessionId, payload.message);
    if (payload.type === 'approval.resolved') this.unwait(sessionId);
    if (payload.type !== 'run.status') return;
    this.unwait(sessionId);
    const session = this.hooks.session(sessionId);
    if (!session) return;
    const terminal = payload.status !== 'running' && payload.status !== 'awaiting_approval';
    // Claude's turn is over once only background tasks go on; their ending without another turn is no news.
    const background = before?.waiting === 'background';
    const ended = (terminal && !background) || (payload.waiting === 'background' && !background);
    const kind: PushKind | undefined =
      payload.status === 'awaiting_approval'
        ? payload.waiting === 'question'
          ? 'question'
          : 'approval'
        : !ended || payload.status === 'cancelled'
          ? undefined
          : payload.status === 'failed'
            ? 'failed'
            : 'done';
    if (kind && session.push) this.push(session, kind);
    else if ((kind === 'approval' || kind === 'question') && this.settings.fallback) {
      if (!this.settings.delayMinutes) this.push(session, kind);
      else {
        const wait = setTimeout(() => {
          this.waits.delete(sessionId);
          const now = this.hooks.session(sessionId);
          if (now?.activeRun?.status === 'awaiting_approval') this.push(now, kind);
        }, this.settings.delayMinutes * 60_000);
        wait.unref();
        this.waits.set(sessionId, wait);
      }
    }
    if (terminal) this.errors.delete(sessionId);
    if (ended && session.push === 'once') this.hooks.ended(sessionId);
  }
  close() {
    for (const wait of this.waits.values()) clearTimeout(wait);
    this.waits.clear();
  }

  private push(session: Session, kind: PushKind) {
    if (!this.settings.enabled || !this.settings.events[kind]) return;
    const error = kind === 'failed' ? this.errors.get(session.id) : undefined;
    const message: PushMessage = {
      title: `【${headings[kind]}】${session.title}`,
      text: [
        `设备：${session.device?.name ?? '未知设备'}`,
        ...(error ? [`错误：${error}`] : []),
      ].join('\n'),
      url: this.hooks.link(session.id),
    };
    for (const channel of this.settings.channels)
      if (channel.enabled) void this.send(channel, message);
  }
  // The reason it failed, or nothing once it was sent. Only a change of the failures is told to the windows.
  private async send(channel: PushChannel, message: PushMessage) {
    try {
      await (this.hooks.deliver ?? deliver)(channel.config, message);
      if (this.failures.delete(channel.id)) this.hooks.changed(this.state());
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Push to "${channel.name}" failed: ${reason}`);
      this.failures.set(channel.id, { at: new Date().toISOString(), message: reason });
      this.hooks.changed(this.state());
      return reason;
    }
  }
  private channel(channelId: string) {
    const channel = this.settings.channels.find((item) => item.id === channelId);
    if (!channel) throw new DomainError('not_found', '推送渠道不存在。');
    return channel;
  }
  private unwait(sessionId: string) {
    clearTimeout(this.waits.get(sessionId));
    this.waits.delete(sessionId);
  }
  private save(settings: PushSettings) {
    this.settings = writePush(this.directory, settings);
    return this.state();
  }
}
