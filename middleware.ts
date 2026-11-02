import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE, SESSION_COOKIE } from '@/lib/http/cookies';

/**
 * A cheap gate that saves anonymous visitors a render: no cookie, no page.
 * The real check -- session row live, account not disabled -- happens in the
 * layouts against the database; a cookie alone never decides permission.
 * User and console sessions never cross.
 */
const WORKSPACE = ['/dashboard', '/rees', '/settings'];

export function middleware(request: NextRequest): NextResponse {
  const path = request.nextUrl.pathname;
  if (path.startsWith('/admin')) {
    if (path === '/admin/login' || request.cookies.has(ADMIN_SESSION_COOKIE)) return NextResponse.next();
    return NextResponse.redirect(new URL('/admin/login', request.url));
  }
  if (WORKSPACE.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) && !request.cookies.has(SESSION_COOKIE)) {
    const login = new URL('/login', request.url);
    login.searchParams.set('returnTo', path + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/rees/:path*', '/settings/:path*', '/admin/:path*'],
};
