import type { Metadata } from 'next';
import { ExpertControls } from '@/components/admin/expert-controls';
import { FilterSelect } from '@/components/admin/list-controls';
import {
  ConsoleButton,
  ConsoleNotice,
  ConsolePageHeader,
  EmptyRow,
  ExportLink,
  IconLink,
  ListToolbar,
  Pagination,
  Panel,
  Pill,
  TabBar,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { AwardIcon, EyeIcon } from '@/components/ui/icons';
import {
  EXPERT_FILTERS,
  listExpertApplications,
  type ExpertFilter,
} from '@/lib/application/expert-libraries';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { initialsOf, oneOf, PAGE_SIZE, pageNumber, pageWindow, searchTerm, utcStamp } from '../list-params';
import { decideExpertAction, revokeExpertAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.expertLibraries.title };
}

const STATUS_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'danger',
  revoked: 'neutral',
  withdrawn: 'neutral',
};

const LIFECYCLE_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  published: 'ok',
  suspended: 'danger',
  archived: 'neutral',
};

/** A stored enum through its dictionary, with the raw value as the fallback. */
function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/**
 * The expert-library queue -- expert-library-prd.md 6.2.
 *
 * Pending applications first, oldest at the top. The subscription and
 * lifecycle columns are the library *now*, not at the time of applying:
 * an approval re-checks both, and an administrator should see a library
 * that has since gone private before opening it.
 */
export default async function AdminExpertLibrariesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([
    requireAdminCapability('expertLibraries'),
    searchParams,
    getMessages(),
  ]);
  const x = t.admin.expertLibraries;
  const d = t.admin.expertDetail;
  const f = t.admin.filters;
  const lifecycle = t.dashboard.libraryDetail.lifecycle;
  const query = searchTerm(params.q);
  const status = oneOf(params.status, EXPERT_FILTERS, 'pending');
  const page = pageNumber(params.page);

  const { rows, total, counts } = await listExpertApplications({
    query,
    status,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const view = pageWindow({ page, total, rows: rows.length });

  const link = (next: { status?: ExpertFilter; page?: number }) => {
    const search = new URLSearchParams();
    if (query) search.set('q', query);
    const filter = next.status ?? status;
    if (filter !== 'pending') search.set('status', filter);
    const target = next.page ?? 1;
    if (target > 1) search.set('page', String(target));
    return `/admin/expert-libraries${search.size > 0 ? `?${search.toString()}` : ''}`;
  };
  const href = (next: ExpertFilter) => link({ status: next });

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={x.title} description={x.description} />

      <TabBar
        activeId={status}
        tabs={[
          { id: 'pending', label: x.tabs.pending, count: counts.pending, href: href('pending') },
          { id: 'approved', label: x.tabs.approved, count: counts.approved, href: href('approved') },
          { id: 'rejected', label: x.tabs.rejected, count: counts.rejected, href: href('rejected') },
          { id: 'revoked', label: x.tabs.revoked, count: counts.revoked, href: href('revoked') },
          { id: 'withdrawn', label: x.tabs.withdrawn, count: counts.withdrawn, href: href('withdrawn') },
          { id: 'all', label: x.tabs.all, count: counts.all, href: href('all') },
        ]}
      />

      <ConsoleNotice icon={<AwardIcon size={18} />} title={x.ruleTitle} body={x.rule} />

      <Panel>
        <form method="get">
          <ListToolbar placeholder={x.searchPlaceholder} name="q" defaultValue={query}>
            <FilterSelect
              name="status"
              label={f.label}
              value={status}
              options={[
                { id: 'all', label: f.all },
                ...EXPERT_FILTERS.filter((filter) => filter !== 'all').map((filter) => ({
                  id: filter,
                  label: label(d.statuses, filter),
                })),
              ]}
            />
            <ConsoleButton type="submit">{t.admin.administrators.searchSubmit}</ConsoleButton>
            <ExportLink
              resource="expert-libraries"
              query={query}
              status={status}
              label={t.admin.actions.export}
            />
          </ListToolbar>
        </form>

        <TableScroller>
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr>
                {x.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
                <th scope="col" className={`${TH} w-[110px]`}>
                  <span className="sr-only">{t.admin.actions.more}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow
                  columns={x.columns.length + 1}
                  message={x.empty}
                  note={counts.all === 0 ? t.admin.notReady.expertLibraries : undefined}
                />
              ) : null}
              {rows.map((row) => (
                <tr key={row.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <TitleCell title={row.libraryTitle} meta={row.libraryPublicId} />
                  </td>
                  <td className={TD}>{row.workspaceName || '—'}</td>
                  <td className={TD}>
                    <Pill tone={row.ownerSubscribed ? 'ok' : 'danger'}>
                      {row.ownerSubscribed ? d.subscribed : d.unsubscribed}
                    </Pill>
                  </td>
                  <td className={TD}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={row.visibility === 'public' ? 'brand' : 'neutral'}>
                        {row.visibility === 'public'
                          ? t.dashboard.libraries.scopePublic
                          : t.dashboard.libraries.scopePrivate}
                      </Pill>
                      <Pill tone={LIFECYCLE_TONE[row.lifecycleStatus] ?? 'warn'}>
                        {label(lifecycle, row.lifecycleStatus)}
                      </Pill>
                    </span>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(row.createdAt)}</td>
                  <td className={TD}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={STATUS_TONE[row.status] ?? 'neutral'}>
                        {label(d.statuses, row.status)}
                      </Pill>
                      {row.expertTaggedAt && row.status !== 'approved' ? (
                        <Pill tone="brand">{d.taggedBadge}</Pill>
                      ) : null}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="flex items-center gap-1.5">
                      <IconLink
                        label={t.admin.actions.view}
                        href={`/admin/expert-libraries/${encodeURIComponent(row.id)}`}
                      >
                        <EyeIcon size={14} />
                      </IconLink>
                      <ExpertControls
                        target={{
                          id: row.id,
                          libraryTitle: row.libraryTitle,
                          libraryPublicId: row.libraryPublicId,
                          workspaceName: row.workspaceName || '—',
                          initial: initialsOf(row.libraryTitle),
                        }}
                        status={row.status}
                        approvable={row.approvable}
                        decideAction={decideExpertAction}
                        revokeAction={revokeExpertAction}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <Pagination
          summary={fill(x.showing, { from: view.from, to: view.to, total })}
          pages={view.pages}
          activePage={page}
          pageCount={view.pageCount}
          href={(target) => link({ page: target })}
          labels={t.admin.actions}
        />
      </Panel>
    </div>
  );
}
