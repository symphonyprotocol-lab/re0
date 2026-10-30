/**
 * GET /api/v1/anchors?version=/owner/repo/<label> -- a public version's
 * anchor status and proof. requirement.md 6.4: Context and Search never inline
 * anchor fields; this is the separate query they point to. Reads the anchor
 * tables only (aptos-anchoring-proposal.md 5); it never calls the chain, and
 * it costs no Call.
 *
 * Unmetered and credential-free is not the same as free to hammer: every call
 * is a database read, and nothing else on this route counts them. So it takes
 * the same per-address limit the anonymous retrieval door uses, with its own
 * scope so the two cannot exhaust each other's budget. Generous, because the
 * honest use is a page verifying the proofs it shows.
 *
 * Route Handlers may only call lib/application use cases. architecture.md 4.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { publicVersionAnchor, splitPinnedId } from '@/lib/application/anchors';
import { rateLimitKey } from '@/lib/http/auth-endpoints';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import type { RateLimitRule } from '@/lib/infrastructure/cache/redis';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';

export const runtime = 'nodejs';

const ANCHOR_RATE_RULE: RateLimitRule = { limit: 120, windowSeconds: 3_600 };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const verdict = await strictRateLimit(
      await rateLimitKey(request, 'anchors'),
      ANCHOR_RATE_RULE,
    );
    if (!verdict.allowed) {
      throw new AppError('rate_limited', 'anchor proof limit reached; retry later');
    }

    const version = request.nextUrl.searchParams.get('version')?.trim() ?? '';
    if (!version || !splitPinnedId(version)) {
      throw new AppError(
        'invalid_request',
        'version is required as a pinned Asset ID, e.g. /owner/repo/20260101-abcdef12',
      );
    }

    const anchor = await publicVersionAnchor(version);
    if (!anchor) {
      throw new AppError('library_not_found', 'no public version with that id');
    }

    return NextResponse.json(
      { anchor, requestId },
      { headers: { 'cache-control': 'public, max-age=60' } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
