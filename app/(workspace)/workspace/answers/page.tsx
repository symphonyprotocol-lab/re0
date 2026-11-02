import type { Metadata } from 'next';
import Link from 'next/link';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { periodParams } from '@/lib/domain/statistics';
import { currentUser } from '@/lib/http/session';
import { ownedReeRows, workspaceAnswers, workspaceQuery } from '@/lib/services/statistics';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { FilterForm } from '@/components/statistics/filter-form';
import { PeriodControls } from '@/components/statistics/period-controls';
import { AnswerCell, CitationCell } from '@/components/statistics/ree-statistics-view';
import { DetailTable, EmptyState, LinkPager, StatisticsHeading, cell, hrefFor } from '@/components/statistics/shared';
import { SummaryStrip, TakenDownTag } from '@/components/statistics/workspace-bits';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.statistics.workspace.answers.title };
}

/**
 * `/workspace/answers` (prototype workspace-details.js): successful answers
 * across my Rees in a period, by Ree or record by record.
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
      <Topbar crumbs={[{ label: w.crumb, href: '/dashboard' }, { label: a.title }]} />
      <main className="mx-auto flex max-w-[1180px] flex-col gap-5 px-4 py-8 md:px-8">
        <StatisticsHeading title={a.title} lede={a.lede} tag={w.mine} />
        <PeriodControls filter={{ period: query.period, date: query.date, start: query.start, end: query.end }} />
        <SummaryStrip
          locale={locale}
          items={[
            [answerLabel, data.totals.answers],
            [a.saved, data.totals.saved],
          ]}
        />
        <p className="text-[12px] leading-relaxed text-muted">{a.explanation}</p>
        <section className="card min-w-0 overflow-hidden">
          <FilterForm
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
            size={query.size}
            resetKeys={['ree']}
          />
          {data.records ? (
            <DetailTable
              label={a.title}
              heads={[a.heads.qa, a.heads.answering, a.heads.source, a.heads.time]}
              empty={<EmptyState icon="chat" title={a.empty} body={a.emptyBody} />}
            >
              {data.records.items.map((record) => (
                <tr key={record.id}>
                  <td className={`${cell} min-w-[260px] max-w-[460px]`}>
                    <AnswerCell question={record.question} answer={record.answer} t={t} />
                  </td>
                  <td className={`${cell} min-w-[120px]`}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Link href={`/rees/${record.reeId}/statistics`} className="break-words hover:text-blue">
                        {record.reeName}
                      </Link>
                      {moderated.has(record.reeId) && <TakenDownTag t={t} />}
                    </span>
                  </td>
                  <td className={`${cell} min-w-[160px] max-w-[260px] break-words`}>
                    <CitationCell citation={record.citation} t={t} locale={locale} />
                  </td>
                  <td className={`${cell} whitespace-nowrap text-muted`}>{formatDateTime(record.createdAt, locale)}</td>
                </tr>
              ))}
            </DetailTable>
          ) : (
            <DetailTable
              label={a.title}
              heads={[a.heads.ree, answerLabel, a.heads.saved, a.heads.actions]}
              empty={<EmptyState icon="search" title={a.empty} body={filtered ? a.emptyBody : t.statistics.dashboard.ranking.empty} />}
            >
              {data.summary!.items.map((row) => (
                <tr key={row.reeId}>
                  <td className={`${cell} min-w-[180px]`}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Link href={`/rees/${row.reeId}/statistics`} className="font-semibold break-words hover:text-blue">
                        {row.name}
                      </Link>
                      {moderated.has(row.reeId) && <TakenDownTag t={t} />}
                    </span>
                  </td>
                  <td className={cell}>
                    <strong className="font-mono">{n(row.answers)}</strong>
                  </td>
                  <td className={cell}>
                    <span className="font-mono">{n(row.saved)}</span>
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    <span className="flex items-center gap-3">
                      {row.saved ? (
                        <Link href={href({ ree: row.reeId, view: 'records', q: '', page: 1 })} className="text-link text-[12px]">
                          {a.viewRecords}
                        </Link>
                      ) : (
                        <span className="text-[12px] text-muted">{a.noRecords}</span>
                      )}
                      <Link href={`/rees/${row.reeId}/statistics`} className="text-link text-[12px]">
                        {a.openRee}
                      </Link>
                    </span>
                  </td>
                </tr>
              ))}
            </DetailTable>
          )}
          <LinkPager t={t} locale={locale} page={list.page} size={query.size} total={list.total} href={(page) => href({ page })} />
        </section>
      </main>
    </>
  );
}
