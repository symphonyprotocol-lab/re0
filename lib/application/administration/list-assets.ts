/**
 * Use cases: user assets, by where they stand, and ownership claims.
 *
 * Both read `asset`; what separates them is the join to `asset_claim`.
 * Ingestion is not built yet (architecture.md 21), so these lists are
 * legitimately empty rather than seeded with something that looks like content.
 */
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { exposure } from '@/lib/application/channels/visibility';
import { ref } from './column-ref';
import { likePattern } from './like-pattern';

/** The console's tabs over user assets: live ones, and ones the platform or their owner stopped. */
export type AssetReviewFilter = 'all' | 'approved' | 'rejected';

export interface ConsoleAssetRow {
  id: string;
  publicId: string;
  title: string;
  ownerName: string | null;
  sourceType: string | null;
  storageBytes: number;
  visibility: 'public' | 'private';
  lifecycleStatus: string;
  createdAt: Date;
  /** Whether the current version is indexed, which a restoration requires. */
  hasReadyVersion: boolean;
}

/** Whether `current_version_id` points at a version whose index is ready. */
const hasReadyVersion = sql<boolean>`exists (
  select 1 from ${schema.assetVersion}
  where ${ref(schema.assetVersion.id)} = ${ref(schema.asset.currentVersionId)}
    and ${ref(schema.assetVersion.indexStatus)} = 'ready'
)`;

/** The one source an asset was built from, when it has exactly one. */
const sourceType = sql<string | null>`(
  select ${ref(schema.source.type)} from ${schema.source}
  where ${ref(schema.source.assetId)} = ${ref(schema.asset.id)}
  order by ${ref(schema.source.id)} limit 1
)`;

const ownerName = sql<string | null>`(
  select ${ref(schema.workspace.name)} from ${schema.workspace}
  where ${ref(schema.workspace.id)} = ${ref(schema.asset.ownerWorkspaceId)}
)`;

/**
 * The console's tabs against the lifecycle enum. `approved` is what is live;
 * `rejected` is what was stopped -- by the platform, by its owner, or taken
 * out of circulation. The review-era states (`submitted`, `reviewing`,
 * `changes_requested`) are no longer written and belong to neither tab.
 */
export const REVIEW_STATUSES = {
  approved: ['published'],
  rejected: ['suspended', 'archived'],
} as const;

/** User assets that still exist; a deleted one is a tombstone (8.4). */
const LIVE_USER_ASSET = and(
  eq(schema.asset.isPlatformAsset, false),
  isNull(schema.asset.deletedAt),
)!;

const ASSET_ROW = {
  id: schema.asset.id,
  publicId: schema.asset.publicId,
  title: schema.asset.title,
  storageBytes: schema.asset.storageBytes,
  visibility: exposure(),
  lifecycleStatus: schema.asset.lifecycleStatus,
  createdAt: schema.asset.createdAt,
  ownerName,
  sourceType,
  hasReadyVersion,
};

function reviewCondition(filter: AssetReviewFilter) {
  /*
   * The filter arrives as a cast, not a parse -- the export route hands
   * whatever `?status=` said straight through -- so an unknown value must fall
   * back to `all` rather than spreading `undefined` into a 500.
   */
  switch (filter) {
    case 'approved':
    case 'rejected':
      return inArray(schema.asset.lifecycleStatus, [...REVIEW_STATUSES[filter]]);
    default:
      return undefined;
  }
}

export async function listUserAssets(input: {
  query?: string;
  review?: AssetReviewFilter;
  limit?: number;
} = {}): Promise<{ rows: ConsoleAssetRow[]; total: number; counts: Record<string, number> }> {
  const database = db();
  const term = input.query?.trim();

  const base = LIVE_USER_ASSET;
  const conditions = [
    base,
    term
      ? or(ilike(schema.asset.title, likePattern(term)), ilike(schema.asset.publicId, likePattern(term)))
      : undefined,
    reviewCondition(input.review ?? 'all'),
  ].filter(Boolean);

  const [rows, [totalRow], statusRows, [claimRow]] = await Promise.all([
    database
      .select(ASSET_ROW)
      .from(schema.asset)
      .where(and(...conditions))
      .orderBy(desc(schema.asset.createdAt))
      .limit(input.limit ?? 50),
    database.select({ n: count() }).from(schema.asset).where(and(...conditions)),
    database
      .select({ status: schema.asset.lifecycleStatus, n: count() })
      .from(schema.asset)
      .where(base)
      .groupBy(schema.asset.lifecycleStatus),
    database
      .select({ n: count() })
      .from(schema.assetClaim)
      .where(eq(schema.assetClaim.status, 'pending')),
  ]);

  const byStatus = new Map<string, number>(statusRows.map((row) => [row.status, row.n]));
  const sum = (statuses: readonly string[]) =>
    statuses.reduce((total, status) => total + (byStatus.get(status) ?? 0), 0);

  return {
    rows: rows.map(normalize),
    total: totalRow?.n ?? 0,
    counts: {
      all: [...byStatus.values()].reduce((a, b) => a + b, 0),
      approved: sum(REVIEW_STATUSES.approved),
      rejected: sum(REVIEW_STATUSES.rejected),
      claims: claimRow?.n ?? 0,
    },
  };
}

export type ClaimFilter = 'all' | 'pending' | 'claimed' | 'revoked' | 'disputed' | 'expired';

