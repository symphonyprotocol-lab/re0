'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
  shiftDate,
  validRange,
  type Period,
  type PeriodFilter,
} from '@/lib/domain/statistics';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { periodLabel } from '@/components/statistics/shared';

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
 * The reporting period (prototype statistics-period.js and
 * statistics-calendar.js): all time / day / week / month / custom as links,
 * and for the others a date trigger opening a calendar popover. Every link
 * starts from the current pathname and query, so the same control serves
 * `/rees/[id]/statistics`, `/workspace/answers` and the console's tab.
 */
export function PeriodControls({ filter }: { filter: PeriodFilter }) {
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
  const previous = stepper ? shiftDate(stepper, filter.date, -1) : null;
  const next = stepper ? shiftDate(stepper, filter.date, 1) : null;
  return (
    <section aria-label={p.label} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <nav aria-label={p.tabsLabel} className="inline-flex max-w-full flex-wrap rounded-lg border border-line bg-white p-0.5">
          {PERIODS.map((period) => (
            <Link
              key={period}
              href={tabHref(period)}
              aria-current={filter.period === period ? 'true' : undefined}
              className={`rounded-md px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap ${
                filter.period === period ? 'bg-blue text-white' : 'text-muted hover:bg-wash hover:text-ink'
              }`}
            >
              {p.names[period]}
            </Link>
          ))}
        </nav>
        <p className="text-[11px] text-muted">{p.timezone}</p>
      </div>
      {active && (
        <div className="flex flex-wrap items-center gap-2">
          <DateControl filter={filter} today={today} hrefWith={hrefWith} />
          {stepper && previous && next && (
            <span className="flex items-center gap-1">
              <Link href={hrefWith({ period: stepper, date: previous })} className="icon-btn border border-line bg-white" aria-label={p.previous[stepper]} title={p.previous[stepper]}>
                <Icon name="chevronLeft" />
              </Link>
              {next <= today ? (
                <Link href={hrefWith({ period: stepper, date: next })} className="icon-btn border border-line bg-white" aria-label={p.next[stepper]} title={p.next[stepper]}>
                  <Icon name="chevronRight" />
                </Link>
              ) : (
                <button type="button" className="icon-btn border border-line bg-white" aria-label={p.next[stepper]} disabled>
                  <Icon name="chevronRight" />
                </button>
              )}
            </span>
          )}
          {stepper && (
            <Link href={hrefWith({ period: stepper, date: today })} className="text-link text-[12px]">
              {p.quick[stepper]}
            </Link>
          )}
        </div>
      )}
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
    const first = root.current?.querySelector<HTMLButtonElement>('[data-pick][aria-pressed="true"]:not(:disabled), [data-pick]:not(:disabled)');
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
    if (event.key === 'Escape') {
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
  const weekdays = c.weekdays.split(',');
  const hint = custom ? (range.phase === 'start' ? c.hint.start : c.hint.end) : c.hint[period as 'day' | 'week' | 'month'];
  const cellClass = (on: boolean) =>
    `rounded-md text-[12px] transition disabled:cursor-not-allowed disabled:opacity-35 ${on ? 'bg-blue font-semibold text-white' : 'hover:bg-soft hover:text-blue'}`;

  return (
    <div ref={root} className="relative w-full sm:w-auto" onKeyDown={onKeyDown}>
      <span className="sr-only">{label}</span>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}：${value}`}
        className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-semibold hover:border-[#c4cce0] sm:w-auto sm:min-w-[220px]"
      >
        <span className="flex min-w-0 flex-col items-start">
          <small className="text-[10px] font-normal text-muted">{label}</small>
          <span className="truncate font-mono">{value}</span>
        </span>
        <Icon name="clock" className="size-4 flex-none text-muted" />
      </button>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-red">
          {error}
        </p>
      )}
      {open && (
        <div role="dialog" aria-label={label} className="absolute top-full left-0 z-30 mt-2 w-[304px] max-w-[calc(100vw-32px)] rounded-xl border border-line bg-white p-3 shadow-xl">
          {custom && (
            <>
              <div role="group" aria-label={c.presets} className="mb-2 flex flex-wrap gap-1.5">
                {RECENT_RANGES.map((days) => {
                  const recent = recentRange(days)!;
                  const on = range.start === recent.start && range.end === recent.end;
                  return (
                    <button
                      key={days}
                      type="button"
                      aria-pressed={on}
                      onClick={() => applyRange(recent.start, recent.end)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${on ? 'border-blue bg-soft text-blue' : 'border-line text-muted hover:text-ink'}`}
                    >
                      {fill(c.recent, { n: days })}
                    </button>
                  );
                })}
              </div>
              <div className="mb-2 grid grid-cols-2 gap-2">
                {(['start', 'end'] as const).map((bound) => (
                  <button
                    key={bound}
                    type="button"
                    aria-pressed={range.phase === bound}
                    onClick={() => setRange((current) => ({ ...current, phase: bound }))}
                    className={`flex flex-col items-start rounded-lg border px-2.5 py-1.5 text-left ${range.phase === bound ? 'border-blue bg-soft' : 'border-line'}`}
                  >
                    <small className="text-[10px] text-muted">{bound === 'start' ? c.start : c.end}</small>
                    <strong className="font-mono text-[12px]">{range[bound] || c.choose}</strong>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setCursor(previousCursor)}
              aria-label={period === 'month' ? c.previousYear : c.previousMonth}
            >
              <Icon name="chevronLeft" />
            </button>
            <div className="flex items-center gap-1.5">
              <select
                aria-label={c.year}
                value={year}
                onChange={(event) => setCursor(`${event.target.value}-${String(month).padStart(2, '0')}-01`)}
                className="rounded-md border border-line bg-white px-1.5 py-1 text-[12px]"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              {period !== 'month' && (
                <select
                  aria-label={c.month}
                  value={month}
                  onChange={(event) => setCursor(`${year}-${String(event.target.value).padStart(2, '0')}-01`)}
                  className="rounded-md border border-line bg-white px-1.5 py-1 text-[12px]"
                >
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
              className="icon-btn"
              onClick={() => setCursor(nextCursor)}
              disabled={nextDisabled}
              aria-label={period === 'month' ? c.nextYear : c.nextMonth}
            >
              <Icon name="chevronRight" />
            </button>
          </div>
          {period === 'month' ? (
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: 12 }, (_, index) => {
                const day = `${year}-${String(index + 1).padStart(2, '0')}-01`;
                const on = selected(day);
                return (
                  <button
                    key={day}
                    type="button"
                    data-pick
                    aria-pressed={on}
                    aria-label={fill(p.monthLabel, { year, month: index + 1 })}
                    disabled={!pickable(period, day, today)}
                    onClick={() => pick(day)}
                    className={`h-10 ${cellClass(on)}`}
                  >
                    {monthName(index + 1)}
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <div className={`grid gap-0.5 text-center text-[10px] text-muted ${period === 'week' ? 'grid-cols-8' : 'grid-cols-7'}`}>
                {period === 'week' && <span>{c.week}</span>}
                {weekdays.map((day) => (
                  <span key={day}>{day}</span>
                ))}
              </div>
              {period === 'week' ? (
                <div className="mt-1 flex flex-col gap-0.5">
                  {weeks.map((days) => {
                    const on = selected(days[0]!);
                    const week = reportingWeek(days[0]!);
                    return (
                      <button
                        key={days[0]}
                        type="button"
                        data-pick
                        aria-pressed={on}
                        aria-label={`${week} · ${days[0]} — ${days[6]}`}
                        disabled={!pickable(period, days[0]!, today)}
                        onClick={() => pick(days[0]!)}
                        className={`grid h-8 grid-cols-8 items-center text-center ${cellClass(on)}`}
                      >
                        <small className={`text-[10px] ${on ? 'text-white/80' : 'text-muted'}`}>{Number(week.slice(6))}</small>
                        {days.map((day) => (
                          <span key={day} className={outside(day) && !on ? 'text-[#b6bccb]' : ''}>
                            {Number(day.slice(8))}
                          </span>
                        ))}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-1 grid grid-cols-7 gap-0.5">
                  {weeks.flat().map((day) => {
                    const on = selected(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        data-pick
                        aria-pressed={on}
                        aria-label={day}
                        aria-current={day === today ? 'date' : undefined}
                        disabled={!pickable(period, day, today)}
                        onClick={() => pick(day)}
                        className={`h-8 ${cellClass(on)} ${inRange(day) ? 'bg-soft text-blue' : ''} ${outside(day) && !on ? 'text-[#b6bccb]' : ''} ${
                          day === today && !on ? 'ring-1 ring-blue/40' : ''
                        }`}
                      >
                        {Number(day.slice(8))}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted" aria-live="polite">
              {hint}
            </p>
            <button type="button" className="btn-ghost" onClick={close}>
              {c.close}
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-1 text-[11px] text-red">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
