/**
 * Use case: run a claim's check. requirement.md 7.3.3, architecture.md 5.4.
 *
 * Success writes the owner, marks the claim `verified` and appends the audit
 * event; the first two are one transaction so an owner without a claim record
 * cannot exist. Failure records a stable reason code and counts the attempt;
 * enough of them lock the claim. An expired challenge is marked so on the way
 * in and is never re-run.
 *
 * The output carries the reason code and nothing else about what was seen:
 * no permission table, no TXT payload, no fetched body (requirement.md 7.3.7).
 */
import { and, eq, sql } from 'drizzle-orm';
import { AppError, type ClaimFailureReason } from '@/contracts/errors';
import type { ClaimStatus, SourceType } from '@/lib/domain';
import {
  checkStates,
  dnsRecordName,
  hasRepositoryControl,
  isClaimExpired,
  nextClaimStatus,
  repositoryKey,
  verificationDomain,
  wellKnownUrl,
  type ClaimCheckView,
} from '@/lib/domain/claim';
import { AuthFailure } from '@/lib/domain/auth';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { publicRepositoryHomepage, repositoryGrant } from '@/lib/infrastructure/identity/github';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import {
  checkDnsChallenge,
  checkWellKnownChallenge,
} from '@/lib/infrastructure/verification/challenge';
import { publicFailureMessage } from './rules';
import {
  assertWithinClaimLimits,
  auditClaim,
  failure,
  loadClaim,
  notFound,
  visibleAssetById,
  type ClaimRow,
} from './shared';

export interface GithubGrant {
  /** The claimant's own token, held for this one read and then dropped. */
  token: string;
  /** GitHub's id for the account the token belongs to. */
  subject: string;
  /** The signed-in user, whose linked GitHub account the token must match. */
  userId: string;
}

export interface VerifyClaimInput {
  claimId: string;
  /**
   * The caller's workspace. When given, a claim that belongs to someone else
   * answers "not found" -- the claim id is not a capability.
   */
  workspaceId?: string;
  /**
   * The caller's role in that workspace. Verification is the step that writes
   * `owner_workspace_id` and with it the revenue-share payee (7.3.4), so it
   * asks for the same authority as starting the claim and as releasing it. A
   * caller without a workspace -- there is none -- passes none.
   */
  role?: WorkspaceRole;
  grant?: GithubGrant;
  now?: Date;
}

export interface VerifyClaimResult {
  claimId: string;
  status: ClaimStatus;
  checks: ClaimCheckView[];
  /** Control was proven but the asset has an owner; an administrator decides. */
  disputed: boolean;
}

