/**
 * GET /api/v1/revenue -- the workspace's publisher earnings; POST accepts the
 * publisher agreement and opens the account. publisher-revenue-share.md
 * stage 2: figures are recomputed from the ledger on every read, and the
 * platform holds no funds -- the numbers describe accounting, not a balance
 * anyone can move.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { requireScope, resolveApiKey } from '@/lib/application/auth/api-key';
import {
  acceptPublisherAgreement,
  publisherEarnings,
  type EarningPayouts,
} from '@/lib/application/revenue';
import { API_KEY_MANAGEMENT_SCOPE, hasScope } from '@/lib/domain/api-key';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

/**
 * Reading is open to any key of the workspace; entering the programme is an
 * account-level change and needs the management scope, like key management
 * and redeeming earnings do.
 */
async function principalOf(request: NextRequest, access: 'read' | 'manage' = 'read') {
  const principal = await resolveApiKey(request.headers.get('authorization'));
  if (!principal) throw new AppError('invalid_api_key', 'an API key is required');
  if (access === 'manage') requireScope(principal, API_KEY_MANAGEMENT_SCOPE);
  return principal;
}

/**
 * The payee address is personal data and only the keys that may request a
 * payout get to see it; a read key -- the kind handed to CI or an
 * integration -- still sees amounts and statuses.
 */
function withoutPayeeEmails(payouts: EarningPayouts): EarningPayouts {
  const strip = <T extends { payeeEmail: string | null }>(payout: T): T => ({
    ...payout,
    payeeEmail: null,
  });
  return {
    ...payouts,
    open: payouts.open ? strip(payouts.open) : null,
    history: payouts.history.map(strip),
    lastPayeeEmail: null,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const principal = await principalOf(request);
    const earnings = await publisherEarnings(principal.workspaceId);
    const payouts = hasScope(principal.scopes, API_KEY_MANAGEMENT_SCOPE)
      ? earnings.payouts
      : withoutPayeeEmails(earnings.payouts);
    return NextResponse.json(
      { ...earnings, payouts, requestId },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { workspaceId } = await principalOf(request, 'manage');

    let body: { agreementVersion?: unknown };
    try {
      body = (await request.json()) as { agreementVersion?: unknown };
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const agreementVersion =
      typeof body.agreementVersion === 'string' ? body.agreementVersion.trim() : '';
    if (agreementVersion.length === 0 || agreementVersion.length > 40) {
      throw new AppError('invalid_request', 'agreementVersion is required (1-40 characters)');
    }

    const { accountId } = await acceptPublisherAgreement({ workspaceId, agreementVersion });
    return NextResponse.json(
      { accountId, requestId },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
