/**
 * The public catalogue: what an anonymous visitor may read. Only routable
 * assets appear -- free in a public channel (agent-first-proposal.md 6.2),
 * published, with a ready current version -- the same predicate retrieval
 * admits, so a page never advertises what a query would then refuse
 * (architecture.md 5.2). The channel directory and channel pages list
 * channels (lib/application/channels); this is the per-asset view beneath.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { refreshSchedule, type ScheduledSource } from '@/lib/application/ingestion';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { ref } from '@/lib/application/administration/column-ref';
import { parseSourceConfig } from '@/lib/domain/ingestion';
import { sharedWithEveryone } from '@/lib/application/channels/visibility';
import { channelsOfAssets } from '@/lib/application/channels/membership';

export interface CatalogEntry {
  publicId: string;
  title: string;
  domainTag: string | null;
  trustScore: number;
  totalChunks: number;
  updatedAt: string | null;
  /** Served retrievals in the popularity window (`POPULARITY_WINDOW_DAYS`). */
  recentCalls: number;
}

export const CATALOG_PAGE_SIZE = 50;

/** The rolling window "popular" is measured over. */
export const POPULARITY_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const ROUTABLE: SQL = and(
  sharedWithEveryone(),
  eq(schema.asset.lifecycleStatus, 'published'),
  eq(schema.asset.indexStatus, 'ready'),
  isNotNull(schema.asset.currentVersionId),
  /* Implied by the three above for a tombstone, and stated anyway: a lookup
     by public id must never land on a deleted row that shares the id. */
  isNull(schema.asset.deletedAt),
)!;

/** The newest trust score, or 0 for an asset nobody has scored. */
const trustScore = sql<number>`coalesce((
  select s.trust_score from ${schema.assetScore} s
  where s.asset_id = ${ref(schema.asset.id)}
  order by s.computed_at desc limit 1
), 0)`;

export async function countPublicAssets(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.asset)
    .where(ROUTABLE);
  return row?.n ?? 0;
}

/**
 * One page of the directory.
 *
 * "Popular" is the served retrievals of the last thirty days, from the
 * request log -- every door counts, anonymous included, which `usage_event`
 * (metered calls only) would miss -- with the trust score as the tie-break
 * and the whole order for a platform nobody has queried yet.
 */
export async function listPublicAssets(input: {
  sort: 'popular' | 'recent';
  limit?: number;
  offset?: number;
}): Promise<CatalogEntry[]> {
  const database = db();
  const since = new Date(Date.now() - POPULARITY_WINDOW_DAYS * DAY_MS);

  const calls = database
    .select({
      publicId: schema.requestLog.assetPublicId,
      n: sql<number>`count(*)::int`.as('n'),
    })
    .from(schema.requestLog)
    .where(
      and(
        gte(schema.requestLog.createdAt, since),
        lt(schema.requestLog.statusCode, 400),
        isNotNull(schema.requestLog.assetPublicId),
      ),
    )
    .groupBy(schema.requestLog.assetPublicId)
    .as('calls');
  const recentCalls = sql<number>`coalesce(${calls.n}, 0)`;

  const rows = await database
    .select({
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      domainTag: schema.asset.domainTag,
      lastSuccessfulRefreshAt: schema.asset.lastSuccessfulRefreshAt,
      createdAt: schema.asset.createdAt,
      totalChunks: schema.assetVersion.totalChunks,
      trustScore,
      recentCalls,
    })
    .from(schema.asset)
    .innerJoin(schema.assetVersion, eq(schema.assetVersion.id, schema.asset.currentVersionId))
    .leftJoin(calls, eq(calls.publicId, schema.asset.publicId))
    .where(ROUTABLE)
    /*
     * `desc` in Postgres means NULLS FIRST, so "recently updated" was led by
     * the assets that have never successfully refreshed at all -- the
     * emptiest rows at the top of the freshest list, printing their creation
     * date because that is what the mapping falls back to. Never-refreshed
     * sorts last, which is what "recently updated" means.
     *
     * The public id closes both orders. It is unique, so two rows with the
     * same date (or the same call count and trust score) cannot swap places
     * between one offset page and the next and hide or repeat an asset.
     */
    .orderBy(
      ...(input.sort === 'recent'
        ? [sql`${schema.asset.lastSuccessfulRefreshAt} desc nulls last`, desc(schema.asset.createdAt)]
        : [desc(recentCalls), desc(trustScore), desc(schema.asset.createdAt)]),
      desc(schema.asset.publicId),
    )
    .limit(Math.min(input.limit ?? CATALOG_PAGE_SIZE, 100))
    .offset(Math.max(0, input.offset ?? 0));

  return rows.map((row) => ({
    publicId: row.publicId,
    title: row.title,
    domainTag: row.domainTag,
    trustScore: Number(row.trustScore),
    totalChunks: row.totalChunks,
    updatedAt: (row.lastSuccessfulRefreshAt ?? row.createdAt)?.toISOString() ?? null,
    recentCalls: Number(row.recentCalls),
  }));
}

