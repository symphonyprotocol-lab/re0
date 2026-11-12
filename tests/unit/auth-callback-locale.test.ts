import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/* The provider exchange and the session store are the integration suite's (tests/integration/account.test.ts); here only what the callback sends back. */
vi.mock('@/lib/services/auth', () => ({
  completeOAuth: vi.fn(async () => ({ sessionToken: 'token', expiresAt: new Date(Date.now() + 3_600_000), returnTo: '/en/r/x', userId: 'u', created: false, lang: 'en' })),
}));

const { GET } = await import('@/app/api/auth/[provider]/callback/route');

describe('sign-in callback', () => {
  it("makes the account's language this browser's cookie, whatever the browser asked for", async () => {
    const request = new NextRequest('https://re0.test/api/auth/github/callback?code=c&state=s', { headers: { cookie: 're0_lang=zh', 'accept-language': 'zh-CN' } });
    const response = await GET(request, { params: Promise.resolve({ provider: 'github' }) });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/\/en\/r\/x$/);
    const cookie = response.cookies.get('re0_lang');
    expect(cookie).toMatchObject({ value: 'en', path: '/', sameSite: 'lax' });
    expect(cookie?.httpOnly).toBeFalsy();
  });
});
