import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AMOUNT_SORTS, csvHref, listHref, PAYOUT_HISTORY_FILTERS, payoutHistoryView, RECENT_PERIODS } from '@/lib/domain/admin-lists';
import { listPayouts } from '@/lib/services/payouts';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, ResultsLine, SummaryCards } from '@/components/admin/list-kit';
import { PayoutsTable } from '@/components/admin/payouts-table';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consolePayouts.payouts.historyTitle };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * `/admin/payout-history` (2.5 "提现记录", prototype admin-records.js):
 * every request in its five states, filtered by status and time, newest
 * first, exported as CSV with the same filters.
 */
export default async function PayoutHistoryPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const p = t.consolePayouts.payouts;
  const l = t.console.list;
  const view = payoutHistoryView(await searchParams);
  const data = await listPayouts(view, 'history');
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/payout-history', current, changes);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'all' || view.period !== 'all' || view.sort !== 'newest';
  const reset = listHref('/admin/payout-history', { size: view.size });
  const periods: Record<string, string> = { all: l.allTime, '7': l.last7, '30': l.last30, '90': l.last90 };
  return (
    <>
      <PageHead crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: p.historyTitle }]} title={p.historyTitle} lede={p.historyLede} />
      <SummaryCards
        items={[
          { label: p.cards.all, value: n(data.counts.all ?? 0), href: reset, active: !filtered, title: l.clearFilters },
          { label: p.cards.paid, value: n(data.counts.paid ?? 0), href: href({ status: 'paid' }), active: view.status === 'paid' },
          { label: p.cards.failed, value: n(data.counts.failed ?? 0), href: href({ status: 'failed' }), active: view.status === 'failed' },
          { label: p.cards.rejected, value: n(data.counts.rejected ?? 0), href: href({ status: 'rejected' }), active: view.status === 'rejected' },
        ]}
      />
      <section className="card overflow-hidden">
        <ListFilters
          q={view.q}
          placeholder={p.search}
          defaults={{ status: 'all', period: 'all', sort: 'newest', size: '20' }}
          resetHref={reset}
          filtered={filtered}
          selects={[
            { name: 'status', label: p.filters.status, value: view.status, options: PAYOUT_HISTORY_FILTERS.map((status) => [status, status === 'all' ? p.allStatuses : t.consolePayouts.payoutStatus[status]] as [string, string]) },
            { name: 'period', label: p.filters.period, value: view.period, options: RECENT_PERIODS.map((period) => [period, periods[period]!] as [string, string]) },
            { name: 'sort', label: p.filters.sort, value: view.sort, options: AMOUNT_SORTS.map((sort) => [sort, p.sorts[sort]] as [string, string]) },
            { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), String(size)] as [string, string]) },
          ]}
        />
        <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/payouts/history', view)} />
        <PayoutsTable t={t} locale={locale} items={data.items} back={encodeURIComponent(href({}))} />
        <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
      </section>
    </>
  );
}
