/**
 * POST /api/auth/{github|notion}/connect -- ask for import access.
 *
 * The second consent a signed-in person gives, separate from login: the
 * token it yields is kept (sealed) so the asset wizard can list what the
 * account may import -- their own public repositories on GitHub, the pages
 * they shared with the integration on Notion -- and prove the one they pick
 * is theirs. Only these two providers have a connect step; any other is a
 * 404-shaped refusal.
 *
 * POST, same-origin and behind a session, like the login start: a bare link
 * or a prefetch must not be able to begin a grant on someone's behalf.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { GITHUB_CONNECT_RETURN_TO } from '@/lib/domain/github';
import { NOTION_CONNECT_RETURN_TO } from '@/lib/domain/notion';
import { beginGithubConnect, beginNotionConnect, resolveSession } from '@/lib/application/auth';
import {
  appRedirect,
  loginRedirect,
  logAuthFailure,
  withinRateLimit,
} from '@/lib/http/auth-endpoints';
import { newRequestId } from '@/lib/http/respond';
import {
  githubConnectCallbackUrl,
  isSameOrigin,
  notionConnectCallbackUrl,
  SESSION_COOKIE,
  setGithubConnectCookie,
  setNotionConnectCookie,
} from '@/lib/http/session';

type ConnectProvider = 'github' | 'notion';

function isConnectProvider(value: string): value is ConnectProvider {
  return value === 'github' || value === 'notion';
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const requestId = newRequestId();
  const { provider } = await context.params;
  if (!isConnectProvider(provider)) {
    return new NextResponse('not found', { status: 404 });
  }
  if (!(await isSameOrigin())) {
    return new NextResponse('cross-origin request refused', { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const returnTo = form?.get('returnTo');
  const fallback = provider === 'github' ? GITHUB_CONNECT_RETURN_TO : NOTION_CONNECT_RETURN_TO;
  const back = typeof returnTo === 'string' ? returnTo : fallback;
  /* The outcome parameter the wizard reads: `?github=` or `?notion=`. */
  const failed = `${back}?${provider}=failed`;

  const session = await resolveSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return loginRedirect(undefined, back);
  if (!(await withinRateLimit(request, `${provider}-connect`))) {
    return appRedirect(failed);
  }

  try {
    if (provider === 'github') {
      const started = await beginGithubConnect({
        returnTo: back,
        redirectUri: githubConnectCallbackUrl(),
      });
      const response = NextResponse.redirect(started.redirectUrl, 303);
      setGithubConnectCookie(response, started.handshake, started.expiresAt);
      return response;
    }
    const started = await beginNotionConnect({
      returnTo: back,
      redirectUri: notionConnectCallbackUrl(),
    });
    const response = NextResponse.redirect(started.redirectUrl, 303);
    setNotionConnectCookie(response, started.handshake, started.expiresAt);
    return response;
  } catch (error) {
    logAuthFailure({
      requestId,
      provider: `${provider}-connect`,
      error: 'oauth_failed',
      detail: error instanceof Error ? error.message : 'unknown',
    });
    return appRedirect(failed);
  }
}