export interface PublicAssetVersion {
  label: string;
  indexStatus: string;
  totalChunks: number;
  totalTokens: number;
  createdAt: string;
  publishedAt: string | null;
  current: boolean;
}

export interface PublicAssetSource {
  type: string;
  location: string;
  /** `source.refresh_policy.cadence`; `unknown` when the row holds none. */
  refreshPolicy: ScheduledSource['policy'];
}

export interface PublicAssetDetail {
  /** The row id, for what hangs off the asset on its page (its comments, proposal 6.8). */
  id: string;
  publicId: string;
  title: string;
  /** The public channel the asset is shown in (agent-first-proposal.md 6.1). */
  channel: { slug: string; title: string } | null;
  description: string | null;
  domainTag: string | null;
  language: string | null;
  claimedBy: string | null;
  storageBytes: number;
  version: {
    label: string;
    indexStatus: string;
    totalChunks: number;
    totalTokens: number;
    documents: number;
    parserVersion: string;
    chunkerVersion: string;
    embeddingModel: string;
    publishedAt: string | null;
  };
  /** Every build, newest first, the current one flagged. */
  versions: PublicAssetVersion[];
  trustScore: number;
  benchmarkScore: number;
  /** When the scores were last computed; null when never. */
  scoredAt: string | null;
  sources: PublicAssetSource[];
  /** What the sources' `re0.json` scoped the index to, merged across sources. */
  scope: { folders: string[]; excludeFolders: string[] };
  freshness: {
    /** The tightest cadence among the sources. */
    refreshPolicy: ScheduledSource['policy'];
    lastCheckedAt: string | null;
    lastSuccessfulRefreshAt: string | null;
    /** The soonest due time among timed sources; null when every source is manual. */
    nextDueAt: string | null;
    /** A refresh is queued or running now. */
    refreshOpen: boolean;
  };
  /** Served retrievals in the popularity window. */
  recentCalls: number;
  updatedAt: string | null;
}

const POLICY_RANK: Record<ScheduledSource['policy'], number> = {
  daily: 0,
  weekly: 1,
  manual: 2,
  unknown: 3,
};

