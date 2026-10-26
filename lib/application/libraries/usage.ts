/**
 * How much a workspace's own libraries are used: the calls served from each,
 * whoever made them. Read from `usage_event`, the billed record of every
 * served retrieval, so the count is the one billing and revenue share see.
 * Builds are usage events too but consumed no library's content, so they are
 * left out here as they are from the revenue pool (close-period.ts).
 *
 * The owner sees who called only as "this workspace" or "a reader": another
 * workspace's identity, keys and query text are theirs (architecture.md 17.1
 * keeps the query out of every log anyway).
 */
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { revenuePeriodId } from '@/lib/domain';
import { BUILD_ENTRYPOINT } from '@/lib/domain/build-billing';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface LibraryUsageCount {
  total: number;
  /** Since the first of this UTC month, the same window as a revenue period. */
  thisMonth: number;
}

export type LibraryUsageEarning = 'earned' | 'voided' | 'none';

export interface LibraryUsageEntry {
  id: string;
  createdAt: string;
  operation: string;
  entrypoint: string;
  statusCode: number;
  latencyMs: number | null;
  returnedTokens: number | null;
  versionLabel: string | null;
  /** The owner's own workspace, or anyone else. */
  caller: 'self' | 'reader';
  /** An earning event exists for the call; `voided` once a close flagged it. */
  earning: LibraryUsageEarning;
}

export interface LibraryUsageLog {
  summary: LibraryUsageCount & {
    /** Of this month's calls, the ones that earned (unflagged earning events). */
    earnedThisMonth: number;
    readersThisMonth: number;
  };
  entries: LibraryUsageEntry[];
  total: number;
}

export const LIBRARY_USAGE_PAGE_SIZE = 50;

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const RETRIEVAL = ne(schema.usageEvent.entrypoint, BUILD_ENTRYPOINT);

/** Calls served per library, for the library list. One grouped read. */
export async function libraryUsageCounts(
  libraryIds: string[],
): Promise<Map<string, LibraryUsageCount>> {
  if (libraryIds.length === 0) return new Map();
  const rows = await db()
    .select({
      libraryId: schema.usageEvent.libraryId,
      total: sql<number>`count(*)::int`,
      thisMonth: sql<number>`(count(*) filter (where ${schema.usageEvent.createdAt} >= ${monthStart()}))::int`,
    })
    .from(schema.usageEvent)
    .where(and(inArray(schema.usageEvent.libraryId, libraryIds), RETRIEVAL))
    .groupBy(schema.usageEvent.libraryId);
  return new Map(
    rows.map((row) => [row.libraryId!, { total: row.total, thisMonth: row.thisMonth }]),
  );
}

/**
 * One library's calls, newest first, a page at a time. The caller has already
 * established that `workspaceId` owns the library (workspaceLibraryDetail);
 * the owner filter here only decides which calls read as the owner's own.
 */
export async function libraryUsageLog(input: {
  workspaceId: string;
  libraryId: string;
  page: number;
}): Promise<LibraryUsageLog> {
  const database = db();
  const where = and(eq(schema.usageEvent.libraryId, input.libraryId), RETRIEVAL);
  const since = monthStart();

  const [summary, entries, [earned]] = await Promise.all([
    database
      .select({
        total: sql<number>`count(*)::int`,
        thisMonth: sql<number>`(count(*) filter (where ${schema.usageEvent.createdAt} >= ${since}))::int`,
        readersThisMonth: sql<number>`(count(distinct ${schema.usageEvent.workspaceId}) filter (where ${schema.usageEvent.createdAt} >= ${since} and ${schema.usageEvent.workspaceId} <> ${input.workspaceId}))::int`,
      })
      .from(schema.usageEvent)
      .where(where),
    database
      .select({
        id: schema.usageEvent.id,
        createdAt: schema.usageEvent.createdAt,
        operation: schema.usageEvent.operation,
        entrypoint: schema.usageEvent.entrypoint,
        statusCode: schema.usageEvent.statusCode,
        latencyMs: schema.usageEvent.latencyMs,
        returnedTokens: schema.usageEvent.returnedTokens,
        callerWorkspaceId: schema.usageEvent.workspaceId,
        versionLabel: schema.libraryVersion.label,
        earningFlagged: schema.earningEvent.flagged,
      })
      .from(schema.usageEvent)
      .leftJoin(schema.libraryVersion, eq(schema.libraryVersion.id, schema.usageEvent.versionId))
      .leftJoin(schema.earningEvent, eq(schema.earningEvent.requestId, schema.usageEvent.requestId))
      .where(where)
      .orderBy(desc(schema.usageEvent.createdAt), desc(schema.usageEvent.id))
      .limit(LIBRARY_USAGE_PAGE_SIZE)
      .offset((Math.max(1, input.page) - 1) * LIBRARY_USAGE_PAGE_SIZE),
    /* By period id, not created_at: that is what the period/library index covers. */
    database
      .select({ n: count() })
      .from(schema.earningEvent)
      .where(
        and(
          eq(schema.earningEvent.periodId, revenuePeriodId(since)),
          eq(schema.earningEvent.libraryId, input.libraryId),
          eq(schema.earningEvent.flagged, false),
        ),
      ),
  ]);

  const totals = summary[0] ?? { total: 0, thisMonth: 0, readersThisMonth: 0 };
  return {
    summary: { ...totals, earnedThisMonth: earned?.n ?? 0 },
    total: totals.total,
    entries: entries.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      operation: row.operation,
      entrypoint: row.entrypoint,
      statusCode: row.statusCode,
      latencyMs: row.latencyMs,
      returnedTokens: row.returnedTokens,
      versionLabel: row.versionLabel,
      caller: row.callerWorkspaceId === input.workspaceId ? 'self' : 'reader',
      earning:
        row.earningFlagged === null ? 'none' : row.earningFlagged ? 'voided' : 'earned',
    })),
  };
}
