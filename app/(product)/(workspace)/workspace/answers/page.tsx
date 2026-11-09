import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { periodParams } from '@/lib/domain/statistics';
import { currentUser } from '@/lib/http/session';
import { ownedReeRows, workspaceAnswers, workspaceQuery } from '@/lib/services/statistics';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { hrefFor } from '@/components/statistics/shared';
import { OwnerFilters } from '@/components/statistics/owner/filters';
import { OwnerPeriod } from '@/components/statistics/owner/period';
import {
  OwnerAnswerCell,
  OwnerCitationCell,
  OwnerEmpty,
  OwnerHeading,
  OwnerPage,
  OwnerPager,
  OwnerSummary,
  OwnerTable,
  OwnerTakenDown,
} from '@/components/statistics/owner/detail';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.statistics.workspace.answers.title };
}

/**
 * `/workspace/answers` (prototype workspace-details.js, its markup and
 * owner-statistics.css): successful answers across my Rees in a period, by
 * Ree or record by record.
 */
export default async function WorkspaceAnswersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const w = t.statistics.workspace;
  const a = w.answers;
  const rees = await ownedReeRows(user.id);
  const query = workspaceQuery(await searchParams, rees.map((ree) => ree.id), true);
  const data = await workspaceAnswers(user.id, query);
  const moderated = new Set(rees.filter((ree) => ree.moderatedAt).map((ree) => ree.id));
  const ranged = query.period !== 'all';
  const n = (value: number) => formatNumber(value, locale);
  const href = (patch: Partial<{ ree: string; view: 'summary' | 'records'; q: string; page: number }>) => {
    const next = { ree: query.ree, view: query.view, q: query.q, page: query.page, ...patch };
    return hrefFor('/workspace/answers', {
      ...periodParams(query),
      ree: next.ree === 'all' ? null : next.ree,
      view: next.view === 'summary' ? null : next.view,
      q: next.q,
      size: query.size === LIST_PAGE_SIZES[0] ? null : query.size,
      page: next.page > 1 ? next.page : null,
    });
  };
  const answerLabel = ranged ? a.answersPeriod : a.answers;
  const list = data.records ?? data.summary!;
  const filtered = Boolean(query.q) || query.ree !== 'all' || ranged;
  return (
    <>
      <Topbar crumbs={[{ label: t.rees.title, href: '/rees' }, { label: a.title }]} />
      <OwnerPage>
        <OwnerHeading title={a.title} lede={a.lede} tag={w.mine} />
        <OwnerPeriod filter={{ period: query.period, date: query.date, start: query.start, end: query.end }} />
        <OwnerSummary
          locale={locale}
          items={[
            [answerLabel, data.totals.answers],
            [a.saved, data.totals.saved],
          ]}
        />
        <p className="creator-detail-explanation">{a.explanation}</p>
        <section className="card">
          <OwnerFilters
            search={{ value: query.q, label: query.view === 'summary' ? a.searchSummary : a.searchRecords, placeholder: query.view === 'summary' ? a.searchSummary : a.searchRecords }}
            selects={[
              { name: 'ree', label: w.ree, value: query.ree, options: [['all', w.allRees], ...rees.map((ree) => [ree.id, ree.name] as [string, string])] },
              {
                name: 'view',
                label: a.view,
                value: query.view,
                options: [
                  ['summary', a.views.summary],
                  ['records', a.views.records],
                ],
              },
            ]}
            fixed={fill(a.fixed, { period: t.statistics.period.names[query.period] })}
            fixedIcon
            size={query.size}
            resetKeys={['ree']}
          />
          {data.records ? (
            <OwnerTable
              label={a.title}
              heads={[a.heads.qa, a.heads.answering, a.heads.source, a.heads.time]}
              empty={<OwnerEmpty icon="search" title={a.empty} body={a.emptyBody} />}
            >
              {data.records.items.map((record) => (
                <tr key={record.id}>
                  <td>
                    <OwnerAnswerCell question={record.question} answer={record.answer} t={t} />
                  </td>
                  <td>
                    <Link href={`/rees/${record.reeId}/statistics`}>{record.reeName}</Link>
                    {moderated.has(record.reeId) && <OwnerTakenDown t={t} />}
                  </td>
                  <td>
                    <OwnerCitationCell citation={record.citation} t={t} locale={locale} />
                  </td>
                  <td>{formatDateTime(record.createdAt, locale)}</td>
                </tr>
              ))}
            </OwnerTable>
          ) : (
            <OwnerTable
              label={a.title}
              heads={[a.heads.ree, answerLabel, a.heads.saved, a.heads.actions]}
              empty={<OwnerEmpty icon="search" title={a.empty} body={filtered ? a.emptyBody : t.statistics.dashboard.ranking.empty} />}
            >
              {data.summary!.items.map((row) => (
                <tr key={row.reeId}>
                  <td>
                    <Link href={`/rees/${row.reeId}/statistics`} className="text-link">
                      {row.name}
                    </Link>
                    {moderated.has(row.reeId) && <OwnerTakenDown t={t} />}
                  </td>
                  <td>
                    <strong className="mono">{n(row.answers)}</strong>
                  </td>
                  <td>
                    <span className="mono">{n(row.saved)}</span>
                  </td>
                  <td>
                    <div className="creator-detail-actions">
                      {row.saved ? (
                        <Link href={href({ ree: row.reeId, view: 'records', q: '', page: 1 })} className="text-link">
                          {a.viewRecords}
                        </Link>
                      ) : (
                        <span className="muted">{a.noRecords}</span>
                      )}
                      <Link href={`/rees/${row.reeId}/statistics`} className="text-link">
                        {a.openRee}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </OwnerTable>
          )}
          <OwnerPager t={t} locale={locale} page={list.page} size={query.size} total={list.total} href={(page) => href({ page })} />
        </section>
      </OwnerPage>
    </>
  );
}
