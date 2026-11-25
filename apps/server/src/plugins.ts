import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

// Hands the service's events to the plugins in <data>/plugins, each a directory with a hooks/hooks.json (see
// docs/plugins.md). The directory is read at each event, so a change there holds from the next one on. A plugin
// changes nothing here: its output is not read, and what goes wrong with it is only logged.
export class Plugins {
  private directory: string;
  private running = new Set<ChildProcess>();
  private closed = false;
  constructor(directory: string) {
    this.directory = directory;
  }
  dispatch(event: ServiceEvent) {
    if (this.closed) return;
    const plugins = join(this.directory, 'plugins');
    let names: string[] = [];
    try {
      names = readdirSync(plugins);
    } catch {
      // No plugins.
    }
    for (const name of names) {
      const path = join(plugins, name, 'hooks', 'hooks.json');
      if (!existsSync(path)) continue;
      try {
        const { hooks } = hooksFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        const field = matcherFields[event.hook_event_name];
        for (const group of hooks[event.hook_event_name] ?? [])
          if (matches(group.matcher, field && event[field]))
            for (const hook of group.hooks) this.run(name, hook, event);
      } catch (error) {
        this.failed(name, event, error instanceof Error ? error.message : String(error));
      }
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
    const child = spawn(filled(hook.command), hook.args?.map(filled) ?? [], {
      cwd: root,
      env,
      shell: !hook.args,
      // A group of its own, so that what the command started ends with it.
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.running.add(child);
    let stderr = '';
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      stop(child);
    }, hook.timeout * 1000);
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr = (stderr + text).slice(-2000);
    });
    child.on('error', (error) => this.failed(name, event, error.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      this.running.delete(child);
      if (late) this.failed(name, event, `stopped after ${hook.timeout}s`);
      else if (code && code > 0) this.failed(name, event, `exit ${code} ${stderr.trim()}`.trim());
    });
    // A command that does not read its input may be gone before it is written.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  }
  private failed(name: string, event: ServiceEvent, reason: string) {
    console.log(`Plugin ${name}, ${event.hook_event_name}: ${reason}`);
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
