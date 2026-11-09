/**
 * What the console's finance charts share in SQL (lib/domain/admin-finance.ts):
 * the start of the UTC+8 hour, day or month a timestamp falls in, as epoch
 * milliseconds, so each chart is one `group by status, bucket` query over
 * the list's own filters. Written without parameters, so the same text can
 * be selected and grouped by, and independent of the session's time zone.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { REPORT_UTC_OFFSET_HOURS } from '@/lib/constants';
import { financeTrend, type FinanceKind, type FinanceTrend, type FinanceSeries } from '@/lib/domain/admin-finance';

export function bucketStart(column: AnyColumn, unit: 'hour' | 'day' | 'month'): SQL<string | number | null> {
  const hours = REPORT_UTC_OFFSET_HOURS;
  return sql<string | number | null>`((extract(epoch from date_trunc('${sql.raw(unit)}', (${column} at time zone 'UTC') + interval '${sql.raw(String(hours))} hours')) * 1000)::bigint - ${sql.raw(String(hours * 60 * 60 * 1000))})`;
}

/** The trend from grouped rows as drivers return them (bigints as strings). */
export function trendOf<K extends FinanceKind>(
  kind: K,
  time: { period: string; date: string; start: string; end: string },
  rows: readonly { status: string; at: string | number | null; count: string | number; cents: string | number | null }[],
  now: Date,
): FinanceTrend<FinanceSeries<K>> {
  return financeTrend(
    kind,
    time,
    rows.map((row) => ({ status: row.status, at: row.at === null ? null : Number(row.at), count: Number(row.count), cents: Number(row.cents ?? 0) })),
    now,
  );
}
