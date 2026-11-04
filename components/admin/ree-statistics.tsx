/**
 * A Ree's usage statistics in the console, in the prototype's markup
 * (admin-ree-statistics.js through dot-statistics.js `page`): heading, the
 * reporting period, four metric cards (`.creator-metric`), the trend
 * (`.statistics-trend`), the explanation, and the filtered detail table of
 * saved answers or query income with its pages (`.creator-detail-*`). Fed
 * by the same `reeStatistics` as the product's own statistics page; every
 * link is `base` + `keep` (the tab and the way back) + the view's state.
 */
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { locatorLabel } from '@/lib/domain/answer';
import { periodParams, reportingDate } from '@/lib/domain/statistics';
import type { ReeStatistics } from '@/lib/services/statistics';
import type { Locale, Messages } from '@/i18n';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { hrefFor } from '@/components/statistics/shared';
import { CI, type ConsoleIconName } from '@/components/admin/console-icon';
import { ReeStatisticsPeriod } from '@/components/admin/ree-statistics-period';
// console.css first, so these later prototype rules keep their cascade order.
import '@/components/admin/console.css';
import '@/components/admin/console-rees.css';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function ReeStatisticsPage({
  t,
  locale,
  name,
  data,
  base,
  keep,
  sourcesHref,
}: {
  t: Messages;
  locale: Locale;
  name: string;
  data: ReeStatistics;
  base: string;
  keep: Record<string, string>;
  sourcesHref: string;
}) {
  const s = t.statistics;
  const d = s.detail;
  const query = data.query;
  const view = query.view;
  const income = view === 'income';
  const ranged = query.period !== 'all';
  const n = (value: number) => formatNumber(value, locale);
  const period = periodParams(query);
  const href = (patch: Partial<{ view: string; q: string; size: number; page: number }>) => {
    const next = { view, q: query.q, size: query.size, page: query.page, ...patch };
    return hrefFor(base, {
      ...keep,
      ...(ranged ? period : {}),
      view: next.view === 'answers' ? null : next.view,
      q: next.q,
      size: next.size === LIST_PAGE_SIZES[0] ? null : next.size,
      page: next.page > 1 ? next.page : null,
    });
  };
  const list = income ? data.incomeList : data.answerList;
  const total = list?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / query.size));
  const current = Math.min(Math.max(1, list?.page ?? 1), pages);
  const filtered = Boolean(query.q) || ranged;
  const metric = (label: string, value: number, note: string, target: string, icon: ConsoleIconName) => (
    <Link href={target} className="card creator-metric">
      <div className="between">
        <span>{label}</span>
        <CI name={icon} />
      </div>
      <strong className="mono">{n(value)}</strong>
      <small>{note}</small>
    </Link>
  );
  const heads = income ? [d.heads.income, d.heads.amount, d.heads.time] : [d.heads.qa, d.heads.source, d.heads.time];
  const rows = income
    ? (data.incomeList?.items ?? []).map((entry) => (
        <tr key={entry.id}>
          <td>{entry.note || d.incomeFallback}</td>
          <td>
            <strong className="mono">+{n(entry.amount)} credits</strong>
          </td>
          <td>{formatDateTime(entry.createdAt, locale)}</td>
        </tr>
      ))
    : (data.answerList?.items ?? []).map((record) => {
        const where = record.citation ? locatorLabel(record.citation.locator, locale) : '';
        return (
          <tr key={record.id}>
            <td>
              <strong className="creator-answer-question">{record.question || d.noQuestion}</strong>
              <details className="creator-answer-detail">
                <summary>{d.readAnswer}</summary>
                <div>{record.answer}</div>
              </details>
            </td>
            <td>
              {record.citation ? (
                <>
                  {record.citation.title}
                  {where && <small className="creator-cell-note">{where}</small>}
                </>
              ) : (
                d.noSource
              )}
            </td>
            <td>{formatDateTime(record.createdAt, locale)}</td>
          </tr>
        );
      });
  return (
    <div className="page creator-detail-page admin-ree-statistics">
      <div className="creator-detail-heading">
        <div>
          <h1>{s.title}</h1>
          <p>
            {name} · {s.lede}
          </p>
        </div>
        <span className="tag blue">{s.thisRee}</span>
      </div>
      <ReeStatisticsPeriod
        filter={{ period: query.period, date: query.date, start: query.start, end: query.end }}
        base={base}
        keep={{ ...keep, ...(view === 'income' ? { view } : {}), ...(query.q ? { q: query.q } : {}), ...(query.size !== LIST_PAGE_SIZES[0] ? { size: String(query.size) } : {}) }}
      />
      <div className="creator-metrics">
        {metric(ranged ? s.metrics.answersPeriod : s.metrics.answers, data.answers, ranged ? s.metrics.answersPeriodNote : s.metrics.answersNote, href({ view: 'answers', q: '', page: 1 }), 'chat')}
        {metric(s.metrics.saved, data.saved, s.metrics.savedNote, href({ view: 'answers', q: '', page: 1 }), 'file')}
        {metric(s.metrics.sources, data.sources.ready, fill(s.metrics.sourcesNote, { n: n(data.sources.total) }), sourcesHref, 'layers')}
        {metric(ranged ? s.metrics.incomePeriod : s.metrics.income, data.income, s.metrics.incomeNote, href({ view: 'income', q: '', page: 1 }), 'wallet')}
      </div>
      {data.trend && <Trend t={t} locale={locale} trend={data.trend} period={query.period} income={income} />}
      <p className="creator-detail-explanation">
        {s.explanation}
        {ranged && ` ${s.explanationPeriod}`}
      </p>
      <section className="card">
        {/* A plain GET form, as the prototype's: applying starts again at page 1. */}
        <form action={base} method="get" id="admin-ree-statistics-filter" className="creator-detail-filters">
          {Object.entries({ ...keep, ...(ranged ? period : {}) }).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
          <div className="creator-detail-search">
            <CI name="search" />
            <input type="search" name="q" aria-label={d.search} placeholder={income ? d.searchIncome : d.searchAnswers} defaultValue={query.q} maxLength={200} />
          </div>
          <label>
            <span>{d.view}</span>
            <select name="view" aria-label={d.view} defaultValue={view}>
              <option value="answers">{d.views.answers}</option>
              <option value="income">{d.views.income}</option>
            </select>
          </label>
          <span className="creator-detail-fixed">
            {s.period.names[query.period]} · {s.thisRee}
          </span>
          <label>
            <span>{d.size}</span>
            <select name="size" aria-label={d.size} defaultValue={String(query.size)}>
              {LIST_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn secondary sm">
            {d.apply}
          </button>
          <Link className="text-link" href={href({ q: '', page: 1 })}>
            {d.reset}
          </Link>
        </form>
        <div className="table-wrap creator-detail-table" role="region" aria-label={d.table} tabIndex={0}>
          <table>
            <thead>
              <tr>
                {heads.map((head) => (
                  <th key={head}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows
              ) : (
                <tr>
                  <td colSpan={heads.length}>
                    <div className="creator-detail-empty">
                      <CI name={income ? 'wallet' : 'chat'} />
                      <h3>{filtered ? d.emptyFiltered : income ? d.emptyIncome : d.emptyAnswers}</h3>
                      <p>{filtered ? d.emptyFilteredBody : income ? d.emptyIncomeBody : d.emptyAnswersBody}</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="creator-detail-pagination">
          <span>
            {total
              ? fill(s.pager.range, { from: n((current - 1) * query.size + 1), to: n(Math.min(current * query.size, total)), total: n(total) })
              : s.pager.empty}
          </span>
          <div>
            {current > 1 ? (
              <Link href={href({ page: current - 1 })} className="btn secondary sm">
                {s.pager.previous}
              </Link>
            ) : (
              <button type="button" className="btn secondary sm" disabled>
                {s.pager.previous}
              </button>
            )}
            <span>
              {current} / {pages}
            </span>
            {current < pages ? (
              <Link href={href({ page: current + 1 })} className="btn secondary sm">
                {s.pager.next}
              </Link>
            ) : (
              <button type="button" className="btn secondary sm" disabled>
                {s.pager.next}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
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
  const hour = (start: number) => String(new Date(start + 8 * HOUR).getUTCHours()).padStart(2, '0');
  const name = (bar: { start: number; end: number }) => {
    if (trend.grouping === 'hour') return `${reportingDate(bar.start)} ${hour(bar.start)}:00`;
    const first = reportingDate(bar.start);
    const last = reportingDate(bar.end - 1);
    return first === last ? first : `${first} — ${last}`;
  };
  const axis = (bar: { start: number }, index: number) => {
    const last = index === bars.length - 1;
    if (trend.grouping === 'hour') return index % 4 === 0 || last ? hour(bar.start) : '';
    const date = reportingDate(bar.start);
    if (period === 'week') return date.slice(5);
    if (period === 'month') return index % 5 === 0 || last ? date.slice(8) : '';
    return index % 5 === 0 || last ? date.slice(5) : '';
  };
  return (
    <section className="card statistics-trend" aria-label={s.title}>
      <div className="statistics-trend-head">
        <div>
          <h2>{s.title}</h2>
          <p>
            {grouping} · {label}
          </p>
        </div>
        <strong className="mono">
          {n(sum)}
          <small>{unit}</small>
        </strong>
      </div>
      <div className="statistics-bars" role="list" aria-label={label}>
        {bars.map((bar, index) => {
          const full = `${name(bar)} · ${n(bar.value)}${unit}`;
          return (
            <div key={bar.start} className="statistics-bar-item" role="listitem" aria-label={full} title={full}>
              <span className="statistics-bar-track">
                <i style={{ height: `${(bar.value / max) * 100}%` }} />
              </span>
              <span className="statistics-bar-label">{axis(bar, index)}</span>
            </div>
          );
        })}
      </div>
      {!sum && <p className="statistics-trend-empty">{s.empty}</p>}
    </section>
  );
}
