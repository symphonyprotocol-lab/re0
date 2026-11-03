import type { Metadata } from 'next';
import Link from 'next/link';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { currentUser } from '@/lib/http/session';
import { ownedReeRows, WORKSPACE_KINDS, WORKSPACE_SOURCE_STATES, workspaceQuery, workspaceSources } from '@/lib/services/statistics';
import { serverMessages } from '@/i18n/server';
import { formatDateTime } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { hrefFor } from '@/components/statistics/shared';
import { OwnerFilters } from '@/components/statistics/owner/filters';
import { OwnerEmpty, OwnerHeading, OwnerPage, OwnerPager, OwnerSummary, OwnerTable, OwnerTakenDown } from '@/components/statistics/owner/detail';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.statistics.workspace.sources.title };
}

/**
 * `/workspace/sources` (prototype workspace-details.js, its markup and
 * owner-statistics.css): every current source across my Rees, the trash
 * excluded, filtered by Ree, type and state, with a way into the preview or
 * the Ree's knowledge page.
 */
export default async function WorkspaceSourcesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const w = t.statistics.workspace;
  const s = w.sources;
  const rees = await ownedReeRows(user.id);
  const query = workspaceQuery(await searchParams, rees.map((ree) => ree.id), false);
  const list = await workspaceSources(user.id, query);
  const moderated = new Set(rees.filter((ree) => ree.moderatedAt).map((ree) => ree.id));
  const href = (page: number) =>
    hrefFor('/workspace/sources', {
      ree: query.ree === 'all' ? null : query.ree,
      kind: query.kind === 'all' ? null : query.kind,
      status: query.status === 'all' ? null : query.status,
      q: query.q,
      size: query.size === LIST_PAGE_SIZES[0] ? null : query.size,
      page: page > 1 ? page : null,
    });
  return (
    <>
      <Topbar crumbs={[{ label: w.crumb, href: '/dashboard' }, { label: s.title }]} />
      <OwnerPage>
        <OwnerHeading title={s.title} lede={s.lede} tag={w.mine} />
        <OwnerSummary
          locale={locale}
          items={[
            [s.all, list.all],
            [s.matching, list.total],
          ]}
        />
        <section className="card">
          <OwnerFilters
            search={{ value: query.q, label: s.search, placeholder: s.search }}
            selects={[
              { name: 'ree', label: w.ree, value: query.ree, options: [['all', w.allRees], ...rees.map((ree) => [ree.id, ree.name] as [string, string])] },
              { name: 'kind', label: s.kind, value: query.kind, options: WORKSPACE_KINDS.map((kind) => [kind, s.kinds[kind]] as [string, string]) },
              { name: 'status', label: s.status, value: query.status, options: WORKSPACE_SOURCE_STATES.map((state) => [state, s.statuses[state]] as [string, string]) },
            ]}
            size={query.size}
            resetKeys={['ree', 'kind', 'status']}
          />
          <OwnerTable
            label={s.title}
            heads={[s.heads.source, s.heads.ree, s.heads.status, s.heads.updated, s.heads.actions]}
            empty={list.all ? <OwnerEmpty icon="search" title={s.empty} body={s.emptyBody} /> : <OwnerEmpty icon="file" title={s.none} body={s.noneBody} />}
          >
            {list.items.map((source) => (
              <tr key={source.id}>
                <td>
                  <Link href={`/rees/${source.reeId}/knowledge/${source.id}`} className="creator-detail-source">
                    {source.title}
                  </Link>
                  <small className="creator-cell-note">{s.kinds[source.kind as keyof typeof s.kinds] ?? source.kind}</small>
                </td>
                <td>
                  <Link href={`/rees/${source.reeId}/knowledge`} className="text-link">
                    {source.reeName}
                  </Link>
                  {moderated.has(source.reeId) && <OwnerTakenDown t={t} />}
                </td>
                <td>
                  <span className={`tag creator-status-${source.state}`}>{s.statuses[source.state]}</span>
                </td>
                <td>{formatDateTime(source.updatedAt, locale)}</td>
                <td>
                  <div className="creator-detail-actions">
                    <Link href={`/rees/${source.reeId}/knowledge/${source.id}`} className="text-link">
                      {s.preview}
                    </Link>
                    <Link href={`/rees/${source.reeId}/knowledge${query.status !== 'all' ? `?status=${query.status}` : ''}`} className="text-link">
                      {s.manage}
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </OwnerTable>
          <OwnerPager t={t} locale={locale} page={list.page} size={query.size} total={list.total} href={href} />
        </section>
      </OwnerPage>
    </>
  );
}
