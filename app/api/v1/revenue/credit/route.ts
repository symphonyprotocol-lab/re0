/**
 * POST /api/v1/revenue/credit -- redeem every redeemable statement as
 * Additional Calls. publisher-revenue-share.md 3.4: the same step as the
 * dashboard button, for publishers who entered the programme through the API
 * and run their account from it.
 *
 * An API key acts for its workspace with no role of its own, as the agreement
 * acceptance beside it already does; a key that may read the workspace's
 * revenue may spend it on the workspace's own calls.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { resolveApiKey } from '@/lib/application/auth/api-key';
import { redeemEarningsAsCalls } from '@/lib/application/revenue';
import { EarningCreditRefused } from '@/lib/domain';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const principal = await resolveApiKey(request.headers.get('authorization'));
    if (!principal) throw new AppError('invalid_api_key', 'an API key is required');

    try {
      const redeemed = await redeemEarningsAsCalls({ workspaceId: principal.workspaceId });
      return NextResponse.json(
        { ...redeemed, requestId },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    } catch (error) {
      if (error instanceof EarningCreditRefused) {
        /* A refusal is the caller's state, not a server fault: say which. */
        throw new AppError('invalid_request', `${error.code}: ${error.message}`);
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
