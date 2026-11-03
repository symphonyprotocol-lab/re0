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
 * The ledger (prototype `ledger()`): 全部 / 消费 / 收入, paged on the server.
 * Filter, page and size live in the URL (`activity`, `page`, `size`), so a
 * refresh or the back button lands on the same rows. Each row says which
 * kinds of credit it moved -- the trace back to its grants.
 */
export function Entries({
  items,
  total,
  page,
  size,
  activity,
  official = false,
}: {
  items: EntryRow[];
  total: number;
  page: number;
  size: number;
  activity: Activity;
  /** Official accounts have no 收入 tab; the server already leaves their income rows out. */
  official?: boolean;
}) {
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
    const amount = entry.reason === 'knowledge_settle' || entry.reason === 'query_base' || entry.reason === 'query_fee_paid' ? chargedFromNote(entry.note) : null;
    return amount === null ? null : fill(b.charged, { n: formatNumber(amount, locale) });
  };

  return (
    <section id="credit-activity" className="card mt32">
      <div className="between ledger-head">
        <h2 className="section-title">{b.activity.title}</h2>
        <span className="tiny muted">{b.activity.hint}</span>
      </div>
      <div role="tablist" aria-label={b.activity.label} className="tab-row">
        {(official ? (['all', 'spend'] as const) : (['all', 'spend', 'income'] as const)).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={activity === value} className={activity === value ? 'active' : ''} onClick={() => go({ activity: value })}>
            {b.activity.tabs[value]}
          </button>
        ))}
      </div>
      <div className={`table-wrap ${pending ? 'is-loading' : ''}`} aria-busy={pending}>
        <table>
          <thead>
            <tr>
              <th>{b.activity.item}</th>
              <th>{b.activity.time}</th>
              <th>{b.activity.sources}</th>
              <th className="numeric">Credits</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="ledger-empty">
                  {b.activity.empty}
                </td>
              </tr>
            ) : (
              items.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {b.reasons[entry.reason]}
                    {charged(entry) && <small className="ledger-charged">{charged(entry)}</small>}
                  </td>
                  <td>{formatDateTime(entry.createdAt, locale)}</td>
                  <td>
                    <span className="ledger-sources">
                      {entry.sources.map((source) => (
                        <span key={source.source} className="tag">
                          {b.sources[source.source as keyof typeof b.sources] ?? source.source} {formatNumber(source.amount, locale)}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className={`mono numeric ${entry.delta > 0 ? 'positive' : 'negative'}`}>
                    {entry.delta > 0 ? '+' : ''}
                    {formatNumber(entry.delta, locale)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="ledger-pager">
        <Pager page={page} size={size} total={total} sizes={LIST_PAGE_SIZES} onPage={(value) => go({ page: value })} onSize={(value) => go({ size: value })} />
      </div>
    </section>
  );
}
