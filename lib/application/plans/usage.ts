/**
 * What a workspace reads about its own consumption. architecture.md 6.3 and
 * 11.1: `usage_summary` is derived and rebuildable from usage events -- the
 * dashboard never trusts a browser-side count -- and `request_log` is the
 * user-facing summary of each request, without the query text (17.1).
 *
 * The summary rebuild is idempotent by construction: it recomputes a window
 * of daily buckets from the events and replaces exactly that window. Reads
 * rebuild before returning, so the figures are always the events' figures --
 * the table is a materialisation, not a second source of truth.
 */
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { maskApiKey } from '@/lib/domain/api-key';
import { uuidv7 } from '@/lib/domain/id';
import { BUILD_ENTRYPOINT } from '@/lib/domain/build-billing';
import { REQUEST_PAGE_SIZE, type RequestFilter } from '@/lib/domain/request-log';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { workspacePlanVersion } from './billing';

/** Daily buckets kept per workspace. */
const SUMMARY_WINDOW_DAYS = 90;
const REQUEST_PAGE_LIMIT = REQUEST_PAGE_SIZE;
/** Rows per round trip when an export walks the whole filtered log. */
const EXPORT_BATCH = 500;

export interface UsageBucket {
  date: string; // YYYY-MM-DD, UTC
  /** Retrieval calls. */
  calls: number;
  /** Build calls (library-build-billing.md 8), shown apart. */
  buildCalls: number;
}

export interface UsageOverview {
  buckets: UsageBucket[];
  periodStart: string;
  periodEnd: string;
  /** Every call billed this period, retrieval and build, whichever balance paid for it. */
  callsThisPeriod: number;
  /** Of those, the ones the monthly allowance paid for; never more than `planAllowance`. */
  planCallsThisPeriod: number;
  /** Of those, the ones call packs paid for -- only once the allowance ran out (quota.ts deduction order). */
  addonCallsThisPeriod: number;
  retrievalCallsThisPeriod: number;
  buildCallsThisPeriod: number;
  returnedTokensThisPeriod: number;
  planAllowance: number;
  addonBalanceRemaining: number;
  /** Calls ever granted by packs; with the balance, how much of them is spent. Zero before the first pack. */
  addonGranted: number;
}

/** Rebuild the workspace's daily buckets from its usage events. */
export async function rebuildUsageSummary(workspaceId: string): Promise<void> {
  const database = db();
  const windowStart = new Date(Date.now() - SUMMARY_WINDOW_DAYS * 86_400_000);
  windowStart.setUTCHours(0, 0, 0, 0);

  /*
   * Counted, deleted and written in one transaction, and upserted rather than
   * plainly inserted: two concurrent rebuilds of one workspace otherwise race,
   * and the loser hits `usage_summary_uq` and turns a read path into a 500.
   * The upsert makes the loser overwrite the same buckets with the same
   * figures instead; the delete clears buckets the events no longer cover.
   */
  await database.transaction(async (tx) => {
    const counted = await tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${schema.usageEvent.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        calls: sql<number>`coalesce(sum(${schema.usageEvent.calls}) filter (where ${schema.usageEvent.entrypoint} <> ${BUILD_ENTRYPOINT}), 0)::int`,
        buildCalls: sql<number>`coalesce(sum(${schema.usageEvent.calls}) filter (where ${schema.usageEvent.entrypoint} = ${BUILD_ENTRYPOINT}), 0)::int`,
      })
      .from(schema.usageEvent)
      .where(
        and(
          eq(schema.usageEvent.workspaceId, workspaceId),
          gte(schema.usageEvent.createdAt, windowStart),
        ),
      )
      .groupBy(sql`1`);

    await tx
      .delete(schema.usageSummary)
      .where(
        and(
          eq(schema.usageSummary.workspaceId, workspaceId),
          gte(schema.usageSummary.bucketDate, windowStart),
        ),
      );
    if (counted.length > 0) {
      await tx
        .insert(schema.usageSummary)
        .values(
          counted.map((bucket) => ({
            id: uuidv7(),
            workspaceId,
            periodStart: windowStart,
            bucketDate: new Date(`${bucket.day}T00:00:00Z`),
            calls: bucket.calls,
            buildCalls: bucket.buildCalls,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.usageSummary.workspaceId, schema.usageSummary.bucketDate],
          set: {
            periodStart: sql`excluded.period_start`,
            calls: sql`excluded.calls`,
            buildCalls: sql`excluded.build_calls`,
          },
        });
    }
  });
}

