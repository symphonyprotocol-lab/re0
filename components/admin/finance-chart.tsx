'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { RECENT_RANGES } from '@/lib/constants';
import {
  FINANCE_METRICS,
  financeAxisLabel,
  financeAxisMax,
  financeBarLabel,
  type FinanceKind,
  type FinanceMetric,
  type FinanceTrend,
} from '@/lib/domain/admin-finance';
import { formatCentsUsd } from '@/lib/domain/payouts';
import {
  PERIODS,
  periodDays,
  periodParams,
  recentRange,
  reportingDate,
  reportingWeek,
  selectionOf,
  validRange,
  type Period,
  type PeriodFilter,
} from '@/lib/domain/statistics';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { periodLabel } from '@/components/statistics/shared';
// console.css first, so these later prototype rules keep their cascade order.
import '@/components/admin/console.css';
import '@/components/admin/console-finance.css';

/**
 * A record list's page (prototype admin-records.js `page` / `afterRender`):
 * `.admin-record-page`, which hides the page kicker, and the table's
 * `--record-table-height`, sized so the table scrolls inside the window
 * with its pages still in view (a chart above it counts for 160px at most).
 */
export function RecordPage({ kind, finance = false, children }: { kind: string; finance?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const resize = () => {
      const wrap = root.querySelector<HTMLElement>('.record-table .table-wrap');
      const pager = root.querySelector<HTMLElement>('.record-pagination');
      if (!wrap || !pager) return;
      const top = wrap.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(190, Math.min(800, window.innerHeight - (finance ? Math.min(top, 160) : top) - pager.offsetHeight - 24));
      root.style.setProperty('--record-table-height', `${height}px`);
    };
    const observer = new ResizeObserver(resize);
    for (const element of root.querySelectorAll('.record-filter, .page-head')) observer.observe(element);
    window.addEventListener('resize', resize);
    // Measure now, and again once layout settles (a hidden tab never runs the frame).
    resize();
    const frame = requestAnimationFrame(resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(frame);
    };
  }, [finance]);
  return (
    <div ref={ref} className={`admin-record-page ${finance ? 'has-finance-chart' : ''}`} data-record-kind={kind}>
      {children}
    </div>
  );
}

/**
 * A finance list's chart (prototype admin-finance.js `render`,
 * admin-finance.css): the amount / count switch (links that keep the page),
 * the reporting period, a legend with each status's total, and grouped bars
 * that show their exact values on hover or keyboard focus. The trend is
 * computed on the server from the whole matching set.
 */
