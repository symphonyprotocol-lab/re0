import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE, PATH_HEADER, SESSION_COOKIE } from '@/lib/http/cookies';
import { adminLoginHref } from '@/lib/http/admin-next';

/**
 * A cheap gate that saves anonymous visitors a render: no cookie, no page.
 * The real check -- session row live, account not disabled -- happens in the
 * layouts against the database; a cookie alone never decides permission.
 * User and console sessions never cross.
 */
const WORKSPACE = ['/dashboard', '/rees', '/settings', '/talk', '/chats', '/workspace', '/videos'];

export function middleware(request: NextRequest): NextResponse {
  const path = request.nextUrl.pathname;
  if (path.startsWith('/admin')) {
    if (path === '/admin/login') return NextResponse.next();
    // A signed-out deep link signs in first, then comes back (`next`).
    if (!request.cookies.has(ADMIN_SESSION_COOKIE)) return NextResponse.redirect(new URL(adminLoginHref(path + request.nextUrl.search), request.url));
    const headers = new Headers(request.headers);
    headers.set(PATH_HEADER, path + request.nextUrl.search);
    return NextResponse.next({ request: { headers } });
  }
  if (WORKSPACE.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    if (!request.cookies.has(SESSION_COOKIE)) {
      const login = new URL('/login', request.url);
      login.searchParams.set('returnTo', path + request.nextUrl.search);
      return NextResponse.redirect(login);
    }
    const headers = new Headers(request.headers);
    headers.set(PATH_HEADER, path + request.nextUrl.search);
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/rees/:path*', '/settings/:path*', '/talk', '/chats/:path*', '/workspace/:path*', '/admin/:path*', '/videos'],
};
