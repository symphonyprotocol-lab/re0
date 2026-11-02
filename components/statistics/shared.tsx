import Link from 'next/link';
import type { ReactNode } from 'react';
import { periodDays, type PeriodFilter } from '@/lib/domain/statistics';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { Icon, type IconName } from '@/components/ui/icons';

/*
 * Pieces shared by the statistics pages (prototype dot-statistics.js,
 * workspace-details.js). No hooks and no 'use client': they render on the
 * server pages and inside the client period controls alike.
 */

/** `path?query`, skipping empty values. */
export function hrefFor(path: string, params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** What a period's picker shows: the day, the week's first and last day, the month, or the range. */
export function periodLabel(t: Messages, filter: PeriodFilter): string {
  if (filter.period === 'all') return t.statistics.period.names.all;
  if (filter.period === 'custom') return `${filter.start ?? filter.date} — ${filter.end ?? filter.date}`;
  if (filter.period === 'week') {
    const days = periodDays(filter)!;
    return `${days.first} — ${days.last}`;
  }
  if (filter.period === 'month') return fill(t.statistics.period.monthLabel, { year: filter.date.slice(0, 4), month: Number(filter.date.slice(5, 7)) });
  return filter.date;
}

/** "第 a–b 项，共 N 项" and previous / next links, as in the prototype's detail tables. */
export function LinkPager({ t, locale, page, size, total, href }: { t: Messages; locale: Locale; page: number; size: number; total: number; href: (page: number) => string }) {
  const p = t.statistics.pager;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  const n = (value: number) => formatNumber(value, locale);
  return (
    <nav aria-label={p.label} className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-[12px] text-muted md:px-5">
      <span>{total ? fill(p.range, { from: n((current - 1) * size + 1), to: n(Math.min(current * size, total)), total: n(total) }) : p.empty}</span>
      <div className="flex items-center gap-2">
        {current > 1 ? (
          <Link href={href(current - 1)} className="btn-secondary btn-sm">
            {p.previous}
          </Link>
        ) : (
          <button type="button" className="btn-secondary btn-sm" disabled>
            {p.previous}
          </button>
        )}
        <span className="font-mono text-ink">
          {current} / {pages}
        </span>
        {current < pages ? (
          <Link href={href(current + 1)} className="btn-secondary btn-sm">
            {p.next}
          </Link>
        ) : (
          <button type="button" className="btn-secondary btn-sm" disabled>
            {p.next}
          </button>
        )}
      </div>
    </nav>
  );
}

/** A table that scrolls sideways inside its card on a phone, never the page. */
export function DetailTable({ label, heads, children, empty }: { label: string; heads: ReactNode[]; children: ReactNode[]; empty: ReactNode }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full min-w-[640px] border-collapse text-left text-[12px]">
        <thead>
          <tr className="border-b border-line bg-wash text-[11px] text-muted">
            {heads.map((head, index) => (
              <th key={index} scope="col" className="px-4 py-2.5 font-semibold whitespace-nowrap md:px-5">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {children.length ? (
            children
          ) : (
            <tr>
              <td colSpan={heads.length} className="px-4 py-10">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-2 text-center">
      <span className="inline-flex size-10 items-center justify-center rounded-xl bg-soft text-blue">
        <Icon name={icon} className="size-5" />
      </span>
      <strong className="text-[13px]">{title}</strong>
      <p className="text-[12px] leading-relaxed text-muted">{body}</p>
    </div>
  );
}

export const cell = 'px-4 py-3 align-top md:px-5';

/** A page heading with the scope tag on the right. */
export function StatisticsHeading({ title, lede, tag }: { title: string; lede: string; tag: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[24px] font-extrabold tracking-tight md:text-[28px]">{title}</h1>
        <p className="mt-2 text-[13px] text-muted">{lede}</p>
      </div>
      <span className="tag border-[#d8e6fb] bg-soft text-blue">{tag}</span>
    </div>
  );
}
