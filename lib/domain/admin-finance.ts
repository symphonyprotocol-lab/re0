/**
 * The console's finance charts (prototype admin-finance.js, README
 * 「充值记录与提现审核统计图表」 and 「提现记录的结果统计图表」): grouped bars
 * per status for 充值交易, 提现审核 and 提现记录, on the user-side reporting
 * calendar (UTC+8, Monday weeks; lib/domain/statistics.ts). The chart and
 * the list read one result set: the same search, status and period, the
 * whole matching set rather than a page. Amounts are integer US cents: a
 * purchase's amount, a payout's requested amount before fees.
 *
 * The database groups rows by the UTC+8 hour, day or month they fall in
 * (`financeUnit`); `financeTrend` lays those groups onto the bars.
 */
import { CREDIT_USD, RECENT_RANGES, REPORT_UTC_OFFSET_HOURS } from '@/lib/constants';
import { param } from '@/lib/domain/list';
import {
  dayStart,
  PERIODS,
  periodFilter,
  periodRange,
  recentRange,
  reportingDate,
  trendBuckets,
  type Period,
  type PeriodFilter,
  type Range,
} from '@/lib/domain/statistics';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OFFSET = REPORT_UTC_OFFSET_HOURS * HOUR;

/** The statuses each chart draws, in legend order: 提现审核 only the queue, 提现记录 only outcomes. */
export const FINANCE_SERIES = {
  purchases: ['paid', 'refunded', 'chargeback'],
  payouts: ['pending', 'approved'],
  'payout-history': ['paid', 'failed', 'rejected'],
} as const;
export type FinanceKind = keyof typeof FINANCE_SERIES;
export type FinanceSeries<K extends FinanceKind = FinanceKind> = (typeof FINANCE_SERIES)[K][number];

export const FINANCE_METRICS = ['amount', 'count'] as const;
export type FinanceMetric = (typeof FINANCE_METRICS)[number];

/** All time draws one bar per month up to this many, then groups months. */
export const FINANCE_MAX_MONTH_BARS = 24;

/** Credits in one US cent (1 credit = USD 0.0001). */
export const CREDITS_PER_CENT = Math.round(1 / (CREDIT_USD * 100));

