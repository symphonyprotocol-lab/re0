/**
 * The scheduler side of the refresh queue: refresh policies turned into rows.
 *
 * A source carries a cadence (`daily`, `weekly`, `manual`; lib/domain/asset
 * `RefreshPolicy`). Until now only the operator's button produced a refresh
 * operation, so the cadence was a label. This reads every platform source, works
 * out when each is next due, and queues a refresh for the ones whose time has
 * come. The scheduled drain (`/api/cron/drain`) calls it before draining, so a
 * source is checked within one drain interval of falling due.
 *
 * "Last checked" is per source, although the asset row only records it per
 * asset: the finished refresh operations say which source they fetched
 * (`source_id`, null for all of them), and the newest one that covered a source
 * is when that source was last looked at. The asset's own `last_checked_at`
 * is the floor, for builds older than per-source operations.
 *
 * Platform assets only. architecture.md 8.4: a private asset defaults to
 * manual refresh, and a workspace's sources are refreshed from the dashboard or
 * by webhook, never on a timer we run.
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import { isRefreshPolicy, refreshDueAt, type RefreshPolicy } from '@/lib/domain/asset';
import { db, schema } from '@/lib/infrastructure/postgres/client';

/** Operation types that fetch an asset's sources. */
const FETCHING_OPERATIONS = ['refresh', 'ingest'] as const;
const OPEN_STATES = ['pending', 'running'] as const;
const FINISHED_STATES = ['succeeded', 'skipped', 'failed'] as const;

export interface ScheduledSource {
  assetId: string;
  publicId: string;
  title: string;
  lifecycleStatus: string;
  sourceId: string;
  sourceType: string;
  location: string;
  policy: RefreshPolicy | 'unknown';
  /** When this source was last fetched or found unchanged; null if never. */
  lastCheckedAt: Date | null;
  /** Next time the policy asks for a check; null for a manual source. */
  dueAt: Date | null;
  /** A refresh covering this source is already queued or running. */
  open: boolean;
}

/**
 * Every platform source and where it stands against its policy, due first.
 *
 * Archived assets are left out: `requestPlatformAssetRefresh` refuses
 * them, and the scheduler should not do by timer what the button may not.
 */
export async function refreshSchedule(
  now: Date = new Date(),
  /** One asset's sources only -- the asset page's freshness panel. */
  only?: { assetId: string },
): Promise<ScheduledSource[]> {
  const database = db();

  const sources = await database
    .select({
      assetId: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      lifecycleStatus: schema.asset.lifecycleStatus,
      assetCheckedAt: schema.asset.lastCheckedAt,
      sourceId: schema.source.id,
      sourceType: schema.source.type,
      location: schema.source.location,
      refreshPolicy: schema.source.refreshPolicy,
    })
    .from(schema.source)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.source.assetId))
    .where(
      and(
        eq(schema.asset.isPlatformAsset, true),
        isNull(schema.asset.deletedAt),
        ne(schema.asset.lifecycleStatus, 'archived'),
        ...(only ? [eq(schema.asset.id, only.assetId)] : []),
      ),
    )
    .orderBy(schema.asset.publicId, schema.source.id);

  if (sources.length === 0) return [];
  const assetIds = [...new Set(sources.map((row) => row.assetId))];

  /*
   * The newest finished operation per (asset, source) and every open one.
   * `distinct on` keeps this one row per pair however long the history is.
   */
  const [finished, open] = await Promise.all([
    database
      .selectDistinctOn([schema.workflowOperation.assetId, schema.workflowOperation.sourceId], {
        assetId: schema.workflowOperation.assetId,
        sourceId: schema.workflowOperation.sourceId,
        updatedAt: schema.workflowOperation.updatedAt,
      })
      .from(schema.workflowOperation)
      .where(
        and(
          inArray(schema.workflowOperation.assetId, assetIds),
          inArray(schema.workflowOperation.operationType, [...FETCHING_OPERATIONS]),
          inArray(schema.workflowOperation.status, [...FINISHED_STATES]),
        ),
      )
      .orderBy(
        schema.workflowOperation.assetId,
        schema.workflowOperation.sourceId,
        sql`${schema.workflowOperation.updatedAt} desc`,
      ),
    database
      .select({
        assetId: schema.workflowOperation.assetId,
        sourceId: schema.workflowOperation.sourceId,
      })
      .from(schema.workflowOperation)
      .where(
        and(
          inArray(schema.workflowOperation.assetId, assetIds),
          inArray(schema.workflowOperation.operationType, [...FETCHING_OPERATIONS]),
          inArray(schema.workflowOperation.status, [...OPEN_STATES]),
        ),
      ),
  ]);

  const checkedAt = new Map<string, Date>();
  for (const row of finished) checkedAt.set(`${row.assetId}/${row.sourceId ?? '*'}`, row.updatedAt);
  const openKeys = new Set(open.map((row) => `${row.assetId}/${row.sourceId ?? '*'}`));

  const rows = sources.map((row): ScheduledSource => {
    const policy = readPolicy(row.refreshPolicy);
    const lastCheckedAt = latest(
      row.assetCheckedAt,
      checkedAt.get(`${row.assetId}/*`) ?? null,
      checkedAt.get(`${row.assetId}/${row.sourceId}`) ?? null,
    );
    return {
      assetId: row.assetId,
      publicId: row.publicId,
      title: row.title,
      lifecycleStatus: row.lifecycleStatus,
      sourceId: row.sourceId,
      sourceType: row.sourceType,
      location: row.location,
      policy,
      lastCheckedAt,
      dueAt: refreshDueAt(policy, lastCheckedAt),
      open: openKeys.has(`${row.assetId}/*`) || openKeys.has(`${row.assetId}/${row.sourceId}`),
    };
  });

  /* Due first, soonest first; manual sources last, in list order. */
  return rows.sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime();
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return 0;
  });
}

