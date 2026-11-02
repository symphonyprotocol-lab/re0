import type { Metadata } from 'next';
import Link from 'next/link';
import { csvHref, KYC_DEFAULTS, KYC_FILTERS, kycView, listHref, RECENT_PERIODS } from '@/lib/domain/admin-lists';
import { listKyc } from '@/lib/services/kyc';
import { serverMessages } from '@/i18n/server';
import { formatDateTime, formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, RecordsTable, ResultsLine, RoleBadge, SummaryCards } from '@/components/admin/list-kit';
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
  const k = t.consolePayouts.kyc;
  const l = t.console.list;
  const view = kycView(await searchParams);
  const data = await listKyc(view);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/kyc', current, changes, KYC_DEFAULTS);
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'all' || view.period !== 'all' || view.sort !== 'oldest';
  const back = encodeURIComponent(href({}));
  const periods: Record<string, string> = { all: l.allTime, '7': l.last7, '30': l.last30, '90': l.last90 };
  return (
    <>
      <PageHead crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: k.title }]} title={k.title} lede={k.lede} />
      <SummaryCards
        items={(['all', 'pending', 'verified', 'rejected'] as const).map((status) => ({
          label: k.cards[status],
          value: n(data.counts[status] ?? 0),
          href: status === 'all' ? listHref('/admin/kyc', { size: view.size }, {}, KYC_DEFAULTS) : href({ status }),
          active: status === 'all' ? !filtered : view.status === status,
          title: status === 'all' ? l.clearFilters : undefined,
        }))}
      />
      <section className="card overflow-hidden">
        <ListFilters
          q={view.q}
          placeholder={k.search}
          defaults={{ status: 'all', period: 'all', sort: 'oldest', size: '20' }}
          resetHref={listHref('/admin/kyc', { size: view.size }, {}, KYC_DEFAULTS)}
          filtered={filtered}
          selects={[
            { name: 'status', label: k.filters.status, value: view.status, options: KYC_FILTERS.map((status) => [status, status === 'all' ? k.allStatuses : t.consolePayouts.kycStatus[status]] as [string, string]) },
            { name: 'period', label: k.filters.period, value: view.period, options: RECENT_PERIODS.map((period) => [period, periods[period]!] as [string, string]) },
            { name: 'sort', label: k.filters.sort, value: view.sort, options: [['oldest', l.oldest], ['newest', l.newest]] },
            { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), String(size)] as [string, string]) },
          ]}
        />
        <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/kyc', view, KYC_DEFAULTS)} />
        <RecordsTable
          label={l.tableRegion}
          empty={l.empty}
          head={[k.columns.applicant, k.columns.submission, k.columns.status, k.columns.submitted, k.columns.reviewer, k.columns.action]}
          rows={data.items.map((row) => [
            <div key="applicant" className="max-w-[240px] min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <Link href={`/admin/users/${row.userId}?tab=kyc&from=${back}`} className="truncate font-semibold hover:text-blue" title={row.name}>
                  {row.name}
                </Link>
                <RoleBadge t={t} role={row.role} />
              </span>
              <small className="block truncate text-muted" title={row.email}>
                {row.email}
              </small>
            </div>,
            <div key="submission" className="max-w-[260px] min-w-[160px]">
              <span className="block truncate" title={row.legalName ?? ''}>
                {row.legalName ?? '—'}
              </span>
              <small className="block truncate text-muted">
                {row.country ?? '—'} · {row.documentKind ? t.payouts.kyc.kinds[row.documentKind] : '—'} {row.documentLast4 ? `•••• ${row.documentLast4}` : ''}
              </small>
              <small className="block text-muted">
                {row.taxForm ?? '—'} · {row.declared ? k.declared : k.notDeclared}
              </small>
            </div>,
            <div key="status" className="flex flex-col items-start gap-1">
              <KycStatusTag t={t} status={row.status} />
              {row.resetAt && <small className="text-muted">{k.superseded}</small>}
              {row.filesDeleted && <small className="text-muted">{k.filesDeleted}</small>}
            </div>,
            <span key="submitted" className="whitespace-nowrap">
              {formatDateTime(row.createdAt, locale)}
            </span>,
            <div key="reviewer" className="max-w-[200px] min-w-0">
              <span className="block truncate" title={row.reviewer ?? ''}>
                {row.reviewer ?? '—'}
              </span>
              {row.decidedAt && <small className="block whitespace-nowrap text-muted">{formatDateTime(row.decidedAt, locale)}</small>}
            </div>,
            <Link key="action" href={`/admin/kyc/${row.id}?from=${back}`} className={`${row.status === 'pending' ? 'btn' : 'btn-secondary'} btn-sm whitespace-nowrap`}>
              {row.status === 'pending' ? k.review : k.view}
            </Link>,
          ])}
        />
        <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
      </section>
    </>
  );
}
