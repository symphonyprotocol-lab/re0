import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { periodParams, reportingDate } from '@/lib/domain/statistics';
import type { ReeStatistics } from '@/lib/services/statistics';
import type { Messages } from '@/i18n';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { hrefFor } from '@/components/statistics/shared';
import { StatIcon, type StatIconName } from '@/components/statistics/owner/icons';
import { OwnerFilters } from '@/components/statistics/owner/filters';
import { OwnerPeriod } from '@/components/statistics/owner/period';
import {
  OwnerAnswerCell,
  OwnerCitationCell,
  OwnerEmpty,
  OwnerHeading,
  OwnerPage,
  OwnerPager,
  OwnerTable,
} from '@/components/statistics/owner/detail';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * `/rees/[id]/statistics` in the prototype's markup (dot-statistics.js
 * `page`): the period, the metric cards, the trend, and the detail table of
 * saved answers or query income. Same data and links as
 * components/statistics/ree-statistics-view.tsx, which the console keeps.
 */
export function OwnerReeStatistics({
  t,
  locale,
  data,
  reeName,
  basePath,
  sourcesHref,
  showIncome,
}: {
  t: Messages;
  locale: Locale;
  data: ReeStatistics;
  reeName: string;
  basePath: string;
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
    <OwnerPage official={!showIncome}>
      <OwnerHeading title={s.title} lede={`${reeName} · ${showIncome ? s.lede : s.ledeNoIncome}`} tag={s.thisRee} />
      <OwnerPeriod filter={{ period: query.period, date: query.date, start: query.start, end: query.end }} />

      <div className="creator-metrics">
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
            icon="wallet"
            label={ranged ? s.metrics.incomePeriod : s.metrics.income}
            value={n(data.income)}
            note={s.metrics.incomeNote}
          />
        )}
      </div>

      {data.trend && <Trend t={t} locale={locale} trend={data.trend} period={query.period} income={view === 'income'} />}

      <p className="creator-detail-explanation">
        {s.explanation}
        {ranged && ` ${s.explanationPeriod}`}
        {!showIncome && ` ${s.explanationOfficial}`}
      </p>

      <section className="card">
        <OwnerFilters
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
          <OwnerTable
            label={d.table}
            heads={[d.heads.income, d.heads.amount, d.heads.time]}
            empty={<OwnerEmpty icon="wallet" title={filtered ? d.emptyFiltered : d.emptyIncome} body={filtered ? d.emptyFilteredBody : d.emptyIncomeBody} />}
          >
            {(data.incomeList?.items ?? []).map((entry) => (
              <tr key={entry.id}>
                <td>{entry.note || d.incomeFallback}</td>
                <td>
                  <strong className="mono">+{n(entry.amount)} credits</strong>
                </td>
                <td>{formatDateTime(entry.createdAt, locale)}</td>
              </tr>
            ))}
          </OwnerTable>
        ) : (
          <OwnerTable
            label={d.table}
            heads={[d.heads.qa, d.heads.source, d.heads.time]}
            empty={<OwnerEmpty icon="chat" title={filtered ? d.emptyFiltered : d.emptyAnswers} body={filtered ? d.emptyFilteredBody : d.emptyAnswersBody} />}
          >
            {(data.answerList?.items ?? []).map((record) => (
              <tr key={record.id}>
                <td>
                  <OwnerAnswerCell question={record.question} answer={record.answer} t={t} />
                </td>
                <td>
                  <OwnerCitationCell citation={record.citation} t={t} locale={locale} />
                </td>
                <td>{formatDateTime(record.createdAt, locale)}</td>
              </tr>
            ))}
          </OwnerTable>
        )}
        <OwnerPager t={t} locale={locale} page={list?.page ?? 1} size={query.size} total={total} href={(page) => href({ page })} />
      </section>
    </OwnerPage>
  );
}

function Metric({ href, icon, label, value, note }: { href: string; icon: StatIconName; label: string; value: string; note: string }) {
  return (
    <Link href={href} className="card creator-metric">
      <div className="between">
        <span>{label}</span>
        <StatIcon name={icon} />
      </div>
      <strong className="mono">{value}</strong>
      <small>{note}</small>
    </Link>
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