export async function verifyClaim(input: VerifyClaimInput): Promise<VerifyClaimResult> {
  if (input.role !== undefined && !canManageAssets(input.role)) {
    throw new AppError('access_denied', 'only an owner or admin may verify a claim');
  }
  const now = input.now ?? new Date();
  const claim = await loadClaim(input.claimId);
  if (!claim || (input.workspaceId && claim.claimantWorkspaceId !== input.workspaceId)) {
    throw notFound();
  }

  /*
   * The same predicate the claim was opened under, not just "not deleted": a
   * asset turned private or archived since then is no longer claimable, and
   * an old challenge must not be a way to rewrite its owner anyway.
   */
  const asset = await visibleAssetById(claim.assetId);

  const view = (status: ClaimStatus, reason: ClaimFailureReason | null, attempted: boolean) =>
    checkStates({ method: claim.method, status, failureReason: reason, attempted });

  if (claim.status !== 'pending') {
    return {
      claimId: claim.id,
      status: claim.status,
      checks: view(claim.status, claim.failureReason, claim.attempts > 0),
      disputed: false,
    };
  }

  if (isClaimExpired(claim.expiresAt, now)) {
    await db()
      .update(schema.assetClaim)
      .set({ status: 'expired', failureReason: 'challenge_expired' })
      .where(and(eq(schema.assetClaim.id, claim.id), eq(schema.assetClaim.status, 'pending')));
    await auditClaim({
      action: 'claim.expire',
      claimId: claim.id,
      before: { status: 'pending' },
      after: { status: 'expired' },
      result: 'success',
    });
    throw failure('challenge_expired', publicFailureMessage('challenge_expired'));
  }

  await assertWithinClaimLimits('verify', claim.claimantWorkspaceId, claim.assetId);

  const reason = await runCheck(claim, asset, input.grant);
  if (reason) {
    /*
     * The count is a security control, not a statistic: 7.3.7 locks the entry
     * on it. So the increment is taken under the row's own lock rather than
     * from `claim.attempts`, which was read before a check that takes a DNS
     * lookup or an HTTP fetch to answer. Two checks failing in that window
     * both wrote `attempts = 0 + 1`, and a claimant pairing their requests got
     * two guesses for the price of one -- ten instead of five, with more for
     * wider fan-out. `nextClaimStatus` still decides the transition; only the
     * number it is asked about changes.
     */
    const { attempts, status } = await db().transaction(async (tx) => {
      const [locked] = await tx
        .select({ attempts: schema.assetClaim.attempts })
        .from(schema.assetClaim)
        .where(eq(schema.assetClaim.id, claim.id))
        .for('update');
      const spent = (locked?.attempts ?? claim.attempts) + 1;
      const next = nextClaimStatus('pending', 'verify_failed', { attempts: spent }) ?? 'failed';
      await tx
        .update(schema.assetClaim)
        .set({ attempts: spent, failureReason: reason, status: next })
        .where(eq(schema.assetClaim.id, claim.id));
      return { attempts: spent, status: next };
    });
    await auditClaim({
      action: 'claim.verify',
      claimId: claim.id,
      before: { status: 'pending', attempts: claim.attempts },
      after: { status, attempts, failureReason: reason, method: claim.method },
      result: 'failure',
    });
    throw failure(
      status === 'failed' ? 'retry_limit_exceeded' : reason,
      publicFailureMessage(status === 'failed' ? 'retry_limit_exceeded' : reason),
    );
  }

  /*
   * Control is proven. Whether that makes an owner depends on the conflict
   * check, which reads the asset again inside the transaction: the owner
   * may have changed since the claim opened.
   */
  const outcome = await db().transaction(async (tx) => {
    const [current] = await tx
      .select({ ownerWorkspaceId: schema.asset.ownerWorkspaceId })
      .from(schema.asset)
      .where(eq(schema.asset.id, claim.assetId))
      .for('update');
    const owner = current?.ownerWorkspaceId ?? null;

    if (owner !== null && owner !== claim.claimantWorkspaceId) {
      /*
       * A dispute: the evidence is recorded on the claim; the owner is not
       * touched. `verified_at` says the checks passed and `already_claimed`
       * says which one did not -- the shared conflict check, because the
       * asset has another owner. The status stays `pending` (7.3.3 fixes
       * the five values) and an administrator rules on it; leaving the reason
       * null instead would make `checkStates` render a claim that passed
       * every check as though it had never run one.
       */
      await tx
        .update(schema.assetClaim)
        .set({
          /* Relative, for the same reason the failure branch is: the lock
             above is on the asset row, not on this claim's. */
          attempts: sql`${schema.assetClaim.attempts} + 1`,
          failureReason: 'already_claimed',
          verifiedAt: now,
        })
        .where(eq(schema.assetClaim.id, claim.id));
      return { disputed: true as const, previousOwner: owner };
    }

    await tx
      .update(schema.asset)
      .set({ ownerWorkspaceId: claim.claimantWorkspaceId })
      .where(eq(schema.asset.id, claim.assetId));
    await tx
      .update(schema.assetClaim)
      .set({
        attempts: sql`${schema.assetClaim.attempts} + 1`,
        failureReason: null,
        status: 'verified',
        verifiedAt: now,
      })
      .where(eq(schema.assetClaim.id, claim.id));
    return { disputed: false as const, previousOwner: owner };
  });

  await auditClaim({
    action: outcome.disputed ? 'claim.dispute_evidence' : 'claim.verify',
    claimId: claim.id,
    before: { status: 'pending', ownerWorkspaceId: outcome.previousOwner },
    after: {
      status: outcome.disputed ? 'pending' : 'verified',
      failureReason: outcome.disputed ? 'already_claimed' : null,
      ownerWorkspaceId: outcome.disputed ? outcome.previousOwner : claim.claimantWorkspaceId,
      assetId: claim.assetId,
      assetPublicId: asset.publicId,
      method: claim.method,
    },
    result: 'success',
  });

  if (outcome.disputed) {
    /* Exactly what the row now says, so a reload of the page agrees with this. */
    return {
      claimId: claim.id,
      status: 'pending',
      checks: view('pending', 'already_claimed', true),
      disputed: true,
    };
  }
  return { claimId: claim.id, status: 'verified', checks: view('verified', null, true), disputed: false };
}

/** The method's check, answering a failure code or null for "control proven". */
async function runCheck(
  claim: ClaimRow,
  asset: { sourceType: SourceType; location: string },
  grant: GithubGrant | undefined,
): Promise<ClaimFailureReason | null> {
  if (claim.method === 'github_permission') {
    if (!grant) return 'account_not_linked';

    const [linked] = await db()
      .select({ subject: schema.oauthAccount.providerSubject })
      .from(schema.oauthAccount)
      .where(
        and(eq(schema.oauthAccount.userId, grant.userId), eq(schema.oauthAccount.provider, 'github')),
      )
      .limit(1);
    if (!linked || linked.subject !== grant.subject) return 'account_not_linked';

    const repository = await unlessUnavailable(() => repositoryGrant(grant.token, asset.location));
    if (!repository) return 'insufficient_permission';
    if (repositoryKey(repository.fullName) !== repositoryKey(asset.location)) {
      return 'source_mismatch';
    }
    return hasRepositoryControl(repository.permissions) ? null : 'insufficient_permission';
  }

  const homepage =
    asset.sourceType === 'github'
      ? await unlessUnavailable(() => publicRepositoryHomepage(asset.location))
      : null;
  const domain = verificationDomain({
    sourceType: asset.sourceType,
    location: asset.location,
    homepage,
  });
  if (!domain) return 'source_mismatch';

  const outcome =
    claim.method === 'dns_txt'
      ? await checkDnsChallenge({
          recordName: dnsRecordName(domain),
          tokenHash: claim.challengeTokenHash,
        })
      : await checkWellKnownChallenge({
          url: wellKnownUrl(domain, claim.id),
          tokenHash: claim.challengeTokenHash,
        });
  return outcome === 'matched' ? null : 'challenge_not_found';
}

/**
 * Separates "GitHub answered, and the answer is no" from "GitHub did not
 * answer". requirement.md 7.3.7 counts a failed *check*; a secondary rate
 * limit, a 5xx or a timeout is not one, and counting it would spend an
 * attempt the claimant never made -- five of those lock the entry for the
 * rest of the challenge's seven days with no self-service way out.
 *
 * Thrown rather than returned as a failure code so it lands before the
 * attempt is recorded. The message is ours: GitHub's own never reaches the
 * caller (7.3.7).
 */
async function unlessUnavailable<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AuthFailure && error.loginError === 'provider_unavailable') {
      throw new AppError(
        'provider_unavailable',
        'the source provider could not be reached; the check was not run, try again shortly',
      );
    }
    throw error;
  }
}
