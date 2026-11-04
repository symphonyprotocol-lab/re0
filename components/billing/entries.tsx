'use client';

import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useOptimistic, useTransition, type CSSProperties } from 'react';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import type { Activity } from '@/lib/domain/billing';
import { chargedFromNote } from '@/lib/domain/credits';
import type { ActivitySummary, EntryRow } from '@/lib/services/billing';
import { periodParams, type PeriodFilter } from '@/lib/domain/statistics';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Pager } from '@/components/ui/pager';
import { PeriodControls } from '@/components/statistics/period-controls';
import { FilterForm } from '@/components/statistics/filter-form';

/**
 * The ledger (prototype `ledger()`): 全部 / 消费 / 收入, paged on the server.
 * Category, reporting period, search, page and size live in the URL, so a
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
  filter,
  summary,
}: {
  items: EntryRow[];
  total: number;
  page: number;
  size: number;
  activity: Activity;
  /** Official accounts have no 收入 tab; the server already leaves their income rows out. */
  official?: boolean;
  filter: PeriodFilter & { q: string };
  summary: ActivitySummary;
}) {
  const { t, locale } = useI18n();
  const b = t.billing;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selection, select] = useOptimistic({ activity, filter });
  const activities = official ? (['all', 'spend'] as const) : (['all', 'spend', 'income'] as const);
  const resultKey = JSON.stringify([activity, filter, page, size]);

  const go = (next: { activity?: Activity; page?: number; size?: number; filter?: PeriodFilter }) => {
    const nextFilter = { ...selection.filter, ...next.filter };
    const params = new URLSearchParams({ tab: 'billing', ...periodParams(nextFilter) });
    if (nextFilter.q) params.set('q', nextFilter.q);
    const a = next.activity ?? selection.activity;
    const p = next.page ?? 1;
    const s = next.size ?? size;
    if (a !== 'all') params.set('activity', a);
    if (p !== 1) params.set('page', String(p));
    if (s !== LIST_PAGE_SIZES[0]) params.set('size', String(s));
    startTransition(() => {
      select({ activity: a, filter: nextFilter });
      router.push(`/settings?${params}#credit-activity`, { scroll: false });
    });
  };

  const charged = (entry: EntryRow) => {
    const amount = entry.reason === 'knowledge_settle' || entry.reason === 'query_base' || entry.reason === 'query_fee_paid' ? chargedFromNote(entry.note) : null;
    return amount === null ? null : fill(b.charged, { n: formatNumber(amount, locale) });
  };

  return (
    <section id="credit-activity" className={`card billing-ledger${pending ? ' is-pending' : ''}`}>
      <div className="billing-loading-track" aria-hidden="true">
        <span />
      </div>
      <div className="between ledger-head">
        <h2 className="section-title">{b.activity.title}</h2>
        <span className="tiny muted">{b.activity.hint}</span>
      </div>
      <div className="billing-period">
        <PeriodControls filter={selection.filter} onChange={(next) => go({ filter: next })} />
        <div key={resultKey} className="billing-activity-summary billing-result-enter" aria-busy={pending}>
          {(['spend', 'income', 'purchases'] as const).filter((key) => !official || key !== 'income').map((key) => (
            <div key={key}>
              <span>{b.reporting[key]}</span>
              <strong>
                {formatNumber(summary[key], locale)} <small>credits</small>
              </strong>
            </div>
          ))}
        </div>
        <p className="tiny muted">{b.reporting.note}</p>
      </div>
      <div className="billing-category-row">
        <div role="tablist" aria-label={b.activity.label} className="billing-category-tabs" style={{ '--tab-count': activities.length, '--tab-index': activities.findIndex((value) => value === selection.activity) } as CSSProperties}>
          <span className="billing-category-indicator" aria-hidden="true" />
          {activities.map((value) => (
            <button key={value} type="button" role="tab" aria-selected={selection.activity === value} aria-controls="billing-entries" className={selection.activity === value ? 'active' : ''} onClick={() => go({ activity: value })}>
              {b.activity.tabs[value]}
            </button>
          ))}
        </div>
      </div>
      <FilterForm search={{ value: filter.q, label: b.reporting.search, placeholder: b.reporting.search }} selects={[]} size={size} />
      <div id="billing-entries" key={`rows-${resultKey}`} className="billing-results billing-result-enter" aria-busy={pending}>
        <div className="table-wrap">
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
                      {(entry.reeName || entry.note) && <small className="ledger-note">{entry.reeName ?? entry.note}</small>}
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
      </div>
    </section>
  );
}
