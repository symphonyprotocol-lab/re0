import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { financeFilter } from '@/lib/domain/admin-finance';
import { csvHref, listHref, purchasesView, PURCHASE_STATUSES, SUBSCRIPTION_STATUSES } from '@/lib/domain/admin-lists';
import { listPurchases, listSubscriptions, purchaseCounts, purchaseTrend } from '@/lib/services/admin-purchases';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber, formatUsd } from '@/i18n/format';
import { FinanceChart } from '@/components/admin/finance-chart';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, RecordsTable, ResultsLine, SummaryCards, Tag } from '@/components/admin/list-kit';
import { ConsoleTopbar } from '@/components/admin/console-topbar';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleUsers.purchases.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const SIZES = [20, 50, 100].map((size) => [String(size), String(size)] as [string, string]);

/**
 * `/admin/purchases` (prototype admin-records.js, kind `purchases`): two tabs
 * as links in the top bar, 充值交易 (default) and Plan 订阅, each with its own cards,
 * filters and CSV. Read-only: refunds happen in Paddle.
 */
export default async function PurchasesPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const p = t.consoleUsers.purchases;
  const l = t.console.list;
  const view = purchasesView(await searchParams);
  const subscriptions = view.tab === 'subscriptions';
  const [subscriptionRows, purchaseRows, counts, trend] = await Promise.all([
    subscriptions ? listSubscriptions(view) : null,
    subscriptions ? null : listPurchases(view),
    purchaseCounts(),
    subscriptions ? null : purchaseTrend(view),
  ]);
  const data = (subscriptionRows ?? purchaseRows)!;
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/purchases', current, changes);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const time = (value: Date | null) => (value ? formatDateTime(value, locale) : '—');
  const filtered = Boolean(view.q) || view.status !== 'all' || view.kind !== 'all' || view.period !== 'all' || view.sort !== 'newest';
  const resetHref = listHref('/admin/purchases', { tab: view.tab, size: view.size, metric: view.metric });
  const back = encodeURIComponent(href({}));
  const period: [string, string][] = [['all', l.allTime], ['7', l.last7], ['30', l.last30], ['90', l.last90]];
  const user = (row: { userId: string; name: string; email: string }, tab: 'summary' | 'purchases' = 'summary') => (
    <div key="user" className="max-w-[240px] min-w-0">
      <Link href={`/admin/users/${row.userId}?${tab === 'purchases' ? 'tab=purchases&' : ''}from=${back}`} className="block truncate font-semibold hover:text-blue" title={row.name}>
        {row.name}
      </Link>
      <small className="block truncate text-muted" title={row.email}>
        {row.email}
      </small>
    </div>
  );

  return (
    <>
      <ConsoleTopbar
        crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: p.title }]}
        tabs={(['transactions', 'subscriptions'] as const).map((tab) => ({
          label: p.tabs[tab],
          href: listHref('/admin/purchases', { size: view.size }, { tab }),
          active: view.tab === tab,
        }))}
        tabsLabel={p.tabs.label}
      />
      <PageHead title={p.title} lede={p.lede} />
      <SummaryCards
        items={
          subscriptions
            ? [
                { label: p.cards.subscriptions, value: n(counts.subscriptions.total), href: resetHref, active: !filtered, title: l.clearFilters },
                { label: p.cards.active, value: n(counts.subscriptions.active), href: href({ status: 'active' }), active: view.status === 'active' },
                { label: p.cards.cancelled, value: n(counts.subscriptions.cancelled), href: href({ status: 'cancelled' }), active: view.status === 'cancelled' },
                { label: p.cards.expired, value: n(counts.subscriptions.expired), href: href({ status: 'expired' }), active: view.status === 'expired' },
              ]
            : [
                { label: p.cards.total, value: n(counts.purchases.total), href: resetHref, active: !filtered, title: l.clearFilters },
                { label: p.cards.paid, value: n(counts.purchases.paid), href: href({ status: 'paid' }), active: view.status === 'paid' },
                { label: p.cards.refunded, value: n(counts.purchases.refunded), href: href({ status: 'refunded' }), active: view.status === 'refunded' },
                { label: p.cards.chargeback, value: n(counts.purchases.chargeback), href: href({ status: 'chargeback' }), active: view.status === 'chargeback' },
              ]
        }
      />
      {trend && (
        <FinanceChart
          kind="purchases"
          trend={trend}
          metric={view.metric}
          metricHrefs={{ amount: href({ metric: 'amount' }), count: href({ metric: 'count' }) }}
          filter={financeFilter(view)}
        />
      )}
      <section className="card overflow-hidden">
        <ListFilters
          q={view.q}
          placeholder={subscriptions ? p.searchSubscriptions : p.search}
          defaults={{ status: 'all', kind: 'all', period: 'all', sort: 'newest', size: '20' }}
          resetHref={resetHref}
          filtered={filtered}
          selects={
            subscriptions
              ? [
                  { name: 'status', label: p.filters.status, value: view.status, options: [['all', l.allStatuses], ...SUBSCRIPTION_STATUSES.map((s) => [s, p.subscriptionStatus[s]] as [string, string])] },
                  { name: 'period', label: p.filters.period, value: view.period, options: period },
                  { name: 'sort', label: p.filters.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest]] },
                  { name: 'size', label: l.perPage, value: String(view.size), options: SIZES },
                ]
              : [
                  { name: 'status', label: p.filters.status, value: view.status, options: [['all', l.allStatuses], ...PURCHASE_STATUSES.map((s) => [s, p.status[s]] as [string, string])] },
                  { name: 'kind', label: p.filters.kind, value: view.kind, options: [['all', p.allKinds], ['plan', p.kinds.plan], ['pack', p.kinds.pack]] },
                  {
                    name: 'sort',
                    label: p.filters.sort,
                    value: view.sort,
                    options: [['newest', l.newest], ['oldest', l.oldest], ['amount-high', l.amountHigh], ['amount-low', l.amountLow]],
                  },
                  { name: 'size', label: l.perPage, value: String(view.size), options: SIZES },
                ]
          }
        />
        <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/purchases', view)} />
        {subscriptionRows ? (
          <RecordsTable
            actions
            label={l.tableRegion}
            empty={l.empty}
            head={[p.subscriptionColumns.user, p.subscriptionColumns.status, p.subscriptionColumns.renewal, p.subscriptionColumns.planRemaining, p.subscriptionColumns.periodEnd, p.subscriptionColumns.created, p.subscriptionColumns.action]}
            rows={subscriptionRows.items.map((row) => [
              user(row),
              <div key="status" className="flex flex-col items-start gap-1">
                <Tag tone={row.status === 'active' ? 'green' : row.status === 'cancelled' ? 'orange' : 'grey'}>{p.subscriptionStatus[row.status]}</Tag>
                <small className="block max-w-[180px] font-mono text-[10px] break-all text-muted">{row.paddleSubscriptionId}</small>
              </div>,
              row.status === 'active' && !row.cancelAtPeriodEnd ? (
                <Tag key="renewal" tone="green">
                  {p.renewalOn}
                </Tag>
              ) : (
                <Tag key="renewal">{p.renewalOff}</Tag>
              ),
              <span key="remaining" className="font-mono">
                {n(row.planRemaining)}
              </span>,
              <span key="end" className="whitespace-nowrap">
                {time(row.currentPeriodEnd)}
              </span>,
              <span key="created" className="whitespace-nowrap">
                {time(row.createdAt)}
              </span>,
              <Link key="action" href={`/admin/users/${row.userId}?tab=purchases&from=${back}`} className="btn-secondary btn-sm">
                {p.userDetail}
              </Link>,
            ])}
          />
        ) : (
          <RecordsTable
            actions
            label={l.tableRegion}
            empty={l.empty}
            head={[p.columns.user, p.columns.typeAmount, p.columns.transaction, p.columns.credits, p.columns.statusTime, p.columns.action]}
            rows={(purchaseRows?.items ?? []).map((row) => [
              user(row, 'purchases'),
              <div key="type">
                <strong className="font-mono whitespace-nowrap">
                  {row.currency === 'USD' ? formatUsd(row.amountMinor, locale) : `${(row.amountMinor / 100).toFixed(2)} ${row.currency}`}
                </strong>
                <small className="block text-muted">
                  {p.kinds[row.kind]}
                  {row.quantity > 1 && ` ${fill(p.quantity, { n: row.quantity })}`}
                </small>
              </div>,
              <span key="txn" className="block max-w-[200px] font-mono text-[11px] break-all" title={row.paddleTransactionId}>
                {row.paddleTransactionId}
              </span>,
              <div key="credits">
                <span className="font-mono">{n(row.credits)}</span>
                {row.reversedCredits > 0 && <small className="block text-red">{fill(p.reversed, { n: n(row.reversedCredits) })}</small>}
              </div>,
              <div key="status" className="flex flex-col items-start gap-1">
                <Tag tone={row.status === 'paid' ? 'green' : row.status === 'refunded' ? 'orange' : 'red'}>{p.status[row.status]}</Tag>
                <small className="whitespace-nowrap text-muted">{time(row.createdAt)}</small>
              </div>,
              <Link key="action" href={`/admin/purchases/${row.id}?from=${back}`} className="btn-secondary btn-sm">
                {p.transaction}
              </Link>,
            ])}
          />
        )}
        <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
      </section>
    </>
  );
}
