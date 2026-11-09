import { NextResponse, type NextRequest } from 'next/server';
import { appBaseUrl, HANDSHAKE_COOKIE } from '@/lib/http/cookies';
import { clearHandshakeCookie, currentUser } from '@/lib/http/session';
import { CONNECTIONS_PATH, completeGithubConnect, connectReturnPath } from '@/lib/services/connections';

/**
 * GitHub's redirect after "连接 GitHub". Under the sign-in callback's path,
 * so an OAuth app whose registered callback is `/api/auth/github/callback`
 * accepts it as a sub-path.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  if ((await context.params).provider !== 'github') return new NextResponse(null, { status: 404 });
  const params = request.nextUrl.searchParams;
  const redirect = (path: string) => {
    const response = NextResponse.redirect(new URL(path, appBaseUrl()), 303);
    clearHandshakeCookie(response);
    return response;
  };
  const user = await currentUser();
  if (!user) return redirect(`/login?returnTo=${encodeURIComponent(CONNECTIONS_PATH)}`);
  if (params.get('error')) return redirect(connectReturnPath(CONNECTIONS_PATH, params.get('error') === 'access_denied' ? 'canceled' : 'failed'));
  try {
    const result = await completeGithubConnect({
      userId: user.id,
      code: params.get('code'),
      state: params.get('state'),
      sealedHandshake: request.cookies.get(HANDSHAKE_COOKIE)?.value,
      redirectUri: `${appBaseUrl()}/api/auth/github/callback/connect`,
    });
    return redirect(connectReturnPath(result.returnTo, 'connected'));
  } catch (error) {
    console.warn(`github connect failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return redirect(connectReturnPath(CONNECTIONS_PATH, 'failed'));
  }
}
