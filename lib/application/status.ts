/**
 * Use case: the public status page's figures, read from the tables that
 * recorded them (requirement.md 13.3 可观测性). The page is the platform's own
 * monitor: the API log says what was served, the operation log what was
 * built, the refresh schedule what is owed.
 * The arithmetic is `lib/domain/status.ts`; this only fetches.
 */
import { and, gte, inArray, sql, type AnyColumn } from 'drizzle-orm';
import { refreshSchedule } from '@/lib/application/ingestion';
import {
  STATUS_WINDOW_DAYS,
  summarizeStatus,
  type ApiDay,
  type OperationDay,
  type PlatformStatus,
} from '@/lib/domain/status';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export type { ComponentStatus, Incident, PlatformStatus } from '@/lib/domain/status';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a due refresh may stand before it counts against the platform. */
const GRACE_MS = DAY_MS;

const FETCHING_OPERATIONS = ['refresh', 'ingest'] as const;
const FINISHED_STATES = ['succeeded', 'skipped', 'failed'] as const;

export async function platformStatus(now: Date = new Date()): Promise<PlatformStatus> {
  const database = db();
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      (STATUS_WINDOW_DAYS - 1) * DAY_MS,
  );
  const utcDay = (column: AnyColumn) =>
    sql<string>`(${column} at time zone 'UTC')::date::text`;

  const [api, operations, schedule] = await Promise.all([
    database
      .select({
        day: utcDay(schema.requestLog.createdAt),
        requests: sql<number>`count(*)::int`,
        failures: sql<number>`(count(*) filter (where ${schema.requestLog.statusCode} >= 500))::int`,
        p95Ms: sql<number | null>`
          percentile_cont(0.95) within group (order by ${schema.requestLog.latencyMs})`,
      })
      .from(schema.requestLog)
      .where(gte(schema.requestLog.createdAt, since))
      .groupBy(sql`1`),
    database
      .select({
        day: utcDay(schema.workflowOperation.updatedAt),
        finished: sql<number>`count(*)::int`,
        failed: sql<number>`(count(*) filter (where ${schema.workflowOperation.status} = 'failed'))::int`,
      })
      .from(schema.workflowOperation)
      .where(
        and(
          gte(schema.workflowOperation.updatedAt, since),
          inArray(schema.workflowOperation.operationType, [...FETCHING_OPERATIONS]),
          inArray(schema.workflowOperation.status, [...FINISHED_STATES]),
        ),
      )
      .groupBy(sql`1`),
    refreshSchedule(now),
  ]);

  const timed = schedule.filter((source) => source.dueAt !== null);
  const overdue = timed.filter(
    (source) => !source.open && source.dueAt!.getTime() < now.getTime() - GRACE_MS,
  );
  const upcoming = timed
    .filter((source) => source.dueAt!.getTime() > now.getTime())
    .map((source) => source.dueAt!)
    .sort((a, b) => a.getTime() - b.getTime());

  return summarizeStatus({
    now,
    api: api.map(
      (row): ApiDay => ({
        day: row.day,
        requests: row.requests,
        failures: row.failures,
        p95Ms: row.p95Ms === null ? null : Math.round(Number(row.p95Ms)),
      }),
    ),
    operations: operations.map(
      (row): OperationDay => ({ day: row.day, finished: row.finished, failed: row.failed }),
    ),
    refresh: {
      scheduled: timed.length,
      overdue: overdue.length,
      open: schedule.filter((source) => source.open).length,
      nextDueAt: upcoming[0] ?? null,
    },
  });
}
