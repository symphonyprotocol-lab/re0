import { NextResponse, type NextRequest } from 'next/server';
import { AuthFailure, isIdentityProvider } from '@/lib/domain/auth';
import { appBaseUrl, HANDSHAKE_COOKIE } from '@/lib/http/cookies';
import { localeFromRequest } from '@/i18n/locale';
import { callbackUrl, clearHandshakeCookie, setSessionCookie } from '@/lib/http/session';
import { completeOAuth } from '@/lib/services/auth';

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  const params = request.nextUrl.searchParams;
  const back = (error: string) => {
    const response = NextResponse.redirect(new URL(`/login?error=${error}`, appBaseUrl()), 303);
    clearHandshakeCookie(response);
    return response;
  };
  if (!isIdentityProvider(provider)) return back('oauth_failed');
  /* The user pressed "cancel" on the provider's consent screen. */
  if (params.get('error')) return back(params.get('error') === 'access_denied' ? 'oauth_canceled' : 'oauth_failed');

  try {
    const result = await completeOAuth({
      provider,
      code: params.get('code'),
      state: params.get('state'),
      sealedHandshake: request.cookies.get(HANDSHAKE_COOKIE)?.value,
      redirectUri: callbackUrl(provider),
      lang: localeFromRequest(request.cookies.get.bind(request.cookies), request.headers.get('accept-language')),
    });
    const response = NextResponse.redirect(new URL(result.returnTo, appBaseUrl()), 303);
    setSessionCookie(response, result.sessionToken, result.expiresAt);
    clearHandshakeCookie(response);
    return response;
  } catch (error) {
    const failure = error instanceof AuthFailure ? error : new AuthFailure('oauth_failed', 'unexpected failure');
    console.warn(`auth ${provider} failed code=${failure.loginError} detail=${error instanceof Error ? error.message : 'unknown'}`);
    return back(failure.loginError);
  }
}
