import type { Metadata } from 'next';
import Link from 'next/link';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { currentUser } from '@/lib/http/session';
import { ownedReeRows, WORKSPACE_KINDS, WORKSPACE_SOURCE_STATES, workspaceQuery, workspaceSources } from '@/lib/services/statistics';
import { serverMessages } from '@/i18n/server';
import { formatDateTime } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { FilterForm } from '@/components/statistics/filter-form';
import { DetailTable, EmptyState, LinkPager, StatisticsHeading, cell, hrefFor } from '@/components/statistics/shared';
import { STATE_TONES, SummaryStrip, TakenDownTag } from '@/components/statistics/workspace-bits';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.statistics.workspace.sources.title };
}

/**
 * `/workspace/sources` (prototype workspace-details.js): every current source
 * across my Rees, the trash excluded, filtered by Ree, type and state, with a
 * way into the preview or the Ree's knowledge page.
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
      <main className="mx-auto flex max-w-[1180px] flex-col gap-5 px-4 py-8 md:px-8">
        <StatisticsHeading title={s.title} lede={s.lede} tag={w.mine} />
        <SummaryStrip
          locale={locale}
          items={[
            [s.all, list.all],
            [s.matching, list.total],
          ]}
        />
        <section className="card min-w-0 overflow-hidden">
          <FilterForm
            search={{ value: query.q, label: s.search, placeholder: s.search }}
            selects={[
              { name: 'ree', label: w.ree, value: query.ree, options: [['all', w.allRees], ...rees.map((ree) => [ree.id, ree.name] as [string, string])] },
              { name: 'kind', label: s.kind, value: query.kind, options: WORKSPACE_KINDS.map((kind) => [kind, s.kinds[kind]] as [string, string]) },
              { name: 'status', label: s.status, value: query.status, options: WORKSPACE_SOURCE_STATES.map((state) => [state, s.statuses[state]] as [string, string]) },
            ]}
            size={query.size}
            resetKeys={['ree', 'kind', 'status']}
          />
          <DetailTable
            label={s.title}
            heads={[s.heads.source, s.heads.ree, s.heads.status, s.heads.updated, s.heads.actions]}
            empty={list.all ? <EmptyState icon="search" title={s.empty} body={s.emptyBody} /> : <EmptyState icon="file" title={s.none} body={s.noneBody} />}
          >
            {list.items.map((source) => (
              <tr key={source.id}>
                <td className={`${cell} min-w-[220px] max-w-[380px]`}>
                  <Link href={`/rees/${source.reeId}/knowledge/${source.id}`} className="block font-semibold break-words hover:text-blue">
                    {source.title}
                  </Link>
                  <small className="mt-0.5 block text-[11px] text-muted">{s.kinds[source.kind as keyof typeof s.kinds] ?? source.kind}</small>
                </td>
                <td className={`${cell} min-w-[140px]`}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/rees/${source.reeId}/knowledge`} className="break-words text-blue hover:underline">
                      {source.reeName}
                    </Link>
                    {moderated.has(source.reeId) && <TakenDownTag t={t} />}
                  </span>
                </td>
                <td className={cell}>
                  <span className={`tag whitespace-nowrap ${STATE_TONES[source.state]}`}>{s.statuses[source.state]}</span>
                </td>
                <td className={`${cell} whitespace-nowrap text-muted`}>{formatDateTime(source.updatedAt, locale)}</td>
                <td className={`${cell} whitespace-nowrap`}>
                  <span className="flex items-center gap-3">
                    <Link href={`/rees/${source.reeId}/knowledge/${source.id}`} className="text-link text-[12px]">
                      {s.preview}
                    </Link>
                    <Link href={`/rees/${source.reeId}/knowledge${query.status !== 'all' ? `?status=${query.status}` : ''}`} className="text-link text-[12px]">
                      {s.manage}
                    </Link>
                  </span>
                </td>
              </tr>
            ))}
          </DetailTable>
          <LinkPager t={t} locale={locale} page={list.page} size={query.size} total={list.total} href={href} />
        </section>
      </main>
    </>
  );
}
