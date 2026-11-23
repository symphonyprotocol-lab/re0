import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonLd } from '@/components/site/json-ld';
import { oneLine, publicPage, reeContentLocale, reeJsonLd, reePage, reeTitle } from '@/lib/seo';
import type { PublicRee } from '@/lib/services/public-rees';

beforeEach(() => vi.stubEnv('APP_BASE_URL', 'https://re0.io/'));
afterEach(() => vi.unstubAllEnvs());

describe('publicPage', () => {
  it('canonicalises on the page in its language, with hreflang alternates and the site image', () => {
    const meta = publicPage({ path: '/pricing', title: 'Pricing', description: 'd', locale: 'en' });
    expect(meta.alternates?.canonical).toBe('https://re0.io/en/pricing');
    /* x-default is the English page, never the plain path that redirects (GSC 2026-11, 问题 4). */
    expect(meta.alternates?.languages).toEqual({ zh: 'https://re0.io/zh/pricing', en: 'https://re0.io/en/pricing', 'x-default': 'https://re0.io/en/pricing' });
    expect(meta.openGraph).toMatchObject({ url: 'https://re0.io/en/pricing', locale: 'en_US', alternateLocale: ['zh_CN'], images: [{ url: '/og/site/en', alt: 'RE0 — Ask once. Many Rees answer.' }] });
    expect(publicPage({ path: '/pricing', title: 'Pricing', description: 'd', locale: 'zh' }).twitter).toMatchObject({ card: 'summary_large_image', images: [{ url: '/og/site/zh' }] });
    expect(publicPage({ path: '/', title: 'RE0', description: 'd', locale: 'zh' }).alternates?.canonical).toBe('https://re0.io/zh');
  });

  it('canonicalises a one-language page on that language from both URLs, with no other language listed', () => {
    for (const locale of ['zh', 'en'] as const) {
      const meta = publicPage({ path: '/r/x', title: 'X', description: 'd', locale, contentLocale: 'en' });
      expect(meta.alternates).toEqual({ canonical: 'https://re0.io/en/r/x' });
      expect(meta.openGraph).toMatchObject({ url: 'https://re0.io/en/r/x', locale: 'en_US', alternateLocale: [] });
    }
  });

  it('leaves the images key out for a route with its own opengraph-image file', () => {
    const meta = publicPage({ path: '/r/x', title: 'X', description: 'd', locale: 'zh', ownImage: true });
    expect(meta.openGraph && 'images' in meta.openGraph).toBe(false);
    expect(meta.twitter && 'images' in meta.twitter).toBe(false);
  });
});

describe('a public Ree', () => {
  const official = { slug: 'tokio', name: 'Tokio Docs', role: 'official' } as const;
  const someone = { slug: 'notes', name: '读书笔记', role: 'normal' } as const;

  it('is English when official (no content-language field yet), in both languages otherwise', () => {
    expect(reeContentLocale(official)).toBe('en');
    expect(reeContentLocale({ role: 'verified' })).toBeNull();
    expect(reeContentLocale(someone)).toBeNull();
  });

  it('is titled with its name and what the page is for, in the Ree\'s language', () => {
    expect(reeTitle(official, 'zh')).toBe('Tokio Docs — Ask questions, get cited answers');
    expect(reeTitle(official, 'en')).toBe('Tokio Docs — Ask questions, get cited answers');
    expect(reeTitle(someone, 'zh')).toBe('读书笔记 — 提问，获得带出处的回答');
    expect(reeTitle(someone, 'en')).toBe('读书笔记 — Ask questions, get cited answers');
  });

  it('is canonical on /en for an official Ree, from /zh too; anyone else\'s keeps both languages', () => {
    const zh = reePage(official, 'zh', 'About Tokio');
    expect(zh.alternates).toEqual({ canonical: 'https://re0.io/en/r/tokio' });
    expect(zh).toMatchObject({ title: 'Tokio Docs — Ask questions, get cited answers', description: 'About Tokio' });
    expect(zh.openGraph && 'images' in zh.openGraph).toBe(false);
    const theirs = reePage(someone, 'zh', 'd');
    expect(theirs.alternates).toEqual({
      canonical: 'https://re0.io/zh/r/notes',
      languages: { zh: 'https://re0.io/zh/r/notes', en: 'https://re0.io/en/r/notes', 'x-default': 'https://re0.io/en/r/notes' },
    });
  });
});

describe('oneLine', () => {
  it('collapses whitespace and cuts by code points, never splitting an emoji', () => {
    expect(oneLine('  a\n\n b\tc ', 10)).toBe('a b c');
    const cut = oneLine(`${'x'.repeat(198)}😀😀😀`, 200);
    expect(cut).toBe(`${'x'.repeat(198)}😀…`);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(oneLine('😀'.repeat(200), 200)).toBe('😀'.repeat(200));
  });
});

describe('JSON-LD', () => {
  it('cannot be closed early by a name holding </script>', () => {
    const html = renderToStaticMarkup(JsonLd({ data: { name: '</script><script>alert(1)</script>' } }));
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(html.replace(/^<script[^>]*>|<\/script>$/g, '')).name).toBe('</script><script>alert(1)</script>');
  });

  it('describes a Ree with its breadcrumb and owner, nothing invented', () => {
    const ree = { slug: 'dw200', name: 'DW200', role: 'official', ownerName: 'RE0', ownerWebsite: '', tags: [], updatedAt: new Date('2026-11-01T00:00:00Z') } as unknown as PublicRee;
    const graph = reeJsonLd(ree, 'zh', { home: 'Home', explore: 'Explore', category: 'Expertise', description: 'About DW200' })['@graph'] as Record<string, unknown>[];
    expect(graph.map((node) => node['@type'])).toEqual(['WebPage', 'BreadcrumbList', 'CreativeWork']);
    /* An official Ree is English: its /zh page describes the canonical /en page. */
    expect(graph[0]).toMatchObject({ '@id': 'https://re0.io/en/r/dw200', inLanguage: 'en' });
    expect((graph[1]!.itemListElement as { item: string }[]).map((item) => item.item)).toEqual(['https://re0.io/zh', 'https://re0.io/zh/explore', 'https://re0.io/en/r/dw200']);
    const theirs = reeJsonLd({ ...ree, role: 'normal' } as PublicRee, 'zh', { home: 'Home', explore: 'Explore', category: 'Expertise', description: 'About DW200' })['@graph'] as Record<string, unknown>[];
    expect(theirs[0]).toMatchObject({ '@id': 'https://re0.io/zh/r/dw200', inLanguage: 'zh-CN' });
    expect(graph[2]).toMatchObject({ author: { '@type': 'Organization', name: 'RE0' }, keywords: undefined });
    expect(JSON.stringify(graph)).not.toMatch(/aggregateRating|opengraph-image/);
  });
});
