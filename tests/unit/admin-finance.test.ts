/**
 * The console's finance charts (prototype tests/admin-finance.test.mjs):
 * the calendar in the list URL, UTC+8 bars for a day, a week across the
 * year end, a leap February, custom and all-time ranges with a bounded bar
 * count, integer cents, the series each list draws, and undated rows.
 */
import { describe, expect, it } from 'vitest';
import {
  centsOfCredits,
  financeAxisLabel,
  financeAxisMax,
  financeBarLabel,
  financeFilter,
  financeRange,
  financeTime,
  financeTrend,
  financeUnit,
  type FinanceGroup,
  type FinanceTrend,
} from '@/lib/domain/admin-finance';
import { csvHref, listHref, LIST_DEFAULTS, payoutHistoryView, payoutQueueView, PAYOUT_QUEUE_DEFAULTS, purchasesView } from '@/lib/domain/admin-lists';

const now = new Date('2026-11-01T10:00:00Z');
const row = (status: string, at: string | null, cents = 0): FinanceGroup => ({ status, at: at === null ? null : Date.parse(at), count: 1, cents });
const sum = (trend: FinanceTrend, key: string, field: 'count' | 'cents') => trend.bars.reduce((total, bar) => total + bar.values[key]![field], 0);

describe('finance calendar in the list URL', () => {
  it('reads the period, orders a custom range, caps dates at today and keeps the metric', () => {
    expect(financeTime({ period: 'week', date: '2026-10-29', metric: 'count' }, now)).toEqual({ period: 'week', date: '2026-10-29', start: '', end: '', metric: 'count' });
    expect(financeTime({ period: 'custom', start: '2026-10-30', end: '2026-10-01' }, now)).toEqual({ period: 'custom', date: '', start: '2026-10-01', end: '2026-10-30', metric: 'amount' });
    expect(financeTime({ period: 'day', date: '2026-02-30' }, now).date).toBe('2026-11-01');
    expect(financeTime({ period: 'month', date: '2028-01-01' }, now).date).toBe('2026-11-01');
    expect(financeTime({ period: 'year', metric: 'sum' }, now)).toEqual({ period: 'all', date: '', start: '', end: '', metric: 'amount' });
  });

  it('keeps old period=7|30|90 links filtering, as the same custom range', () => {
    const time = financeTime({ period: '30' }, now);
    expect(time).toMatchObject({ period: 'custom', start: '2026-10-03', end: '2026-11-01' });
    expect(financeRange(time)).toEqual({ start: Date.parse('2026-10-02T16:00:00Z'), end: Date.parse('2026-11-01T16:00:00Z') });
    expect(financeTime({ period: '7' }, now)).toMatchObject({ start: '2026-10-26', end: '2026-11-01' });
  });

  it('builds canonical links: time changes go back to page 1, the metric keeps the page', () => {
    const view = purchasesView({ q: 'creator', status: 'paid', period: 'week', date: '2026-10-29', size: '50', page: '3' }, now);
    expect(listHref('/admin/purchases', view)).toBe('/admin/purchases?q=creator&status=paid&period=week&date=2026-10-29&size=50&page=3');
    const metric = listHref('/admin/purchases', view, { metric: 'count' });
    expect(metric).toBe('/admin/purchases?q=creator&status=paid&period=week&date=2026-10-29&metric=count&size=50&page=3');
    expect(listHref('/admin/purchases', view, { date: '2026-10-20' })).toBe('/admin/purchases?q=creator&status=paid&period=week&date=2026-10-20&size=50');
    expect(csvHref('/api/admin/purchases', { ...view, metric: 'count' })).toBe('/api/admin/purchases?q=creator&status=paid&period=week&date=2026-10-29&size=50&format=csv');
    const custom = payoutQueueView({ status: 'approved', period: 'custom', start: '2026-10-30', end: '2026-10-01', metric: 'count' }, now);
    expect(listHref('/admin/payouts', custom, {}, PAYOUT_QUEUE_DEFAULTS)).toBe('/admin/payouts?status=approved&period=custom&start=2026-10-01&end=2026-10-30&metric=count');
    const history = payoutHistoryView({ q: 'x', status: 'failed', period: 'month', date: '2026-10-01', metric: 'count', size: '20', page: '2' }, now);
    expect(listHref('/admin/payout-history', history, { page: 3 })).toBe('/admin/payout-history?q=x&status=failed&period=month&date=2026-10-01&metric=count&page=3');
    expect(listHref('/admin/payout-history', payoutHistoryView({}, now))).toBe('/admin/payout-history');
    expect(LIST_DEFAULTS.metric).toBe('amount');
  });

  it('leaves Plan 订阅 on its last-N-days select', () => {
    expect(purchasesView({ tab: 'subscriptions', period: '7' }, now)).toMatchObject({ period: '7', date: '', start: '', end: '' });
    expect(financeRange(purchasesView({ tab: 'subscriptions', period: '7' }, now))).toBeNull();
    expect(purchasesView({ tab: 'subscriptions', period: 'day' }, now).period).toBe('all');
  });
});

