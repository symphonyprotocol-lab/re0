/**
 * How much a workspace's own assets are used: the calls served from each,
 * whoever made them. Read from `usage_event`, the billed record of every
 * served retrieval, so the count is the one billing sees. Builds are usage
 * events too but consumed no asset's content, so they are left out here.
 *
 * The owner sees who called only as "this workspace" or "a reader": another
 * workspace's identity, keys and query text are theirs (architecture.md 17.1
 * keeps the query out of every log anyway).
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { BUILD_ENTRYPOINT } from '@/lib/domain/build-billing';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface AssetUsageCount {
  total: number;
  /** Since the first of this UTC month. */
  thisMonth: number;
}

export interface AssetUsageEntry {
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
}

export interface AssetUsageLog {
  summary: AssetUsageCount & {
    readersThisMonth: number;
  };
  entries: AssetUsageEntry[];
  total: number;
}

export const ASSET_USAGE_PAGE_SIZE = 50;

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const RETRIEVAL = ne(schema.usageEvent.entrypoint, BUILD_ENTRYPOINT);

/** Calls served per asset, for the asset list. One grouped read. */
export async function assetUsageCounts(
  assetIds: string[],
): Promise<Map<string, AssetUsageCount>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db()
    .select({
      assetId: schema.usageEvent.assetId,
      total: sql<number>`count(*)::int`,
      thisMonth: sql<number>`(count(*) filter (where ${schema.usageEvent.createdAt} >= ${monthStart()}))::int`,
    })
    .from(schema.usageEvent)
    .where(and(inArray(schema.usageEvent.assetId, assetIds), RETRIEVAL))
    .groupBy(schema.usageEvent.assetId);
  return new Map(
    rows.map((row) => [row.assetId!, { total: row.total, thisMonth: row.thisMonth }]),
  );
}

/**
 * One asset's calls, newest first, a page at a time. The caller has already
 * established that `workspaceId` owns the asset (workspaceAssetDetail);
 * the owner filter here only decides which calls read as the owner's own.
 */
export async function assetUsageLog(input: {
  workspaceId: string;
  assetId: string;
  page: number;
}): Promise<AssetUsageLog> {
  const database = db();
  const where = and(eq(schema.usageEvent.assetId, input.assetId), RETRIEVAL);
  const since = monthStart();

  const [summary, entries] = await Promise.all([
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
        versionLabel: schema.assetVersion.label,
      })
      .from(schema.usageEvent)
      .leftJoin(schema.assetVersion, eq(schema.assetVersion.id, schema.usageEvent.versionId))
      .where(where)
      .orderBy(desc(schema.usageEvent.createdAt), desc(schema.usageEvent.id))
      .limit(ASSET_USAGE_PAGE_SIZE)
      .offset((Math.max(1, input.page) - 1) * ASSET_USAGE_PAGE_SIZE),
  ]);

  const totals = summary[0] ?? { total: 0, thisMonth: 0, readersThisMonth: 0 };
  return {
    summary: totals,
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
    })),
  };
}
