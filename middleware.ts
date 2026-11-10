import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE, PATH_HEADER, SESSION_COOKIE } from '@/lib/http/cookies';
import { adminLoginHref } from '@/lib/http/admin-next';
import { contentSecurityPolicy, createNonce, policyHeaderName } from '@/lib/http/csp';

/**
 * Two jobs, on every page request:
 *
 * 1. The Content-Security-Policy (lib/http/csp.ts) with a fresh nonce. It is
 *    set on the request too, which is where Next finds the nonce to stamp on
 *    its own script tags, and on the response, which is what the browser
 *    enforces. Every page is already rendered per request (the root layout
 *    reads the session and language cookies), so a per-request nonce costs
 *    no static rendering or CDN caching that existed before.
 *
 * 2. A cheap gate that saves anonymous visitors a render: no cookie, no page.
 *    The real check -- session row live, account not disabled -- happens in
 *    the layouts against the database; a cookie alone never decides
 *    permission. User and console sessions never cross. Redirects carry no
 *    document, so they need no policy.
 */
const WORKSPACE = ['/dashboard', '/rees', '/settings', '/talk', '/chats', '/workspace', '/videos'];

export function middleware(request: NextRequest): NextResponse {
  const path = request.nextUrl.pathname;
  const headers = new Headers(request.headers);
  if ((path === '/admin' || path.startsWith('/admin/')) && path !== '/admin/login') {
    // A signed-out deep link signs in first, then comes back (`next`).
    if (!request.cookies.has(ADMIN_SESSION_COOKIE)) return NextResponse.redirect(new URL(adminLoginHref(path + request.nextUrl.search), request.url));
    headers.set(PATH_HEADER, path + request.nextUrl.search);
  } else if (WORKSPACE.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    if (!request.cookies.has(SESSION_COOKIE)) {
      const login = new URL('/login', request.url);
      login.searchParams.set('returnTo', path + request.nextUrl.search);
      return NextResponse.redirect(login);
    }
    headers.set(PATH_HEADER, path + request.nextUrl.search);
  }
  const policy = contentSecurityPolicy({ nonce: createNonce(), dev: process.env.NODE_ENV === 'development', paddleSandbox: process.env.PADDLE_ENVIRONMENT === 'sandbox' });
  const name = policyHeaderName();
  /* Drop whatever a client sent under either name: Next reads the nonce from the first it finds. */
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.set(name, policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(name, policy);
  return response;
}

/*
 * Every page. Not API routes, Next's static and image files, `/media` blobs
 * or files under public/ (none of them is a document; next.config.mjs gives
 * them a policy that allows nothing).
 */
export const config = {
  matcher: ['/((?!api/|_next/static/|_next/image|media/|video/|favicon.ico).*)'],
};
