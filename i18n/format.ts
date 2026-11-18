/** `{name}` placeholders, filled from `values`; unknown names are left as they are. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

export function formatNumber(value: number, locale: 'zh' | 'en'): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US').format(value);
}

/** Times are shown in UTC+8 (rebuild-proposal.md 8.2, "用户侧统计"). */
export function formatDateTime(value: Date | string, locale: 'zh' | 'en'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    timeZone: 'Asia/Kuching',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** A calendar day in UTC+8, e.g. 2026年12月2日 / December 2, 2026. */
export function formatDate(value: Date | string, locale: 'zh' | 'en'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Kuching', year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

/** US dollars from cents, always two decimals. */
export function formatUsd(minor: number, locale: 'zh' | 'en'): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(minor / 100);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Deep string shape of a dictionary, so the English file must cover every Chinese key. */
export type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** "刚刚", "3 分钟前", "2 小时前", "昨天"... up to a week, then the date: how long ago `value` was, seen at `now`. */
export function formatRelative(value: Date | string, now: number, locale: 'zh' | 'en', justNow: string): string {
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60_000));
  if (minutes === 0) return justNow;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 60) return relative.format(-minutes, 'minute');
  if (minutes < 1_440) return relative.format(-Math.floor(minutes / 60), 'hour');
  if (minutes < 10_080) return relative.format(-Math.floor(minutes / 1_440), 'day');
  return formatDate(value, locale);
}
