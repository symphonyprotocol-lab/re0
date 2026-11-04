'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { RECENT_RANGES } from '@/lib/constants';
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
import { fill } from '@/i18n/format';
import { periodLabel } from '@/components/statistics/shared';
import { CalendarIcon, StatIcon } from '@/components/statistics/owner/icons';

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

/**
 * The reporting period on the owner's statistics pages, in the prototype's
 * markup (statistics-period.js `.statistics-period`, statistics-calendar.js
 * `.statistics-calendar`), styled by owner-statistics.css. Same behaviour as
 * components/statistics/period-controls.tsx (which the console keeps): all
 * time / day / week / month / custom as links, and for the others a date
 * trigger opening a calendar popover; every link starts from the current
 * pathname and query.
 */
export function OwnerPeriod({ filter }: { filter: PeriodFilter }) {
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
            <Link key={period} href={tabHref(period)} aria-current={filter.period === period ? 'true' : undefined}>
              {p.names[period]}
            </Link>
          ))}
        </nav>
        {active && (
          <form className="statistics-period-form" onSubmit={(event) => event.preventDefault()}>
            <DateControl key={JSON.stringify(filter)} filter={filter} today={today} hrefWith={hrefWith} />
            {stepper && (
              <Link className="text-link" href={hrefWith({ period: stepper, date: today })}>
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
    const first = root.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]:not(:disabled), [data-pick]:not(:disabled)');
    first?.focus();
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
    router.push(hrefWith(next));
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
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      /* Focus may leave this non-modal popover; collapse once it has moved outside. */
      setTimeout(() => {
        if (root.current && !root.current.contains(document.activeElement)) setOpen(false);
      }, 0);
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
  const weekdays = c.weekdays.split(',');
  const hint = custom ? (range.phase === 'start' ? c.hint.start : c.hint.end) : c.hint[period as 'day' | 'week' | 'month'];

  return (
    <div ref={root} className="statistics-date-control" data-period={period} onKeyDown={onKeyDown}>
      <span>{label}</span>
      <button
        ref={trigger}
        type="button"
        className="statistics-date-trigger"
        onClick={toggle}
        aria-label={`${label}：${value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span>{value}</span>
        <CalendarIcon />
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
                      <button
                        key={days}
                        type="button"
                        aria-pressed={range.start === recent.start && range.end === recent.end}
                        onClick={() => applyRange(recent.start, recent.end)}
                      >
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
              <button
                type="button"
                className="statistics-calendar-nav is-previous"
                onClick={() => setCursor(previousCursor)}
                aria-label={period === 'month' ? c.previousYear : c.previousMonth}
              >
                <StatIcon name="arrow" />
              </button>
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
              <button
                type="button"
                className="statistics-calendar-nav"
                onClick={() => setCursor(nextCursor)}
                disabled={nextDisabled}
                aria-label={period === 'month' ? c.nextYear : c.nextMonth}
              >
                <StatIcon name="arrow" />
              </button>
            </div>
            {period === 'month' ? (
              <div className="statistics-month-grid">
                {Array.from({ length: 12 }, (_, index) => {
                  const day = `${year}-${String(index + 1).padStart(2, '0')}-01`;
                  return (
                    <button
                      key={day}
                      type="button"
                      data-pick
                      aria-pressed={selected(day)}
                      aria-label={fill(p.monthLabel, { year, month: index + 1 })}
                      disabled={!pickable(period, day, today)}
                      onClick={() => pick(day)}
                    >
                      {monthName(index + 1)}
                    </button>
                  );
                })}
              </div>
            ) : (
              <>
                <div className={`statistics-calendar-weekdays${period === 'week' ? ' with-weeks' : ''}`}>
                  {period === 'week' && <span>{c.week}</span>}
                  {weekdays.map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                {period === 'week' ? (
                  <div className="statistics-week-grid">
                    {weeks.map((days) => {
                      const week = reportingWeek(days[0]!);
                      return (
                        <button
                          key={days[0]}
                          type="button"
                          data-pick
                          aria-pressed={selected(days[0]!)}
                          aria-label={`${week} · ${days[0]} — ${days[6]}`}
                          disabled={!pickable(period, days[0]!, today)}
                          onClick={() => pick(days[0]!)}
                        >
                          <small>{Number(week.slice(6))}</small>
                          {days.map((day) => (
                            <span key={day} className={outside(day) ? 'outside-month' : undefined}>
                              {Number(day.slice(8))}
                            </span>
                          ))}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="statistics-day-grid">
                    {weeks.flat().map((day) => (
                      <button
                        key={day}
                        type="button"
                        data-pick
                        aria-pressed={selected(day)}
                        aria-label={day}
                        aria-current={day === today ? 'date' : undefined}
                        data-in-range={inRange(day) ? 'true' : undefined}
                        className={outside(day) ? 'outside-month' : undefined}
                        disabled={!pickable(period, day, today)}
                        onClick={() => pick(day)}
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
              <p role="alert" className="statistics-calendar-error">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
