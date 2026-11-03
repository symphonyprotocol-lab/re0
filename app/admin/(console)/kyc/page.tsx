import type { Metadata } from 'next';
import { Fragment } from 'react';
import { redirect } from 'next/navigation';
import { csvHref, KYC_DEFAULTS, KYC_FILTERS, kycView, listHref, RECENT_PERIODS } from '@/lib/domain/admin-lists';
import { listKyc } from '@/lib/services/kyc';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { Clip, LinkPager, OpenLink, PageHead, Person, RecordSection, RecordsTable, ResultsLine, Subline, SummaryCards } from '@/components/admin/list-kit';
import { RecordPage } from '@/components/admin/finance-chart';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { KycStatusTag } from '@/components/admin/payout-kit';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consolePayouts.kyc.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * `/admin/kyc` (2.5 "KYC 记录", prototype manual-kyc.js `page`,
 * admin-records.js): every submission, oldest first, filtered by status and
 * time in the URL, exported as CSV with the same filters.
 */
export default async function KycPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const c = t.consolePayouts;
  const k = c.kyc;
  const l = t.console.list;
  const view = kycView(await searchParams);
  const data = await listKyc(view);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/kyc', current, changes, KYC_DEFAULTS);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'all' || view.period !== 'all' || view.sort !== 'oldest';
  const back = encodeURIComponent(href({}));
  const periods: Record<string, string> = { all: l.allTime, '7': l.last7, '30': l.last30, '90': l.last90 };
  const size = [20, 50, 100].map((value) => [String(value), fill(l.rows, { n: value })] as [string, string]);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: k.title }]} />
      <RecordPage kind="kyc">
        <PageHead title={k.title} lede={k.lede} />
        <SummaryCards
          label={c.summary}
          items={(['all', 'pending', 'verified', 'rejected'] as const).map((status) => ({
            label: k.cards[status],
            value: n(data.counts[status] ?? 0),
            href: status === 'all' ? listHref('/admin/kyc', { size: view.size }, {}, KYC_DEFAULTS) : href({ status }),
            active: status === 'all' ? !filtered : view.status === status,
            title: status === 'all' ? c.clear.kyc : fill(l.filterBy, { label: k.cards[status] }),
          }))}
        />
        <RecordSection>
          <ListFilters
            q={view.q}
            placeholder={k.search}
            defaults={{ status: 'all', period: 'all', sort: 'oldest', size: '20' }}
            resetHref={listHref('/admin/kyc', { size: view.size }, {}, KYC_DEFAULTS)}
            filtered={filtered}
            selects={[
              { name: 'status', label: l.status, aria: c.aria.status, value: view.status, options: KYC_FILTERS.map((status) => [status, status === 'all' ? k.allStatuses : t.consolePayouts.kycStatus[status]] as [string, string]) },
              { name: 'period', label: l.time, aria: c.aria.period, value: view.period, options: RECENT_PERIODS.map((period) => [period, periods[period]!] as [string, string]) },
              { name: 'sort', label: l.sort, aria: c.aria.sort, value: view.sort, options: [['oldest', l.oldest], ['newest', l.newest]] },
              { name: 'size', label: l.perPage, aria: c.aria.size, value: String(view.size), options: size },
            ]}
          />
          <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/kyc', view, KYC_DEFAULTS)} />
          <RecordsTable
            actions
            label={l.tableRegion}
            empty={l.empty}
            head={[k.columns.applicant, k.columns.submission, k.columns.status, k.columns.submitted, k.columns.reviewer, k.columns.action]}
            rows={data.items.map((row) => [
              <Person key="applicant" name={row.name} email={row.email} href={`/admin/users/${row.userId}?tab=kyc&from=${back}`} />,
              <Fragment key="submission">
                <Clip value={[row.legalName, row.country].filter(Boolean).join(' · ') || null} />
                <Subline>
                  {row.taxForm ?? '—'} · {row.documentLast4 ? `•••• ${row.documentLast4}` : '—'}
                </Subline>
              </Fragment>,
              <Fragment key="status">
                <KycStatusTag t={t} status={row.status} />
                {row.resetAt && <Subline>{k.superseded}</Subline>}
                {row.filesDeleted && <Subline>{k.filesDeleted}</Subline>}
              </Fragment>,
              formatDateTime(row.createdAt, locale),
              <Fragment key="reviewer">
                <Clip value={row.reviewer} />
                {row.decidedAt && <Subline>{formatDateTime(row.decidedAt, locale)}</Subline>}
              </Fragment>,
              <OpenLink key="action" href={`/admin/kyc/${row.id}?from=${back}`}>
                {row.status === 'pending' ? k.review : l.details}
              </OpenLink>,
            ])}
          />
          <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
        </RecordSection>
      </RecordPage>
    </ConsolePage>
  );
}
