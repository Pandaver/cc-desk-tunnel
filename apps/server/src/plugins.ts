import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { pluginManifestSchema, pluginNameSchema } from '@cc-desk-tunnel/protocol';
import type { Plugin, PluginManifest, PluginValue, PluginValues } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { eventExample } from './event-examples.ts';
import { readPluginConfig, removePluginConfig, writePluginConfig } from './plugin-config.ts';
import type { PluginConfig } from './plugin-config.ts';
import { hooksFileSchema, matches } from './plugin-hooks.ts';
import type { Hook } from './plugin-hooks.ts';
import { installArchive } from './plugin-install.ts';
import type { PluginArchive } from './plugin-install.ts';
import { masked, PluginLog } from './plugin-log.ts';
import { stop } from './plugin-process.ts';
import { askButton, askCheck, checkValues, fieldsOf, loadUi, NOTHING } from './plugin-ui.ts';
import type { Declared } from './plugin-ui.ts';
import { matcherFields } from './service-events.ts';
import type { ServiceEvent } from './service-events.ts';

// What is known of a plugin, read anew whenever its directory changes.
type Entry = {
  manifest: Partial<PluginManifest>;
  declared: Declared;
  events: string[];
  broken?: string;
};

// How much of what a command printed is kept, and how long changes in the directory are gathered.
const OUTPUT_LIMIT = 8192;
const SETTLE_MS = 300;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The plugins in <data>/plugins, each a directory with a hooks/hooks.json and, for its settings, a ui file (see
// docs/plugins.md): hands them the service's events and keeps what they are set to. The directory is watched, so a
// change there holds a moment later. A plugin's code runs in processes of its own, and how they went goes to its log.
export class Plugins {
  private directory: string;
  private changed: () => void;
  private log: PluginLog;
  private entries = new Map<string, Entry>();
  // Apart from what is read anew, which may be while a plugin is set or runs.
  private configs = new Map<string, PluginConfig>();
  private failures = new Map<string, { at: string; message: string }>();
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
      const values = this.values(name);
      const { enabled } = this.config(name);
      const secret = (key: string) => {
        const field = fields[key];
        return field?.type === 'string' && !!field.sensitive;
      };
      return {
        name,
        title: entry.manifest.displayName,
        description: entry.manifest.description,
        version: entry.manifest.version,
        enabled,
        problem: enabled ? this.problem(name) : undefined,
        failure: this.failures.get(name),
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
      declared: NOTHING,
      events: [],
    };
    try {
      const manifest = join(root, '.claude-plugin', 'plugin.json');
      if (existsSync(manifest))
        entry.manifest = pluginManifestSchema
          .partial()
          .parse(JSON.parse(readFileSync(manifest, 'utf8')));
      entry.events = Object.keys(this.hooks(name)).filter((event) => eventExample(event));
      // A disabled plugin's code does not run, and so it has nothing to be set.
      if (this.config(name).enabled) entry.declared = await loadUi(root);
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
  private config(name: string) {
    let config = this.configs.get(name);
    if (!config) this.configs.set(name, (config = readPluginConfig(this.directory, name)));
    return config;
  }
  private entry(name: string) {
    const entry = this.entries.get(name);
    if (!entry) throw new DomainError('not_found', '插件不存在。');
    return entry;
  }
  // What the plugin is set to, with the defaults of what it was not.
  private values(name: string, changes: Record<string, PluginValue | null> = {}): PluginValues {
    const values: PluginValues = {};
    const kept = this.config(name).values;
    for (const [key, field] of Object.entries(fieldsOf(this.entry(name).declared.settings))) {
      if (field.type === 'button') continue;
      const change = changes[key];
      const same = field.type === 'string' && field.sensitive && change === '';
      const value = change === undefined || same ? kept[key] : (change ?? undefined);
      const effective = value ?? field.default;
      if (effective !== undefined) values[key] = effective;
    }
    return values;
  }
  private secrets(name: string, values = this.values(name)) {
    const kept = this.config(name).values;
    return Object.entries(fieldsOf(this.entry(name).declared.settings)).flatMap(([key, field]) =>
      field.type === 'string' && field.sensitive
        ? [values[key], kept[key]].filter((value) => typeof value === 'string')
        : [],
    );
  }
  private problem(name: string) {
    const entry = this.entry(name);
    if (entry.broken) return entry.broken;
    const groups = entry.declared.settings;
    const wrong = Object.keys(checkValues(groups, this.values(name)))[0];
    return wrong && `待配置：${fieldsOf(groups)[wrong]!.title}`;
  }
  private write(name: string, config: PluginConfig) {
    writePluginConfig(this.directory, name, config);
    this.configs.set(name, config);
    this.changed();
  }

  async enable(name: string, enabled: boolean) {
    this.entry(name);
    this.write(name, { ...this.config(name), enabled });
    this.log.write(name, enabled ? '启用' : '停用');
    this.stale.add(name);
    await this.refresh();
  }
  async configure(name: string, changes: Record<string, PluginValue | null>, save: boolean) {
    const entry = this.entry(name);
    const groups = entry.declared.settings;
    const values = this.values(name, changes);
    const secrets = this.secrets(name, values);
    const own = checkValues(groups, values);
    const said = await askCheck(this.root(name), groups, values);
    this.printed(name, '检查设置', said.printed, secrets);
    const errors = { ...said.errors, ...own };
    for (const key of Object.keys(errors)) errors[key] = masked(errors[key]!, secrets);
    const saved = save && !Object.keys(errors).length;
    if (saved) {
      const kept = { ...this.config(name).values };
      for (const [key, change] of Object.entries(changes))
        if (change === null) delete kept[key];
        else if (values[key] !== undefined) kept[key] = values[key];
      this.write(name, { ...this.config(name), values: kept });
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
      const values = this.values(name, changes);
      const secrets = this.secrets(name, values);
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
    const problem = this.config(name).enabled ? this.problem(name) : '插件没有启用。';
    if (problem) return { ok: false, message: problem };
    const example = eventExample(event);
    if (!example) throw new DomainError('not_found', '没有这个事件。');
    const hooks = this.hooksFor(name, example);
    if (!hooks.length) return { ok: false, message: '这个事件没有匹配的命令。' };
    const results = await Promise.all(
      hooks.map((hook) => this.run(name, hook, example, '[试跑] ')),
    );
    return {
      ok: results.every(({ ok }) => ok),
      message: results.map(({ text }) => text).join('\n'),
    };
  }
  version(name: string) {
    const entry = this.entries.get(name);
    return entry && { version: entry.manifest.version };
  }
  async install(archive: PluginArchive) {
    const { name, version } = archive.manifest;
    installArchive(this.directory, archive);
    this.log.write(name, `安装 ${version ?? ''}`.trim());
    this.stale.add(name);
    await this.refresh();
  }
  async remove(name: string) {
    this.entry(name);
    rmSync(this.root(name), { recursive: true, force: true });
    rmSync(join(this.directory, 'plugin-data', name), { recursive: true, force: true });
    removePluginConfig(this.directory, name);
    this.configs.delete(name);
    this.failures.delete(name);
    this.log.clear(name);
    await this.refresh();
  }
  logOf(name: string, clear = false) {
    this.entry(name);
    if (clear) this.log.clear(name);
    return this.log.read(name);
  }

  dispatch(event: ServiceEvent) {
    if (this.closed) return;
    for (const name of this.entries.keys()) {
      if (!this.config(name).enabled || this.problem(name)) continue;
      try {
        for (const hook of this.hooksFor(name, event)) void this.run(name, hook, event);
      } catch (error) {
        this.failed(name, `${event.hook_event_name} 没有运行：${reason(error)}`);
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
  private run(name: string, hook: Hook, event: ServiceEvent, mark = '') {
    const root = this.root(name);
    const data = join(this.directory, 'plugin-data', name);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data };
    const filled = (text: string) =>
      text
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => root)
        .replaceAll('${CLAUDE_PLUGIN_DATA}', () => data);
    const config = this.values(name);
    const secrets = this.secrets(name, config);
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
          this.told(name, ok ? undefined : `${event.hook_event_name} ${result}`);
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
  private failed(name: string, message: string) {
    this.log.write(name, message);
    this.told(name, message);
  }
  // Every window hears of a first failure and of the first time it went well after it.
  private told(name: string, failure: string | undefined) {
    const before = this.failures.get(name)?.message;
    if (failure) this.failures.set(name, { at: new Date().toISOString(), message: failure });
    else this.failures.delete(name);
    if (before !== failure) this.changed();
  }
  private printed(name: string, of: string, text: string, secrets: string[]) {
    if (text.trim())
      this.log.write(name, `[${of}]\n${masked(text.trim(), secrets).replace(/^/gm, '    ')}`);
  }
}
