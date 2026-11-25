import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

// How large a plugin's log grows before it is put aside, and how many of its lines are shown.
const LIMIT = 1024 * 1024;
const LINES = 200;

// A plugin's secrets are not shown as they are; in another form, as signed or encoded, they cannot be told.
export const masked = (text: string, secrets: string[]) =>
  secrets
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.replaceAll(secret, '***'), text);

export class PluginLog {
  private directory: string;
  constructor(directory: string) {
    this.directory = join(directory, 'plugin-logs');
  }
  private file(name: string, old = '') {
    return join(this.directory, `${name}${old}.log`);
  }
  write(name: string, text: string) {
    const file = this.file(name);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (existsSync(file) && statSync(file).size > LIMIT) renameSync(file, this.file(name, '.1'));
      appendFileSync(file, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
    } catch {
      // A log that cannot be written is gone without.
    }
  }
  read(name: string) {
    const lines = ['.1', '']
      .map((old) => this.file(name, old))
      .filter((file) => existsSync(file))
      .flatMap((file) => readFileSync(file, 'utf8').trimEnd().split('\n'));
    return lines.slice(-LINES).join('\n');
  }
  clear(name: string) {
    for (const old of ['.1', '']) rmSync(this.file(name, old), { force: true });
  }
}
