import type { Metadata } from 'next';
import Link from 'next/link';
import { csvHref, listHref, reesView, REE_VISIBILITY } from '@/lib/domain/admin-lists';
import { listAdminRees, reeCounts } from '@/lib/services/admin-rees';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, RecordsTable, ResultsLine, RoleBadge, SummaryCards, Tag } from '@/components/admin/list-kit';
import { VISIBILITY_TONES } from '@/components/admin/ree-detail';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleRees.rees.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** `/admin/rees` (prototype admin-ree.js): every live Ree with its owner, filtered by visibility, server paging, CSV of every match. */
export default async function ReesPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const r = t.consoleRees.rees;
  const l = t.console.list;
  const view = reesView(await searchParams);
  const [data, counts] = await Promise.all([listAdminRees(view), reeCounts()]);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/rees', current, changes);
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'all' || view.sort !== 'newest';
  const back = encodeURIComponent(href({}));
  return (
    <>
      <PageHead crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: r.title }]} title={r.title} lede={r.lede} />
      <SummaryCards
        items={[
          { label: r.cards.total, value: n(counts.total), href: listHref('/admin/rees', { size: view.size }), active: !filtered, title: l.clearFilters },
          ...REE_VISIBILITY.map((status) => ({
            label: r.cards[status],
            value: n(counts[status]),
            href: href({ status }),
            active: view.status === status,
            title: fill(l.filterBy, { label: r.cards[status] }),
          })),
        ]}
      />
      <section className="card overflow-hidden">
        <ListFilters
          q={view.q}
          placeholder={r.search}
          defaults={{ status: 'all', sort: 'newest', size: '20' }}
          resetHref={listHref('/admin/rees', { size: view.size })}
          filtered={filtered}
          selects={[
            { name: 'status', label: r.filters.status, value: view.status, options: [['all', r.allStatuses], ...REE_VISIBILITY.map((s) => [s, r.visibility[s]] as [string, string])] },
            { name: 'sort', label: r.filters.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest]] },
            { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), String(size)] as [string, string]) },
          ]}
        />
        <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/rees', view)} />
        <RecordsTable
          label={l.tableRegion}
          empty={l.empty}
          head={[r.columns.ree, r.columns.owner, r.columns.visibility, r.columns.sources, r.columns.fee, r.columns.created, r.columns.action]}
          rows={data.items.map((row) => [
            <Link key="ree" href={`/admin/rees/${row.id}?from=${back}`} className="flex max-w-[260px] min-w-0 items-center gap-2.5 hover:text-blue">
              <ReeAvatar avatar={row.avatarBlob} color={row.color} size="sm" />
              <span className="min-w-0">
                <span className="block truncate font-semibold" title={row.name}>
                  {row.name}
                </span>
                <small className="block truncate font-mono text-[11px] text-muted" title={row.slug}>
                  {row.slug}
                </small>
              </span>
            </Link>,
            <div key="owner" className="max-w-[220px] min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-semibold" title={row.ownerName}>
                  {row.ownerName}
                </span>
                <RoleBadge t={t} role={row.ownerRole} />
              </div>
              <small className="block truncate text-muted" title={row.ownerEmail}>
                {row.ownerEmail}
              </small>
            </div>,
            <Tag key="visibility" tone={VISIBILITY_TONES[row.visibility]}>
              {r.visibility[row.visibility]}
            </Tag>,
            <span key="sources" className="font-mono whitespace-nowrap">
              {n(row.readySources)} / {n(row.sources)}
            </span>,
            <span key="fee" className="font-mono whitespace-nowrap">
              {fill(r.fee, { n: n(row.queryFee) })}
            </span>,
            <span key="created" className="whitespace-nowrap">
              {formatDateTime(row.createdAt, locale)}
            </span>,
            <Link key="action" href={`/admin/rees/${row.id}?from=${back}`} className="btn-secondary btn-sm">
              {r.details}
            </Link>,
          ])}
        />
        <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
      </section>
    </>
  );
}
