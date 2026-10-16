/**
 * POST /api/v1/revenue/credit -- redeem every redeemable statement as
 * Additional Calls. publisher-revenue-share.md 3.4: the same step as the
 * dashboard button, for publishers who entered the programme through the API
 * and run their account from it.
 *
 * An API key has no workspace role, so the management scope stands in for
 * owner/admin: a key narrowed to reading knowledge must not be able to spend
 * the workspace's earnings. The agreement acceptance beside it is gated the
 * same way.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { requireScope, resolveApiKey } from '@/lib/application/auth/api-key';
import { redeemEarningsAsCalls } from '@/lib/application/revenue';
import { EarningCreditRefused } from '@/lib/domain';
import { API_KEY_MANAGEMENT_SCOPE } from '@/lib/domain/api-key';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const principal = await resolveApiKey(request.headers.get('authorization'));
    if (!principal) throw new AppError('invalid_api_key', 'an API key is required');
    requireScope(principal, API_KEY_MANAGEMENT_SCOPE);

    try {
      const redeemed = await redeemEarningsAsCalls({
        workspaceId: principal.workspaceId,
        actor: { kind: 'api_key', id: principal.apiKeyId },
      });
      return NextResponse.json(
        { ...redeemed, requestId },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    } catch (error) {
      if (error instanceof EarningCreditRefused) {
        /* No pack rate is our configuration, not the caller's state. */
        throw new AppError(
          error.code === 'no_pack_rate' ? 'provider_unavailable' : 'invalid_request',
          `${error.code}: ${error.message}`,
        );
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
