import type { TurnStats } from '@cc-desk-tunnel/protocol';
import { cacheHitRate, percent } from './UsageCharts.tsx';
import { seconds, tokens } from './UsagePanel.tsx';

// One figure of a turn. The detail list shows every field that has a value; the summary line only the ones
// switched on in the settings, which start as `summary`. A new figure is one more entry here.
export type StatField = {
  key: string;
  label: string;
  summary: boolean;
  // Null when the turn has no such figure.
  value: (stats: TurnStats) => string | null;
  // A shorter wording for the summary line; by default the label and the value.
  short?: (stats: TurnStats) => string;
};

const total = (stats: TurnStats) =>
  stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
const count = (value: number) => `${value.toLocaleString('zh-CN')} tok`;

export const statFields: StatField[] = [
  {
    key: 'tokens',
    label: 'Token 用量',
    summary: true,
    value: (stats) => count(total(stats)),
    short: (stats) => `${tokens(total(stats))} tok`,
  },
  {
    key: 'ttft',
    label: '平均首字',
    summary: true,
    value: (stats) => (stats.ttftMs == null ? null : seconds(stats.ttftMs)),
  },
  {
    key: 'speed',
    label: '平均速度',
    summary: true,
    value: (stats) =>
      stats.outputPerSecond == null ? null : `${stats.outputPerSecond.toFixed(1)} tok/s`,
    short: (stats) => `平均 ${Math.round(stats.outputPerSecond!)} tok/s`,
  },
  { key: 'modelTime', label: '模型用时', summary: false, value: (stats) => seconds(stats.modelMs) },
  {
    key: 'requests',
    label: '模型请求',
    summary: false,
    value: (stats) => `${stats.requests} 次`,
  },
  { key: 'input', label: '输入', summary: false, value: (stats) => count(stats.inputTokens) },
  { key: 'output', label: '输出', summary: false, value: (stats) => count(stats.outputTokens) },
  {
    key: 'cacheRead',
    label: '缓存读取',
    summary: false,
    value: (stats) => count(stats.cacheReadTokens),
  },
  {
    key: 'cacheWrite',
    label: '缓存写入',
    summary: false,
    value: (stats) => count(stats.cacheCreationTokens),
  },
  {
    key: 'cacheHit',
    label: '缓存命中',
    summary: false,
    value: (stats) => (total(stats) ? percent(cacheHitRate(stats)) : null),
  },
];

// `chosen` holds only the switches the user has flipped, by key.
export const inSummary = (field: StatField, chosen: Record<string, boolean>) =>
  chosen[field.key] ?? field.summary;

// The summary line: the fields switched on that have a value, short wording where a field has one.
export const summaryText = (stats: TurnStats, chosen: Record<string, boolean>) =>
  statFields
    .filter((field) => inSummary(field, chosen) && field.value(stats) != null)
    .map((field) => field.short?.(stats) ?? `${field.label} ${field.value(stats)}`)
    .join(' · ');

// A made-up turn for the settings to preview the line with.
export const sampleStats: TurnStats = {
  type: 'turn.stats',
  requests: 2,
  inputTokens: 12,
  outputTokens: 2700,
  cacheReadTokens: 36567,
  cacheCreationTokens: 9259,
  modelMs: 28200,
  ttftMs: 952,
  outputPerSecond: 99.3,
  partial: false,
};
