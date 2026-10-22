import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueShowcaseUnlock, showcaseCookieName, showcaseGateFor, showcaseUnlocked } from '@/lib/http/showcase-gate';

/**
 * The unlock cookie of a link-only page (lib/http/showcase-gate.ts): a
 * signed statement of page, password version and expiry.
 */
const SECRET = 'a-signing-secret-of-at-least-thirty-two-characters';
const PAGE = '0199b7c0-0000-7000-8000-000000000001';

describe('showcase unlock cookie', () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.SESSION_SIGNING_SECRET;
    process.env.SESSION_SIGNING_SECRET = SECRET;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SESSION_SIGNING_SECRET;
    else process.env.SESSION_SIGNING_SECRET = previous;
  });

  it('is named after the page and opens it at the version it was issued for, until it expires', async () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const cookie = await issueShowcaseUnlock(PAGE, 2, now);
    expect(cookie.name).toBe(showcaseCookieName(PAGE));
    expect(await showcaseUnlocked(cookie.value, PAGE, 2, now + 1_000)).toBe(true);
    expect(await showcaseUnlocked(cookie.value, PAGE, 3, now + 1_000)).toBe(false);
    expect(await showcaseUnlocked(cookie.value, '0199b7c0-0000-7000-8000-000000000002', 2, now + 1_000)).toBe(false);
    expect(await showcaseUnlocked(cookie.value, PAGE, 2, cookie.expires.getTime() + 1)).toBe(false);
  });

  it('refuses a cookie that was tampered with or made up', async () => {
    const cookie = await issueShowcaseUnlock(PAGE, 1);
    const [version, exp, sig] = cookie.value.split('.');
    expect(await showcaseUnlocked(`${version}.${Number(exp) + 999_999}.${sig}`, PAGE, 1)).toBe(false);
    expect(await showcaseUnlocked(`${version}.${exp}.${'0'.repeat(sig!.length)}`, PAGE, 1)).toBe(false);
    expect(await showcaseUnlocked('nonsense', PAGE, 1)).toBe(false);
    expect(await showcaseUnlocked(undefined, PAGE, 1)).toBe(false);
  });

  it('decides the gate from the page and the jar', async () => {
    const cookie = await issueShowcaseUnlock(PAGE, 1);
    const jar = (value?: string) => ({ get: () => (value ? { value } : undefined) });
    const gate = { showcaseId: PAGE, hasPassword: true, passwordVersion: 1, expiresAt: null };
    expect(await showcaseGateFor(jar(), gate)).toBe('locked');
    expect(await showcaseGateFor(jar(cookie.value), gate)).toBe('open');
    expect(await showcaseGateFor(jar(cookie.value), { ...gate, passwordVersion: 2 })).toBe('locked');
    expect(await showcaseGateFor(jar(cookie.value), { ...gate, expiresAt: '2000-01-01T00:00:00Z' })).toBe('expired');
    expect(await showcaseGateFor(jar(), { ...gate, hasPassword: false })).toBe('open');
  });
});