export interface ScheduledRefresh {
  operationId: string;
  assetId: string;
  publicId: string;
  /** Null when the whole asset was queued. */
  sourceId: string | null;
}

/**
 * Queues a refresh for every source that is due and not already covered.
 *
 * One row per asset when all of its sources are due, so the build fetches
 * them together and publishes one version; otherwise one row per due source,
 * and the build carries the others forward. Nothing is written to the audit
 * log -- there is no administrator behind it -- which is what the row's
 * `trigger` column is for.
 */
/*
 * Only platform assets are scheduled (`refreshSchedule` filters on
 * `is_platform_asset`), and a platform build is nobody's bill, so no
 * affordability gate runs here. asset-build-billing.md 7 describes the
 * gate an owned-asset schedule would need; it belongs with that change.
 */
export async function scheduleDueRefreshes(now: Date = new Date()): Promise<ScheduledRefresh[]> {
  const schedule = await refreshSchedule(now);
  const byAsset = new Map<string, ScheduledSource[]>();
  for (const row of schedule) {
    const list = byAsset.get(row.assetId) ?? [];
    list.push(row);
    byAsset.set(row.assetId, list);
  }

  const queued: ScheduledRefresh[] = [];
  const database = db();
  for (const [assetId, rows] of byAsset) {
    const due = rows.filter((row) => row.dueAt !== null && row.dueAt <= now && !row.open);
    const first = due[0];
    if (!first) continue;
    const targets = due.length === rows.length ? [null] : due.map((row) => row.sourceId);
    for (const sourceId of targets) {
      const operationId = uuidv7();
      await database.insert(schema.workflowOperation).values({
        id: operationId,
        assetId,
        operationType: 'refresh',
        sourceDigest: null,
        sourceId,
        status: 'pending',
        trigger: 'scheduled',
      });
      queued.push({ operationId, assetId, publicId: first.publicId, sourceId });
    }
  }
  return queued;
}

function readPolicy(stored: Record<string, unknown> | null): RefreshPolicy | 'unknown' {
  const value = stored?.cadence;
  return isRefreshPolicy(value) ? value : 'unknown';
}

function latest(...dates: (Date | null)[]): Date | null {
  let best: Date | null = null;
  for (const date of dates) if (date && (!best || date > best)) best = date;
  return best;
}
