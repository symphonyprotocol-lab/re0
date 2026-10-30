/**
 * What the claim use cases share: the visibility rule, the row loaders, the
 * audit shape and the rate-limit rules.
 *
 * requirement.md 7.3.7: for an asset the caller cannot see, every claim
 * answer must be indistinguishable from "not found". `visibleAsset` is the
 * one place that decides visibility, and every other file asks it.
 */
import { and, desc, eq, inArray, isNull, ne, type SQL } from 'drizzle-orm';
import { AppError, type ClaimFailureReason } from '@/contracts/errors';
import { CLAIMABLE_SOURCE_TYPES, type ClaimMethod, type ClaimStatus, type SourceType } from '@/lib/domain';
import { recordAudit } from '@/lib/application/administration/audit';
import type { WorkspaceRole } from '@/lib/application/assets/delete';
import type { RateLimitRule } from '@/lib/infrastructure/cache/redis';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { listedInPublicChannel } from '@/lib/application/channels/visibility';

export interface ClaimableAsset {
  id: string;
  publicId: string;
  title: string;
  ownerWorkspaceId: string | null;
  sourceType: SourceType;
  location: string;
}

/**
 * An asset a claim may name: public, live, built from one claimable source,
 * and not the platform's own. Anything else -- private, deleted, archived,
 * platform-curated, or simply absent -- is the same `asset_not_found`.
 */
export async function visibleAsset(publicId: string): Promise<ClaimableAsset> {
  return claimable(eq(schema.asset.publicId, publicId));
}

/**
 * The same rule, addressed by primary key.
 *
 * Verification reaches the asset through the claim rather than through a
 * public id, and it has to apply the same predicate: an asset made private,
 * archived or platform-curated after its claim opened is no longer claimable,
 * and rewriting its owner from a challenge minted while it was public would
 * be a way around the visibility rule.
 */
export async function visibleAssetById(assetId: string): Promise<ClaimableAsset> {
  return claimable(eq(schema.asset.id, assetId));
}

async function claimable(identity: SQL): Promise<ClaimableAsset> {
  const [row] = await db()
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      sourceType: schema.source.type,
      location: schema.source.location,
    })
    .from(schema.asset)
    .innerJoin(schema.source, eq(schema.source.assetId, schema.asset.id))
    .where(
      and(
        identity,
        /* Only what others can see is claimable by others (agent-first-proposal.md 6.2). */
        listedInPublicChannel(),
        eq(schema.asset.isPlatformAsset, false),
        ne(schema.asset.lifecycleStatus, 'archived'),
        isNull(schema.asset.deletedAt),
        /*
         * "Built from one claimable source" is part of the rule, not just the
         * sentence above it. An upload or a Notion page has no claim flow at
         * all (requirement.md 7.3.2), and letting one through
         * renders a claim page with no method to pick and a Start button that
         * can only fail.
         */
        inArray(schema.source.type, [...CLAIMABLE_SOURCE_TYPES]),
      ),
    )
    .orderBy(schema.source.id)
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export function notFound(): AppError {
  return new AppError('asset_not_found', 'no such asset');
}

export function failure(reason: ClaimFailureReason, message: string): AppError {
  return new AppError('claim_verification_failed', message, reason);
}

export interface ClaimRow {
  id: string;
  assetId: string;
  claimantWorkspaceId: string;
  method: ClaimMethod;
  challengeTokenHash: string;
  status: ClaimStatus;
  failureReason: ClaimFailureReason | null;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  rulingAdminId: string | null;
  rulingReason: string | null;
  createdAt: Date;
}

export async function loadClaim(claimId: string): Promise<ClaimRow | null> {
  const [row] = await db()
    .select()
    .from(schema.assetClaim)
    .where(eq(schema.assetClaim.id, claimId))
    .limit(1);
  return row ? (row as ClaimRow) : null;
}

/** The newest claim one workspace holds on one asset, whatever its state. */
export async function newestClaimBy(
  workspaceId: string,
  assetId: string,
): Promise<ClaimRow | null> {
  const [row] = await db()
    .select()
    .from(schema.assetClaim)
    .where(
      and(
        eq(schema.assetClaim.claimantWorkspaceId, workspaceId),
        eq(schema.assetClaim.assetId, assetId),
      ),
    )
    .orderBy(desc(schema.assetClaim.createdAt))
    .limit(1);
  return row ? (row as ClaimRow) : null;
}

/**
 * The role one user holds in one workspace, or null when they hold none.
 *
 * requirement.md 3.3 puts ownership changes behind the manage permission, and
 * the OAuth callback that finishes a GitHub grant carries a session but not
 * the membership it was resolved from. Reading the role here keeps the check
 * in the use case rather than in the route that happens to call it.
 */
export async function workspaceRoleOf(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db()
    .select({ role: schema.workspaceMember.role })
    .from(schema.workspaceMember)
    .where(
      and(
        eq(schema.workspaceMember.workspaceId, workspaceId),
        eq(schema.workspaceMember.userId, userId),
      ),
    )
    .limit(1);
  return (row?.role as WorkspaceRole | undefined) ?? null;
}

/** Cheap guard so a junk id cannot reach Postgres as a bad uuid cast. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Every claim action is an audit fact (requirement.md 7.3.7). User-driven
 * ones have no administrator; the claimant workspace is recorded in the
 * values instead, where it is a snapshot rather than a key.
 */
export async function auditClaim(input: {
  action: string;
  claimId: string;
  administratorId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  clientAddress?: string | null;
  result: 'success' | 'failure';
}): Promise<void> {
  await recordAudit({
    administratorId: input.administratorId ?? null,
    action: input.action,
    targetType: 'library_claim',
    targetId: input.claimId,
    reason: input.reason ?? null,
    beforeValue: input.before,
    afterValue: input.after,
    clientAddress: input.clientAddress ?? null,
    result: input.result,
  });
}

/*
 * requirement.md 7.3.7: starting and retrying are limited per account and per
 * asset separately, and past the limit the caller cools down. Strict, not
 * fail-open: a claim endpoint that lost its limiter would be a free probe.
 */
const START_PER_ACCOUNT: RateLimitRule = { limit: 10, windowSeconds: 3600 };
const START_PER_ASSET: RateLimitRule = { limit: 5, windowSeconds: 3600 };
const VERIFY_PER_ACCOUNT: RateLimitRule = { limit: 30, windowSeconds: 3600 };
const VERIFY_PER_ASSET: RateLimitRule = { limit: 20, windowSeconds: 3600 };

export async function assertWithinClaimLimits(
  phase: 'start' | 'verify',
  workspaceId: string,
  assetId: string,
): Promise<void> {
  /*
   * Sequential, not concurrent: the per-asset budget is shared with every
   * other claimant, and a caller already past its own account limit must not
   * be able to spend it. Its own limit is checked first and stops there.
   */
  const account = await strictRateLimit(
    `ratelimit:claim-${phase}-account:${workspaceId}`,
    phase === 'start' ? START_PER_ACCOUNT : VERIFY_PER_ACCOUNT,
  );
  if (!account.allowed) throw cooldown();

  const asset = await strictRateLimit(
    `ratelimit:claim-${phase}-asset:${assetId}`,
    phase === 'start' ? START_PER_ASSET : VERIFY_PER_ASSET,
  );
  if (!asset.allowed) throw cooldown();
}

function cooldown(): AppError {
  return new AppError(
    'rate_limited',
    'too many claim attempts; wait for the cooldown to end',
    'retry_limit_exceeded',
  );
}
