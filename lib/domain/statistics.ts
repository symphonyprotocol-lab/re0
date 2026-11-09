/**
 * The reporting calendar (8.2 "用户侧统计", prototype statistics-time.js):
 * days run on UTC+8, weeks start on Monday, and a period is all time, one
 * day, one week, one month, or a custom range of whole days. Everything here
 * works on `YYYY-MM-DD` strings in that calendar and on UTC instants, so the
 * same code runs in the browser and on the server whatever their time zone.
 */
import { RECENT_RANGES, REPORT_UTC_OFFSET_HOURS, TREND_MAX_BARS } from '@/lib/constants';

const DAY = 24 * 60 * 60 * 1000;
const OFFSET = REPORT_UTC_OFFSET_HOURS * 60 * 60 * 1000;

export const PERIODS = ['all', 'day', 'week', 'month', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export interface PeriodFilter {
  period: Period;
  /** The day the period contains (custom: its last day). */
  date: string;
  start?: string;
  end?: string;
}

/** `[start, end)` in epoch milliseconds. */
export interface Range {
  start: number;
  end: number;
}

/** Today (or `now`'s day) in the reporting calendar. */
export function reportingDate(now: Date | number = new Date()): string {
  return new Date(Number(now) + OFFSET).toISOString().slice(0, 10);
}

export function validReportDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** Midnight of a reporting day, as an instant. */
export function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - OFFSET;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: Params, name: string): string {
  if (params instanceof URLSearchParams) return params.get(name) ?? '';
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/**
 * The period a URL asks for. A missing or broken date is today; a custom
 * range is ordered, capped at today, and defaults to this month so far.
 */
export function periodFilter(params: Params, now: Date = new Date()): PeriodFilter {
  const raw = read(params, 'period');
  const period: Period = (PERIODS as readonly string[]).includes(raw) ? (raw as Period) : 'all';
  const today = reportingDate(now);
  const requested = read(params, 'date');
  let date = validReportDate(requested) ? requested : today;
  if (date > today) date = today;
  if (period !== 'custom') return { period, date };
  const startRaw = read(params, 'start');
  const endRaw = read(params, 'end');
  const start = validReportDate(startRaw) ? startRaw : `${date.slice(0, 7)}-01`;
  const end = validReportDate(endRaw) ? endRaw : date;
  const [first, last] = [start > today ? today : start, end > today ? today : end].sort() as [string, string];
  return { period, date: last, start: first, end: last };
}

export function validRange(start: unknown, end: unknown, now: Date = new Date()): boolean {
  return validReportDate(start) && validReportDate(end) && start <= end && end <= reportingDate(now);
}

/** The instants a period covers; null for all time. */
export function periodRange(filter: PeriodFilter): Range | null {
  if (filter.period === 'all') return null;
  if (filter.period === 'custom') {
    return { start: dayStart(filter.start ?? filter.date), end: dayStart(filter.end ?? filter.date) + DAY };
  }
  const local = new Date(`${filter.date}T00:00:00Z`);
  if (filter.period === 'week') local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  if (filter.period === 'month') local.setUTCDate(1);
  const start = local.getTime() - OFFSET;
  if (filter.period === 'month') local.setUTCMonth(local.getUTCMonth() + 1);
  else local.setUTCDate(local.getUTCDate() + (filter.period === 'week' ? 7 : 1));
  return { start, end: local.getTime() - OFFSET };
}

/** The last 7 / 30 / 90 days including today, as a custom range. */
export function recentRange(days: number, now: Date = new Date()): { start: string; end: string } | null {
  if (!(RECENT_RANGES as readonly number[]).includes(days)) return null;
  const end = reportingDate(now);
  return { start: reportingDate(dayStart(end) - (days - 1) * DAY), end };
}

/** ISO week label (`2026-W44`) of a reporting day. */
export function reportingWeek(date: string): string {
  const local = new Date(`${date}T00:00:00Z`);
  local.setUTCDate(local.getUTCDate() + 3 - ((local.getUTCDay() + 6) % 7));
  const year = local.getUTCFullYear();
  const first = Date.parse(`${year}-01-01T00:00:00Z`);
  const week = Math.ceil(((local.getTime() - first) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The value a period's picker shows: the day, the ISO week or the month. */
export function selectionOf(period: Period, date: string): string {
  return period === 'week' ? reportingWeek(date) : period === 'month' ? date.slice(0, 7) : date;
}

/** A picker's value back to a day inside it, or null when it names no real day, week or month. */
export function dateOfSelection(period: Period, value: string): string | null {
  if (period === 'day') return validReportDate(value) ? value : null;
  if (period === 'month') return /^\d{4}-\d{2}$/.test(value) && validReportDate(`${value}-01`) ? `${value}-01` : null;
  if (period !== 'week' || !/^\d{4}-W\d{2}$/.test(value)) return null;
  const year = value.slice(0, 4);
  const week = Number(value.slice(6));
  if (week < 1 || week > 53) return null;
  const first = periodRange({ period: 'week', date: `${year}-01-04` })!.start;
  const date = reportingDate(first + (week - 1) * 7 * DAY);
  return reportingWeek(date) === value ? date : null;
}

/** The day one period before or after (`direction` −1 / +1). */
export function shiftDate(period: 'day' | 'week' | 'month', date: string, direction: number): string {
  const range = periodRange({ period, date })!;
  const local = new Date(range.start + OFFSET);
  if (period === 'month') local.setUTCMonth(local.getUTCMonth() + direction);
  else local.setUTCDate(local.getUTCDate() + (period === 'week' ? 7 : 1) * direction);
  return local.toISOString().slice(0, 10);
}

/** First and last day of a period, for its label. */
export function periodDays(filter: PeriodFilter): { first: string; last: string } | null {
  const range = periodRange(filter);
  return range ? { first: reportingDate(range.start), last: reportingDate(range.end - 1) } : null;
}

export interface Bucket {
  start: number;
  end: number;
}

/**
 * The trend's bars: hours for a day, days for a week or month, and for a
 * custom range days grouped so there are at most 31 bars.
 */
export function trendBuckets(filter: PeriodFilter): { buckets: Bucket[]; step: number; grouping: 'hour' | 'day' | 'days' } {
  const range = periodRange(filter);
  if (!range) return { buckets: [], step: DAY, grouping: 'day' };
  const step =
    filter.period === 'day'
      ? 60 * 60 * 1000
      : filter.period === 'custom'
        ? Math.max(1, Math.ceil((range.end - range.start) / DAY / TREND_MAX_BARS)) * DAY
        : DAY;
  const buckets: Bucket[] = [];
  for (let start = range.start; start < range.end; start += step) buckets.push({ start, end: Math.min(start + step, range.end) });
  return { buckets, step, grouping: filter.period === 'day' ? 'hour' : step > DAY ? 'days' : 'day' };
}

/** Counts (or sums) per bar from `[instant, value]` pairs. */
export function fillBuckets(buckets: readonly Bucket[], points: readonly (readonly [number, number])[]): number[] {
  const values = buckets.map(() => 0);
  if (!buckets.length) return values;
  const start = buckets[0]!.start;
  const end = buckets[buckets.length - 1]!.end;
  const step = buckets[0]!.end - buckets[0]!.start;
  for (const [at, value] of points) {
    if (at < start || at >= end) continue;
    const index = Math.min(values.length - 1, Math.floor((at - start) / step));
    values[index] = values[index]! + value;
  }
  return values;
}

/** The URL parameters that carry a period, for links that keep it. */
export function periodParams(filter: PeriodFilter): Record<string, string> {
  if (filter.period === 'all') return {};
  if (filter.period === 'custom') return { period: 'custom', start: filter.start!, end: filter.end! };
  return { period: filter.period, date: filter.date };
}

/** `YYYY-MM-DD HH:mm` in the reporting calendar (UTC+8), for tables and exports. */
export function reportingTime(at: Date | number | string | null | undefined): string {
  if (at === null || at === undefined) return '';
  const value = new Date(new Date(at).getTime() + OFFSET).toISOString();
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}
