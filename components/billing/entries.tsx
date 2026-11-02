'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import type { Activity } from '@/lib/domain/billing';
import { chargedFromNote } from '@/lib/domain/credits';
import type { EntryRow } from '@/lib/services/billing';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Pager } from '@/components/ui/pager';

/**
 * The ledger (prototype `ledger()`): 全部 / 消耗 / 收入, paged on the server.
 * Filter, page and size live in the URL (`activity`, `page`, `size`), so a
 * refresh or the back button lands on the same rows. Each row says which
 * kinds of credit it moved -- the trace back to its grants.
 */
export function Entries({ items, total, page, size, activity }: { items: EntryRow[]; total: number; page: number; size: number; activity: Activity }) {
  const { t, locale } = useI18n();
  const b = t.billing;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const go = (next: { activity?: Activity; page?: number; size?: number }) => {
    const params = new URLSearchParams({ tab: 'billing' });
    const a = next.activity ?? activity;
    const p = next.page ?? 1;
    const s = next.size ?? size;
    if (a !== 'all') params.set('activity', a);
    if (p !== 1) params.set('page', String(p));
    if (s !== LIST_PAGE_SIZES[0]) params.set('size', String(s));
    startTransition(() => router.push(`/settings?${params}#credit-activity`, { scroll: false }));
  };

  const charged = (entry: EntryRow) => {
    const amount = entry.reason === 'knowledge_settle' || entry.reason === 'query_base' ? chargedFromNote(entry.note) : null;
    return amount === null ? null : fill(b.charged, { n: formatNumber(amount, locale) });
  };

  return (
    <section id="credit-activity" className="card scroll-mt-32">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5 md:px-6">
        <h2 className="text-[15px] font-bold">{b.activity.title}</h2>
        <span className="text-[11px] text-muted">{b.activity.hint}</span>
      </div>
      <div role="tablist" aria-label={b.activity.label} className="mt-3 flex gap-1 overflow-x-auto border-b border-line px-3 md:px-4">
        {(['all', 'spend', 'income'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={activity === value}
            onClick={() => go({ activity: value })}
            className={`flex-none border-b-2 px-3 py-2.5 text-[13px] font-medium ${activity === value ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {b.activity.tabs[value]}
          </button>
        ))}
      </div>
      <div className={pending ? 'opacity-60 transition-opacity' : ''} aria-busy={pending}>
        <div className="hidden grid-cols-[minmax(0,1fr)_150px_160px_110px] gap-4 border-b border-line px-6 py-2.5 text-[11px] font-semibold text-muted md:grid">
          <span>{b.activity.item}</span>
          <span>{b.activity.time}</span>
          <span>{b.activity.sources}</span>
          <span className="text-right">Credits</span>
        </div>
        {items.length === 0 ? (
          <p className="px-6 py-10 text-center text-[13px] text-muted">{b.activity.empty}</p>
        ) : (
          <ul>
            {items.map((entry) => (
              <li
                key={entry.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b border-line px-5 py-3 last:border-0 md:grid-cols-[minmax(0,1fr)_150px_160px_110px] md:items-center md:px-6"
              >
                <span className="min-w-0 text-[13px]">
                  <span className="font-medium">{b.reasons[entry.reason]}</span>
                  {charged(entry) && <span className="ml-2 text-[11px] text-muted">{charged(entry)}</span>}
                </span>
                <span className={`text-right font-mono text-[13px] md:order-last ${entry.delta > 0 ? 'text-green' : entry.delta < 0 ? 'text-ink' : 'text-muted'}`}>
                  {entry.delta > 0 ? '+' : ''}
                  {formatNumber(entry.delta, locale)}
                </span>
                <span className="text-[11px] text-muted md:text-[12px]">{formatDateTime(entry.createdAt, locale)}</span>
                <span className="flex flex-wrap justify-end gap-1 md:justify-start">
                  {entry.sources.map((source) => (
                    <span key={source.source} className="tag px-1.5 text-[10px]">
                      {b.sources[source.source as keyof typeof b.sources] ?? source.source} {formatNumber(source.amount, locale)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line px-5 py-3 md:px-6">
        <Pager page={page} size={size} total={total} sizes={LIST_PAGE_SIZES} onPage={(value) => go({ page: value })} onSize={(value) => go({ size: value })} />
      </div>
    </section>
  );
}
