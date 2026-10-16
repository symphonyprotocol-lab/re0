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
import { acceptPublisherAgreement, publisherEarnings } from '@/lib/application/revenue';
import { API_KEY_MANAGEMENT_SCOPE } from '@/lib/domain/api-key';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

/**
 * Reading is open to any key of the workspace; entering the programme is an
 * account-level change and needs the management scope, like key management
 * and redeeming earnings do.
 */
async function workspaceOf(
  request: NextRequest,
  access: 'read' | 'manage' = 'read',
): Promise<string> {
  const principal = await resolveApiKey(request.headers.get('authorization'));
  if (!principal) throw new AppError('invalid_api_key', 'an API key is required');
  if (access === 'manage') requireScope(principal, API_KEY_MANAGEMENT_SCOPE);
  return principal.workspaceId;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const workspaceId = await workspaceOf(request);
    const earnings = await publisherEarnings(workspaceId);
    return NextResponse.json(
      { ...earnings, requestId },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const workspaceId = await workspaceOf(request, 'manage');

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
