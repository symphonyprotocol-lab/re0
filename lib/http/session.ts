/**
 * The signed-in user, for pages and for API routes. The row is the only
 * authority: a cookie whose session row is gone or expired is nobody.
 */
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { NextResponse } from 'next/server';
import { resolveSession, type SessionUser } from '@/lib/services/auth';
import { appBaseUrl, cookieOptions, HANDSHAKE_COOKIE, SESSION_COOKIE } from '@/lib/http/cookies';
import { fail } from '@/lib/http/respond';

export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
});

/** Pages: the user, or a redirect to sign-in that comes back here. */
export async function requireUser(returnTo: string): Promise<SessionUser> {
  const user = await currentUser();
  if (user) return user;
  redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

/**
 * API routes: the user, or a 401 response. Writes also require the request
 * to come from our own origin (the session cookie is `SameSite=Lax`, which
 * does not stop a same-site form POST from a sibling subdomain).
 */
export async function apiUser(request: Request): Promise<SessionUser | NextResponse> {
  if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request.headers)) {
    return fail('cross_origin', 403);
  }
  const user = await currentUser();
  return user ?? fail('unauthorized', 401);
}

export function sameOrigin(headerBag: Headers): boolean {
  const origin = headerBag.get('origin');
  const allowed = new URL(appBaseUrl()).origin;
  if (origin) return origin === allowed || origin === requestOrigin(headerBag);
  const referer = headerBag.get('referer');
  if (!referer) return false;
  try {
    const from = new URL(referer).origin;
    return from === allowed || from === requestOrigin(headerBag);
  } catch {
    return false;
  }
}

/** The origin the request was actually sent to, so preview URLs other than APP_BASE_URL work. */
function requestOrigin(headerBag: Headers): string | null {
  const host = headerBag.get('x-forwarded-host') ?? headerBag.get('host');
  if (!host) return null;
  const proto = headerBag.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function isSameOriginRequest(): Promise<boolean> {
  return sameOrigin(await headers());
}

export function callbackUrl(provider: string): string {
  return `${appBaseUrl()}/api/auth/${provider}/callback`;
}

export function setSessionCookie(response: NextResponse, token: string, expiresAt: Date): void {
  response.cookies.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
}

export function setHandshakeCookie(response: NextResponse, value: string, expiresAt: number): void {
  response.cookies.set(HANDSHAKE_COOKIE, value, cookieOptions(new Date(expiresAt)));
}

export function clearHandshakeCookie(response: NextResponse): void {
  response.cookies.set(HANDSHAKE_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
}
