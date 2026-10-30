/**
 * The console's side of ownership. requirement.md 5.3, 7.3.5; architecture.md 5.4.
 *
 * Three moves, all high risk, all with a required reason and an audit row:
 *
 * - `ruleDispute`: a claim opened on an owned asset is decided here, never
 *   by the self-service check. Granting transfers the owner to the claimant;
 *   dismissing closes the claim and leaves the owner alone.
 * - `revokeClaim`: closes a claim. On a verified one the asset loses its
 *   owner as well (7.3.5: source gone, rights report upheld, security event).
 * - `claimDetail`: the record with its evidence -- method, checks, attempts,
 *   timestamps, ruling. Never the challenge, never what DNS or the fetch
 *   answered; the check modules do not keep that, so there is nothing to show.
 *
 * Ruling is the only way to ownership that skips verification, and it is
 * allowed only where a dispute exists: a claim on an *unowned* asset is the
 * claimant's to prove, and an administrator cannot prove it for them.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { ClaimFailureReason } from '@/contracts/errors';
import type { ClaimMethod, ClaimStatus, SourceType } from '@/lib/domain';
import { AdminChangeRefused, normalizeReason } from '@/lib/domain/admin';
import {
  checkStates,
  isClaimExpired,
  isDisputedClaim,
  nextClaimStatus,
  remainingDays,
  type ClaimCheckView,
} from '@/lib/domain/claim';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { auditClaim, isUuid, loadClaim } from './shared';

export interface ClaimActor {
  administratorId: string;
  email: string;
  clientAddress?: string | null;
}

export type DisputeDecision = 'grant' | 'dismiss';

export interface RuleDisputeInput {
  actor: ClaimActor;
  claimId: string;
  decision: DisputeDecision;
  reason: string;
  now?: Date;
}

export interface RuleDisputeResult {
  status: ClaimStatus;
  ownerWorkspaceId: string | null;
}

export async function ruleDispute(input: RuleDisputeInput): Promise<RuleDisputeResult> {
  const reason = normalizeReason(input.reason);
  const now = input.now ?? new Date();
  const claim = isUuid(input.claimId) ? await loadClaim(input.claimId) : null;
  if (!claim) throw new AdminChangeRefused('not_found', 'no such claim');
  if (claim.status !== 'pending') {
    throw new AdminChangeRefused('invalid_input', 'only a pending claim can be ruled on');
  }

  const outcome = await db().transaction(async (tx) => {
    const [asset] = await tx
      .select({ id: schema.asset.id, ownerWorkspaceId: schema.asset.ownerWorkspaceId })
      .from(schema.asset)
      .where(eq(schema.asset.id, claim.assetId))
      .for('update');
    if (!asset) throw new AdminChangeRefused('not_found', 'no such asset');

    /*
     * No owner means no dispute -- and no ruling. requirement.md 5.3: the
     * console may not grant ownership in place of verification.
     */
    if (
      !isDisputedClaim({
        status: claim.status,
        ownerWorkspaceId: asset.ownerWorkspaceId,
        claimantWorkspaceId: claim.claimantWorkspaceId,
      })
    ) {
      throw new AdminChangeRefused('invalid_input', 'this claim is not a dispute');
    }
    /* Named, because `isDisputedClaim` is what established it is not null. */
    const previousOwner = asset.ownerWorkspaceId as string;

    const status = nextClaimStatus('pending', input.decision, { attempts: claim.attempts });
    if (!status) throw new AdminChangeRefused('invalid_input', 'ruling not allowed');

    if (input.decision === 'grant') {
      await tx
        .update(schema.asset)
        .set({ ownerWorkspaceId: claim.claimantWorkspaceId })
        .where(eq(schema.asset.id, asset.id));
      /*
       * The previous owner's verified claim is closed too, so the record does
       * not hold two live claims for one asset.
       */
      await tx
        .update(schema.assetClaim)
        .set({ status: 'revoked', rulingAdminId: input.actor.administratorId, rulingReason: reason })
        .where(
          and(
            eq(schema.assetClaim.assetId, asset.id),
            eq(schema.assetClaim.claimantWorkspaceId, previousOwner),
            eq(schema.assetClaim.status, 'verified'),
          ),
        );
    }

    await tx
      .update(schema.assetClaim)
      .set({
        status,
        verifiedAt: input.decision === 'grant' ? now : claim.verifiedAt,
        failureReason: input.decision === 'dismiss' ? 'already_claimed' : null,
        rulingAdminId: input.actor.administratorId,
        rulingReason: reason,
      })
      .where(eq(schema.assetClaim.id, claim.id));

    return {
      status,
      previousOwner: asset.ownerWorkspaceId,
      ownerWorkspaceId: input.decision === 'grant' ? claim.claimantWorkspaceId : asset.ownerWorkspaceId,
    };
  });

  await auditClaim({
    action: input.decision === 'grant' ? 'claim.transfer' : 'claim.dismiss',
    claimId: claim.id,
    administratorId: input.actor.administratorId,
    reason,
    before: { status: 'pending', ownerWorkspaceId: outcome.previousOwner },
    after: {
      status: outcome.status,
      ownerWorkspaceId: outcome.ownerWorkspaceId,
      assetId: claim.assetId,
      claimantWorkspaceId: claim.claimantWorkspaceId,
      administrator: input.actor.email,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { status: outcome.status, ownerWorkspaceId: outcome.ownerWorkspaceId };
}

export interface RevokeClaimInput {
  actor: ClaimActor;
  claimId: string;
  reason: string;
  now?: Date;
}

export interface RevokeClaimResult {
  status: ClaimStatus;
  /** True when the asset lost its owner with this revocation. */
  ownerCleared: boolean;
}

export async function revokeClaim(input: RevokeClaimInput): Promise<RevokeClaimResult> {
  const reason = normalizeReason(input.reason);
  const claim = isUuid(input.claimId) ? await loadClaim(input.claimId) : null;
  if (!claim) throw new AdminChangeRefused('not_found', 'no such claim');

  const status = nextClaimStatus(claim.status, 'revoke', { attempts: claim.attempts });
  if (!status) {
    throw new AdminChangeRefused('invalid_input', 'this claim cannot be revoked from its state');
  }

  const outcome = await db().transaction(async (tx) => {
    /*
     * The owner as it actually stands, read under the row lock. Revoking is
     * not always a transfer: a pending dispute, a failed claim, or a verified
     * one whose asset has since moved on all leave the owner exactly where
     * it was, and the audit entry has to say so. Deriving the two values from
     * `ownerCleared` instead reported `null` on both sides of every one of
     * those -- an entry claiming an asset lost an owner it still has, on the
     * record requirement.md 5.3 keeps precisely to answer "what changed".
     */
    const [current] = await tx
      .select({ ownerWorkspaceId: schema.asset.ownerWorkspaceId })
      .from(schema.asset)
      .where(eq(schema.asset.id, claim.assetId))
      .for('update');
    const previousOwner = current?.ownerWorkspaceId ?? null;

    let ownerCleared = false;
    if (claim.status === 'verified') {
      const cleared = await tx
        .update(schema.asset)
        .set({ ownerWorkspaceId: null })
        .where(
          and(
            eq(schema.asset.id, claim.assetId),
            eq(schema.asset.ownerWorkspaceId, claim.claimantWorkspaceId),
          ),
        )
        .returning({ id: schema.asset.id });
      ownerCleared = cleared.length > 0;
    }
    await tx
      .update(schema.assetClaim)
      .set({ status, rulingAdminId: input.actor.administratorId, rulingReason: reason })
      .where(eq(schema.assetClaim.id, claim.id));
    return { ownerCleared, previousOwner };
  });

  await auditClaim({
    action: 'claim.revoke',
    claimId: claim.id,
    administratorId: input.actor.administratorId,
    reason,
    before: {
      status: claim.status,
      ownerWorkspaceId: outcome.previousOwner,
    },
    after: {
      status,
      ownerWorkspaceId: outcome.ownerCleared ? null : outcome.previousOwner,
      assetId: claim.assetId,
      claimantWorkspaceId: claim.claimantWorkspaceId,
      administrator: input.actor.email,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { status, ownerCleared: outcome.ownerCleared };
}

/* ------------------------------------------------------------------ detail */

export interface ClaimAuditEntry {
  id: string;
  action: string;
  administratorName: string | null;
  reason: string | null;
  result: string;
  createdAt: Date;
}

export interface ConsoleClaimDetail {
  id: string;
  status: ClaimStatus;
  method: ClaimMethod;
  failureReason: ClaimFailureReason | null;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  verifiedAt: Date | null;
  remainingDays: number;
  expired: boolean;
  /** Pending on an asset another workspace owns. */
  disputed: boolean;
  rulingAdminName: string | null;
  rulingReason: string | null;
  asset: {
    id: string;
    publicId: string;
    title: string;
    deletedAt: Date | null;
    sourceType: SourceType | null;
    location: string | null;
  };
  claimant: { id: string; name: string };
  currentOwner: { id: string; name: string } | null;
  checks: ClaimCheckView[];
  audit: ClaimAuditEntry[];
}

/** One claim with everything the console may see. Null for an unknown id. */
export async function claimDetail(
  claimId: string,
  now: Date = new Date(),
): Promise<ConsoleClaimDetail | null> {
  if (!isUuid(claimId)) return null;
  const claim = await loadClaim(claimId);
  if (!claim) return null;

  const database = db();
  const [[asset], [claimant], audit] = await Promise.all([
    database
      .select({
        id: schema.asset.id,
        publicId: schema.asset.publicId,
        title: schema.asset.title,
        deletedAt: schema.asset.deletedAt,
        ownerWorkspaceId: schema.asset.ownerWorkspaceId,
        sourceType: schema.source.type,
        location: schema.source.location,
      })
      .from(schema.asset)
      .leftJoin(schema.source, eq(schema.source.assetId, schema.asset.id))
      .where(eq(schema.asset.id, claim.assetId))
      .orderBy(schema.source.id)
      .limit(1),
    database
      .select({ id: schema.workspace.id, name: schema.workspace.name })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, claim.claimantWorkspaceId))
      .limit(1),
    database
      .select({
        id: schema.auditLog.id,
        action: schema.auditLog.action,
        administratorName: schema.administrator.username,
        reason: schema.auditLog.reason,
        result: schema.auditLog.result,
        createdAt: schema.auditLog.createdAt,
      })
      .from(schema.auditLog)
      .leftJoin(schema.administrator, eq(schema.administrator.id, schema.auditLog.administratorId))
      .where(
        and(eq(schema.auditLog.targetType, 'library_claim'), eq(schema.auditLog.targetId, claim.id)),
      )
      .orderBy(desc(schema.auditLog.seq))
      .limit(50),
  ]);
  if (!asset) return null;

  const [owner, ruler] = await Promise.all([
    asset.ownerWorkspaceId
      ? database
          .select({ id: schema.workspace.id, name: schema.workspace.name })
          .from(schema.workspace)
          .where(eq(schema.workspace.id, asset.ownerWorkspaceId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    claim.rulingAdminId
      ? database
          .select({ name: schema.administrator.username })
          .from(schema.administrator)
          .where(eq(schema.administrator.id, claim.rulingAdminId))
          .limit(1)
          .then((rows) => rows[0]?.name ?? null)
      : Promise.resolve(null),
  ]);

  return {
    id: claim.id,
    status: claim.status,
    method: claim.method,
    failureReason: claim.failureReason,
    attempts: claim.attempts,
    createdAt: claim.createdAt,
    expiresAt: claim.expiresAt,
    verifiedAt: claim.verifiedAt,
    remainingDays: remainingDays(claim.expiresAt, now),
    expired: claim.status === 'pending' && isClaimExpired(claim.expiresAt, now),
    disputed: isDisputedClaim({
      status: claim.status,
      ownerWorkspaceId: asset.ownerWorkspaceId,
      claimantWorkspaceId: claim.claimantWorkspaceId,
    }),
    rulingAdminName: ruler,
    rulingReason: claim.rulingReason,
    asset: {
      id: asset.id,
      publicId: asset.publicId,
      title: asset.title,
      deletedAt: asset.deletedAt,
      sourceType: (asset.sourceType as SourceType | null) ?? null,
      location: asset.location ?? null,
    },
    claimant: { id: claim.claimantWorkspaceId, name: claimant?.name ?? '' },
    currentOwner: owner,
    checks: checkStates({
      method: claim.method,
      status: claim.status,
      failureReason: claim.failureReason,
      attempted: claim.attempts > 0,
    }),
    audit,
  };
}
