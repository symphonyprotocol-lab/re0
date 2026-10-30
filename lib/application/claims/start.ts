/**
 * Use case: open an ownership claim. requirement.md 7.3.3, architecture.md 5.4.
 *
 * Mints one challenge, bound to (claimant, library, method) and good for seven
 * days. The plaintext is returned exactly once; the row keeps its hash. The
 * partial unique index on `library_claim` is what guarantees a single
 * `pending` claim per library, so a race between two claimants is settled by
 * Postgres rather than by a check that could be read stale.
 */
import { and, eq } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import type { ClaimChallenge } from '@/contracts/schemas';
import type { ClaimMethod } from '@/lib/domain';
import {
  claimExpiryFrom,
  dnsRecordName,
  isClaimLocked,
  verificationDomain,
  wellKnownUrl,
} from '@/lib/domain/claim';
import { uuidv7 } from '@/lib/domain/id';
import { AuthFailure } from '@/lib/domain/auth';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { randomToken, sha256 } from '@/lib/infrastructure/crypto/tokens';
import { publicRepositoryHomepage } from '@/lib/infrastructure/identity/github';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { assertMethodSupported } from './rules';
import {
  assertWithinClaimLimits,
  auditClaim,
  failure,
  newestClaimBy,
  visibleLibrary,
} from './shared';

export interface StartClaimInput {
  workspaceId: string;
  /**
   * The caller's role in that workspace. A claim binds the library's
   * management and its share of the revenue pool to the workspace
   * (requirement.md 7.3.4), which is the same authority `releaseOwnership`
   * and library deletion ask for -- so a viewer or a developer may not open
   * one, and the use case checks it rather than trusting the screen.
   */
  role: WorkspaceRole;
  libraryPublicId: string;
  method: ClaimMethod;
  now?: Date;
}

/** The contract's challenge, plus whether the library already has an owner. */
export interface StartedClaim extends ClaimChallenge {
  /**
   * requirement.md 7.3.5: a claim on an owned library is a dispute. The claim
   * still opens -- the evidence has to be collected somewhere -- but it is
   * settled by an administrator, never by the self-service check.
   */
  disputed: boolean;
}

export async function startClaim(input: StartClaimInput): Promise<StartedClaim> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only an owner or admin may claim a library');
  }
  const now = input.now ?? new Date();
  const library = await visibleLibrary(input.libraryPublicId);
  assertMethodSupported(library.sourceType, input.method);

  if (library.ownerWorkspaceId === input.workspaceId) {
    throw failure('already_claimed', 'this workspace already owns the library');
  }

  const previous = await newestClaimBy(input.workspaceId, library.id);
  if (previous?.status === 'pending') {
    throw failure('claim_in_progress', 'this workspace already has a pending claim');
  }
  if (previous && isClaimLocked(previous, now)) {
    throw failure('retry_limit_exceeded', 'the claim entry is locked pending review');
  }

  const [pending] = await db()
    .select({ id: schema.libraryClaim.id })
    .from(schema.libraryClaim)
    .where(
      and(eq(schema.libraryClaim.libraryId, library.id), eq(schema.libraryClaim.status, 'pending')),
    )
    .limit(1);
  if (pending) {
    throw failure('claim_in_progress', 'another claim is in progress for this library');
  }

  await assertWithinClaimLimits('start', input.workspaceId, library.id);

  /*
   * The domain is resolved now rather than at verification so the user is
   * told where to put the record before they go and put it somewhere. A
   * GitHub source has no domain unless the repository names one.
   */
  let domain: string | null = null;
  if (input.method !== 'github_permission') {
    /*
     * A repository that names no home page answers null and the claim cannot
     * take this method; GitHub being unreachable is not that answer, and it
     * is told apart so the user is asked to retry rather than told their
     * source does not match.
     */
    let homepage: string | null = null;
    if (library.sourceType === 'github') {
      try {
        homepage = await publicRepositoryHomepage(library.location);
      } catch (error) {
        if (error instanceof AuthFailure && error.loginError === 'provider_unavailable') {
          throw new AppError(
            'provider_unavailable',
            'the source provider could not be reached; try again shortly',
          );
        }
        throw error;
      }
    }
    domain = verificationDomain({
      sourceType: library.sourceType,
      location: library.location,
      homepage,
    });
    if (!domain) {
      throw failure('source_mismatch', 'the source names no domain this method can verify');
    }
  }

  const claimId = uuidv7(now.getTime());
  const token = randomToken();
  const expiresAt = claimExpiryFrom(now);
  const disputed = library.ownerWorkspaceId !== null;

  try {
    await db().insert(schema.libraryClaim).values({
      id: claimId,
      libraryId: library.id,
      claimantWorkspaceId: input.workspaceId,
      method: input.method,
      challengeTokenHash: await sha256(token),
      status: 'pending',
      attempts: 0,
      expiresAt,
      createdAt: now,
    });
  } catch (error) {
    /* The partial unique index caught a claim that opened between the check and the insert. */
    const detail = [
      error instanceof Error ? error.message : '',
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    ].join(' ');
    if (detail.includes('asset_claim_pending_uq')) {
      throw failure('claim_in_progress', 'another claim is in progress for this library');
    }
    throw error;
  }

  await auditClaim({
    action: disputed ? 'claim.dispute' : 'claim.start',
    claimId,
    after: {
      libraryId: library.id,
      libraryPublicId: library.publicId,
      claimantWorkspaceId: input.workspaceId,
      method: input.method,
      currentOwnerWorkspaceId: library.ownerWorkspaceId,
      expiresAt: expiresAt.toISOString(),
    },
    result: 'success',
  });

  return {
    claimId,
    method: input.method,
    status: 'pending',
    expiresAt: expiresAt.toISOString(),
    disputed,
    ...(input.method === 'dns_txt' && domain
      ? { challengeToken: token, dnsRecordName: dnsRecordName(domain), dnsRecordValue: token }
      : {}),
    ...(input.method === 'well_known' && domain
      ? { challengeToken: token, wellKnownUrl: wellKnownUrl(domain, claimId) }
      : {}),
  };
}