describe('finance trend', () => {
  it('cuts a day on UTC+8 hours and sums exact integer cents', () => {
    const time = financeTime({ period: 'day', date: '2026-10-31' }, now);
    expect(financeUnit(time)).toBe('hour');
    const range = financeRange(time)!;
    expect(range).toEqual({ start: Date.parse('2026-10-30T16:00:00Z'), end: Date.parse('2026-10-31T16:00:00Z') });
    const rows = [
      row('paid', '2026-10-30T15:59:59Z', 2000),
      row('paid', '2026-10-30T16:00:00Z', 10),
      row('paid', '2026-10-30T16:30:00Z', 20),
      row('refunded', '2026-10-31T15:59:59Z', 1000),
      row('paid', '2026-10-31T16:00:00Z', 4000),
    ];
    const trend = financeTrend('purchases', time, rows, now);
    expect(trend.bars).toHaveLength(24);
    expect(trend.grouping).toBe('hour');
    expect(trend.bars[0]!.values.paid).toEqual({ count: 2, cents: 30 });
    expect(trend.bars[23]!.values.refunded).toEqual({ count: 1, cents: 1000 });
    expect(trend.totals).toEqual({ paid: { count: 2, cents: 30 }, refunded: { count: 1, cents: 1000 }, chargeback: { count: 0, cents: 0 } });
    expect(financeBarLabel(trend, trend.bars[0]!)).toBe('2026-10-31 00:00');
    expect(financeAxisLabel(trend, 4)).toBe('04');
    expect(financeAxisLabel(trend, 5)).toBe('');
  });

  it('draws a week across the year end and a leap February day by day', () => {
    const later = new Date('2028-03-01T10:00:00Z');
    const week = financeTime({ period: 'week', date: '2027-01-01' }, later);
    const rows = [row('paid', '2026-12-27T16:00:00Z', 1000), row('paid', '2027-01-03T15:59:59Z', 2000), row('paid', '2027-01-03T16:00:00Z', 3000)];
    const trend = financeTrend('purchases', week, rows, later);
    expect(trend.bars).toHaveLength(7);
    expect(financeBarLabel(trend, trend.bars[0]!)).toBe('2026-12-28');
    expect(financeBarLabel(trend, trend.bars[6]!)).toBe('2027-01-03');
    expect(trend.totals.paid).toEqual({ count: 2, cents: 3000 });
    expect(financeTrend('purchases', financeTime({ period: 'month', date: '2028-02-29' }, later), [], later).bars).toHaveLength(29);
    expect(financeTrend('purchases', financeTime({ period: 'month', date: '2027-02-10' }, later), [], later).bars).toHaveLength(28);
  });

  it('groups a long custom range into at most 31 bars and counts the end day in full', () => {
    const time = financeTime({ period: 'custom', start: '2000-01-01', end: '2026-11-01' }, now);
    const rows = Array.from({ length: 1200 }, (_, index) => row('paid', `${2000 + (index % 27)}-01-15T00:00:00Z`, 1000));
    const trend = financeTrend('purchases', time, rows, now);
    expect(trend.bars.length).toBeLessThanOrEqual(31);
    expect(trend.grouping).toBe('days');
    expect(sum(trend, 'paid', 'count')).toBe(1200);
    expect(trend.totals.paid.cents).toBe(1_200_000);
    const short = financeTime({ period: 'custom', start: '2026-10-12', end: '2026-10-14' }, now);
    const last = financeTrend('payout-history', short, [row('paid', '2026-10-14T15:59:59Z', 10_000)], now);
    expect(last.bars).toHaveLength(3);
    expect(last.bars[2]!.values.paid.count).toBe(1);
  });

  it('draws all time by month, at most 24 bars, and leaves undated rows out with a count', () => {
    const all = financeTime({}, now);
    expect(financeUnit(all)).toBe('month');
    const rows = Array.from({ length: 1200 }, (_, index) => row('paid', `${2000 + (index % 27)}-01-01T00:00:00+08:00`, 1000));
    const trend = financeTrend('purchases', all, [...rows, row('paid', null, 500)], now);
    expect(trend.bars.length).toBeLessThanOrEqual(24);
    expect(trend.grouping).toBe('months');
    expect(sum(trend, 'paid', 'count')).toBe(1200);
    expect(trend.totals.paid.cents).toBe(1_200_000);
    expect(trend.missingTime).toBe(1);
    expect(financeBarLabel(trend, trend.bars[0]!)).toMatch(/^2000-01 — \d{4}-\d{2}$/);
    const empty = financeTrend('purchases', all, [row('paid', null, 1000)], now);
    expect(empty.bars).toHaveLength(1);
    expect(empty.grouping).toBe('month');
    expect(financeBarLabel(empty, empty.bars[0]!)).toBe('2026-11');
    expect(empty.totals.paid.count).toBe(0);
    expect(financeAxisMax(empty, 'amount')).toBe(2);
    for (const bar of empty.bars) for (const value of Object.values(bar.values)) expect(Number.isFinite(value.cents)).toBe(true);
  });

  it('draws only the queue on 提现审核 and only outcomes on 提现记录', () => {
    const time = financeTime({ period: 'month', date: '2026-10-01' }, now);
    const rows = ['pending', 'approved', 'paid', 'failed', 'rejected'].map((status) => row(status, '2026-10-30T00:00:00Z', 5000));
    const queue = financeTrend('payouts', time, rows, now);
    expect(queue.keys).toEqual(['pending', 'approved']);
    expect(queue.totals).toEqual({ pending: { count: 1, cents: 5000 }, approved: { count: 1, cents: 5000 } });
    const history = financeTrend('payout-history', time, rows, now);
    expect(history.keys).toEqual(['paid', 'failed', 'rejected']);
    expect(Object.values(history.totals).map((value) => value.count)).toEqual([1, 1, 1]);
    expect(financeTrend('payout-history', time, [row('pending', '2026-10-30T00:00:00Z', 5000)], now).totals.paid.count).toBe(0);
    expect(financeTrend('payouts', time, [row('pending', null, 5000)], now).missingTime).toBe(1);
  });

  it('turns requested credits into whole cents per request', () => {
    expect(centsOfCredits(500_000)).toBe(5000);
    expect(centsOfCredits(1_000_000)).toBe(10_000);
    expect(centsOfCredits(500_049)).toBe(5000);
    expect(centsOfCredits(500_050)).toBe(5001);
    expect(centsOfCredits(Number.NaN)).toBe(0);
    expect(financeAxisMax(financeTrend('purchases', financeTime({ period: 'day', date: '2026-10-31' }, now), [row('paid', '2026-10-31T00:00:00Z', 1001)], now), 'amount')).toBe(1002);
  });

  it('gives the period controls a date to start from', () => {
    expect(financeFilter(financeTime({}, now), now)).toEqual({ period: 'all', date: '2026-11-01' });
    expect(financeFilter(financeTime({ period: 'custom', start: '2026-10-01', end: '2026-10-31' }, now), now)).toEqual({ period: 'custom', date: '2026-10-31', start: '2026-10-01', end: '2026-10-31' });
  });
});