/** A payout's requested credits in whole cents, rounded per request as the chart sums them. */
export function centsOfCredits(credits: number): number {
  return Number.isFinite(credits) ? Math.max(0, Math.round(credits / CREDITS_PER_CENT)) : 0;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

/**
 * The time part of a finance list's view, as its URL keeps it: `period`
 * and either `date` (day / week / month) or `start` and `end` (custom),
 * blank otherwise so the canonical URL leaves them out, and the metric.
 */
export interface FinanceTime {
  period: Period;
  date: string;
  start: string;
  end: string;
  metric: FinanceMetric;
}

/**
 * Reads the calendar from a URL. The old `period=7|30|90` links keep
 * filtering as the equivalent custom range (the last N days including today).
 */
export function financeTime(params: Params, now: Date = new Date()): FinanceTime {
  const raw = param(params, 'period');
  const recent = (RECENT_RANGES as readonly number[]).map(String).includes(raw) ? recentRange(Number(raw), now) : null;
  const filter: PeriodFilter = recent ? { period: 'custom', date: recent.end, ...recent } : periodFilter(params, now);
  const metric = param(params, 'metric');
  return {
    period: filter.period,
    date: filter.period === 'all' || filter.period === 'custom' ? '' : filter.date,
    start: filter.period === 'custom' ? filter.start! : '',
    end: filter.period === 'custom' ? filter.end! : '',
    metric: (FINANCE_METRICS as readonly string[]).includes(metric) ? (metric as FinanceMetric) : 'amount',
  };
}

/** The calendar a view stands for; anything not a calendar period (a subscription tab's `7`) is all time. */
export function financeFilter(time: { period: string; date: string; start: string; end: string }, now: Date = new Date()): PeriodFilter {
  const period = (PERIODS as readonly string[]).includes(time.period) ? (time.period as Period) : 'all';
  if (period === 'custom' && time.start && time.end) return { period, date: time.end, start: time.start, end: time.end };
  if (period !== 'all' && period !== 'custom' && time.date) return { period, date: time.date };
  return { period: 'all', date: reportingDate(now) };
}

/** `[start, end)` the list and the chart filter on, or null for all time. */
export function financeRange(time: { period: string; date: string; start: string; end: string }): Range | null {
  return periodRange(financeFilter(time));
}

/** What the database groups by: hours for a day, months for all time, days otherwise. */
export function financeUnit(time: { period: string }): 'hour' | 'day' | 'month' {
  return time.period === 'day' ? 'hour' : (PERIODS as readonly string[]).includes(time.period) && time.period !== 'all' ? 'day' : 'month';
}

export interface FinanceValue {
  count: number;
  cents: number;
}

/** One group from the database: a status, the start of the UTC+8 hour / day / month (null when the row has no time), its count and cents. */
export interface FinanceGroup {
  status: string;
  at: number | null;
  count: number;
  cents: number;
}

export interface FinanceBar<S extends string = string> {
  start: number;
  end: number;
  values: Record<S, FinanceValue>;
}

export interface FinanceTrend<S extends string = string> {
  keys: S[];
  bars: FinanceBar<S>[];
  totals: Record<S, FinanceValue>;
  /** Rows with no reliable time: listed under all time, not drawn. */
  missingTime: number;
  /** `days` / `months`: each bar covers `step` days or months. */
  grouping: 'hour' | 'day' | 'days' | 'month' | 'months';
  step: number;
}

/** The first instant of the UTC+8 month `months` after the one `date` is in. */
function monthStart(date: string, months = 0): number {
  const local = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  local.setUTCMonth(local.getUTCMonth() + months);
  return dayStart(local.toISOString().slice(0, 10));
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/**
 * All time's bars: every month from the earliest dated row (or this month)
 * to this month or the latest row, grouped so there are at most
 * `FINANCE_MAX_MONTH_BARS`.
 */
export function monthBars(first: number | null, last: number | null, now: Date = new Date()): { bars: { start: number; end: number }[]; step: number } {
  const today = reportingDate(now);
  const from = first === null ? today : reportingDate(Math.min(first, dayStart(today)));
  const to = last === null || reportingDate(last) < today ? today : reportingDate(last);
  const months = monthIndex(to) - monthIndex(from) + 1;
  const step = Math.max(1, Math.ceil(months / FINANCE_MAX_MONTH_BARS));
  const end = monthStart(to, 1);
  const bars: { start: number; end: number }[] = [];
  for (let index = 0; index < months; index += step) {
    bars.push({ start: monthStart(from, index), end: Math.min(monthStart(from, index + step), end) });
  }
  return { bars, step };
}

/** The bar holding `at`, by binary search over sorted, adjoining bars. */
function barAt<B extends { start: number; end: number }>(bars: readonly B[], at: number): B | null {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const bar = bars[middle]!;
    if (at < bar.start) high = middle - 1;
    else if (at >= bar.end) low = middle + 1;
    else return bar;
  }
  return null;
}

/**
 * The chart for `kind` over a view's period: the bars (hours for a day,
 * days for a week or month, at most 31 grouped days for a custom range,
 * months for all time), each status's count and cents per bar, the totals
 * of what was drawn, and how many rows had no time. Groups whose status the
 * chart does not draw are ignored.
 */
export function financeTrend<K extends FinanceKind>(
  kind: K,
  time: { period: string; date: string; start: string; end: string },
  groups: readonly FinanceGroup[],
  now: Date = new Date(),
): FinanceTrend<FinanceSeries<K>> {
  type S = FinanceSeries<K>;
  const keys = [...FINANCE_SERIES[kind]] as S[];
  const empty = () => Object.fromEntries(keys.map((key) => [key, { count: 0, cents: 0 }])) as Record<S, FinanceValue>;
  const drawn = groups.filter((group) => (keys as string[]).includes(group.status));
  const dated = drawn.filter((group) => group.at !== null && Number.isFinite(group.at));
  const filter = financeFilter(time, now);
  let shape: { bars: { start: number; end: number }[]; grouping: FinanceTrend['grouping']; step: number };
  if (filter.period === 'all') {
    const times = dated.map((group) => group.at!);
    const months = monthBars(times.length ? Math.min(...times) : null, times.length ? Math.max(...times) : null, now);
    shape = { bars: months.bars, grouping: months.step > 1 ? 'months' : 'month', step: months.step };
  } else {
    const { buckets, step, grouping } = trendBuckets(filter);
    shape = { bars: buckets, grouping, step: grouping === 'hour' ? 1 : Math.round(step / DAY) };
  }
  const bars: FinanceBar<S>[] = shape.bars.map((bar) => ({ ...bar, values: empty() }));
  const totals = empty();
  for (const group of dated) {
    const bar = barAt(bars, group.at!);
    if (!bar) continue;
    const status = group.status as S;
    const count = Number(group.count) || 0;
    const cents = Number.isFinite(Number(group.cents)) ? Math.max(0, Math.round(Number(group.cents))) : 0;
    bar.values[status].count += count;
    bar.values[status].cents += cents;
    totals[status].count += count;
    totals[status].cents += cents;
  }
  const missingTime = drawn.filter((group) => group.at === null || !Number.isFinite(group.at)).reduce((sum, group) => sum + (Number(group.count) || 0), 0);
  return { keys, bars, totals, missingTime, grouping: shape.grouping, step: shape.step };
}

/** The top of the value axis: the tallest bar rounded up to an even number, at least 2. */
export function financeAxisMax(trend: FinanceTrend, metric: FinanceMetric): number {
  const field = metric === 'count' ? 'count' : 'cents';
  const peak = Math.max(0, ...trend.bars.flatMap((bar) => trend.keys.map((key) => bar.values[key]![field])));
  return Math.max(2, Math.ceil(peak / 2) * 2);
}

/** A bar's full label: `2026-10-31 08:00`, a day, a range of days, a month or a range of months (UTC+8). */
export function financeBarLabel(trend: Pick<FinanceTrend, 'grouping'>, bar: { start: number; end: number }): string {
  const first = reportingDate(bar.start);
  const last = reportingDate(bar.end - 1);
  if (trend.grouping === 'hour') return `${first} ${String(new Date(bar.start + OFFSET).getUTCHours()).padStart(2, '0')}:00`;
  if (trend.grouping === 'month' || trend.grouping === 'months') return first.slice(0, 7) === last.slice(0, 7) ? first.slice(0, 7) : `${first.slice(0, 7)} — ${last.slice(0, 7)}`;
  return first === last ? first : `${first} — ${last}`;
}

/** The axis text under a bar; sparse when the bars are many. */
export function financeAxisLabel(trend: Pick<FinanceTrend, 'grouping' | 'bars'>, index: number): string {
  const bar = trend.bars[index]!;
  const last = index === trend.bars.length - 1;
  const date = reportingDate(bar.start);
  const many = trend.bars.length > 8;
  if (trend.grouping === 'hour') return index % 4 === 0 || last ? String(new Date(bar.start + OFFSET).getUTCHours()).padStart(2, '0') : '';
  if (trend.grouping === 'month' || trend.grouping === 'months') return !many || index % 4 === 0 || last ? date.slice(0, 7) : '';
  return !many || index % 5 === 0 || last ? date.slice(5) : '';
}
