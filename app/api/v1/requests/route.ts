/**
 * GET /api/v1/requests -- the workspace's request log. architecture.md 6.3:
 * per-request summaries for the user's own screen -- outcome, asset,
 * latency, returned tokens -- and never the query text (17.1). API key with
 * `usage:read` required; a workspace reads only its own log.
 *
 * Takes the same filters as the dashboard screen (`from`, `to`, `status`,
 * `entrypoint`, `asset`, `q`, `page`) and answers with the page and the
 * count behind it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { requireScope, resolveApiKey } from '@/lib/application/auth/api-key';
import { queryRequests } from '@/lib/application/plans';
import { parseRequestFilter } from '@/lib/domain/request-log';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const principal = await resolveApiKey(request.headers.get('authorization'));
    if (!principal) throw new AppError('invalid_api_key', 'an API key is required');
    requireScope(principal, 'usage:read');

    const params = Object.fromEntries(request.nextUrl.searchParams.entries());
    const filter = parseRequestFilter(params);
    const limit = Number(params.limit ?? 50);
    const page = await queryRequests(
      principal.workspaceId,
      filter,
      Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50,
    );
    return NextResponse.json(
      {
        requests: page.rows,
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
        requestId,
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
