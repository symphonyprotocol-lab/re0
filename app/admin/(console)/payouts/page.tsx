import type { Metadata } from 'next';
import Link from 'next/link';
import { AMOUNT_SORTS, listHref, PAYOUT_QUEUE_DEFAULTS, PAYOUT_QUEUE_FILTERS, payoutQueueView } from '@/lib/domain/admin-lists';
import { listPayouts } from '@/lib/services/payouts';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, ResultsLine, SummaryCards } from '@/components/admin/list-kit';
import { creditsUsd } from '@/components/admin/payout-kit';
import { PayoutsTable } from '@/components/admin/payouts-table';
import { Icon } from '@/components/ui/icons';

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
  const { t, locale } = await serverMessages();
  const p = t.consolePayouts.payouts;
  const l = t.console.list;
  const view = payoutQueueView(await searchParams);
  const data = await listPayouts(view, 'queue');
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/payouts', current, changes, PAYOUT_QUEUE_DEFAULTS);
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'all' || view.sort !== 'oldest';
  const reset = listHref('/admin/payouts', { size: view.size }, {}, PAYOUT_QUEUE_DEFAULTS);
  return (
    <>
      <PageHead
        crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: p.title }]}
        title={p.title}
        lede={p.lede}
        actions={
          <Link href="/admin/payout-history" className="text-link text-[12px]">
            {p.viewAll}
            <Icon name="arrow" className="size-3.5" />
          </Link>
        }
      />
      <SummaryCards
        items={[
          { label: p.cards.open, value: n(data.counts.open ?? 0), href: reset, active: !filtered, title: l.clearFilters },
          { label: p.cards.pending, value: n(data.counts.pending ?? 0), href: href({ status: 'pending' }), active: view.status === 'pending' },
          { label: p.cards.approved, value: n(data.counts.approved ?? 0), href: href({ status: 'approved' }), active: view.status === 'approved' },
          { label: p.cards.held, value: creditsUsd(data.held) },
        ]}
      />
      <section className="card overflow-hidden">
        <ListFilters
          q={view.q}
          placeholder={p.search}
          defaults={{ status: 'all', sort: 'oldest', size: '20' }}
          resetHref={reset}
          filtered={filtered}
          selects={[
            { name: 'status', label: p.filters.status, value: view.status, options: PAYOUT_QUEUE_FILTERS.map((status) => [status, status === 'all' ? p.allOpen : t.consolePayouts.payoutStatus[status]] as [string, string]) },
            { name: 'sort', label: p.filters.sort, value: view.sort, options: AMOUNT_SORTS.map((sort) => [sort, p.sorts[sort]] as [string, string]) },
            { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), String(size)] as [string, string]) },
          ]}
        />
        <ResultsLine t={t} total={data.total} page={data.page} size={data.size} />
        <PayoutsTable t={t} locale={locale} items={data.items} back={encodeURIComponent(href({}))} />
        <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
      </section>
    </>
  );
}
