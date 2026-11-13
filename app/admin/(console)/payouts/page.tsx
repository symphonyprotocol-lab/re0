import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { redirect } from 'next/navigation';
import { financeFilter } from '@/lib/domain/admin-finance';
import { AMOUNT_SORTS, csvHref, listHref, PAYOUT_QUEUE_DEFAULTS, PAYOUT_QUEUE_FILTERS, payoutQueueView } from '@/lib/domain/admin-lists';
import { listPayouts, payoutTrend } from '@/lib/services/payouts';
import { payoutFundingLines } from '@/lib/services/payout-funding';
import { sitePayoutMinimum } from '@/lib/services/payout-minimum';
import { SitePayoutMinimumForm } from '@/components/admin/payout-minimum-forms';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { FinanceChart, RecordPage } from '@/components/admin/finance-chart';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, RecordSection, ResultsLine, SummaryCards } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { creditsUsd } from '@/components/admin/payout-kit';
import { PayoutsTable } from '@/components/admin/payouts-table';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consolePayouts.payouts.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * `/admin/payouts` (2.5 "提现审核", prototype suite.js `payoutsPage(true)`):
 * only requests waiting for review or for the transfer, oldest first. What
 * is done moves to 提现记录.
 */
export default async function PayoutsPage({ searchParams }: Props) {
  const administrator = await requireAdministrator();
  const { t, locale } = await serverMessages();
  const c = t.consolePayouts;
  const p = c.payouts;
  const l = t.console.list;
  const view = payoutQueueView(await searchParams);
  const [data, trend, minimum] = await Promise.all([listPayouts(view, 'queue'), payoutTrend(view, 'queue'), sitePayoutMinimum()]);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/payouts', current, changes, PAYOUT_QUEUE_DEFAULTS);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const funding = await payoutFundingLines(administrator, data.items.map((item) => item.id));
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'all' || view.period !== 'all' || view.sort !== 'oldest';
  const reset = listHref('/admin/payouts', { size: view.size, metric: view.metric }, {}, PAYOUT_QUEUE_DEFAULTS);
  const size = [20, 50, 100].map((value) => [String(value), fill(l.rows, { n: value })] as [string, string]);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: p.title }]} />
      <RecordPage kind="payouts" finance>
        <PageHead title={p.title} lede={p.lede} />
        <SitePayoutMinimumForm initial={minimum} />
        <SummaryCards
          label={c.summary}
          items={[
            { label: p.cards.open, value: n(data.counts.open ?? 0), href: reset, active: !filtered, title: c.clear.payouts },
            { label: p.cards.pending, value: n(data.counts.pending ?? 0), href: href({ status: 'pending' }), active: view.status === 'pending', title: fill(l.filterBy, { label: p.cards.pending }) },
            { label: p.cards.approved, value: n(data.counts.approved ?? 0), href: href({ status: 'approved' }), active: view.status === 'approved', title: fill(l.filterBy, { label: p.cards.approved }) },
            { label: p.cards.held, value: creditsUsd(data.held), href: reset, title: c.clear.payouts },
          ]}
        />
        <FinanceChart
          kind="payouts"
          trend={trend}
          metric={view.metric}
          metricHrefs={{ amount: href({ metric: 'amount' }), count: href({ metric: 'count' }) }}
          filter={financeFilter(view)}
        />
        <RecordSection>
          <ListFilters
            q={view.q}
            placeholder={p.search}
            defaults={{ status: 'all', sort: 'oldest', size: '20' }}
            resetHref={reset}
            filtered={filtered}
            selects={[
              { name: 'status', label: l.status, aria: c.aria.status, value: view.status, options: PAYOUT_QUEUE_FILTERS.map((status) => [status, status === 'all' ? p.allOpen : c.payoutStatus[status]] as [string, string]) },
              { name: 'sort', label: l.sort, aria: c.aria.sort, value: view.sort, options: AMOUNT_SORTS.map((sort) => [sort, p.sorts[sort]] as [string, string]) },
              { name: 'size', label: l.perPage, aria: c.aria.size, value: String(view.size), options: size },
            ]}
          >
            <input type="hidden" name="period" value={view.period} />
          </ListFilters>
          <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/payouts', view, PAYOUT_QUEUE_DEFAULTS)} />
          <PayoutsTable t={t} locale={locale} items={data.items} back={encodeURIComponent(href({}))} funding={funding} />
          <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
        </RecordSection>
      </RecordPage>
    </ConsolePage>
  );
}
