import { NextResponse, type NextRequest } from 'next/server';
import { isIdentityProvider } from '@/lib/domain/auth';
import { appBaseUrl } from '@/lib/http/cookies';
import { callbackUrl, sameOrigin, setHandshakeCookie } from '@/lib/http/session';
import { beginOAuth } from '@/lib/services/auth';

/** The login page's provider buttons post here; we answer with the provider's consent screen. */
export async function POST(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  const back = (error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, appBaseUrl()), 303);
  if (!isIdentityProvider(provider)) return back('oauth_failed');
  if (!sameOrigin(request.headers)) return new NextResponse('cross-origin request refused', { status: 403 });
  const form = await request.formData().catch(() => null);
  try {
    const started = await beginOAuth({
      provider,
      returnTo: form?.get('returnTo') ?? undefined,
      redirectUri: callbackUrl(provider),
    });
    const response = NextResponse.redirect(started.redirectUrl, 303);
    setHandshakeCookie(response, started.handshake, started.expiresAt);
    return response;
  } catch (error) {
    console.warn(`auth ${provider} start failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return back('oauth_failed');
  }
}
