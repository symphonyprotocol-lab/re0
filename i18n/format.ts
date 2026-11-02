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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Deep string shape of a dictionary, so the English file must cover every Chinese key. */
export type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };
