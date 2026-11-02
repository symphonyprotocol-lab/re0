import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Fragment } from 'react';
import { financeFilter } from '@/lib/domain/admin-finance';
import { csvHref, listHref, purchasesView, PURCHASE_STATUSES, SUBSCRIPTION_STATUSES } from '@/lib/domain/admin-lists';
import { listPurchases, listSubscriptions, purchaseCounts, purchaseTrend } from '@/lib/services/admin-purchases';
import { formatCentsUsd } from '@/lib/domain/payouts';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { FinanceChart, RecordPage } from '@/components/admin/finance-chart';
import { ListFilters } from '@/components/admin/list-client';
import { Clip, LinkPager, OpenLink, PageHead, Person, RecordSection, RecordsTable, ResultsLine, Subline, SummaryCards, Tag } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleUsers.purchases.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * `/admin/purchases` (prototype admin-records.js, kind `purchases`): two tabs
 * as links in the top bar, 充值交易 (default) and Plan 订阅, each with its own cards,
 * filters and CSV. Read-only: refunds happen in Paddle.
 */
export default async function PurchasesPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const c = t.consolePayouts;
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
  const person = (row: { userId: string; name: string; email: string }) => (
    <Person key="user" name={row.name} email={row.email} href={`/admin/users/${row.userId}?tab=purchases&from=${back}`} />
  );
  const size = [20, 50, 100].map((value) => [String(value), fill(l.rows, { n: value })] as [string, string]);
  const card = (label: string, value: number, status: string) => ({ label, value: n(value), href: href({ status }), active: view.status === status, title: fill(l.filterBy, { label }) });

  return (
    <ConsolePage>
      <ConsoleTopbar
        crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: p.title }]}
        actions={
          <nav className="admin-ree-inline-tabs" aria-label={p.tabs.label}>
            {(['transactions', 'subscriptions'] as const).map((tab) => (
              <Link
                key={tab}
                href={listHref('/admin/purchases', { size: view.size }, { tab })}
                className={view.tab === tab ? 'active' : ''}
                aria-current={view.tab === tab ? 'page' : undefined}
              >
                {p.tabs[tab]}
              </Link>
            ))}
          </nav>
        }
      />
      <RecordPage kind="purchases" finance={!subscriptions}>
        <PageHead title={p.title} lede={p.lede} />
        <SummaryCards
          label={c.summary}
          items={
            subscriptions
              ? [
                  { label: p.cards.subscriptions, value: n(counts.subscriptions.total), href: resetHref, active: !filtered, title: c.clear.subscriptions },
                  card(p.cards.active, counts.subscriptions.active, 'active'),
                  card(p.cards.cancelled, counts.subscriptions.cancelled, 'cancelled'),
                  card(p.cards.expired, counts.subscriptions.expired, 'expired'),
                ]
              : [
                  { label: p.cards.total, value: n(counts.purchases.total), href: resetHref, active: !filtered, title: c.clear.records },
                  card(p.cards.paid, counts.purchases.paid, 'paid'),
                  card(p.cards.refunded, counts.purchases.refunded, 'refunded'),
                  card(p.cards.chargeback, counts.purchases.chargeback, 'chargeback'),
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
        <RecordSection>
          <ListFilters
            q={view.q}
            placeholder={subscriptions ? p.searchSubscriptions : p.search}
            defaults={{ status: 'all', kind: 'all', period: 'all', sort: 'newest', size: '20' }}
            resetHref={resetHref}
            filtered={filtered}
            selects={
              subscriptions
                ? [
                    { name: 'status', label: l.status, aria: c.aria.status, value: view.status, options: [['all', l.allStatuses], ...SUBSCRIPTION_STATUSES.map((s) => [s, p.subscriptionStatus[s]] as [string, string])] },
                    { name: 'period', label: l.time, aria: c.aria.period, value: view.period, options: period },
                    { name: 'sort', label: l.sort, aria: c.aria.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest]] },
                    { name: 'size', label: l.perPage, aria: c.aria.size, value: String(view.size), options: size },
                  ]
                : [
                    { name: 'status', label: l.status, aria: c.aria.status, value: view.status, options: [['all', l.allStatuses], ...PURCHASE_STATUSES.map((s) => [s, p.status[s]] as [string, string])] },
                    { name: 'kind', label: p.filters.kind, aria: c.aria.kind, value: view.kind, options: [['all', p.allKinds], ['plan', p.kinds.plan], ['pack', p.kinds.pack]] },
                    {
                      name: 'sort',
                      label: l.sort,
                      aria: c.aria.sort,
                      value: view.sort,
                      options: [['newest', l.newest], ['oldest', l.oldest], ['amount-high', l.amountHigh], ['amount-low', l.amountLow]],
                    },
                    { name: 'size', label: l.perPage, aria: c.aria.size, value: String(view.size), options: size },
                  ]
            }
          >
            {!subscriptions && <input type="hidden" name="period" value={view.period} />}
          </ListFilters>
          <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/purchases', view)} />
          {subscriptionRows ? (
            <RecordsTable
              actions
              label={l.tableRegion}
              empty={l.empty}
              head={[p.subscriptionColumns.user, p.subscriptionColumns.status, p.subscriptionColumns.renewal, p.subscriptionColumns.planRemaining, p.subscriptionColumns.periodEnd, p.subscriptionColumns.created, p.subscriptionColumns.action]}
              rows={subscriptionRows.items.map((row) => [
                person(row),
                <Fragment key="status">
                  <Tag tone={row.status === 'active' ? 'green' : row.status === 'cancelled' ? 'orange' : 'grey'}>{p.subscriptionStatus[row.status]}</Tag>
                  <Subline>
                    <Clip value={row.paddleSubscriptionId} className="mono" />
                  </Subline>
                </Fragment>,
                row.status === 'active' && !row.cancelAtPeriodEnd ? p.renewalOn : p.renewalOff,
                <span key="remaining" className="mono">
                  {n(row.planRemaining)}
                </span>,
                time(row.currentPeriodEnd),
                time(row.createdAt),
                <OpenLink key="action" href={`/admin/users/${row.userId}?tab=purchases&from=${back}`}>
                  {p.userDetail}
                </OpenLink>,
              ])}
            />
          ) : (
            <RecordsTable
              actions
              label={l.tableRegion}
              empty={l.empty}
              head={[p.columns.user, p.columns.typeAmount, p.columns.transaction, p.columns.credits, p.columns.statusTime, p.columns.action]}
              rows={(purchaseRows?.items ?? []).map((row) => [
                person(row),
                <Fragment key="type">
                  <strong className="mono">{row.currency === 'USD' ? formatCentsUsd(row.amountMinor) : `${(row.amountMinor / 100).toFixed(2)} ${row.currency}`}</strong>
                  <Subline>
                    {p.kinds[row.kind]}
                    {row.quantity > 1 && ` ${fill(p.quantity, { n: row.quantity })}`}
                  </Subline>
                </Fragment>,
                <Clip key="txn" value={row.paddleTransactionId} className="mono record-id" />,
                <Fragment key="credits">
                  {n(row.credits)}
                  {row.reversedCredits > 0 && <Subline>{fill(p.reversed, { n: n(row.reversedCredits) })}</Subline>}
                </Fragment>,
                <Fragment key="status">
                  <Tag tone={row.status === 'paid' ? 'green' : row.status === 'refunded' ? 'grey' : 'red'}>{p.status[row.status]}</Tag>
                  <Subline>{time(row.createdAt)}</Subline>
                </Fragment>,
                <OpenLink key="action" href={`/admin/purchases/${row.id}?from=${back}`}>
                  {p.transaction}
                </OpenLink>,
              ])}
            />
          )}
          <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
        </RecordSection>
      </RecordPage>
    </ConsolePage>
  );
}
