import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
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

// As Claude Code reads a matcher: names when it holds nothing but them, otherwise a regular expression.
export function matches(matcher: string | undefined, value: unknown) {
  if (!matcher || matcher === '*' || value === undefined) return true;
  if (/^[\w\- ,|]+$/.test(matcher))
    return matcher.split(/[|,]/).some((name) => name.trim() === value);
  return new RegExp(matcher).test(String(value));
}

// How much of what a command printed is kept, and how large a plugin's log grows before it is put aside.
const OUTPUT_LIMIT = 8192;
const LOG_LIMIT = 1024 * 1024;
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;

// Hands the service's events to the plugins in <data>/plugins, each a directory with a hooks/hooks.json (see
// docs/plugins.md). The directory is read at each event, so a change there holds from the next one on. A plugin
// changes nothing here: how its commands went and what they printed goes to its log in <data>/plugin-logs.
export class Plugins {
  private directory: string;
  private running = new Set<ChildProcess>();
  private closed = false;
  constructor(directory: string) {
    this.directory = directory;
  }
  names() {
    const plugins = join(this.directory, 'plugins');
    if (this.closed || !existsSync(plugins)) return [];
    return readdirSync(plugins).filter(
      (name) => PLUGIN_NAME.test(name) && existsSync(join(plugins, name, 'hooks', 'hooks.json')),
    );
  }
  dispatch(event: ServiceEvent) {
    for (const name of this.names())
      try {
        const path = join(this.directory, 'plugins', name, 'hooks', 'hooks.json');
        const { hooks } = hooksFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        const field = matcherFields[event.hook_event_name];
        for (const group of hooks[event.hook_event_name] ?? [])
          if (matches(group.matcher, field && event[field]))
            for (const hook of group.hooks) this.run(name, hook, event);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(name, `${event.hook_event_name} 没有运行：${reason}`);
      }
  }
  close() {
    this.closed = true;
    for (const child of this.running) stop(child);
  }
  private run(name: string, hook: Hook, event: ServiceEvent) {
    const root = join(this.directory, 'plugins', name);
    const data = join(this.directory, 'plugin-data', name);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data };
    const filled = (text: string) =>
      text
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => root)
        .replaceAll('${CLAUDE_PLUGIN_DATA}', () => data);
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
    const ended = (result: string) => {
      if (!this.running.delete(child) || this.closed) return;
      clearTimeout(timer);
      const of = event.session_id ? ` 会话=${event.session_id} 运行=${event.run_id}` : '';
      const output = printed.trim().replace(/^/gm, '    ');
      this.log(
        name,
        `${event.hook_event_name}${of} → ${result} ${Date.now() - started}ms` +
          (printed.trim() ? `\n${output}` : ''),
      );
    };
    child.on('error', (error) => ended(`没有启动（${error.message}）`));
    child.on('close', (code, signal) =>
      ended(
        late ? `超时 ${hook.timeout}s，已结束` : code === 0 ? '成功' : `退出 ${code ?? signal}`,
      ),
    );
    // A command that does not read its input may be gone before it is written.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  }
  private log(name: string, text: string) {
    const directory = join(this.directory, 'plugin-logs');
    const file = join(directory, `${name}.log`);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (existsSync(file) && statSync(file).size > LOG_LIMIT)
        renameSync(file, join(directory, `${name}.1.log`));
      appendFileSync(file, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
    } catch {
      // A log that cannot be written is gone without.
    }
  }
}

function stop(child: ChildProcess) {
  if (process.platform === 'win32' || !child.pid) child.kill();
  else
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
}
