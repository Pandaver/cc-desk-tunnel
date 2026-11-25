import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { pluginNameSchema } from '@cc-desk-tunnel/protocol';
import type { Plugin, PluginValue, PluginValues } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { eventExample } from './event-examples.ts';
import { readPluginConfig, writePluginConfig } from './plugin-config.ts';
import type { PluginConfig } from './plugin-config.ts';
import { masked, PluginLog } from './plugin-log.ts';
import { stop } from './plugin-process.ts';
import { askButton, askCheck, checkValues, fieldsOf, loadUi, NOTHING } from './plugin-ui.ts';
import type { Declared } from './plugin-ui.ts';
import { matcherFields } from './service-events.ts';
import type { ServiceEvent } from './service-events.ts';

// The structure of a Claude Code plugin's hooks/hooks.json, of which only command hooks are run.
const hookSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeout: z.number().positive().max(600).default(60),
});
const hooksFileSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(z.object({ matcher: z.string().optional(), hooks: z.array(hookSchema) })),
  ),
});
type Hook = z.infer<typeof hookSchema>;
const manifestSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  version: z.string().max(60).optional(),
});
// What is known of a plugin, read anew whenever its directory changes.
type Entry = {
  manifest: z.infer<typeof manifestSchema>;
  config: PluginConfig;
  declared: Declared;
  events: string[];
  broken?: string;
  failure?: { at: string; message: string };
};

// How much of what a command printed is kept, and how long changes in the directory are gathered.
const OUTPUT_LIMIT = 8192;
const SETTLE_MS = 300;

