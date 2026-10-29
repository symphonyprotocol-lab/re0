/**
 * POST /api/v1/revenue/payout -- request a cash payout of every statement
 * past its hold to a PayPal address. agent-first-proposal.md 6.9: the same
 * step as the dashboard form; an operator pays it by hand and the outcome
 * shows up in GET /api/v1/revenue under `payouts`.
 *
 * Gated like the credit beside it: an API key has no workspace role, so the
 * management scope stands in for owner/admin.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { requireScope, resolveApiKey } from '@/lib/application/auth/api-key';
import { requestPayout } from '@/lib/application/revenue';
import { PayoutRefused } from '@/lib/domain';
import { API_KEY_MANAGEMENT_SCOPE } from '@/lib/domain/api-key';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const principal = await resolveApiKey(request.headers.get('authorization'));
    if (!principal) throw new AppError('invalid_api_key', 'an API key is required');
    requireScope(principal, API_KEY_MANAGEMENT_SCOPE);

    let body: { paypalEmail?: unknown };
    try {
      body = (await request.json()) as { paypalEmail?: unknown };
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }

    try {
      const requested = await requestPayout({
        workspaceId: principal.workspaceId,
        actor: { kind: 'api_key', id: principal.apiKeyId },
        payeeEmail: typeof body.paypalEmail === 'string' ? body.paypalEmail : '',
      });
      return NextResponse.json(
        { ...requested, requestId },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    } catch (error) {
      if (error instanceof PayoutRefused) {
        throw new AppError('invalid_request', `${error.code}: ${error.message}`);
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