export async function publicAssetDetail(publicId: string): Promise<PublicAssetDetail | null> {
  const database = db();
  const [row] = await database
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      description: schema.asset.description,
      domainTag: schema.asset.domainTag,
      language: schema.asset.language,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      isPlatformAsset: schema.asset.isPlatformAsset,
      storageBytes: schema.asset.storageBytes,
      lastCheckedAt: schema.asset.lastCheckedAt,
      lastSuccessfulRefreshAt: schema.asset.lastSuccessfulRefreshAt,
      createdAt: schema.asset.createdAt,
      versionId: schema.assetVersion.id,
      label: schema.assetVersion.label,
      indexStatus: schema.assetVersion.indexStatus,
      totalChunks: schema.assetVersion.totalChunks,
      totalTokens: schema.assetVersion.totalTokens,
      parserVersion: schema.assetVersion.parserVersion,
      chunkerVersion: schema.assetVersion.chunkerVersion,
      embeddingModel: schema.assetVersion.embeddingModel,
      contentMerkleRoot: schema.assetVersion.contentMerkleRoot,
      publishedAt: schema.assetVersion.publishedAt,
    })
    .from(schema.asset)
    .innerJoin(schema.assetVersion, eq(schema.assetVersion.id, schema.asset.currentVersionId))
    .where(and(ROUTABLE, eq(schema.asset.publicId, publicId)));
  if (!row) return null;

  const since = new Date(Date.now() - POPULARITY_WINDOW_DAYS * DAY_MS);

  const [[documents], [score], sources, versions, [calls], schedule] = await Promise.all([
    database
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.document)
      .where(eq(schema.document.versionId, row.versionId)),
    database
      .select({
        trustScore: schema.assetScore.trustScore,
        benchmarkScore: schema.assetScore.benchmarkScore,
        computedAt: schema.assetScore.computedAt,
      })
      .from(schema.assetScore)
      .where(eq(schema.assetScore.assetId, row.id))
      .orderBy(desc(schema.assetScore.computedAt))
      .limit(1),
    database
      .select({
        type: schema.source.type,
        location: schema.source.location,
        config: schema.source.config,
        refreshPolicy: schema.source.refreshPolicy,
      })
      .from(schema.source)
      .where(eq(schema.source.assetId, row.id))
      .orderBy(schema.source.id),
    database
      .select({
        id: schema.assetVersion.id,
        label: schema.assetVersion.label,
        indexStatus: schema.assetVersion.indexStatus,
        totalChunks: schema.assetVersion.totalChunks,
        totalTokens: schema.assetVersion.totalTokens,
        createdAt: schema.assetVersion.createdAt,
        publishedAt: schema.assetVersion.publishedAt,
      })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, row.id))
      .orderBy(desc(schema.assetVersion.createdAt))
      .limit(20),
    database
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.requestLog)
      .where(
        and(
          eq(schema.requestLog.assetPublicId, row.publicId),
          gte(schema.requestLog.createdAt, since),
          lt(schema.requestLog.statusCode, 400),
        ),
      ),
    /* The scheduler's own view of the sources (schedule-refreshes.ts), so the
       "next check" the page shows is the one the drain will act on. Platform
       assets only: a workspace's sources are never on the timer. */
    row.isPlatformAsset ? refreshSchedule(new Date(), { assetId: row.id }) : [],
  ]);

  let claimedBy: string | null = null;
  if (row.ownerWorkspaceId) {
    const [owner] = await database
      .select({ name: schema.workspace.name })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, row.ownerWorkspaceId));
    claimedBy = owner?.name ?? null;
  }

  /*
   * Scope, in `re0.json`'s own field names (requirement.md 5.1). The build
   * stamps what the repository's file said onto the source row
   * (build-version.ts), and `parseSourceConfig` reads it back through the same
   * caps the file went through, so the page shows what the index obeyed.
   */
  const folders = new Set<string>();
  const excludeFolders = new Set<string>();
  for (const source of sources) {
    const config = parseSourceConfig(JSON.stringify(source.config ?? {}));
    for (const folder of config.folders) folders.add(folder);
    for (const folder of config.excludeFolders) excludeFolders.add(folder);
  }

  /*
   * `policies` stays in source order: it is read back positionally below to
   * label each source with its own cadence. Sorting it in place to find the
   * tightest one reordered it under that read, so an asset with a daily and
   * a weekly source labelled each of them with the other's policy. The
   * tightest cadence is picked from a copy.
   */
  const policies = sources.map((source) => readPolicy(source.refreshPolicy));
  const refreshPolicy =
    [...policies].sort((a, b) => POLICY_RANK[a] - POLICY_RANK[b])[0] ?? 'unknown';
  const due = schedule
    .map((source) => source.dueAt)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  const lastChecked = [row.lastCheckedAt, ...schedule.map((source) => source.lastCheckedAt)]
    .filter((date): date is Date => date !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const channel = (await channelsOfAssets([row.id], database)).get(row.id) ?? null;

  return {
    id: row.id,
    publicId: row.publicId,
    title: row.title,
    channel: channel ? { slug: channel.slug, title: channel.title } : null,
    description: row.description,
    domainTag: row.domainTag,
    language: row.language,
    claimedBy,
    storageBytes: row.storageBytes,
    version: {
      label: row.label,
      indexStatus: row.indexStatus,
      totalChunks: row.totalChunks,
      totalTokens: row.totalTokens,
      documents: documents?.n ?? 0,
      parserVersion: row.parserVersion,
      chunkerVersion: row.chunkerVersion,
      embeddingModel: row.embeddingModel,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    },
    versions: versions.map((version) => ({
      label: version.label,
      indexStatus: version.indexStatus,
      totalChunks: version.totalChunks,
      totalTokens: version.totalTokens,
      createdAt: version.createdAt.toISOString(),
      publishedAt: version.publishedAt?.toISOString() ?? null,
      current: version.id === row.versionId,
    })),
    trustScore: score?.trustScore ?? 0,
    benchmarkScore: score?.benchmarkScore ?? 0,
    scoredAt: score?.computedAt?.toISOString() ?? null,
    sources: sources.map((source, index) => ({
      type: source.type,
      location: source.location,
      refreshPolicy: policies[index] ?? 'unknown',
    })),
    scope: { folders: [...folders], excludeFolders: [...excludeFolders] },
    freshness: {
      refreshPolicy,
      lastCheckedAt: lastChecked?.toISOString() ?? null,
      lastSuccessfulRefreshAt: row.lastSuccessfulRefreshAt?.toISOString() ?? null,
      nextDueAt: due[0]?.toISOString() ?? null,
      refreshOpen: schedule.some((source) => source.open),
    },
    recentCalls: calls?.n ?? 0,
    updatedAt: (row.lastSuccessfulRefreshAt ?? row.createdAt)?.toISOString() ?? null,
  };
}

