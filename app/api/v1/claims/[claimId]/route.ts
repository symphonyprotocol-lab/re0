/**
 * GET /api/v1/claims/{claimId} -- one claim as its claimant sees it.
 *
 * The record and the instructions to complete it (where the TXT record or
 * the well-known file goes), but never the challenge token: only its hash
 * exists after creation (architecture.md 5.4). Another workspace's claim id
 * answers `library_not_found`, the same as a bad id.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { claimForClaimant } from '@/lib/application/claims';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import { claimPrincipal } from '../principal';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ claimId: string }> },
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const [principal, { claimId }] = await Promise.all([
      claimPrincipal(request, { mutation: false }),
      context.params,
    ]);
    const claim = await claimForClaimant(principal.workspaceId, claimId);
    return NextResponse.json(
      {
        claimId: claim.id,
        assetId: claim.assetPublicId,
        method: claim.method,
        status: claim.status,
        reason: claim.failureReason ?? undefined,
        attempts: claim.attempts,
        disputed: claim.disputed,
        checks: claim.checks.map((check) => ({ ...check, label: check.key })),
        dnsRecordName: claim.dnsRecordName ?? undefined,
        wellKnownUrl: claim.wellKnownUrl ?? undefined,
        expiresAt: claim.expiresAt.toISOString(),
        verifiedAt: claim.verifiedAt?.toISOString() ?? null,
        createdAt: claim.createdAt.toISOString(),
        requestId,
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
