// How much of the work behind a reply the conversation shows. `standard` is how it has always looked: while a turn
// runs its steps are in groups, folded; once it ends they fold into one line, "用时 …". `expanded` lays every call
// and thought out one after another and folds nothing.
export type ViewMode = 'standard' | 'expanded';
export type TranscriptView = { mode: ViewMode };

export const defaultView: TranscriptView = { mode: 'standard' };

export type ViewPolicy = {
  // Tool calls and thinking are laid out one after another, with no group around them.
  flat: boolean;
  // Finished turns fold into one line.
  fold: boolean;
  // A folded thinking block shows its first line.
  preview: boolean;
};

export const viewModes: { mode: ViewMode; label: string; detail: string; policy: ViewPolicy }[] = [
  {
    mode: 'standard',
    label: '标准',
    detail: '运行中按连续的操作分组，结束后折成“用时 …”',
    policy: { flat: false, fold: true, preview: false },
  },
  {
    mode: 'expanded',
    label: '全部展开',
    detail: '命令和思考一条条平铺，不分组，也不自动收起；思考显示第一行',
    policy: { flat: true, fold: false, preview: true },
  },
];

export const viewPolicy = (mode: ViewMode): ViewPolicy =>
  (viewModes.find((entry) => entry.mode === mode) ?? viewModes[0]).policy;
// The first line that says something, without the Markdown around it.
export function firstLine(text: string) {
  for (const line of text.split('\n')) {
    const plain = line
      .replace(/^[\s>#*\-+\d.)]+/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (plain) return plain;
  }
  return '';
}