/** The dashboard's numbers: rebuilt from events, then read. */
export async function usageOverview(workspaceId: string): Promise<UsageOverview> {
  await rebuildUsageSummary(workspaceId);
  const database = db();

  const buckets = await database
    .select({
      bucketDate: schema.usageSummary.bucketDate,
      calls: schema.usageSummary.calls,
      buildCalls: schema.usageSummary.buildCalls,
    })
    .from(schema.usageSummary)
    .where(eq(schema.usageSummary.workspaceId, workspaceId))
    .orderBy(schema.usageSummary.bucketDate);

  const { allowance, periodStart, periodEnd } = await currentWindow(workspaceId);
  const [inPeriod] = await database
    .select({
      retrieval: sql<number>`coalesce(sum(${schema.usageEvent.calls}) filter (where ${schema.usageEvent.entrypoint} <> ${BUILD_ENTRYPOINT}), 0)::int`,
      build: sql<number>`coalesce(sum(${schema.usageEvent.calls}) filter (where ${schema.usageEvent.entrypoint} = ${BUILD_ENTRYPOINT}), 0)::int`,
      tokens: sql<number>`coalesce(sum(${schema.usageEvent.returnedTokens}), 0)::bigint`,
      /* By the source that paid: a whole event for `addon`, the pack's share of a build that split. */
      addon: sql<number>`coalesce(sum(case
        when ${schema.usageEvent.debitSource} = 'addon' then ${schema.usageEvent.calls}
        when ${schema.usageEvent.debitSource} = 'split' then coalesce((${schema.usageEvent.buildDetail} ->> 'addonCalls')::int, 0)
        else 0 end), 0)::int`,
    })
    .from(schema.usageEvent)
    .where(
      and(
        eq(schema.usageEvent.workspaceId, workspaceId),
        gte(schema.usageEvent.createdAt, periodStart),
        lt(schema.usageEvent.createdAt, periodEnd),
      ),
    );
  const [addon] = await database
    .select({
      remaining: sql<number>`coalesce(sum(${schema.addonGrant.callsGranted} - ${schema.addonGrant.callsConsumed}), 0)::int`,
      granted: sql<number>`coalesce(sum(${schema.addonGrant.callsGranted}), 0)::int`,
    })
    .from(schema.addonGrant)
    .where(eq(schema.addonGrant.workspaceId, workspaceId));

  return {
    buckets: buckets.map((bucket) => ({
      date: bucket.bucketDate.toISOString().slice(0, 10),
      calls: bucket.calls,
      buildCalls: bucket.buildCalls,
    })),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    callsThisPeriod: (inPeriod?.retrieval ?? 0) + (inPeriod?.build ?? 0),
    addonCallsThisPeriod: inPeriod?.addon ?? 0,
    planCallsThisPeriod: Math.max(0, (inPeriod?.retrieval ?? 0) + (inPeriod?.build ?? 0) - (inPeriod?.addon ?? 0)),
    retrievalCallsThisPeriod: inPeriod?.retrieval ?? 0,
    buildCallsThisPeriod: inPeriod?.build ?? 0,
    returnedTokensThisPeriod: Number(inPeriod?.tokens ?? 0),
    planAllowance: allowance,
    addonBalanceRemaining: addon?.remaining ?? 0,
    addonGranted: addon?.granted ?? 0,
  };
}

async function currentWindow(
  workspaceId: string,
): Promise<{ allowance: number; periodStart: Date; periodEnd: Date }> {
  const plan = await workspacePlanVersion(workspaceId);
  return {
    allowance: plan.monthlyCalls,
    periodStart: plan.periodStart,
    periodEnd: plan.periodEnd,
  };
}

/* --------------------------------------------------------- request log */

/**
 * Best-effort by contract: the log is a summary for the user's screen, and
 * failing a served request over its own diary entry would invert priorities.
 * Callers fire and forget.
 */
