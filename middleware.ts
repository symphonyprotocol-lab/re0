import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_LIFETIME_MS } from '@/lib/domain/admin';
import { SESSION_LIFETIME_MS } from '@/lib/domain/auth';
import {
  ADMIN_SESSION_COOKIE_NAMES,
  isSecureDeployment,
  SESSION_COOKIE_NAMES,
} from '@/lib/http/cookie-names';
import { isOwnHostOf } from '@/lib/domain/showcase';
import { PUBLIC_ORIGIN } from '@/lib/site/origin';

/**
 * Cheap gate in front of the dashboard, and the browser half of the sliding
 * session everywhere else.
 *
 * The gate only looks for the presence of a session cookie: it saves anonymous
 * visitors a render, nothing more. The real check -- session live, account
 * active, workspace resolved -- happens in the dashboard layout against the
 * primary database, because permission state must not be decided on a cookie's
 * word (architecture.md 5.2, 16).
 *
 * The console gets the same treatment against its own cookie, and the two
 * never cross: a product session cookie is not an admin one, so it does not
 * open `/admin` even here (requirement.md 3.2). The real console check lives in
 * `app/admin/(console)/layout.tsx`. Capturing the path here is also what lets
 * the sign-in send an administrator back where they were headed.
 */

/**
 * Re-issues the session cookie with its window moved out again.
 *
 * The session row's expiry slides on use (lib/domain/auth.ts, admin.ts), and
 * the browser's copy has to slide with it or the cookie dies on the sign-in
 * date while the row is still live. Same value, same attributes, new
 * `Expires`; the row stays the only authority on whether the session is
 * alive -- a cookie that outlives its row simply resolves to nothing.
 * Set-Cookie on every matched request is the price of not needing a response
 * hook in every server component.
 */
function slideCookie(
  request: NextRequest,
  response: NextResponse,
  names: readonly string[],
  path: '/' | '/admin',
  lifetimeMs: number,
): NextResponse {
  for (const name of names) {
    const value = request.cookies.get(name)?.value;
    if (!value) continue;
    response.cookies.set(name, value, {
      httpOnly: true,
      secure: isSecureDeployment(),
      sameSite: 'lax',
      path,
      expires: new Date(Date.now() + lifetimeMs),
    });
  }
  return response;
}

/**
 * Hosts that are this deployment: the configured base URL, the public
 * origin, Vercel's own, and a laptop. Anything else that reaches us is a
 * customer's subdomain pointed at a showcase page (lib/application/
 * showcase/domain.ts), served by the by-host page; the mapping is read
 * there, not here, so the middleware never touches a database.
 */
function ownHostsOfDeployment(): string[] {
  const hosts = ['localhost', '127.0.0.1', 'vercel.app'];
  for (const origin of [process.env.APP_BASE_URL, PUBLIC_ORIGIN]) {
    if (!origin) continue;
    try {
      hosts.push(new URL(origin).hostname);
    } catch {
      /* not a URL */
    }
  }
  /* Vercel names the deployment's own addresses; an operator names any other alias (staging, a preview domain). */
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (host) hosts.push(host);
  }
  for (const host of (process.env.SHOWCASE_OWN_HOSTS ?? '').split(',')) {
    if (host.trim()) hosts.push(host.trim());
  }
  return hosts;
}

/** The request header the by-host page requires, so it cannot be opened by path on our own host. */
export const CUSTOM_HOST_HEADER = 'x-re0-custom-host';

/** What a custom host serves itself: the page, its own routes and assets; everything else is the page's 404. */
function stayOnCustomHost(path: string): boolean {
  return path.startsWith('/s/') || path.startsWith('/api/') || path.startsWith('/_next/') || path.startsWith('/vendor/') || path.startsWith('/.well-known/');
}

