/**
 * GET / POST /api/v1/claims -- ownership claims. requirement.md 7.3.
 *
 * POST opens a claim and answers the contract's `claimChallenge`: the
 * challenge token is in this response and nowhere else afterwards. GET lists
 * the caller's own claims, never anyone else's.
 *
 * Route Handlers may only call lib/application use cases (architecture.md 4).
 * Failure bodies carry the stable reason code only; an invisible asset is
 * `asset_not_found` exactly like a missing one (7.3.7).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { startClaimInputSchema } from '@/contracts/schemas';
import { listWorkspaceClaims, startClaim } from '@/lib/application/claims';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import { claimPrincipal } from './principal';

export const runtime = 'nodejs';

const NO_STORE = { 'cache-control': 'private, no-store' };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const principal = await claimPrincipal(request, { mutation: false });
    const claims = await listWorkspaceClaims(principal.workspaceId);
    return NextResponse.json(
      {
        claims: claims.map((claim) => ({
          claimId: claim.id,
          assetId: claim.assetPublicId,
          method: claim.method,
          status: claim.status,
          reason: claim.failureReason ?? undefined,
          attempts: claim.attempts,
          disputed: claim.disputed,
          expiresAt: claim.expiresAt.toISOString(),
          verifiedAt: claim.verifiedAt?.toISOString() ?? null,
          createdAt: claim.createdAt.toISOString(),
        })),
        requestId,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const principal = await claimPrincipal(request, { mutation: true });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const parsed = startClaimInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'expected { assetId, method }');
    }

    const started = await startClaim({
      workspaceId: principal.workspaceId,
      role: principal.role,
      assetPublicId: parsed.data.assetId,
      method: parsed.data.method,
    });
    return NextResponse.json({ ...started, requestId }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
