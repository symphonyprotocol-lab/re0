import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { redirect } from 'next/navigation';
import { csvHref, listHref, reesView, REE_VISIBILITY } from '@/lib/domain/admin-lists';
import { listAdminRees } from '@/lib/services/admin-rees';
import { answerCounts } from '@/lib/services/statistics';
import { serverMessages } from '@/i18n/server';
import { Fragment } from 'react';
import { fill, formatNumber } from '@/i18n/format';
import { ExportButton, ListFilters } from '@/components/admin/list-client';
import { PageHead, RecordsTable } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { ConsoleReeAvatar, ReePager, ReeRowActions } from '@/components/admin/ree-detail';
import { ReeListPage } from '@/components/admin/ree-list-page';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleRees.rees.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * `/admin/rees` (prototype admin-ree.js, suite.js `dotsTable`): every live Ree
 * with its owner and successful answers, filtered by visibility (and sorted),
 * server paging, CSV of every match, and takedown / restore from the row.
 */
export default async function ReesPage({ searchParams }: Props) {
  await requireAdministrator();
  const { t, locale } = await serverMessages();
  const r = t.consoleRees.rees;
  const l = t.console.list;
  const view = reesView(await searchParams);
  const data = await listAdminRees(view);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/rees', current, changes);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const answers = await answerCounts(data.items.map((row) => row.id), null);
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.status !== 'all' || view.sort !== 'newest';
  const back = encodeURIComponent(href({}));
  const [before, after] = r.results.split('{total}');
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: r.title }]} />
      <ReeListPage>
        <PageHead title={r.title} lede={r.lede} />
        <section className="card admin-ree-table">
          <ListFilters
            q={view.q}
            placeholder={r.search}
            defaults={{ status: 'all', sort: 'newest', size: '20' }}
            resetHref={listHref('/admin/rees', { size: view.size })}
            searchLabel={r.searchLabel}
            filtered={filtered}
            formId="admin-ree-filter"
            className="admin-ree-filter"
            sizeClassName="admin-ree-size"
            resetClassName="text-link admin-ree-reset"
            selects={[
              { name: 'status', label: r.filters.status, aria: r.filterLabels.status, value: view.status, options: [['all', r.allStatuses], ...REE_VISIBILITY.map((s) => [s, r.visibility[s]] as [string, string])] },
              { name: 'sort', label: r.filters.sort, aria: r.filterLabels.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest]] },
              { name: 'size', label: l.perPage, aria: r.filterLabels.size, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), fill(l.rows, { n: size })] as [string, string]) },
            ]}
          />
          <div className="admin-ree-results" role="status" aria-live="polite">
            {before}
            <strong>{n(data.total)}</strong>
            {after}
            <span>{fill(r.showing, { from: n(data.total ? (data.page - 1) * data.size + 1 : 0), to: n(Math.min(data.page * data.size, data.total)) })}</span>
            <ExportButton href={csvHref('/api/admin/rees', view)} />
          </div>
          <RecordsTable
            label={r.tableRegion}
            empty={l.empty}
            head={[r.columns.ree, r.columns.owner, r.columns.visibility, r.columns.sources, r.columns.fee, r.columns.answers, r.columns.action]}
            rows={data.items.map((row) => [
              <Link
                key="ree"
                href={`/admin/rees/${row.id}?from=${back}`}
                className="table-person admin-ree-name-link"
                aria-label={fill(r.viewDetails, { name: row.name })}
              >
                <ConsoleReeAvatar avatar={row.avatarBlob} color={row.color} small />
                <span>
                  <strong>{row.name}</strong>
                  <small>{row.slug}</small>
                </span>
              </Link>,
              <Link key="owner" href={`/admin/users/${row.ownerId}?from=${back}`}>
                <span className="table-person">
                  <span className="avatar">{Array.from(row.ownerName)[0] ?? '?'}</span>
                  <span>
                    <strong>{row.ownerName}</strong>
                    <small>{row.ownerEmail}</small>
                  </span>
                </span>
              </Link>,
              <span key="visibility" className={`tag ${{ public: 'blue', private: '', moderated: 'orange' }[row.visibility]}`}>
                {r.visibility[row.visibility]}
              </span>,
              `${n(row.readySources)} / ${n(row.sources)}`,
              <Fragment key="fee">
                <span className="mono">{n(row.queryFee)}</span> credits
              </Fragment>,
              n(answers.get(row.id) ?? 0),
              <ReeRowActions key="action" t={t} ree={row} detailHref={`/admin/rees/${row.id}?from=${back}`} />,
            ])}
          />
          <ReePager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
        </section>
      </ReeListPage>
    </ConsolePage>
  );
}
