/**
 * Review round 2 on public posts, the parts that are plain logic: leaving
 * the composer window for the new post (B1), keeping the page's parameters
 * when it opens (S7), the report key's IPv6 /48 (F1), the seed script's
 * refusal of remote databases (S6) and when a summary goes stale (S1).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({}), useSearchParams: () => new URLSearchParams() }));

const { composerExit, composeHref } = await import('@/components/posts/composer');
const { ipBucket, reportBucket } = await import('@/lib/domain/anonymous-chat');
const { seedTargetCheck } = await import('@/lib/services/seed-posts-guard');
const { summaryStale } = await import('@/lib/services/posts');

describe('leaving the composer window (B1)', () => {
  it('navigates to the post and swallows the close that follows, so nothing navigates back', () => {
    const calls: string[] = [];
    const exit = composerExit();
    exit.leave(() => calls.push('push /p/1'));
    /* The new address closes the <dialog>; its close event arrives a task later. */
    exit.closed(() => calls.push('replace current page'));
    expect(calls).toEqual(['push /p/1']);
    /* The next time the window is simply closed, the parameter goes as before. */
    exit.closed(() => calls.push('replace current page'));
    expect(calls).toEqual(['push /p/1', 'replace current page']);
  });
});

describe('the 发帖 link (S7)', () => {
  it('keeps every parameter the page has and adds the composer', () => {
    expect(composeHref('/explore', 'tab=posts&q=brazil')).toBe('/explore?tab=posts&q=brazil&compose=public');
    expect(composeHref('/me/posts', new URLSearchParams('tab=all'))).toBe('/me/posts?tab=all&compose=public');
    expect(composeHref('/r/x', 'from=%2F', { ree: 'r1', name: 'A B' })).toBe('/r/x?from=%2F&compose=public&ree=r1&name=A+B');
    expect(composeHref('/', '')).toBe('/?compose=public');
  });
});

describe('a visitor\'s report key (F1)', () => {
  it('counts IPv6 by /48 for reports and leaves the anonymous rounds at /64', () => {
    expect(reportBucket('2001:db8:1:2::1')).toBe(reportBucket('2001:db8:1:ff00::9'));
    expect(reportBucket('2001:db8:1:2::1')).not.toBe(reportBucket('2001:db8:2:2::1'));
    expect(reportBucket('2001:db8:1:2::1')).toBe('2001:db8:1::/48');
    expect(reportBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:ff00::9'));
  });
});

describe('the seed script\'s target (S6)', () => {
  it('takes a database on this machine and refuses anything else unless told it is production', () => {
    expect(seedTargetCheck('postgres://postgres:pw@127.0.0.1:5465/re0', false)).toBeNull();
    expect(seedTargetCheck('postgres://u:p@localhost/re0', false)).toBeNull();
    expect(seedTargetCheck('postgres://u:p@ep-cool-123.ap-southeast-1.aws.neon.tech/neondb', false)).toMatch(/Refusing ep-cool-123/);
    expect(seedTargetCheck('postgres://u:p@ep-cool-123.ap-southeast-1.aws.neon.tech/neondb', true)).toBeNull();
    expect(seedTargetCheck('not a url', true)).toMatch(/not a URL/);
  });

  it('reads no env file', async () => {
    const { readFileSync } = await import('node:fs');
    const script = readFileSync('scripts/seed-posts.mts', 'utf8');
    expect(script).not.toMatch(/loadEnvConfig|@next\/env|dotenv/);
  });
});

describe('a stale summary (S1)', () => {
  it('stands while every answer it drew on is shown', () => {
    expect(summaryStale(['a', 'b'], new Set(['a', 'b', 'c']))).toBe(false);
    expect(summaryStale(['a', 'b'], new Set(['a']))).toBe(true);
    expect(summaryStale(null, new Set())).toBe(false);
  });
});
