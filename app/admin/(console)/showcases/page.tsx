import type { Metadata } from 'next';
import { ShowcaseControls } from '@/components/admin/showcase-controls';
import { FilterSelect } from '@/components/admin/list-controls';
import {
  ConsoleButton,
  ConsolePageHeader,
  EmptyRow,
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
import { ArrowUpRightIcon } from '@/components/ui/icons';
import { listConsoleShowcases, SHOWCASE_CONSOLE_FILTERS, type ShowcaseConsoleFilter } from '@/lib/application/showcase';
import { showcasePath } from '@/lib/domain/showcase';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { oneOf, PAGE_SIZE, pageNumber, pageWindow, searchTerm, utcStamp } from '../list-params';
import { moderateShowcaseAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.showcases.title };
}

const STATUS_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  published: 'ok',
  disabled: 'warn',
  taken_down: 'danger',
};

/**
 * Every showcase page across workspaces (lib/domain/showcase.ts), newest
 * first, with the one move the console has over a public page: taking it
 * down. Pages are user content on an address of ours, so a reviewer looks
 * here for what the catalogue's review never sees.
 */
export default async function AdminShowcasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([requireAdminCapability('libraries'), searchParams, getMessages()]);
  const x = t.admin.showcases;
  const s = t.dashboard.libraryDetail.showcase;
  const query = searchTerm(params.q);
  const status = oneOf(params.status, SHOWCASE_CONSOLE_FILTERS, 'published');
  const page = pageNumber(params.page);

  const { rows, total, counts } = await listConsoleShowcases({ query, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const view = pageWindow({ page, total, rows: rows.length });

  const link = (next: { status?: ShowcaseConsoleFilter; page?: number }) => {
    const search = new URLSearchParams();
    if (query) search.set('q', query);
    const filter = next.status ?? status;
    if (filter !== 'published') search.set('status', filter);
    const target = next.page ?? 1;
    if (target > 1) search.set('page', String(target));
    return `/admin/showcases${search.size > 0 ? `?${search.toString()}` : ''}`;
  };

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={x.title} description={x.description} />

      <TabBar
        activeId={status}
        tabs={SHOWCASE_CONSOLE_FILTERS.map((filter) => ({ id: filter, label: x.tabs[filter], count: counts[filter], href: link({ status: filter }) }))}
      />

      <Panel>
        <form method="get">
          <ListToolbar placeholder={x.searchPlaceholder} name="q" defaultValue={query}>
            <FilterSelect
              name="status"
              label={t.admin.filters.label}
              value={status}
              options={SHOWCASE_CONSOLE_FILTERS.map((filter) => ({ id: filter, label: x.tabs[filter] }))}
            />
            <ConsoleButton type="submit">{t.admin.administrators.searchSubmit}</ConsoleButton>
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
                <th scope="col" className={`${TH} w-[160px]`}>
                  <span className="sr-only">{t.admin.actions.more}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? <EmptyRow columns={x.columns.length + 1} message={x.empty} /> : null}
              {rows.map((row) => (
                <tr key={row.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <TitleCell title={row.name || row.libraryTitle} meta={showcasePath(row.slug)} />
                  </td>
                  <td className={TD}>
                    <TitleCell title={row.libraryTitle} meta={row.libraryPublicId} />
                  </td>
                  <td className={TD}>{row.workspaceName || '—'}</td>
                  <td className={TD}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Pill tone="neutral">{s.kinds[row.kind]}</Pill>
                      <Pill tone={row.access === 'public' ? 'brand' : 'neutral'}>{row.access === 'public' ? x.accessPublic : x.accessUnlisted}</Pill>
                    </span>
                  </td>
                  <td className={TD}>
                    <Pill tone={STATUS_TONE[row.status] ?? 'neutral'}>{s.status[row.status]}</Pill>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(row.publishedAt ?? row.createdAt)}</td>
                  <td className={`${TD} whitespace-nowrap`}>{row.leads}</td>
                  <td className={TD}>{row.host ? <code className="font-mono text-[11px]">{row.host}</code> : '—'}</td>
                  <td className={TD}>
                    <span className="flex items-start gap-1.5">
                      {row.status === 'published' ? (
                        <IconLink label={t.admin.actions.view} href={showcasePath(row.slug)}>
                          <ArrowUpRightIcon size={14} />
                        </IconLink>
                      ) : null}
                      <ShowcaseControls showcaseId={row.id} slug={row.slug} status={row.status} action={moderateShowcaseAction} />
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
