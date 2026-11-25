import { z } from 'zod';

// The plugins of the service as its clients show them (see docs/plugins.md). What a plugin declares is data here: its
// functions stay with the service, which runs them in a process of their own.
export const pluginNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(60);
const key = z
  .string()
  .regex(/^[a-z]\w*$/i)
  .max(60);
const label = z.string().trim().min(1).max(120);
const said = { title: label, description: z.string().max(1000).optional() };
// The longest text of a setting, in characters; it keeps a frame of them within MAX_FRAME_BYTES.
export const PLUGIN_TEXT_LIMIT = 8000;
const text = z.string().max(PLUGIN_TEXT_LIMIT);
export const pluginValueSchema = z.union([text, z.number(), z.boolean()]);
export type PluginValue = z.infer<typeof pluginValueSchema>;

export const pluginFieldSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'),
    ...said,
    required: z.boolean().optional(),
    default: text.optional(),
    multiline: z.boolean().optional(),
    // Kept by the service and sent to no window.
    sensitive: z.boolean().optional(),
    options: z.array(z.string().min(1).max(120)).min(1).max(50).optional(),
  }),
  z.object({
    type: z.literal('number'),
    ...said,
    required: z.boolean().optional(),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({ type: z.literal('boolean'), ...said, default: z.boolean().optional() }),
  z.object({
    type: z.literal('button'),
    ...said,
    // Asked before it runs.
    confirm: z.string().max(300).optional(),
    // In seconds.
    timeout: z.number().positive().max(60).optional(),
  }),
]);
export type PluginField = z.infer<typeof pluginFieldSchema>;
export const pluginGroupSchema = z.object({
  title: label,
  // A switch whose group shows its other fields only while it is on, or one of several.
  showWhen: z.union([key, z.array(key).min(1)]).optional(),
  fields: z.record(key, pluginFieldSchema),
});
export type PluginGroup = z.infer<typeof pluginGroupSchema>;
export type PluginValues = Record<string, PluginValue>;
// Whether what `showWhen` names is on.
export const shownWhen = (showWhen: string | string[] | undefined, values: PluginValues) =>
  !showWhen || [showWhen].flat().some((name) => !!values[name]);

export const pluginSchema = z.object({
  name: pluginNameSchema,
  title: label.optional(),
  description: z.string().max(1000).optional(),
  version: z.string().max(60).optional(),
  enabled: z.boolean(),
  // Why it does not run though it is enabled.
  problem: z.string().optional(),
  // How it last failed, until it next goes well.
  failure: z.object({ at: z.iso.datetime(), message: z.string() }).optional(),
  // The events it has commands for, and what it may be set to; a disabled plugin is not asked.
  events: z.array(z.string()),
  settings: z.array(pluginGroupSchema),
  values: z.record(key, pluginValueSchema),
  // The sensitive settings that have a value.
  secrets: z.array(key),
});
export type Plugin = z.infer<typeof pluginSchema>;

const request = { requestId: z.uuid(), name: pluginNameSchema };
// A sensitive setting left out or empty keeps its value; null clears any setting.
const values = z.record(key, pluginValueSchema.nullable());
export const pluginCommandSchemas = [
  z.object({ type: z.literal('plugin.enable'), ...request, enabled: z.boolean() }).strict(),
  // Checks the values, and keeps them if `save` and they hold.
  z.object({ type: z.literal('plugin.configure'), ...request, values, save: z.boolean() }).strict(),
  // Runs a button of the plugin's settings with the values as they are in the form, kept or not.
  z.object({ type: z.literal('plugin.press'), ...request, button: key, values }).strict(),
  // Runs the plugin's commands for an example of the event.
  z.object({ type: z.literal('plugin.try'), ...request, event: z.string().max(60) }).strict(),
  z
    .object({ type: z.literal('plugin.log'), ...request, clear: z.literal(true).optional() })
    .strict(),
] as const;
export const pluginMessageSchemas = [
  // Every plugin, sent on signing in and to every connection whenever it changes.
  z.object({ type: z.literal('plugins'), plugins: z.array(pluginSchema) }),
  z.object({
    type: z.literal('plugin.checked'),
    requestId: z.uuid(),
    errors: z.record(key, z.string()),
    // That the plugin's own check could not be run, which keeps nothing from being saved.
    notice: z.string().optional(),
    saved: z.boolean(),
  }),
  z.object({
    type: z.literal('plugin.done'),
    requestId: z.uuid(),
    ok: z.boolean(),
    message: z.string(),
  }),
  z.object({ type: z.literal('plugin.log'), requestId: z.uuid(), text: z.string() }),
] as const;
