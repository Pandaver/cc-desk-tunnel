// Making a formatter costs far more than using one, and every message shown asks for its time.
const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const day = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });
const dayOfYear = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});
const whole = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});

export function messageTime(at: string, now = new Date()) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const today = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const label = today
    ? '今天'
    : date.toDateString() === yesterday.toDateString()
      ? '昨天'
      : (date.getFullYear() !== now.getFullYear() ? dayOfYear : day).format(date);
  return { short: `${label} ${clock.format(date)}`, full: whole.format(date) };
}
