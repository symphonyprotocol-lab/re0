'use server';

import { revalidatePath } from 'next/cache';
import { AppError, type ClaimFailureReason } from '@/contracts/errors';
import type { ClaimStatus } from '@/lib/domain';
import { isClaimMethod, type ClaimCheckView } from '@/lib/domain/claim';
import { startClaim, verifyClaim } from '@/lib/application/claims';
import { requireSession } from '@/lib/http/session';

/**
 * The claim page's two mutations: open a claim, run its check.
 *
 * Both re-resolve the session (a server action is a public endpoint with a
 * generated name) and hand the use case the workspace *and role* it resolved,
 * never one from the form; the use case checks the role itself, because
 * binding an asset's management and its share of the pool to a workspace is
 * the same authority as releasing it.
 *
 * What comes back is a coarse code or the 7.3.8 reason; the use case already
 * keeps the DNS answer, the fetched body and GitHub's permission table on the
 * server (requirement.md 7.3.7).
 */
export interface ClaimActionResult {
  ok: boolean;
  error?:
    | 'not_found'
    | 'method_unavailable'
    | 'access_denied'
    | 'provider_unavailable'
    | 'unavailable';
  /** A stable 7.3.8 reason code; the page pairs it with a next step. */
  reason?: ClaimFailureReason;
  challenge?: {
    claimId: string;
    method: 'github_permission' | 'dns_txt' | 'well_known';
    expiresAt: string;
    disputed: boolean;
    challengeToken?: string;
    dnsRecordName?: string;
    wellKnownUrl?: string;
  };
  verified?: {
    status: ClaimStatus;
    checks: ClaimCheckView[];
    disputed: boolean;
  };
}

function refused(error: unknown): ClaimActionResult {
  if (error instanceof AppError) {
    if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
    if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
    /*
     * The check did not run, so there is no reason code to show and no
     * attempt was spent; the page says so and offers the same button again.
     */
    if (error.code === 'provider_unavailable') return { ok: false, error: 'provider_unavailable' };
    if (error.code === 'rate_limited') return { ok: false, reason: 'retry_limit_exceeded' };
    if (error.reason) return { ok: false, reason: error.reason };
  }
  console.error(`claim action failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

export async function startClaimAction(
  _previous: ClaimActionResult | null,
  form: FormData,
): Promise<ClaimActionResult> {
  const assetId = String(form.get('assetId') ?? '');
  const method = String(form.get('method') ?? '');
  const session = await requireSession(`/assets/claim?asset=${encodeURIComponent(assetId)}`);
  if (!isClaimMethod(method)) return { ok: false, error: 'method_unavailable' };

  try {
    const started = await startClaim({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetPublicId: assetId,
      method,
    });
    revalidatePath('/assets/claim');
    return {
      ok: true,
      challenge: {
        claimId: started.claimId,
        method: started.method,
        expiresAt: started.expiresAt,
        disputed: started.disputed,
        challengeToken: started.challengeToken,
        dnsRecordName: started.dnsRecordName,
        wellKnownUrl: started.wellKnownUrl,
      },
    };
  } catch (error) {
    /* assertMethodSupported answers source_mismatch; on this form that is a method choice. */
    if (
      error instanceof AppError &&
      error.code === 'claim_verification_failed' &&
      error.reason === 'source_mismatch'
    ) {
      return { ok: false, error: 'method_unavailable' };
    }
    return refused(error);
  }
}

export async function verifyClaimAction(
  _previous: ClaimActionResult | null,
  form: FormData,
): Promise<ClaimActionResult> {
  const claimId = String(form.get('claimId') ?? '');
  const session = await requireSession(`/assets/claim?claim=${encodeURIComponent(claimId)}`);

  try {
    const result = await verifyClaim({
      claimId,
      workspaceId: session.workspace.id,
      role: session.workspace.role,
    });
    revalidatePath('/assets/claim');
    revalidatePath('/dashboard/assets');
    return {
      ok: true,
      verified: { status: result.status, checks: result.checks, disputed: result.disputed },
    };
  } catch (error) {
    revalidatePath('/assets/claim');
    return refused(error);
  }
}
