import type { Metadata } from 'next';
import Link from 'next/link';
import { csvHref, listHref, usersView, ACCOUNT_STATUSES, MEMBERSHIP_STATES, USER_KYC_STATES } from '@/lib/domain/admin-lists';
import { USER_ROLES } from '@/lib/domain/roles';
import { listUsers, userCounts } from '@/lib/services/admin-users';
import { serverMessages } from '@/i18n/server';
import { formatDateTime, formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, RecordsTable, ResultsLine, RoleBadge, SummaryCards, Tag } from '@/components/admin/list-kit';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleUsers.users.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** `/admin/users` (prototype admin-records.js, kind `users`): combined filters, server paging, CSV of every match. */
export default async function UsersPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const u = t.consoleUsers.users;
  const l = t.console.list;
  const view = usersView(await searchParams);
  const [data, counts] = await Promise.all([listUsers(view), userCounts()]);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/users', current, changes);
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || ['status', 'role', 'membership', 'kyc', 'period'].some((key) => view[key as keyof typeof view] !== 'all') || view.sort !== 'newest';
  const back = encodeURIComponent(href({}));
  return (
    <>
      <PageHead crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: u.title }]} title={u.title} lede={u.lede} />
      <SummaryCards
        items={[
          { label: u.cards.total, value: n(counts.total), href: listHref('/admin/users', { size: view.size }), active: !filtered, title: l.clearFilters },
          { label: u.cards.activePlans, value: n(counts.activePlans), href: href({ membership: 'active' }), active: view.membership === 'active' },
          { label: u.cards.verified, value: n(counts.verified), href: href({ role: 'verified' }), active: view.role === 'verified' },
          { label: u.cards.disabled, value: n(counts.disabled), href: href({ status: 'disabled' }), active: view.status === 'disabled' },
        ]}
      />
      <section className="card overflow-hidden">
        <ListFilters
          q={view.q}
          placeholder={u.search}
          defaults={{ status: 'all', role: 'all', membership: 'all', kyc: 'all', period: 'all', sort: 'newest', size: '20' }}
          resetHref={listHref('/admin/users', { size: view.size })}
          filtered={filtered}
          selects={[
            { name: 'status', label: u.filters.status, value: view.status, options: [['all', u.allStatuses], ...ACCOUNT_STATUSES.map((s) => [s, u.status[s]] as [string, string])] },
            { name: 'role', label: u.filters.role, value: view.role, options: [['all', u.allRoles], ...USER_ROLES.map((r) => [r, t.console.roles[r]] as [string, string])] },
            { name: 'membership', label: u.filters.membership, value: view.membership, options: [['all', u.allMemberships], ...MEMBERSHIP_STATES.map((m) => [m, u.membership[m]] as [string, string])] },
            { name: 'kyc', label: u.filters.kyc, value: view.kyc, options: [['all', u.allKyc], ...USER_KYC_STATES.map((k) => [k, u.kyc[k]] as [string, string])] },
            { name: 'period', label: u.filters.period, value: view.period, options: [['all', l.allTime], ['7', l.last7], ['30', l.last30], ['90', l.last90]] },
            { name: 'sort', label: u.filters.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest]] },
            { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), String(size)] as [string, string]) },
          ]}
        />
        <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/users', view)} />
        <RecordsTable
          label={l.tableRegion}
          empty={l.empty}
          head={[u.columns.user, u.columns.role, u.columns.status, u.columns.credits, u.columns.kyc, u.columns.joined, u.columns.action]}
          rows={data.items.map((row) => [
            <div key="user" className="max-w-[240px] min-w-0">
              <Link href={`/admin/users/${row.id}?from=${back}`} className="block truncate font-semibold hover:text-blue" title={row.name}>
                {row.name}
              </Link>
              <small className="block truncate text-muted" title={row.email}>
                {row.email}
              </small>
            </div>,
            <div key="role" className="flex flex-col items-start gap-1">
              <RoleBadge t={t} role={row.role} showNormal />
              <Link href={`/admin/users/${row.id}?tab=roles&from=${back}`} className="text-link text-[11px]">
                {u.manageRole}
              </Link>
            </div>,
            <div key="status" className="flex flex-col items-start gap-1">
              <Tag tone={row.status === 'active' ? 'green' : 'red'}>{u.status[row.status]}</Tag>
              <small className="text-muted">
                {u.plan} · {u.membership[row.membership]}
              </small>
            </div>,
            <span key="credits" className="font-mono">
              {n(row.plan + row.pack + row.earned + row.welcome)}
            </span>,
            row.role === 'official' ? (
              <Tag key="kyc">{u.kycExempt}</Tag>
            ) : (
              <Tag key="kyc" tone={row.kyc === 'verified' ? 'green' : row.kyc === 'rejected' ? 'red' : row.kyc === 'none' ? 'grey' : 'orange'}>
                {u.kyc[row.kyc]}
              </Tag>
            ),
            <span key="joined" className="whitespace-nowrap">
              {formatDateTime(row.createdAt, locale)}
            </span>,
            <Link key="action" href={`/admin/users/${row.id}?from=${back}`} className="btn-secondary btn-sm">
              {u.details}
            </Link>,
          ])}
        />
        <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
      </section>
    </>
  );
}
