import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { locatorLabel, type CitationSnapshot } from '@/lib/domain/answer';
import { periodParams, reportingDate } from '@/lib/domain/statistics';
import type { ReeStatistics } from '@/lib/services/statistics';
import type { Messages } from '@/i18n';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { Icon, type IconName } from '@/components/ui/icons';
import { FilterForm } from '@/components/statistics/filter-form';
import { PeriodControls } from '@/components/statistics/period-controls';
import { DetailTable, EmptyState, LinkPager, StatisticsHeading, cell, hrefFor } from '@/components/statistics/shared';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * One Ree's usage statistics (prototype dot-statistics.js): the period, four
 * metric cards, the trend, and the detail table of saved answers or query
 * income. Everything below the Ree's top bar; the user side renders it on
 * `/rees/[id]/statistics`, the console on `/admin/rees/[id]?tab=statistics`
 * with `keep={{ tab: 'statistics', ... }}`. Links are `basePath` + the
 * period / view / q / size / page parameters + `keep`; the client pieces
 * (period, filter) start from the current URL instead.
 */
export function ReeStatisticsView({
  t,
  locale,
  data,
  basePath,
  keep = {},
  sourcesHref,
  showIncome,
}: {
  t: Messages;
  locale: Locale;
  data: ReeStatistics;
  basePath: string;
  keep?: Record<string, string>;
  sourcesHref: string;
  showIncome: boolean;
}) {
  const s = t.statistics;
  const d = s.detail;
  const query = data.query;
  const view = showIncome ? query.view : 'answers';
  const ranged = query.period !== 'all';
  const n = (value: number) => formatNumber(value, locale);
  const href = (patch: Partial<{ view: string; q: string; size: number; page: number }>) => {
    const next = { view, q: query.q, size: query.size, page: query.page, ...patch };
    return hrefFor(basePath, {
      ...keep,
      ...periodParams(query),
      view: next.view === 'answers' ? null : next.view,
      q: next.q,
      size: next.size === LIST_PAGE_SIZES[0] ? null : next.size,
      page: next.page > 1 ? next.page : null,
    });
  };
  const list = view === 'income' ? data.incomeList : data.answerList;
  const total = list?.total ?? 0;
  const filtered = Boolean(query.q) || ranged;

  return (
    <div className="flex flex-col gap-5">
      <StatisticsHeading title={s.title} lede={showIncome ? s.lede : s.ledeNoIncome} tag={s.thisRee} />
      <PeriodControls filter={{ period: query.period, date: query.date, start: query.start, end: query.end }} />

      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${showIncome ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
        <Metric
          href={href({ view: 'answers', q: '', page: 1 })}
          icon="chat"
          label={ranged ? s.metrics.answersPeriod : s.metrics.answers}
          value={n(data.answers)}
          note={ranged ? s.metrics.answersPeriodNote : s.metrics.answersNote}
        />
        <Metric href={href({ view: 'answers', q: '', page: 1 })} icon="file" label={s.metrics.saved} value={n(data.saved)} note={s.metrics.savedNote} />
        <Metric href={sourcesHref} icon="layers" label={s.metrics.sources} value={n(data.sources.ready)} note={fill(s.metrics.sourcesNote, { n: n(data.sources.total) })} />
        {showIncome && (
          <Metric
            href={href({ view: 'income', q: '', page: 1 })}
            icon="sparkle"
            label={ranged ? s.metrics.incomePeriod : s.metrics.income}
            value={n(data.income)}
            note={s.metrics.incomeNote}
          />
        )}
      </div>

      {data.trend && <Trend t={t} locale={locale} trend={data.trend} period={query.period} income={view === 'income'} />}

      <p className="text-[12px] leading-relaxed text-muted">
        {s.explanation}
        {ranged && ` ${s.explanationPeriod}`}
        {!showIncome && ` ${s.explanationOfficial}`}
      </p>

      <section className="card min-w-0 overflow-hidden">
        <FilterForm
          search={{ value: query.q, label: d.search, placeholder: view === 'income' ? d.searchIncome : d.searchAnswers }}
          selects={[
            {
              name: 'view',
              label: d.view,
              value: view,
              options: showIncome
                ? [
                    ['answers', d.views.answers],
                    ['income', d.views.income],
                  ]
                : [['answers', d.views.answers]],
            },
          ]}
          fixed={`${s.period.names[query.period]} · ${s.thisRee}`}
          size={query.size}
        />
        {view === 'income' ? (
          <DetailTable
            label={d.table}
            heads={[d.heads.income, d.heads.amount, d.heads.time]}
            empty={
              <EmptyState icon="sparkle" title={filtered ? d.emptyFiltered : d.emptyIncome} body={filtered ? d.emptyFilteredBody : d.emptyIncomeBody} />
            }
          >
            {(data.incomeList?.items ?? []).map((entry) => (
              <tr key={entry.id}>
                <td className={`${cell} max-w-[420px] break-words`}>{entry.note || d.incomeFallback}</td>
                <td className={`${cell} whitespace-nowrap`}>
                  <strong className="font-mono text-green">+{n(entry.amount)} credits</strong>
                </td>
                <td className={`${cell} whitespace-nowrap text-muted`}>{formatDateTime(entry.createdAt, locale)}</td>
              </tr>
            ))}
          </DetailTable>
        ) : (
          <DetailTable
            label={d.table}
            heads={[d.heads.qa, d.heads.source, d.heads.time]}
            empty={<EmptyState icon="chat" title={filtered ? d.emptyFiltered : d.emptyAnswers} body={filtered ? d.emptyFilteredBody : d.emptyAnswersBody} />}
          >
            {(data.answerList?.items ?? []).map((record) => (
              <tr key={record.id}>
                <td className={`${cell} min-w-[260px] max-w-[520px]`}>
                  <AnswerCell question={record.question} answer={record.answer} t={t} />
                </td>
                <td className={`${cell} min-w-[180px] max-w-[280px] break-words`}>
                  <CitationCell citation={record.citation} t={t} locale={locale} />
                </td>
                <td className={`${cell} whitespace-nowrap text-muted`}>{formatDateTime(record.createdAt, locale)}</td>
              </tr>
            ))}
          </DetailTable>
        )}
        <LinkPager t={t} locale={locale} page={list?.page ?? 1} size={query.size} total={total} href={(page) => href({ page })} />
      </section>
    </div>
  );
}

function Metric({ href, icon, label, value, note }: { href: string; icon: IconName; label: string; value: string; note: string }) {
  return (
    <Link href={href} className="card group flex min-w-0 flex-col gap-3 p-5 transition hover:border-[#c4cce0] hover:shadow-sm">
      <span className="flex items-center justify-between gap-2 text-[12px] font-semibold text-muted">
        {label}
        <Icon name={icon} className="size-4 flex-none text-[#a3a9bb] group-hover:text-blue" />
      </span>
      <strong className="font-mono text-[28px] leading-none font-semibold">{value}</strong>
      <span className="text-[11px] text-muted">{note}</span>
    </Link>
  );
}

/** The question in bold, the answer behind a disclosure. */
export function AnswerCell({ question, answer, t }: { question: string; answer: string; t: Messages }) {
  const d = t.statistics.detail;
  return (
    <>
      <strong className="block text-[13px] font-semibold break-words">{question || d.noQuestion}</strong>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[11px] font-semibold text-blue">{d.readAnswer}</summary>
        <div className="mt-2 max-h-[320px] overflow-y-auto rounded-lg bg-wash p-3 text-[12px] leading-relaxed break-words whitespace-pre-wrap text-ink">{answer}</div>
      </details>
    </>
  );
}

export function CitationCell({ citation, t, locale }: { citation: CitationSnapshot | null; t: Messages; locale: Locale }) {
  if (!citation) return <span className="text-muted">{t.statistics.detail.noSource}</span>;
  const where = locatorLabel(citation.locator, locale);
  return (
    <>
      <span className="block font-medium">{citation.title}</span>
      {where && <small className="mt-0.5 block text-[11px] text-muted">{where}</small>}
    </>
  );
}

/**
 * The trend's bars (prototype `trend`): hours for a day, days for a week or
 * month, days grouped for a long custom range. Axis labels are sparse; each
 * bar carries its full label for hover and screen readers.
 */
function Trend({
  t,
  locale,
  trend,
  period,
  income,
}: {
  t: Messages;
  locale: Locale;
  trend: NonNullable<ReeStatistics['trend']>;
  period: ReeStatistics['query']['period'];
  income: boolean;
}) {
  const s = t.statistics.trend;
  const bars = trend.bars;
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  const sum = bars.reduce((total, bar) => total + bar.value, 0);
  const label = income ? s.income : s.answers;
  const unit = income ? s.unitIncome : s.unitAnswers;
  const bucketDays = bars.length ? Math.round((bars[0]!.end - bars[0]!.start) / DAY) : 1;
  const grouping = trend.grouping === 'hour' ? s.hour : trend.grouping === 'days' ? fill(s.days, { n: bucketDays }) : s.day;
  const n = (value: number) => formatNumber(value, locale);
  const name = (bar: { start: number; end: number }) => {
    if (trend.grouping === 'hour') return `${reportingDate(bar.start)} ${String(new Date(bar.start + 8 * HOUR).getUTCHours()).padStart(2, '0')}:00`;
    const first = reportingDate(bar.start);
    const last = reportingDate(bar.end - 1);
    return first === last ? first : `${first} — ${last}`;
  };
  const axis = (bar: { start: number }, index: number) => {
    const last = index === bars.length - 1;
    if (trend.grouping === 'hour') return index % 4 === 0 || last ? String(new Date(bar.start + 8 * HOUR).getUTCHours()).padStart(2, '0') : '';
    const date = reportingDate(bar.start);
    if (period === 'week') return date.slice(5);
    if (period === 'month') return index % 5 === 0 || last ? date.slice(8) : '';
    return index % 5 === 0 || last ? date.slice(5) : '';
  };
  return (
    <section className="card p-5" aria-label={s.title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold">{s.title}</h2>
          <p className="mt-1 text-[11px] text-muted">
            {grouping} · {label}
          </p>
        </div>
        <strong className="font-mono text-[22px]">
          {n(sum)}
          <small className="text-[11px] font-normal text-muted">{unit}</small>
        </strong>
      </div>
      <div role="list" aria-label={label} className="mt-4 flex h-[150px] items-stretch gap-[2px] sm:gap-1">
        {bars.map((bar, index) => {
          const full = `${name(bar)} · ${n(bar.value)}${unit}`;
          return (
            <div key={bar.start} role="listitem" aria-label={full} title={full} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <span className="flex w-full flex-1 items-end rounded-sm bg-[#f1f4fa]">
                <i className="block w-full rounded-sm bg-blue/80" style={{ height: `${(bar.value / max) * 100}%` }} />
              </span>
              <span className="h-3 font-mono text-[9px] leading-3 whitespace-nowrap text-muted">{axis(bar, index)}</span>
            </div>
          );
        })}
      </div>
      {!sum && <p className="mt-3 text-center text-[12px] text-muted">{s.empty}</p>}
    </section>
  );
}