// As Claude Code reads a matcher: names when it holds nothing but them, otherwise a regular expression.
export function matches(matcher: string | undefined, value: unknown) {
  if (!matcher || matcher === '*' || value === undefined) return true;
  if (/^[\w\- ,|]+$/.test(matcher))
    return matcher.split(/[|,]/).some((name) => name.trim() === value);
  return new RegExp(matcher).test(String(value));
}
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The plugins in <data>/plugins, each a directory with a hooks/hooks.json and, for its settings, a ui file (see
// docs/plugins.md): hands them the service's events and keeps what they are set to. The directory is watched, so a
// change there holds a moment later. A plugin's code runs in processes of its own, and how they went goes to its log.
export class Plugins {
  private directory: string;
  private changed: () => void;
  private log: PluginLog;
  private entries = new Map<string, Entry>();
  private running = new Set<ChildProcess>();
  private pressed = new Set<string>();
  private watcher?: FSWatcher;
  private settle?: NodeJS.Timeout;
  private stale = new Set<string>();
  private loading: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(directory: string, changed: () => void = () => {}) {
    this.directory = directory;
    this.changed = changed;
    this.log = new PluginLog(directory);
  }
  async start() {
    const plugins = join(this.directory, 'plugins');
    mkdirSync(plugins, { recursive: true, mode: 0o700 });
    this.watcher = watch(plugins, { recursive: true }, (_event, file) => {
      if (file) this.stale.add(String(file).split(/[\\/]/)[0]!);
      clearTimeout(this.settle);
      this.settle = setTimeout(() => void this.refresh(), SETTLE_MS);
    });
    // Left unwatched, as where the system has no watch to spare, a plugin is read when the service starts.
    this.watcher.on('error', (error) => console.error(`Plugins are not watched: ${error.message}`));
    await this.refresh();
  }
  close() {
    this.closed = true;
    this.watcher?.close();
    clearTimeout(this.settle);
    for (const child of this.running) stop(child);
  }
  // Whether an event reaches anyone.
  any() {
    return !this.closed && this.entries.size > 0;
  }
  list(): Plugin[] {
    return [...this.entries].map(([name, entry]) => {
      const fields = fieldsOf(entry.declared.settings);
      const values = this.values(entry);
      const secret = (key: string) => {
        const field = fields[key];
        return field?.type === 'string' && !!field.sensitive;
      };
      return {
        name,
        title: entry.manifest.displayName,
        description: entry.manifest.description,
        version: entry.manifest.version,
        enabled: entry.config.enabled,
        problem: entry.config.enabled ? this.problem(entry) : undefined,
        failure: entry.failure,
        events: entry.events,
        settings: entry.declared.settings,
        values: Object.fromEntries(Object.entries(values).filter(([key]) => !secret(key))),
        secrets: Object.keys(values).filter((key) => secret(key) && values[key] !== ''),
      };
    });
  }

  // Reads the plugins whose files changed, one read after another.
  private refresh() {
    const read = async () => {
      const plugins = join(this.directory, 'plugins');
      const names = readdirSync(plugins).filter(
        (name) =>
          pluginNameSchema.safeParse(name).success &&
          existsSync(join(plugins, name, 'hooks', 'hooks.json')),
      );
      const stale = new Set(this.stale);
      this.stale.clear();
      const entries = new Map<string, Entry>();
      for (const name of names.sort()) {
        const known = this.entries.get(name);
        entries.set(name, known && !stale.has(name) ? known : await this.load(name));
      }
      if (this.closed) return;
      this.entries = entries;
      this.changed();
    };
    this.loading = this.loading
      .then(read)
      .catch((error) => console.error(`Plugins were not read: ${reason(error)}`));
    return this.loading;
  }
  private async load(name: string): Promise<Entry> {
    const root = join(this.directory, 'plugins', name);
    const entry: Entry = {
      manifest: {},
      config: readPluginConfig(this.directory, name),
      declared: NOTHING,
      events: [],
      failure: this.entries.get(name)?.failure,
    };
    try {
      const manifest = join(root, '.claude-plugin', 'plugin.json');
      if (existsSync(manifest))
        entry.manifest = manifestSchema.parse(JSON.parse(readFileSync(manifest, 'utf8')));
      entry.events = Object.keys(this.hooks(name)).filter((event) => eventExample(event));
      // A disabled plugin's code does not run, and so it has nothing to be set.
      if (entry.config.enabled) entry.declared = await loadUi(root);
    } catch (error) {
      entry.broken = `加载失败：${reason(error)}`;
      this.log.write(name, entry.broken);
    }
    return entry;
  }
  private hooks(name: string) {
    const path = join(this.directory, 'plugins', name, 'hooks', 'hooks.json');
    return hooksFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).hooks;
  }
  private entry(name: string) {
    const entry = this.entries.get(name);
    if (!entry) throw new DomainError('not_found', '插件不存在。');
    return entry;
  }
  // What the plugin is set to, with the defaults of what it was not.
  private values(entry: Entry, changes: Record<string, PluginValue | null> = {}): PluginValues {
    const values: PluginValues = {};
    for (const [key, field] of Object.entries(fieldsOf(entry.declared.settings))) {
      if (field.type === 'button') continue;
      const change = changes[key];
      const kept = field.type === 'string' && field.sensitive && change === '';
      const value = change === undefined || kept ? entry.config.values[key] : (change ?? undefined);
      const effective = value ?? field.default;
      if (effective !== undefined) values[key] = effective;
    }
    return values;
  }
  private secrets(entry: Entry, values = this.values(entry)) {
    return Object.entries(fieldsOf(entry.declared.settings)).flatMap(([key, field]) =>
      field.type === 'string' && field.sensitive
        ? [values[key], entry.config.values[key]].filter((value) => typeof value === 'string')
        : [],
    );
  }
  private problem(entry: Entry) {
    if (entry.broken) return entry.broken;
    const groups = entry.declared.settings;
    const wrong = Object.keys(checkValues(groups, this.values(entry)))[0];
    return wrong && `待配置：${fieldsOf(groups)[wrong]!.title}`;
  }
  private write(name: string, entry: Entry, config: PluginConfig) {
    writePluginConfig(this.directory, name, config);
    entry.config = config;
    this.changed();
  }

  async enable(name: string, enabled: boolean) {
    const entry = this.entry(name);
    this.write(name, entry, { ...entry.config, enabled });
    this.log.write(name, enabled ? '启用' : '停用');
    this.stale.add(name);
    await this.refresh();
  }
  async configure(name: string, changes: Record<string, PluginValue | null>, save: boolean) {
    const entry = this.entry(name);
    const groups = entry.declared.settings;
    const values = this.values(entry, changes);
    const secrets = this.secrets(entry, values);
    const own = checkValues(groups, values);
    const said = await askCheck(this.root(name), groups, values);
    this.printed(name, '检查设置', said.printed, secrets);
    const errors = { ...said.errors, ...own };
    for (const key of Object.keys(errors)) errors[key] = masked(errors[key]!, secrets);
    const saved = save && !Object.keys(errors).length;
    if (saved) {
      const kept = { ...entry.config.values };
      for (const [key, change] of Object.entries(changes))
        if (change === null) delete kept[key];
        else if (values[key] !== undefined) kept[key] = values[key];
      this.write(name, entry, { ...entry.config, values: kept });
      this.log.write(name, '设置已保存');
    }
    return { errors, notice: said.notice && masked(said.notice, secrets), saved };
  }
  async press(name: string, button: string, changes: Record<string, PluginValue | null>) {
    const entry = this.entry(name);
    const group = entry.declared.settings.find((item) => button in item.fields);
    const field = group?.fields[button];
    if (field?.type !== 'button') throw new DomainError('not_found', '插件没有这个按钮。');
    const key = `${name}/${button}`;
    if (this.pressed.has(key)) return { ok: false, message: '正在运行。' };
    this.pressed.add(key);
    try {
      const values = this.values(entry, changes);
      const secrets = this.secrets(entry, values);
      const errors = {
        ...(await askCheck(this.root(name), [group!], values)).errors,
        ...checkValues([group!], values),
      };
      const wrong = Object.entries(errors)[0];
      const result = wrong
        ? { ok: false, message: `${group!.fields[wrong[0]]!.title}：${wrong[1]}`, printed: '' }
        : await askButton(this.root(name), button, field.timeout, values);
      const message = masked(result.message, secrets);
      this.log.write(name, `[${field.title}] ${result.ok ? '成功' : '失败'} ${message}`.trim());
      this.printed(name, field.title, result.printed, secrets);
      return { ok: result.ok, message };
    } finally {
      this.pressed.delete(key);
    }
  }
  // Runs what the plugin has for an example of the event, as the event itself would.
  async attempt(name: string, event: string) {
    const entry = this.entry(name);
    const problem = entry.config.enabled ? this.problem(entry) : '插件没有启用。';
    if (problem) return { ok: false, message: problem };
    const example = eventExample(event);
    if (!example) throw new DomainError('not_found', '没有这个事件。');
    const hooks = this.hooksFor(name, example);
    if (!hooks.length) return { ok: false, message: '这个事件没有匹配的命令。' };
    const results = await Promise.all(
      hooks.map((hook) => this.run(name, entry, hook, example, '[试跑] ')),
    );
    return {
      ok: results.every(({ ok }) => ok),
      message: results.map(({ text }) => text).join('\n'),
    };
  }
  logOf(name: string, clear = false) {
    this.entry(name);
    if (clear) this.log.clear(name);
    return this.log.read(name);
  }

  dispatch(event: ServiceEvent) {
    if (this.closed) return;
    for (const [name, entry] of this.entries) {
      if (!entry.config.enabled || this.problem(entry)) continue;
      try {
        for (const hook of this.hooksFor(name, event)) void this.run(name, entry, hook, event);
      } catch (error) {
        this.failed(name, entry, `${event.hook_event_name} 没有运行：${reason(error)}`);
      }
    }
  }
  private hooksFor(name: string, event: ServiceEvent) {
    const field = matcherFields[event.hook_event_name];
    return (this.hooks(name)[event.hook_event_name] ?? [])
      .filter((group) => matches(group.matcher, field && event[field]))
      .flatMap((group) => group.hooks);
  }
  private root(name: string) {
    return join(this.directory, 'plugins', name);
  }
  private run(name: string, entry: Entry, hook: Hook, event: ServiceEvent, mark = '') {
    const root = this.root(name);
    const data = join(this.directory, 'plugin-data', name);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data };
    const filled = (text: string) =>
      text
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => root)
        .replaceAll('${CLAUDE_PLUGIN_DATA}', () => data);
    const config = this.values(entry);
    const secrets = this.secrets(entry, config);
    const started = Date.now();
    const child = spawn(filled(hook.command), hook.args?.map(filled) ?? [], {
      cwd: root,
      env,
      shell: !hook.args,
      // A group of its own, so that what the command started ends with it.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    this.running.add(child);
    let printed = '';
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      stop(child);
    }, hook.timeout * 1000);
    for (const stream of [child.stdout, child.stderr])
      stream.setEncoding('utf8').on('data', (text: string) => {
        printed = (printed + text).slice(-OUTPUT_LIMIT);
      });
    const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
      const ended = (result: string) => {
        if (!this.running.delete(child)) return;
        clearTimeout(timer);
        const of = event.session_id ? ` 会话=${event.session_id} 运行=${event.run_id}` : '';
        const ok = result === '成功';
        const output = masked(printed.trim(), secrets);
        const text = `${result} ${Date.now() - started}ms${output && `\n${output.replace(/^/gm, '    ')}`}`;
        if (!this.closed) {
          this.log.write(name, `${mark}${event.hook_event_name}${mark ? '' : of} → ${text}`);
          this.told(entry, ok ? undefined : `${event.hook_event_name} ${result}`);
        }
        resolve({ ok, text });
      };
      child.on('error', (error) => ended(`没有启动（${error.message}）`));
      child.on('close', (code, signal) =>
        ended(
          late ? `超时 ${hook.timeout}s，已结束` : code === 0 ? '成功' : `退出 ${code ?? signal}`,
        ),
      );
    });
    // A command that does not read its input may be gone before it is written.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...event, config }));
    return done;
  }
  private failed(name: string, entry: Entry, message: string) {
    this.log.write(name, message);
    this.told(entry, message);
  }
  // Every window hears of a first failure and of the first time it went well after it.
  private told(entry: Entry, failure: string | undefined) {
    const before = entry.failure?.message;
    entry.failure = failure ? { at: new Date().toISOString(), message: failure } : undefined;
    if (before !== failure) this.changed();
  }
  private printed(name: string, of: string, text: string, secrets: string[]) {
    if (text.trim())
      this.log.write(name, `[${of}]\n${masked(text.trim(), secrets).replace(/^/gm, '    ')}`);
  }
}
