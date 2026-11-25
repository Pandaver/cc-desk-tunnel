import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { pluginValueSchema } from '@cc-desk-tunnel/protocol';

// Whether a plugin is enabled and what it is set to, kept apart from the plugin's own directory so that replacing the
// plugin keeps them. They hold its secrets. A file that cannot be read is a plugin's that was never set.
const configSchema = z.object({
  enabled: z.boolean().default(true),
  values: z.record(z.string(), pluginValueSchema).default({}),
});
export type PluginConfig = z.infer<typeof configSchema>;

const file = (directory: string, name: string) => join(directory, 'plugin-config', `${name}.json`);

export function readPluginConfig(directory: string, name: string): PluginConfig {
  try {
    return configSchema.parse(JSON.parse(readFileSync(file(directory, name), 'utf8')));
  } catch {
    return configSchema.parse({});
  }
}
export const removePluginConfig = (directory: string, name: string) =>
  rmSync(file(directory, name), { force: true });
export function writePluginConfig(directory: string, name: string, config: PluginConfig) {
  mkdirSync(join(directory, 'plugin-config'), { recursive: true, mode: 0o700 });
  const path = file(directory, name);
  writeFileSync(`${path}.new`, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.new`, path);
}
