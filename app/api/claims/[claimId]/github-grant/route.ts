/**
 * POST /api/claims/{claimId}/github-grant -- begin the GitHub permission check.
 *
 * The claimant is sent to GitHub to consent to one read of their repository
 * permissions (requirement.md 7.3.2). Same shape as the login start: POST so
 * there is an Origin to check, a sealed handshake cookie, a 303 to GitHub.
 * The callback is the login callback, which tells the two apart by the
 * handshake's purpose and never mints a session for a grant.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { beginGithubGrant, claimPagePath } from '@/lib/application/claims';
import { appRedirect, logAuthFailure, withinRateLimit } from '@/lib/http/auth-endpoints';
import { newRequestId } from '@/lib/http/respond';
import { callbackUrl, isSameOrigin, requireSession, setHandshakeCookie } from '@/lib/http/session';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ claimId: string }> },
): Promise<NextResponse> {
  const requestId = newRequestId();
  const { claimId } = await context.params;
  const back = `${claimPagePath(claimId)}&grant=failed`;

  if (!(await isSameOrigin())) {
    return new NextResponse('cross-origin request refused', { status: 403 });
  }
  if (!(await withinRateLimit(request, 'claim-grant'))) {
    return appRedirect(back);
  }
  const session = await requireSession(claimPagePath(claimId));

  try {
    const started = await beginGithubGrant({
      claimId,
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      redirectUri: callbackUrl('github'),
    });
    const response = NextResponse.redirect(started.redirectUrl, 303);
    setHandshakeCookie(response, started.handshake, started.expiresAt);
    return response;
  } catch (error) {
    logAuthFailure({
      requestId,
      provider: 'github',
      error: 'oauth_failed',
      detail: `claim grant: ${error instanceof Error ? error.message : 'unknown'}`,
    });
    return appRedirect(
      error instanceof AppError && error.code === 'asset_not_found' ? '/assets/claim' : back,
    );
  }
}
