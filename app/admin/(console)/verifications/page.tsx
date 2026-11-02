import type { Metadata } from 'next';
import Link from 'next/link';
import { csvHref, listHref, verificationsView, LIST_DEFAULTS, VERIFICATION_FILTERS } from '@/lib/domain/admin-lists';
import { listVerifications } from '@/lib/services/roles';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, RecordsTable, ResultsLine, RoleBadge, SummaryCards, Tag } from '@/components/admin/list-kit';
import { VerificationStatusTag } from '@/components/admin/user-detail-roles';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleUsers.verifications.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The queue opens on pending, so its URL leaves `status=pending` out. */
const DEFAULTS = { ...LIST_DEFAULTS, status: 'pending' };

/**
 * `/admin/verifications` (prototype role-pages.js `list()`): pending first and
 * oldest first, every other view newest first; the filters live in the URL.
 */
export default async function VerificationsPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const v = t.consoleUsers.verifications;
  const l = t.console.list;
  const view = verificationsView(await searchParams);
  const data = await listVerifications(view);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/verifications', current, changes, DEFAULTS);
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'pending';
  const back = encodeURIComponent(href({}));
  const cards: { label: string; value: string; href: string; active: boolean; title?: string }[] = [
    { label: v.cards.all, value: n(data.counts.all ?? 0), href: href({ q: '', status: 'all' }), active: view.status === 'all' && !view.q, title: l.clearFilters },
    { label: v.cards.pending, value: n(data.counts.pending ?? 0), href: href({ status: 'pending' }), active: view.status === 'pending' },
    { label: v.cards.approved, value: n(data.counts.approved ?? 0), href: href({ status: 'approved' }), active: view.status === 'approved' },
    { label: v.cards.rejected, value: n(data.counts.rejected ?? 0), href: href({ status: 'rejected' }), active: view.status === 'rejected' },
  ];
  /* Closed requests are rare (only a role change closes one): their card shows once there are any. */
  if ((data.counts.closed ?? 0) > 0 || view.status === 'closed') {
    cards.push({ label: v.cards.closed, value: n(data.counts.closed ?? 0), href: href({ status: 'closed' }), active: view.status === 'closed' });
  }
  return (
    <>
      <PageHead crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: v.title }]} title={v.title} lede={v.lede} />
      <SummaryCards items={cards} />
      <section className="card overflow-hidden">
        <ListFilters
          q={view.q}
          placeholder={v.search}
          defaults={{ status: 'pending', size: '20' }}
          resetHref={listHref('/admin/verifications', { size: view.size }, {}, DEFAULTS)}
          filtered={filtered}
          selects={[
            {
              name: 'status',
              label: v.filters.status,
              value: view.status,
              options: VERIFICATION_FILTERS.map((status) => [status, status === 'all' ? v.allStatuses : v.status[status]] as [string, string]),
            },
            { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), String(size)] as [string, string]) },
          ]}
        />
        <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/verifications', view, DEFAULTS)} />
        <RecordsTable
          label={l.tableRegion}
          empty={l.empty}
          head={[v.columns.applicant, v.columns.statement, v.columns.snapshot, v.columns.status, v.columns.action]}
          rows={data.items.map((row) => [
            <div key="applicant" className="max-w-[240px] min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <Link href={`/admin/users/${row.userId}?tab=roles&from=${back}`} className="truncate font-semibold hover:text-blue" title={row.name}>
                  {row.name}
                </Link>
                <RoleBadge t={t} role={row.role} />
              </span>
              <small className="block truncate text-muted" title={row.email}>
                {row.email}
              </small>
              <small className="block font-mono text-[10px] break-all text-muted">{row.id}</small>
            </div>,
            <div key="statement" className="max-w-[320px] min-w-[200px]">
              <span className="line-clamp-2 break-words" title={row.statement}>
                {row.statement}
              </span>
              <small className="text-muted">{fill(v.links, { n: row.links.length })}</small>
            </div>,
            <Tag key="snapshot" tone={row.passed === 5 ? 'green' : 'orange'}>
              {fill(v.passed, { n: row.passed })}
            </Tag>,
            <div key="status" className="flex flex-col items-start gap-1">
              <VerificationStatusTag t={t} status={row.status} />
              <small className="whitespace-nowrap text-muted">{formatDateTime(row.createdAt, locale)}</small>
              {row.closedByRoleChange && <small className="text-muted">{v.closedByRole}</small>}
            </div>,
            <Link key="action" href={`/admin/verifications/${row.id}?from=${back}`} className={`${row.status === 'pending' ? 'btn' : 'btn-secondary'} btn-sm whitespace-nowrap`}>
              {row.status === 'pending' ? v.review : v.view}
            </Link>,
          ])}
        />
        <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
      </section>
    </>
  );
}
