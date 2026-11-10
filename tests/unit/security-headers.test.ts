import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextConfig } from 'next';
import { NextRequest } from 'next/server';
import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header';
import { middleware } from '@/middleware';
import { contentSecurityPolicy } from '@/lib/http/csp';
import { PATH_HEADER, SESSION_COOKIE } from '@/lib/http/cookies';

async function nextConfig(): Promise<NextConfig> {
  vi.resetModules();
  // @ts-expect-error -- next.config.mjs is plain JavaScript without a declaration file.
  return (await import('@/next.config.mjs')).default as NextConfig;
}

async function configHeaders(source: string): Promise<Record<string, string>> {
  const rules = await (await nextConfig()).headers!();
  const rule = rules.find((candidate) => candidate.source === source);
  return Object.fromEntries((rule?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]));
}

function page(path: string, cookies: Record<string, string> = {}) {
  const request = new NextRequest(`https://re0.test${path}`, { headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
  return middleware(request);
}

/** The value the page's request carries on to rendering (NextResponse.next({ request: { headers } })). */
function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

function directives(policy: string): Map<string, string[]> {
  return new Map(policy.split(';').map((part) => part.trim().split(/\s+/)).filter((words) => words[0]).map(([name, ...values]) => [name!, values]));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('security response headers', () => {
  it('sends the hardening headers on every route', async () => {
    const headers = await configHeaders('/:path*');
    expect(headers['strict-transport-security']).toMatch(/max-age=\d{8,}/);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['permissions-policy']).toContain('camera=()');
    /* Pages get their policy from middleware; a second, nonce-less one here would block every script. */
    expect(headers).not.toHaveProperty('content-security-policy');
    expect(headers).not.toHaveProperty('content-security-policy-report-only');
  });

  it('enforces the full policy on every page with a fresh nonce, no inline scripts', async () => {
    const first = page('/');
    const second = page('/pricing');
    const policy = first.headers.get('content-security-policy')!;
    expect(policy).toBeTruthy();
    expect(first.headers.get('content-security-policy-report-only')).toBeNull();
    const nonce = getScriptNonceFromHeader(policy)!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(getScriptNonceFromHeader(second.headers.get('content-security-policy')!)).not.toBe(nonce);
    /* Next stamps its script tags with the nonce it finds in the request's header: the same policy, same nonce. */
    expect(forwarded(first, 'content-security-policy')).toBe(policy);

    const parsed = directives(policy);
    expect(parsed.get('script-src')).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", 'https://cdn.paddle.com']);
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(parsed.get('default-src')).toEqual(["'self'"]);
    expect(parsed.get('frame-src')).toEqual(['https://*.paddle.com']);
    expect(parsed.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(parsed.get('connect-src')).toEqual(["'self'", 'https://vercel.com', 'https://*.blob.vercel-storage.com', 'https://*.paddle.com']);
    expect(parsed.get('frame-ancestors')).toEqual(["'none'"]);
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('base-uri')).toEqual(["'self'"]);
    expect(parsed.has('upgrade-insecure-requests')).toBe(true);
    /* No wildcard scheme sources anywhere ("https:" alone would allow any host). */
    for (const values of parsed.values()) expect(values).not.toContain('https:');
  });

  it('ignores a policy the client sent, and still gates the workspace and console by cookie', async () => {
    const request = new NextRequest('https://re0.test/', { headers: { 'content-security-policy-report-only': "script-src 'nonce-attacker'" } });
    const response = middleware(request);
    expect(forwarded(response, 'content-security-policy-report-only')).toBeNull();
    expect(getScriptNonceFromHeader(forwarded(response, 'content-security-policy')!)).not.toBe('attacker');

    expect(page('/dashboard').headers.get('location')).toBe('https://re0.test/login?returnTo=%2Fdashboard');
    expect(page('/admin/users').headers.get('location')).toMatch(/^https:\/\/re0\.test\/admin\/login/);
    const signedIn = page('/dashboard', { [SESSION_COOKIE]: 'x' });
    expect(signedIn.headers.get('location')).toBeNull();
    expect(signedIn.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(forwarded(signedIn, PATH_HEADER.toLowerCase())).toBe('/dashboard');
  });

  it('gives what is never a document a policy that allows nothing', async () => {
    for (const source of ['/api/:path*', '/media/:path*', '/_next/static/:path*']) {
      expect((await configHeaders(source))['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    }
  });

  it('has a kill switch: CSP_REPORT_ONLY=1 sends the same policy as Report-Only', async () => {
    vi.stubEnv('CSP_REPORT_ONLY', '1');
    const response = page('/');
    expect(response.headers.get('content-security-policy')).toBeNull();
    const reported = response.headers.get('content-security-policy-report-only')!;
    const nonce = getScriptNonceFromHeader(reported)!;
    expect(reported).toBe(contentSecurityPolicy({ nonce }));
    /* Next still finds the nonce, so pages render the same either way. */
    expect(forwarded(response, 'content-security-policy-report-only')).toBe(reported);
    const api = await configHeaders('/api/:path*');
    expect(api['content-security-policy-report-only']).toContain("default-src 'none'");
    expect(api).not.toHaveProperty('content-security-policy');
  });

  it('takes the Paddle stylesheet from the CDN of the configured environment only', () => {
    vi.stubEnv('PADDLE_ENVIRONMENT', 'sandbox');
    expect(directives(page('/checkout').headers.get('content-security-policy')!).get('style-src')).toEqual(["'self'", "'unsafe-inline'", 'https://sandbox-cdn.paddle.com']);
    vi.stubEnv('PADDLE_ENVIRONMENT', 'production');
    expect(directives(page('/checkout').headers.get('content-security-policy')!).get('style-src')).toEqual(["'self'", "'unsafe-inline'", 'https://cdn.paddle.com']);
  });

  it('allows eval and the dev server socket in development only', () => {
    expect(contentSecurityPolicy({ nonce: 'n', dev: true })).toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(contentSecurityPolicy({ nonce: 'n', dev: true })).toMatch(/connect-src[^;]* ws:/);
    expect(contentSecurityPolicy({ nonce: 'n', dev: true })).not.toContain('upgrade-insecure-requests');
  });
});

describe('zod under the enforced policy', () => {
  it('skips its eval probe in the browser, so pages log no refused eval', async () => {
    const { config } = await import('zod');
    const before = config().jitless;
    vi.resetModules();
    vi.stubGlobal('window', {});
    try {
      await import('@/lib/client/zod-jitless');
      expect(config().jitless).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      config({ jitless: before });
    }
  });
});
