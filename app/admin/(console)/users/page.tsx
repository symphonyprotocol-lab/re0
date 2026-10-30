import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { FilterSelect } from '@/components/admin/list-controls';
import {
  ConsoleButton,
  ConsolePageHeader,
  EmptyRow,
  ExportLink,
  IconLink,
  ListToolbar,
  Monogram,
  Pagination,
  Panel,
  Pill,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { UserStatusControl } from '@/components/admin/user-status-dialog';
import { EyeIcon } from '@/components/ui/icons';
import { listConsoleUsers, type UserStatusFilter } from '@/lib/application/administration';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import {
  initialsOf,
  oneOf,
  PAGE_SIZE,
  pageNumber,
  pageWindow,
  searchTerm,
  utcDate,
} from '../list-params';
import { setUserStatusAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.users.title };
}

const STATUSES: UserStatusFilter[] = ['all', 'active', 'suspended'];

/**
 * Registered users -- design source frame `SRtSN`.
 *
 * Reads the real `user` table. Asset and call counts come from the tables
 * that own them, so an account with no activity reads zero; call metering is
 * not live yet (architecture.md 21), which is why that column is all zeroes
 * rather than invented traffic.
 *
 * The two row controls are the two things requirement.md 5.3 asks for beyond
 * the list itself: open the account, and enable or suspend it.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([
    requireAdminCapability('users'),
    searchParams,
    getMessages(),
  ]);
  const u = t.admin.users;
  const f = t.admin.filters;
  const query = searchTerm(params.q);
  const status = oneOf(params.status, STATUSES, 'all');
  const page = pageNumber(params.page);

  const { rows, total } = await listConsoleUsers({
    query,
    status,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    suspensionScope: true,
  });

  const view = pageWindow({ page, total, rows: rows.length });

  /** Keeps the search and filter on the URL when the page changes. */
  const link = (target: number) => {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (status !== 'all') next.set('status', status);
    if (target > 1) next.set('page', String(target));
    return next.size > 0 ? `/admin/users?${next.toString()}` : '/admin/users';
  };

  /*
   * A page past the end is sent to the last real one rather than rendered. The
   * footer would read `0`-`0` over an empty table on its own, which is honest
   * but useless: a stale bookmark deserves the list, not an empty page.
   */
  if (total > 0 && page > view.pageCount) redirect(link(view.pageCount));

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={u.title} description={u.description} />

      <Panel>
        {/* GET, so a filtered list is a URL an operator can keep or share. */}
        <form method="get">
          <ListToolbar placeholder={u.searchPlaceholder} name="q" defaultValue={query}>
            <FilterSelect
              name="status"
              label={f.label}
              value={status}
              options={[
                { id: 'all', label: f.all },
                { id: 'active', label: f.userActive },
                { id: 'suspended', label: f.userSuspended },
              ]}
            />
            <ConsoleButton type="submit">{t.admin.administrators.searchSubmit}</ConsoleButton>
            <ExportLink
              resource="users"
              query={query}
              status={status}
              label={t.admin.actions.export}
            />
          </ListToolbar>
        </form>

        <TableScroller>
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr>
                {u.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
                <th scope="col" className={`${TH} w-[86px]`}>
                  <span className="sr-only">{t.admin.actions.more}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow columns={u.columns.length + 1} message={u.empty} />
              ) : null}
              {rows.map((user) => (
                <tr key={user.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <TitleCell
                      title={user.displayName}
                      meta={user.email}
                      leading={<Monogram initial={initialsOf(user.displayName)} />}
                    />
                  </td>
                  <td className={TD}>
                    <Pill tone={user.planName === 'Free' ? 'neutral' : 'ok'}>{user.planName}</Pill>
                  </td>
                  <td className={TD}>{user.assets.toLocaleString('en-US')}</td>
                  <td className={TD}>{user.callsThisMonth.toLocaleString('en-US')}</td>
                  <td className={`${TD} whitespace-nowrap`}>{utcDate(user.joinedAt)}</td>
                  <td className={TD}>
                    <Pill tone={user.status === 'active' ? 'ok' : 'danger'}>
                      {user.status === 'active'
                        ? t.adminDemo.userStatus.active
                        : t.adminDemo.userStatus.suspended}
                    </Pill>
                  </td>
                  <td className={TD}>
                    <span className="flex items-center gap-1.5">
                      <IconLink label={t.admin.actions.view} href={`/admin/users/${user.id}`}>
                        <EyeIcon size={14} />
                      </IconLink>
                      <UserStatusControl
                        action={setUserStatusAction}
                        target={{
                          id: user.id,
                          displayName: user.displayName,
                          email: user.email,
                          initial: initialsOf(user.displayName),
                          status: user.status,
                          liveSessions: user.liveSessions ?? 0,
                          liveApiKeys: user.liveApiKeys ?? 0,
                          publishedAssets: user.publishedAssets ?? 0,
                        }}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <Pagination
          summary={fill(u.showing, {
            from: view.from,
            to: view.to,
            total: total.toLocaleString('en-US'),
          })}
          pages={view.pages}
          activePage={page}
          pageCount={view.pageCount}
          href={link}
          labels={t.admin.actions}
        />
      </Panel>
    </div>
  );
}