export function FinanceChart({
  kind,
  trend,
  metric,
  metricHrefs,
  filter,
}: {
  kind: FinanceKind;
  trend: FinanceTrend;
  metric: FinanceMetric;
  metricHrefs: Record<FinanceMetric, string>;
  filter: PeriodFilter;
}) {
  const { t, locale } = useI18n();
  const f = t.consolePayouts.finance;
  const [inspected, setInspected] = useState<number | null>(null);
  const count = metric === 'count';
  const field = count ? 'count' : 'cents';
  const n = (value: number) => formatNumber(value, locale);
  const records = (value: number) => fill(f.records, { n: n(value) });
  const usd = formatCentsUsd;
  const value = (amount: number) => (count ? records(amount) : usd(amount));
  const label = (key: string) =>
    kind === 'purchases'
      ? t.consoleUsers.purchases.status[key as keyof typeof t.consoleUsers.purchases.status]
      : t.consolePayouts.payoutStatus[key as keyof typeof t.consolePayouts.payoutStatus];
  const max = financeAxisMax(trend, metric);
  const total = trend.keys.reduce((sum, key) => sum + trend.totals[key]![field], 0);
  const grouping =
    trend.grouping === 'days' || trend.grouping === 'months' ? fill(f.grouping[trend.grouping], { n: trend.step }) : f.grouping[trend.grouping];
  const title = f.titles[kind];
  const describe = (index: number) => {
    const bar = trend.bars[index]!;
    const parts = trend.keys.map((key) => {
      const values = bar.values[key]!;
      return `${label(key)} ${value(values[field])}${count ? '' : ` (${records(values.count)})`}`;
    });
    return `${financeBarLabel(trend, bar)} · ${parts.join(' · ')}`;
  };
  const inspection = inspected !== null && trend.bars[inspected] ? describe(inspected) : total ? f.inspect : f.empty[kind];

  return (
    <section className="card admin-finance" aria-label={title}>
      <div className="finance-heading">
        <div>
          <h2>{title}</h2>
          <p>
            {grouping} · {f.shared}
          </p>
        </div>
        <nav className="finance-metric" aria-label={f.metricLabel}>
          {FINANCE_METRICS.map((option) => (
            <Link key={option} href={metricHrefs[option]} scroll={false} aria-current={metric === option ? 'true' : undefined}>
              {f.metrics[option]}
            </Link>
          ))}
        </nav>
      </div>
      <ConsolePeriodControls filter={filter} id="admin-finance-period" />
      <div className="finance-legend">
        {trend.keys.map((key) => (
          <div key={key}>
            <span className={`finance-key finance-${key}`} />
            <span>{label(key)}</span>
            <strong>{usd(trend.totals[key]!.cents)}</strong>
            <small>{records(trend.totals[key]!.count)}</small>
          </div>
        ))}
      </div>
      <div className="finance-plot" aria-label={f.plotLabel}>
        <div className="finance-y-axis">
          <span>{value(max)}</span>
          <span>{value(Math.round(max / 2))}</span>
          <span>{value(0)}</span>
        </div>
        <div className="finance-bars" role="list" aria-label={`${title} · ${f.metrics[metric]}`}>
          {trend.bars.map((bar, index) => {
            const description = describe(index);
            return (
              <div
                key={bar.start}
                className={`finance-bucket ${inspected === index ? 'is-inspected' : ''}`}
                role="listitem"
                tabIndex={0}
                aria-label={description}
                title={description}
                onPointerEnter={() => setInspected(index)}
                onFocus={() => setInspected(index)}
              >
                <div className="finance-column-group">
                  {trend.keys.map((key) => (
                    <i key={key} className={`finance-column finance-${key}`} style={{ '--bar-height': `${(bar.values[key]![field] / max) * 100}%` } as CSSProperties} />
                  ))}
                </div>
                <span className="finance-axis-label">{financeAxisLabel(trend, index)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="finance-inspection" aria-live="polite">
        {inspection}
      </p>
      <p className="finance-note">
        {f.notes[kind]}
        {trend.missingTime > 0 && ` ${fill(f.missing, { n: n(trend.missingTime) })}`}
      </p>
    </section>
  );
}

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_KEYS = ['period', 'date', 'start', 'end', 'page'];

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** The weeks (Monday first) a month's calendar shows. */
function calendarWeeks(cursor: string): string[][] {
  const first = `${cursor.slice(0, 7)}-01`;
  const end = new Date(`${first}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  const last = end.toISOString().slice(0, 10);
  const weeks: string[][] = [];
  for (let day = periodDays({ period: 'week', date: first })!.first; day <= last; day = addDays(day, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, index) => addDays(day, index)));
  }
  return weeks;
}

/** A picked day as the period's own first day, or null past today. */
function pickable(period: Period, date: string, today: string): string | null {
  const normalized = period === 'week' ? periodDays({ period: 'week', date })!.first : period === 'month' ? `${date.slice(0, 7)}-01` : date;
  return normalized <= today ? normalized : null;
}

function moveCursor(cursor: string, period: Period, direction: number): string {
  const date = new Date(`${cursor.slice(0, 7)}-01T00:00:00Z`);
  if (period === 'month') date.setUTCFullYear(date.getUTCFullYear() + direction);
  else date.setUTCMonth(date.getUTCMonth() + direction);
  return date.toISOString().slice(0, 10);
}

/** The prototype's calendar glyph on the date trigger (statistics-period.js `calendarIcon`). */
function CalendarGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4m10-4v4M3 11h18" />
    </svg>
  );
}

/**
 * The reporting period in the prototype's console markup
 * (statistics-period.js `render`, statistics-calendar.js `paint`,
 * dot-statistics.css): all time / day / week / month / custom as links, and
 * for the others the date trigger with its calendar popover. Links keep the
 * current pathname and query, so the list's filters survive.
 */
export function ConsolePeriodControls({ filter, id }: { filter: PeriodFilter; id: string }) {
  const { t } = useI18n();
  const p = t.statistics.period;
  const pathname = usePathname();
  const search = useSearchParams();
  const hrefWith = (next: PeriodFilter | { period: 'all' }) => {
    const params = new URLSearchParams(search.toString());
    for (const key of PERIOD_KEYS) params.delete(key);
    for (const [key, value] of Object.entries(next.period === 'all' ? {} : periodParams(next as PeriodFilter))) params.set(key, value);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  const today = reportingDate();
  const active = filter.period !== 'all';
  const tabHref = (period: Period) => {
    if (period === 'all') return hrefWith({ period: 'all' });
    if (period === 'custom') {
      const range = filter.period === 'custom' ? { start: filter.start!, end: filter.end! } : { start: `${filter.date.slice(0, 7)}-01`, end: filter.date };
      return hrefWith({ period, date: range.end, ...range });
    }
    return hrefWith({ period, date: filter.date });
  };
  const stepper = filter.period === 'day' || filter.period === 'week' || filter.period === 'month' ? filter.period : null;
  return (
    <section className="statistics-period" aria-label={p.label}>
      <div className="statistics-period-top">
        <nav className="statistics-period-tabs" aria-label={p.tabsLabel}>
          {PERIODS.map((period) => (
            <Link key={period} href={tabHref(period)} scroll={false} aria-current={filter.period === period ? 'true' : undefined}>
              {p.names[period]}
            </Link>
          ))}
        </nav>
        {active && (
          <form id={id} className="statistics-period-form" onSubmit={(event) => event.preventDefault()}>
            <input type="hidden" name="period" value={filter.period} />
            {filter.period === 'custom' ? (
              <>
                <input type="hidden" name="start" value={filter.start} />
                <input type="hidden" name="end" value={filter.end} />
              </>
            ) : (
              <input type="hidden" name="selection" value={selectionOf(filter.period, filter.date)} />
            )}
            <DateControl filter={filter} today={today} hrefWith={hrefWith} />
            {stepper && (
              <Link className="text-link" href={hrefWith({ period: stepper, date: today })} scroll={false}>
                {p.quick[stepper]}
              </Link>
            )}
          </form>
        )}
      </div>
      <p className="statistics-timezone">{p.timezone}</p>
    </section>
  );
}

function DateControl({ filter, today, hrefWith }: { filter: PeriodFilter; today: string; hrefWith: (next: PeriodFilter) => string }) {
  const { t, locale } = useI18n();
  const p = t.statistics.period;
  const c = t.statistics.calendar;
  const router = useRouter();
  const period = filter.period;
  const custom = period === 'custom';
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(`${(custom ? filter.start! : filter.date).slice(0, 7)}-01`);
  const [range, setRange] = useState<{ start: string; end: string; phase: 'start' | 'end' }>({ start: filter.start ?? '', end: filter.end ?? '', phase: 'start' });
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = p.pick[period as Exclude<Period, 'all'>];
  const value = periodLabel(t, filter);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    root.current?.querySelector<HTMLButtonElement>('[data-pick][aria-pressed="true"]:not(:disabled), [data-pick]:not(:disabled)')?.focus();
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setCursor(`${(custom ? filter.start! : filter.date).slice(0, 7)}-01`);
    setRange({ start: filter.start ?? '', end: filter.end ?? '', phase: 'start' });
    setError('');
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const go = (next: PeriodFilter) => {
    setOpen(false);
    router.push(hrefWith(next), { scroll: false });
  };
  const applyRange = (start: string, end: string) => {
    if (!validRange(start, end)) {
      setError(p.invalidRange);
      return;
    }
    setError('');
    go({ period: 'custom', date: end, start, end });
  };
  const pick = (day: string) => {
    const date = pickable(period, day, today);
    if (!date) return;
    if (!custom) {
      go({ period, date });
      return;
    }
    if (range.phase === 'start') {
      setRange({ start: date, end: '', phase: 'end' });
      return;
    }
    const [start, end] = [range.start || filter.start!, date].sort() as [string, string];
    setRange({ start, end, phase: 'start' });
    applyRange(start, end);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-pick]');
    if (!target) return;
    const vertical = period === 'day' || custom ? 7 : period === 'month' ? 3 : 1;
    const delta = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -vertical, ArrowDown: vertical } as Record<string, number>)[event.key];
    if (!delta) return;
    event.preventDefault();
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-pick]') ?? [])];
    const nextButton = buttons[buttons.indexOf(target) + delta];
    if (nextButton && !nextButton.disabled) nextButton.focus();
  };

  const year = Number(cursor.slice(0, 4));
  const month = Number(cursor.slice(5, 7));
  const nowYear = Number(today.slice(0, 4));
  const years = Array.from({ length: nowYear - Math.min(2000, year) + 1 }, (_, index) => nowYear - index);
  const monthName = (m: number) =>
    locale === 'zh' ? fill(c.monthName, { n: m }) : new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, m - 1, 1)));
  const previousCursor = moveCursor(cursor, period, -1);
  const nextCursor = moveCursor(cursor, period, 1);
  const nextDisabled = period === 'month' ? year >= nowYear : nextCursor.slice(0, 7) > today.slice(0, 7);
  const selected = (day: string) => (custom ? day === range.start || day === range.end : selectionOf(period, day) === selectionOf(period, filter.date));
  const inRange = (day: string) => custom && Boolean(range.start && range.end) && day > range.start && day < range.end;
  const weeks = period === 'month' ? [] : calendarWeeks(cursor);
  const outside = (day: string) => day.slice(5, 7) !== cursor.slice(5, 7);
  const hint = custom ? (range.phase === 'start' ? c.hint.start : c.hint.end) : c.hint[period as 'day' | 'week' | 'month'];
  const cell = (day: string, ariaLabel: string) => ({
    type: 'button' as const,
    'data-pick': true,
    'aria-label': ariaLabel,
    'aria-pressed': selected(day),
    disabled: !pickable(period, day, today),
    onClick: () => pick(day),
  });
  const browse = (target: string, backwards: boolean, disabled = false) => (
    <button
      type="button"
      className={`statistics-calendar-nav ${backwards ? 'is-previous' : ''}`}
      onClick={() => setCursor(target)}
      disabled={disabled}
      aria-label={period === 'month' ? (backwards ? c.previousYear : c.nextYear) : backwards ? c.previousMonth : c.nextMonth}
    >
      <CI name="arrow" />
    </button>
  );

  return (
    <div ref={root} className="statistics-date-control" data-period={period} data-date={custom ? filter.start : filter.date} onKeyDown={onKeyDown}>
      <span>{label}</span>
      <button ref={trigger} type="button" className="statistics-date-trigger" onClick={toggle} aria-label={`${label}：${value}`} aria-haspopup="dialog" aria-expanded={open}>
        <span>{value}</span>
        <CalendarGlyph />
      </button>
      <div className="statistics-calendar" role="dialog" aria-label={label} hidden={!open}>
        {open && (
          <>
            {custom && (
              <>
                <div className="statistics-range-presets" role="group" aria-label={c.presets}>
                  {RECENT_RANGES.map((days) => {
                    const recent = recentRange(days)!;
                    return (
                      <button key={days} type="button" aria-pressed={range.start === recent.start && range.end === recent.end} onClick={() => applyRange(recent.start, recent.end)}>
                        {fill(c.recent, { n: days })}
                      </button>
                    );
                  })}
                </div>
                <div className="statistics-range-fields">
                  {(['start', 'end'] as const).map((bound) => (
                    <button key={bound} type="button" aria-pressed={range.phase === bound} onClick={() => setRange((current) => ({ ...current, phase: bound }))}>
                      <small>{bound === 'start' ? c.start : c.end}</small>
                      <strong>{range[bound] || c.choose}</strong>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="statistics-calendar-head">
              {browse(previousCursor, true)}
              <div>
                <select aria-label={c.year} value={year} onChange={(event) => setCursor(`${event.target.value}-${String(month).padStart(2, '0')}-01`)}>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
                {period !== 'month' && (
                  <select aria-label={c.month} value={month} onChange={(event) => setCursor(`${year}-${String(event.target.value).padStart(2, '0')}-01`)}>
                    {Array.from({ length: 12 }, (_, index) => (
                      <option key={index} value={index + 1}>
                        {monthName(index + 1)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {browse(nextCursor, false, nextDisabled)}
            </div>
            {period === 'month' ? (
              <div className="statistics-month-grid">
                {Array.from({ length: 12 }, (_, index) => {
                  const day = `${year}-${String(index + 1).padStart(2, '0')}-01`;
                  return (
                    <button key={day} {...cell(day, fill(p.monthLabel, { year, month: index + 1 }))}>
                      {monthName(index + 1)}
                    </button>
                  );
                })}
              </div>
            ) : (
              <>
                <div className={`statistics-calendar-weekdays ${period === 'week' ? 'with-weeks' : ''}`}>
                  {period === 'week' && <span>{c.week}</span>}
                  {c.weekdays.split(',').map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                {period === 'week' ? (
                  <div className="statistics-week-grid">
                    {weeks.map((days) => (
                      <button key={days[0]} {...cell(days[0]!, `${reportingWeek(days[0]!)} · ${days[0]} — ${days[6]}`)}>
                        <small>{Number(reportingWeek(days[0]!).slice(6))}</small>
                        {days.map((day) => (
                          <span key={day} className={outside(day) ? 'outside-month' : ''}>
                            {Number(day.slice(8))}
                          </span>
                        ))}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="statistics-day-grid">
                    {weeks.flat().map((day) => (
                      <button
                        key={day}
                        {...cell(day, day)}
                        className={outside(day) ? 'outside-month' : ''}
                        data-in-range={inRange(day) ? 'true' : undefined}
                        aria-current={day === today ? 'date' : undefined}
                      >
                        {Number(day.slice(8))}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <p className="statistics-calendar-hint" aria-live="polite">
              {hint}
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
