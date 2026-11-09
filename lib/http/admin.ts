/**
 * The console's session, separate from users': its own cookie and table, so
 * a product session never opens `/admin` (rebuild-proposal.md 2.5).
 */
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE, PATH_HEADER, cookieOptions } from '@/lib/http/cookies';
import { adminLoginHref } from '@/lib/http/admin-next';
import { fail } from '@/lib/http/respond';
import { sameOrigin } from '@/lib/http/session';
import { resolveAdminSession, type Administrator } from '@/lib/services/admin';

export const currentAdministrator = cache(async (): Promise<Administrator | null> => {
  const jar = await cookies();
  return resolveAdminSession(jar.get(ADMIN_SESSION_COOKIE)?.value);
});

export async function requireAdministrator(): Promise<Administrator> {
  const administrator = await currentAdministrator();
  if (administrator) return administrator;
  // The middleware passes the requested page, so an expired session returns there after sign-in.
  redirect(adminLoginHref((await headers()).get(PATH_HEADER) ?? ''));
}

export async function apiAdministrator(request: Request): Promise<Administrator | NextResponse> {
  if (request.method !== 'GET' && !sameOrigin(request.headers)) return fail('cross_origin', 403);
  return (await currentAdministrator()) ?? fail('unauthorized', 401);
}

export function setAdminCookie(response: NextResponse, token: string, expiresAt: Date): void {
  response.cookies.set(ADMIN_SESSION_COOKIE, token, cookieOptions(expiresAt));
}

export function clearAdminCookie(response: NextResponse): void {
  response.cookies.set(ADMIN_SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
}
