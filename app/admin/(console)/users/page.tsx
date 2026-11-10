import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Fragment } from 'react';
import { redirect } from 'next/navigation';
import { csvHref, listHref, usersView, ACCOUNT_STATUSES, MEMBERSHIP_STATES, USER_KYC_STATES } from '@/lib/domain/admin-lists';
import { USER_ROLES } from '@/lib/domain/roles';
import { listUsers, userCounts } from '@/lib/services/admin-users';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, OpenLink, PageHead, Person, RecordSection, RecordsTable, ResultsLine, RoleBadge, Subline, SummaryCards, Tag } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { RecordPage } from '@/components/admin/finance-chart';
import '@/components/admin/console-users.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleUsers.users.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** `/admin/users` (prototype admin-records.js, kind `users`): combined filters, server paging, CSV of every match. */
export default async function UsersPage({ searchParams }: Props) {
  await requireAdministrator();
  const { t, locale } = await serverMessages();
  const u = t.consoleUsers.users;
  const l = t.console.list;
  const view = usersView(await searchParams);
  const [data, counts] = await Promise.all([listUsers(view), userCounts()]);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/users', current, changes);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || ['status', 'role', 'membership', 'kyc', 'period'].some((key) => view[key as keyof typeof view] !== 'all') || view.sort !== 'newest';
  const back = encodeURIComponent(href({}));
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: u.title }]} />
      <RecordPage kind="users">
        <PageHead title={u.title} lede={u.lede} />
        <SummaryCards
          label={u.summaryLabel}
          items={[
            { label: u.cards.total, value: n(counts.total), href: listHref('/admin/users', { size: view.size }), active: !filtered, title: u.clearTitle },
            { label: u.cards.activePlans, value: n(counts.activePlans), href: href({ membership: 'active' }), active: view.membership === 'active', title: fill(l.filterBy, { label: u.cards.activePlans }) },
            { label: u.cards.kycVerified, value: n(counts.kycVerified), href: href({ kyc: 'verified' }), active: view.kyc === 'verified', title: fill(l.filterBy, { label: u.cards.kycVerified }) },
            { label: u.cards.disabled, value: n(counts.disabled), href: href({ status: 'disabled' }), active: view.status === 'disabled', title: fill(l.filterBy, { label: u.cards.disabled }) },
          ]}
        />
        <RecordSection>
          <ListFilters
            variant="users"
            q={view.q}
            placeholder={u.search}
            defaults={{ status: 'all', role: 'all', membership: 'all', kyc: 'all', period: 'all', sort: 'newest', size: '20' }}
            resetHref={listHref('/admin/users', { size: view.size })}
            filtered={filtered}
            selects={[
              { name: 'size', label: l.perPage, aria: u.perPageLabel, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), fill(l.rows, { n: size })] as [string, string]) },
              { name: 'status', label: u.filters.status, aria: u.filterLabels.status, value: view.status, options: [['all', u.allStatuses], ...ACCOUNT_STATUSES.map((s) => [s, u.status[s]] as [string, string])] },
              { name: 'role', label: u.filters.role, aria: u.filterLabels.role, value: view.role, options: [['all', u.allRoles], ...USER_ROLES.map((r) => [r, t.console.roles[r]] as [string, string])] },
              { name: 'membership', label: u.filters.membership, aria: u.filterLabels.membership, value: view.membership, options: [['all', u.allMemberships], ...MEMBERSHIP_STATES.map((m) => [m, u.membership[m]] as [string, string])] },
              { name: 'kyc', label: u.filters.kyc, aria: u.filterLabels.kyc, value: view.kyc, options: [['all', u.allKyc], ...USER_KYC_STATES.map((k) => [k, u.kyc[k]] as [string, string])] },
              { name: 'period', label: u.filters.period, aria: u.filterLabels.period, value: view.period, options: [['all', l.allTime], ['7', l.last7], ['30', l.last30], ['90', l.last90]] },
              { name: 'sort', label: u.filters.sort, aria: u.filterLabels.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest]] },
            ]}
          />
          <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/users', view)} />
          <RecordsTable
            label={l.tableRegion}
            empty={l.empty}
            head={[u.columns.user, u.columns.role, u.columns.status, u.columns.credits, u.columns.kyc, u.columns.joined, u.columns.action]}
            rows={data.items.map((row) => [
              <Person key="user" name={row.name} email={row.email} href={`/admin/users/${row.id}?from=${back}`} />,
              <Fragment key="role">
                <RoleBadge t={t} role={row.role} showNormal />
                <Link href={`/admin/users/${row.id}?tab=roles&from=${back}`} className="text-link cell-subline">
                  {u.manageRole}
                </Link>
              </Fragment>,
              <Fragment key="status">
                <Tag tone={row.status === 'active' ? 'green' : 'grey'}>{u.status[row.status]}</Tag>
                <Subline>
                  {u.plan} · {u.membershipCell[row.membership]}
                </Subline>
              </Fragment>,
              <span key="credits" className="mono">
                {n(row.plan + row.pack + row.earned + row.welcome)}
              </span>,
              row.role === 'official' ? (
                <Tag key="kyc" dot={false}>
                  {u.kycExempt}
                </Tag>
              ) : (
                <Tag key="kyc" tone={row.kyc === 'verified' ? 'green' : row.kyc === 'rejected' ? 'red' : row.kyc === 'pending' ? 'orange' : 'grey'}>
                  {u.kyc[row.kyc]}
                </Tag>
              ),
              formatDateTime(row.createdAt, locale),
              <OpenLink key="action" href={`/admin/users/${row.id}?from=${back}`}>
                {u.details}
              </OpenLink>,
            ])}
          />
          <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
        </RecordSection>
      </RecordPage>
    </ConsolePage>
  );
}
