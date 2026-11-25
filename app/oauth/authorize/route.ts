import { NextResponse, type NextRequest } from 'next/server';
import { OAUTH_LIMITS } from '@/lib/constants';
import { clientIp } from '@/lib/http/client-ip';
import { consentCookieName, consentCookieOptions } from '@/lib/http/oauth';
import { startAuthorization } from '@/lib/services/oauth';
import { hitRateBucket } from '@/lib/services/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The authorization endpoint. A request whose client or redirect URI does
 * not check out stays on re0 (`/oauth/error`), so this is never an open
 * redirect; one with other faults goes back to the client's registered
 * redirect URI with the error. A good one is stored and the browser moves
 * to the consent page, which signs the user in first if needed; a cookie
 * scoped to that page binds the request to this browser. Limited per
 * address, since anyone can start one.
 */
export async function GET(request: NextRequest): Promise<Response> {
  /* Each request may store a row and fetch a client's metadata document: limited per address. */
  if (!(await hitRateBucket(`oauth:authorize:${clientIp(request.headers) ?? 'unknown'}`, OAUTH_LIMITS.authorizationsPerHour, 3_600))) {
    return new Response('Too many authorization requests from this address; try again later.', { status: 429, headers: { 'retry-after': '3600', 'content-type': 'text/plain; charset=utf-8' } });
  }
  const outcome = await startAuthorization(request.nextUrl.searchParams);
  if (outcome.kind === 'error_page') return NextResponse.redirect(new URL(`/oauth/error?reason=${outcome.error}`, request.url), 303);
  if (outcome.kind === 'redirect') return new Response(null, { status: 303, headers: { location: outcome.url, 'cache-control': 'no-store' } });
  const response = NextResponse.redirect(new URL(`/oauth/consent/${outcome.id}`, request.url), 303);
  response.cookies.set(consentCookieName(), outcome.browserSecret, consentCookieOptions(outcome.id, OAUTH_LIMITS.requestMinutes * 60));
  response.headers.set('cache-control', 'no-store');
  return response;
}