/**
 * `claim_status` has no `disputed` value, and should not: requirement.md 7.3
 * defines a dispute as a claim opened on an asset that already has *another*
 * owner, which is a fact about the pair rather than a state of the claim. It
 * is derived here so the tab means what the rule says.
 *
 * The `<>` clause is the whole of it. Without it the queue counts a claim by
 * the workspace that already owns the asset -- and offers a Grant control
 * that `ruleDispute` then refuses as "not a dispute", which is the console
 * disagreeing with itself. `isDisputedClaim` is the same predicate in
 * TypeScript, for every caller that has the rows rather than the query.
 */
const DISPUTED = sql`${schema.assetClaim.status} = 'pending'
  and ${schema.asset.ownerWorkspaceId} is not null
  and ${schema.asset.ownerWorkspaceId} <> ${schema.assetClaim.claimantWorkspaceId}`;

/** The same derivation as `DISPUTED`, per row, so the list can mark one. */
const IS_DISPUTED = sql<boolean>`(${DISPUTED})`;

export interface ConsoleClaimRow {
  id: string;
  assetTitle: string;
  assetPublicId: string;
  claimantName: string;
  method: string;
  openedAt: Date;
  currentOwner: string | null;
  status: string;
  /** Pending on an asset that already has an owner: an administrator decides it. */
  disputed: boolean;
}

export async function listClaims(
  input: { query?: string; status?: ClaimFilter; limit?: number; offset?: number } = {},
): Promise<{
  rows: ConsoleClaimRow[];
  total: number;
  counts: Record<string, number>;
}> {
  const database = db();
  const term = input.query?.trim();

  const statusCondition = claimCondition(input.status ?? 'all');
  const conditions = [
    /* A claim on a deleted asset is moot; the queue does not show it. */
    isNull(schema.asset.deletedAt),
    statusCondition,
    term
      ? or(ilike(schema.asset.title, likePattern(term)), ilike(schema.asset.publicId, likePattern(term)))
      : undefined,
  ].filter(Boolean);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const claimant = sql<string>`(
    select ${ref(schema.workspace.name)} from ${schema.workspace}
    where ${ref(schema.workspace.id)} = ${ref(schema.assetClaim.claimantWorkspaceId)}
  )`;

  const [rows, [totalRow], statusRows, [disputedRow]] = await Promise.all([
    database
      .select({
        id: schema.assetClaim.id,
        assetTitle: schema.asset.title,
        assetPublicId: schema.asset.publicId,
        method: schema.assetClaim.method,
        status: schema.assetClaim.status,
        openedAt: schema.assetClaim.createdAt,
        currentOwner: ownerName,
        claimantName: claimant,
        disputed: IS_DISPUTED,
      })
      .from(schema.assetClaim)
      .innerJoin(schema.asset, eq(schema.asset.id, schema.assetClaim.assetId))
      .where(where)
      .orderBy(desc(schema.assetClaim.createdAt))
      .limit(input.limit ?? 50)
      .offset(input.offset ?? 0),
    database
      .select({ n: count() })
      .from(schema.assetClaim)
      .innerJoin(schema.asset, eq(schema.asset.id, schema.assetClaim.assetId))
      .where(where),
    database
      .select({ status: schema.assetClaim.status, n: count() })
      .from(schema.assetClaim)
      .groupBy(schema.assetClaim.status),
    database
      .select({ n: count() })
      .from(schema.assetClaim)
      .innerJoin(schema.asset, eq(schema.asset.id, schema.assetClaim.assetId))
      .where(DISPUTED),
  ]);

  const byStatus = new Map<string, number>(statusRows.map((row) => [row.status, row.n]));
  return {
    rows: rows.map((row) => ({
      ...row,
      claimantName: row.claimantName ?? '',
      currentOwner: row.currentOwner,
      disputed: Boolean(row.disputed),
    })),
    total: totalRow?.n ?? 0,
    counts: {
      all: [...byStatus.values()].reduce((a, b) => a + b, 0),
      pending: byStatus.get('pending') ?? 0,
      claimed: byStatus.get('verified') ?? 0,
      revoked: byStatus.get('revoked') ?? 0,
      expired: byStatus.get('expired') ?? 0,
      disputed: disputedRow?.n ?? 0,
    },
  };
}

function claimCondition(filter: ClaimFilter) {
  switch (filter) {
    case 'pending':
      return eq(schema.assetClaim.status, 'pending');
    case 'claimed':
      return eq(schema.assetClaim.status, 'verified');
    case 'revoked':
      return eq(schema.assetClaim.status, 'revoked');
    case 'expired':
      return eq(schema.assetClaim.status, 'expired');
    case 'disputed':
      return DISPUTED;
    default:
      return undefined;
  }
}

function normalize(row: {
  id: string;
  publicId: string;
  title: string;
  storageBytes: number;
  visibility: 'public' | 'private';
  lifecycleStatus: string;
  createdAt: Date;
  ownerName: string | null;
  sourceType: string | null;
  hasReadyVersion: boolean;
}): ConsoleAssetRow {
  return {
    hasReadyVersion: row.hasReadyVersion,
    id: row.id,
    publicId: row.publicId,
    title: row.title,
    ownerName: row.ownerName,
    sourceType: row.sourceType,
    storageBytes: row.storageBytes,
    visibility: row.visibility,
    lifecycleStatus: row.lifecycleStatus,
    createdAt: row.createdAt,
  };
}
