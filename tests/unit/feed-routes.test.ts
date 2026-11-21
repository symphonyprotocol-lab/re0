/**
 * The v5 frame's routes: `/` keeps the front page's metadata and canonical,
 * `/about` carries the old home with its own canonical and is in the
 * sitemap list, and old addresses (`/chats`, `/talk`, `/settings?tab=notices`) go
 * to their new places; the new signed-in pages are
 * private (sign-in, robots).
 */
import { describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url), permanentRedirect: (url: string) => redirect(url) }));
vi.mock('@/lib/http/session', () => ({ currentUser: async () => ({ id: 'user-1' }) }));
vi.mock('@/i18n/server', async () => {
  const { messages } = await import('@/i18n');
const { DEFAULT_RETURN_TO, safeReturnTo } = await import('@/lib/domain/auth');
  return { serverMessages: async () => ({ t: messages('zh'), locale: 'zh' }) };
});

const home = await import('@/app/(product)/page');
const rees = await import('@/app/(product)/(discover)/explore/page');
const about = await import('@/app/(product)/(site)/about/page');
const chats = await import('@/app/(product)/(workspace)/chats/page');
const chat = await import('@/app/(product)/(workspace)/chats/[id]/page');
const talk = await import('@/app/(product)/(workspace)/talk/page');
const settings = await import('@/app/(product)/(workspace)/settings/page');
const { PUBLIC_PAGES } = await import('@/i18n/paths');
const { CRAWL_DISALLOWED, WORKSPACE_PATHS } = await import('@/lib/http/private-paths');
const { messages } = await import('@/i18n');
const { DEFAULT_RETURN_TO, safeReturnTo } = await import('@/lib/domain/auth');

describe('the front page and 了解 RE0', () => {
  it('keeps / as the front page: its title, description and canonical', async () => {
    const meta = await home.generateMetadata({ searchParams: Promise.resolve({}) });
    const t = messages('zh');
    expect(meta.title).toEqual({ absolute: `${t.site.home.title} · RE0` });
    expect(meta.description).toBe(t.site.seo.description);
    expect(String(meta.alternates?.canonical)).toMatch(/\/zh$/);
    expect(meta.robots).toBeUndefined();
  });

  it('keeps a post search on / out of search results, under the front page\'s canonical (v6)', async () => {
    const meta = await home.generateMetadata({ searchParams: Promise.resolve({ q: 'refund' }) });
    expect(String(meta.alternates?.canonical)).toMatch(/\/zh$/);
    expect(meta.robots).toMatchObject({ index: false });
  });

  it('names /explore Rees, with its own canonical; a search there is not indexed (v6)', async () => {
    const t = messages('zh');
    expect(t.common.nav.discover).toBe('Rees');
    expect(messages('en').common.nav.discover).toBe('Rees');
    const meta = await rees.generateMetadata({ searchParams: Promise.resolve({}) });
    expect(JSON.stringify(meta.title)).toContain('Rees');
    expect(String(meta.alternates?.canonical)).toMatch(/\/zh\/explore$/);
    expect(meta.robots).toBeUndefined();
    expect((await rees.generateMetadata({ searchParams: Promise.resolve({ q: 'tax' }) })).robots).toMatchObject({ index: false });
  });

  it('gives /about its own canonical and title, and lists it for the sitemap', async () => {
    const meta = await about.generateMetadata();
    expect(String(meta.alternates?.canonical)).toMatch(/\/zh\/about$/);
    expect(JSON.stringify(meta.title)).toContain(messages('zh').site.visitor.aboutTitle);
    expect(PUBLIC_PAGES.map((page) => page.path)).toContain('/about');
  });
});

describe('old addresses', () => {
  it('sends the retired chat pages to 私密: /chats and /chats/[id] to 我的帖子, /talk to the composer', () => {
    expect(() => chats.default()).toThrow('NEXT_REDIRECT /me/posts?tab=private');
    expect(() => chat.default()).toThrow('NEXT_REDIRECT /me/posts?tab=private');
    expect(() => talk.default()).toThrow('NEXT_REDIRECT /?compose=private');
  });

  it('sends Rees\' old 帖子 and 待回答 tabs to 首页 for good (v6)', async () => {
    await expect(rees.default({ searchParams: Promise.resolve({ tab: 'posts' }) })).rejects.toThrow('NEXT_REDIRECT /');
    await expect(rees.default({ searchParams: Promise.resolve({ tab: 'posts', q: 'tax refund' }) })).rejects.toThrow('NEXT_REDIRECT /?q=tax%20refund');
    await expect(rees.default({ searchParams: Promise.resolve({ tab: 'unanswered' }) })).rejects.toThrow('NEXT_REDIRECT /?tab=unanswered');
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
