import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { financeFilter } from '@/lib/domain/admin-finance';
import { AMOUNT_SORTS, csvHref, listHref, PAYOUT_HISTORY_FILTERS, payoutHistoryView } from '@/lib/domain/admin-lists';
import { listPayouts, payoutTrend } from '@/lib/services/payouts';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { FinanceChart, RecordPage } from '@/components/admin/finance-chart';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, RecordSection, ResultsLine, SummaryCards } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
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
  const c = t.consolePayouts;
  const p = c.payouts;
  const l = t.console.list;
  const view = payoutHistoryView(await searchParams);
  const [data, trend] = await Promise.all([listPayouts(view, 'history'), payoutTrend(view, 'history')]);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/payout-history', current, changes);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'all' || view.period !== 'all' || view.sort !== 'newest';
  const reset = listHref('/admin/payout-history', { size: view.size, metric: view.metric });
  const size = [20, 50, 100].map((value) => [String(value), fill(l.rows, { n: value })] as [string, string]);
  const card = (status: 'paid' | 'failed' | 'rejected') => ({
    label: p.cards[status],
    value: n(data.counts[status] ?? 0),
    href: href({ status }),
    active: view.status === status,
    title: fill(l.filterBy, { label: p.cards[status] }),
  });
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: p.historyTitle }]} />
      <RecordPage kind="payout-history" finance>
        <PageHead title={p.historyTitle} lede={p.historyLede} />
        <SummaryCards
          label={c.summary}
          items={[{ label: p.cards.all, value: n(data.counts.all ?? 0), href: reset, active: !filtered, title: c.clear.records }, card('paid'), card('failed'), card('rejected')]}
        />
        <FinanceChart
          kind="payout-history"
          trend={trend}
          metric={view.metric}
          metricHrefs={{ amount: href({ metric: 'amount' }), count: href({ metric: 'count' }) }}
          filter={financeFilter(view)}
        />
        <RecordSection>
          <ListFilters
            q={view.q}
            placeholder={p.search}
            defaults={{ status: 'all', sort: 'newest', size: '20' }}
            resetHref={reset}
            filtered={filtered}
            selects={[
              { name: 'status', label: l.status, aria: c.aria.status, value: view.status, options: PAYOUT_HISTORY_FILTERS.map((status) => [status, status === 'all' ? p.allStatuses : c.payoutStatus[status]] as [string, string]) },
              { name: 'sort', label: l.sort, aria: c.aria.sort, value: view.sort, options: AMOUNT_SORTS.map((sort) => [sort, p.sorts[sort]] as [string, string]) },
              { name: 'size', label: l.perPage, aria: c.aria.size, value: String(view.size), options: size },
            ]}
          >
            <input type="hidden" name="period" value={view.period} />
          </ListFilters>
          <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/payouts/history', view)} />
          <PayoutsTable t={t} locale={locale} items={data.items} back={encodeURIComponent(href({}))} />
          <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
        </RecordSection>
      </RecordPage>
    </ConsolePage>
  );
}
