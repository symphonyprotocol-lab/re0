/**
 * The v5 frame's routes: `/` keeps the front page's metadata and canonical,
 * `/about` carries the old home with its own canonical and is in the
 * sitemap list, and old addresses (`/chats`, `/settings?tab=notices`) go
 * to their new places with their parameters; the new signed-in pages are
 * private (sign-in, robots).
 */
import { describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
vi.mock('@/lib/http/session', () => ({ currentUser: async () => ({ id: 'user-1' }) }));
vi.mock('@/i18n/server', async () => {
  const { messages } = await import('@/i18n');
const { DEFAULT_RETURN_TO, safeReturnTo } = await import('@/lib/domain/auth');
  return { serverMessages: async () => ({ t: messages('zh'), locale: 'zh' }) };
});

const home = await import('@/app/(product)/page');
const about = await import('@/app/(site)/about/page');
const chats = await import('@/app/(product)/(workspace)/chats/page');
const settings = await import('@/app/(product)/(workspace)/settings/page');
const { PUBLIC_PAGES } = await import('@/i18n/paths');
const { CRAWL_DISALLOWED, WORKSPACE_PATHS } = await import('@/lib/http/private-paths');
const { messages } = await import('@/i18n');
const { DEFAULT_RETURN_TO, safeReturnTo } = await import('@/lib/domain/auth');

describe('the front page and 了解 RE0', () => {
  it('keeps / as the front page: its title, description and canonical', async () => {
    const meta = await home.generateMetadata();
    const t = messages('zh');
    expect(meta.title).toEqual({ absolute: `${t.site.home.title} · RE0` });
    expect(meta.description).toBe(t.site.seo.description);
    expect(String(meta.alternates?.canonical)).toMatch(/\/zh$/);
  });

  it('gives /about its own canonical and title, and lists it for the sitemap', async () => {
    const meta = await about.generateMetadata();
    expect(String(meta.alternates?.canonical)).toMatch(/\/zh\/about$/);
    expect(JSON.stringify(meta.title)).toContain(messages('zh').site.visitor.aboutTitle);
    expect(PUBLIC_PAGES.map((page) => page.path)).toContain('/about');
  });
});

describe('old addresses', () => {
  it('sends /chats to 我的帖子 with its search, tab and selection', async () => {
    await expect(chats.default({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT /me/posts');
    await expect(chats.default({ searchParams: Promise.resolve({ view: 'trash', q: 'tax' }) })).rejects.toThrow('NEXT_REDIRECT /me/posts?view=trash&q=tax');
    await expect(chats.default({ searchParams: Promise.resolve({ select: 'abc', focus: '1' }) })).rejects.toThrow('NEXT_REDIRECT /me/posts?select=abc&focus=1');
  });

  it('sends the old notices tab to /notifications, keeping its page', async () => {
    await expect(settings.default({ searchParams: Promise.resolve({ tab: 'notices' }) })).rejects.toThrow('NEXT_REDIRECT /notifications');
    await expect(settings.default({ searchParams: Promise.resolve({ tab: 'notices', page: '3' }) })).rejects.toThrow('NEXT_REDIRECT /notifications?page=3');
  });

  it('keeps the new signed-in pages behind sign-in and out of robots', () => {
    for (const path of ['/me', '/notifications', '/saved']) expect(WORKSPACE_PATHS).toContain(path);
    for (const path of ['/me/', '/notifications', '/saved']) expect(CRAWL_DISALLOWED).toContain(path);
    /* robots.txt matches by prefix: nothing may hide the Ree images under /media. */
    expect(CRAWL_DISALLOWED.some((path) => '/media/avatars/x.webp'.startsWith(path))).toBe(false);
  });
});

describe('coming back after sign-in', () => {
  it('returns to the new pages, the share page and their language URLs', () => {
    for (const path of ['/me/posts?view=trash', '/me/posts?select=abc&focus=1', '/notifications?page=2', '/saved', '/about', '/en/about', '/s/some-ree', '/']) {
      expect(safeReturnTo(path)).toBe(path);
    }
    /* Prefixes match whole segments: /media is not /me, /saver not /saved. */
    for (const path of ['/media/x', '/saver', '/aboutx', '//evil.example']) expect(safeReturnTo(path)).toBe(DEFAULT_RETURN_TO);
  });
});