function readPolicy(stored: Record<string, unknown> | null): ScheduledSource['policy'] {
  const value = stored?.cadence;
  return value === 'daily' || value === 'weekly' || value === 'manual' ? value : 'unknown';
}

/**
 * The little a fixed-asset entry needs before it retrieves: that the id is
 * a routable public asset, and what to call it. The playground's `asset`
 * parameter goes through this so a private or unpublished id is refused the
 * same way a missing one is (requirement.md 6.1: 不得通过…错误差异…枚举).
 */
export async function publicAssetHeading(
  publicId: string,
): Promise<{ publicId: string; title: string; version: string } | null> {
  const [row] = await db()
    .select({
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      version: schema.assetVersion.label,
    })
    .from(schema.asset)
    .innerJoin(schema.assetVersion, eq(schema.assetVersion.id, schema.asset.currentVersionId))
    .where(and(ROUTABLE, eq(schema.asset.publicId, publicId)))
    .limit(1);
  return row ?? null;
}

/** A routable asset's address and the date its content last changed. */
export interface PublicAssetLocation {
  publicId: string;
  updatedAt: string | null;
}

/**
 * Every routable asset, for the sitemap (app/sitemap.ts): the same
 * predicate the directory and retrieval admit, so a crawler is sent exactly
 * where a visitor can go and a withdrawn or unpublished asset drops out
 * on the next build of the file. Ordered by id so two builds of the file
 * list the same rows in the same order; capped at the size of one sitemap.
 */
export async function listPublicAssetLocations(): Promise<PublicAssetLocation[]> {
  const rows = await db()
    .select({
      publicId: schema.asset.publicId,
      lastSuccessfulRefreshAt: schema.asset.lastSuccessfulRefreshAt,
      createdAt: schema.asset.createdAt,
    })
    .from(schema.asset)
    .where(ROUTABLE)
    .orderBy(asc(schema.asset.publicId))
    .limit(50_000);
  return rows.map((row) => ({
    publicId: row.publicId,
    updatedAt: (row.lastSuccessfulRefreshAt ?? row.createdAt)?.toISOString() ?? null,
  }));
}