export async function recordRequestLog(entry: {
  workspaceId: string | null;
  requestId: string;
  operation: string;
  libraryPublicId: string | null;
  entrypoint: string | null;
  statusCode: number;
  latencyMs: number | null;
  returnedTokens: number | null;
  apiKeyId: string | null;
}): Promise<void> {
  await db()
    .insert(schema.requestLog)
    .values({ id: uuidv7(), ...entry });
}

export interface RequestLogRow {
  /**
   * The row's own key. Not `requestId`: one request may write several rows --
   * a showcase draft runs each probe as its own charged retrieval under the
   * request that asked for the draft -- so the request id repeats.
   */
  id: string;
  requestId: string;
  operation: string;
  libraryPublicId: string | null;
  entrypoint: string | null;
  statusCode: number;
  latencyMs: number | null;
  returnedTokens: number | null;
  /** Prefix and last four of the key that made the request, or null. */
  apiKeyMasked: string | null;
  createdAt: string;
}

export interface RequestLogPage {
  rows: RequestLogRow[];
  /** Rows matching the filter, not the page: what a truthful footer prints. */
  total: number;
  page: number;
  pageSize: number;
}

/** Everything a filter narrows the log to, always within the workspace. */
function requestConditions(workspaceId: string, filter: Partial<RequestFilter>): SQL {
  const conditions: SQL[] = [eq(schema.requestLog.workspaceId, workspaceId)];
  if (filter.from) conditions.push(gte(schema.requestLog.createdAt, filter.from));
  if (filter.to) conditions.push(lt(schema.requestLog.createdAt, filter.to));
  if (filter.status === 'ok') conditions.push(lt(schema.requestLog.statusCode, 400));
  if (filter.status === 'error') conditions.push(gte(schema.requestLog.statusCode, 400));
  if (filter.entrypoint) conditions.push(eq(schema.requestLog.entrypoint, filter.entrypoint));
  if (filter.library) conditions.push(eq(schema.requestLog.libraryPublicId, filter.library));
  if (filter.query) {
    /* Escaped so a typed `%` matches a percent sign and not everything. */
    const pattern = `%${filter.query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conditions.push(
      or(
        ilike(schema.requestLog.requestId, pattern),
        ilike(schema.requestLog.operation, pattern),
        ilike(schema.requestLog.libraryPublicId, pattern),
      )!,
    );
  }
  return and(...conditions)!;
}

const REQUEST_SELECTION = {
  id: schema.requestLog.id,
  requestId: schema.requestLog.requestId,
  operation: schema.requestLog.operation,
  libraryPublicId: schema.requestLog.libraryPublicId,
  entrypoint: schema.requestLog.entrypoint,
  statusCode: schema.requestLog.statusCode,
  latencyMs: schema.requestLog.latencyMs,
  returnedTokens: schema.requestLog.returnedTokens,
  createdAt: schema.requestLog.createdAt,
  keyPrefix: schema.apiKey.keyPrefix,
  keyLastFour: schema.apiKey.lastFour,
};

interface RequestSelection {
  id: string;
  requestId: string;
  operation: string;
  libraryPublicId: string | null;
  entrypoint: string | null;
  statusCode: number;
  latencyMs: number | null;
  returnedTokens: number | null;
  createdAt: Date;
  keyPrefix: string | null;
  keyLastFour: string | null;
}

function toRow(row: RequestSelection): RequestLogRow {
  return {
    id: row.id,
    requestId: row.requestId,
    operation: row.operation,
    libraryPublicId: row.libraryPublicId,
    entrypoint: row.entrypoint,
    statusCode: row.statusCode,
    latencyMs: row.latencyMs,
    returnedTokens: row.returnedTokens,
    apiKeyMasked:
      row.keyPrefix && row.keyLastFour ? maskApiKey(row.keyPrefix, row.keyLastFour) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One page of a workspace's log, newest first, with the count behind it.
 * The key is joined for its mask only -- a revoked key still names its
 * requests, which is why revocation keeps the row.
 */
export async function queryRequests(
  workspaceId: string,
  filter: Partial<RequestFilter> = {},
  pageSize = REQUEST_PAGE_LIMIT,
): Promise<RequestLogPage> {
  const database = db();
  const where = requestConditions(workspaceId, filter);
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(Math.max(1, Math.floor(pageSize)), REQUEST_PAGE_LIMIT);

  const [rows, [counted]] = await Promise.all([
    database
      .select(REQUEST_SELECTION)
      .from(schema.requestLog)
      .leftJoin(schema.apiKey, eq(schema.apiKey.id, schema.requestLog.apiKeyId))
      .where(where)
      .orderBy(desc(schema.requestLog.createdAt), desc(schema.requestLog.id))
      .limit(limit)
      .offset((page - 1) * limit),
    database.select({ n: sql<number>`count(*)::int` }).from(schema.requestLog).where(where),
  ]);

  return { rows: rows.map(toRow), total: counted?.n ?? 0, page, pageSize: limit };
}

export interface RequestStats {
  /** Rows matching the filter, the same number `queryRequests` counts. */
  total: number;
  /** Of those, the ones that were served (status below 400). */
  served: number;
  /** Mean latency over served rows that recorded one, or null when none did. */
  averageLatencyMs: number | null;
  /** Tokens returned across matching rows. */
  returnedTokens: number;
}

/**
 * The filtered log summarised, in one query over the same predicate the list
 * and the export use.
 *
 * The screen used to derive its success rate and average latency from the
 * fifty rows it had in hand, which made `?page=2` report a different success
 * rate for the same filter and put a page-shaped figure beside period-shaped
 * ones. A summary of a filter has to be computed over the filter; aggregating
 * in Postgres is also the only way to do it without reading the whole log.
 */
export async function requestStats(
  workspaceId: string,
  filter: Partial<RequestFilter> = {},
): Promise<RequestStats> {
  const [row] = await db()
    .select({
      total: sql<number>`count(*)::int`,
      served: sql<number>`count(*) filter (where ${schema.requestLog.statusCode} < 400)::int`,
      /* Served rows only, matching what the success tile beside it counts; a
         failed request's latency measures how fast it gave up. */
      averageLatencyMs: sql<
        number | null
      >`avg(${schema.requestLog.latencyMs}) filter (where ${schema.requestLog.statusCode} < 400)`,
      returnedTokens: sql<number>`coalesce(sum(${schema.requestLog.returnedTokens}), 0)::bigint`,
    })
    .from(schema.requestLog)
    .where(requestConditions(workspaceId, filter));

  const average = row?.averageLatencyMs ?? null;
  return {
    total: row?.total ?? 0,
    served: row?.served ?? 0,
    averageLatencyMs: average === null ? null : Math.round(Number(average)),
    returnedTokens: Number(row?.returnedTokens ?? 0),
  };
}

/** A workspace reads its own log and nothing else -- anonymous has no log view. */
export async function listRequests(
  workspaceId: string,
  limit = REQUEST_PAGE_LIMIT,
): Promise<RequestLogRow[]> {
  return (await queryRequests(workspaceId, {}, limit)).rows;
}

/**
 * The whole filtered log, a batch at a time, for the CSV export. Keyset on
 * (created_at, id) rather than offset, so a log that grows while it is being
 * exported neither skips nor repeats a row.
 */
export async function* iterateRequests(
  workspaceId: string,
  filter: Partial<RequestFilter> = {},
): AsyncGenerator<RequestLogRow[]> {
  const database = db();
  const base = requestConditions(workspaceId, filter);
  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    const after: SQL | undefined = cursor
      ? sql`(${schema.requestLog.createdAt}, ${schema.requestLog.id}) < (${cursor.createdAt}, ${cursor.id})`
      : undefined;
    const rows: (RequestSelection & { id: string })[] = await database
      .select({ ...REQUEST_SELECTION, id: schema.requestLog.id })
      .from(schema.requestLog)
      .leftJoin(schema.apiKey, eq(schema.apiKey.id, schema.requestLog.apiKeyId))
      .where(after ? and(base, after) : base)
      .orderBy(desc(schema.requestLog.createdAt), desc(schema.requestLog.id))
      .limit(EXPORT_BATCH);
    if (rows.length === 0) return;
    yield rows.map(toRow);
    if (rows.length < EXPORT_BATCH) return;
    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}