export function middleware(request: NextRequest): NextResponse {
  const path = request.nextUrl.pathname;

  const host = (request.headers.get('host') ?? '').toLowerCase();
  /* A host with no dot is a machine on a desk, never a customer's domain. */
  if (host && host.includes('.') && !isOwnHostOf(host, ownHostsOfDeployment()) && !stayOnCustomHost(path)) {
    const bare = host.replace(/:\d+$/, '');
    const target = request.nextUrl.clone();
    target.pathname = `/s/by-host/${bare}${path === '/' ? '' : path}`;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(CUSTOM_HOST_HEADER, bare);
    return NextResponse.rewrite(target, { request: { headers: requestHeaders } });
  }
  /* Query string included: `safeReturnTo` preserves it on the way back. */
  const returnTo = path + request.nextUrl.search;

  /*
   * Every page has a Markdown representation at the same URL plus `.md`.
   * Rewrite before the session gates so the renderer can fetch the canonical
   * page with this request's credentials and preserve its normal access rule.
   * `/.md` is the representation of the home page.
   */
  if (
    (path === '/.md' || path.endsWith('.md')) &&
    !path.startsWith('/.well-known/agent-skills/')
  ) {
    const sourcePath = path === '/.md' ? '/' : path.slice(0, -3) || '/';
    const markdown = request.nextUrl.clone();
    markdown.pathname = '/api/page-markdown';
    markdown.search = '';
    const source = `${sourcePath}${request.nextUrl.search}`;
    markdown.searchParams.set('source', source);

    /* A rewritten Route Handler can retain the original URL's searchParams
       even though `x-middleware-rewrite` contains the destination query.
       Carry the source explicitly in the rewritten request as well. */
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-re0-markdown-page', source);
    const rewritten = NextResponse.rewrite(markdown, {
      request: { headers: requestHeaders },
    });

    /* The canonical page fetch slides the database session. Slide the
       browser's cookie on the outer response as well, because Set-Cookie from
       that internal fetch is deliberately not proxied through the renderer. */
    if (
      sourcePath.startsWith('/admin') &&
      ADMIN_SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))
    ) {
      return slideCookie(
        request,
        rewritten,
        ADMIN_SESSION_COOKIE_NAMES,
        '/admin',
        ADMIN_SESSION_LIFETIME_MS,
      );
    }
    if (SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))) {
      return slideCookie(request, rewritten, SESSION_COOKIE_NAMES, '/', SESSION_LIFETIME_MS);
    }
    return rewritten;
  }

  if (path.startsWith('/admin')) {
    if (ADMIN_SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))) {
      return slideCookie(
        request,
        NextResponse.next(),
        ADMIN_SESSION_COOKIE_NAMES,
        '/admin',
        ADMIN_SESSION_LIFETIME_MS,
      );
    }
    const signIn = new URL('/admin/login', request.url);
    signIn.searchParams.set('returnTo', returnTo);
    return NextResponse.redirect(signIn);
  }

  const signedIn = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));
  if (signedIn) {
    return slideCookie(
      request,
      NextResponse.next(),
      SESSION_COOKIE_NAMES,
      '/',
      SESSION_LIFETIME_MS,
    );
  }

  /*
   * Only the dashboard is gated. Everywhere else an anonymous visitor is a
   * visitor, and the request is matched purely so a signed-in one gets the
   * cookie above: `resolveSession` slides the row on every page that renders
   * the site header, so a reader who lives in the playground kept a live
   * session while the browser dropped the cookie on the thirtieth day after
   * sign-in -- signed out precisely because they had never stopped reading.
   */
  if (!path.startsWith('/dashboard')) return NextResponse.next();

  const login = new URL('/login', request.url);
  login.searchParams.set('returnTo', returnTo);
  return NextResponse.redirect(login);
}

export const config = {
  /*
   * Every browser navigation, so the cookie slides wherever a session is
   * resolved rather than only where one is required.
   *
   * The exclusions: Next's own asset routes and the API, which carry no
   * browser session to slide; and three console paths, each anchored so the
   * exclusion cannot widen to a future `/admin/login-history` -- the sign-in,
   * which would otherwise redirect to itself; the sign-out, which has to
   * answer a POST rather than be bounced once the cookie is already gone, and
   * whose own response must be the one that clears the cookie; and enrolment,
   * which an invited administrator reaches before they have any session.
   */
  matcher: [
    '/((?!_next/|api/|mcp$|admin/login$|admin/login/|admin/sign-out$|admin/enroll$|favicon\\.ico$|icon\\.svg$|logo\\.png$).*)',
  ],
};
