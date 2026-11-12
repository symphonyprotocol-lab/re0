import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonLd } from '@/components/site/json-ld';
import { defaultPrice } from '@/lib/domain/pricing';
import { pricingJsonLd, publicPage, reeJsonLd } from '@/lib/seo';
import type { PublicRee } from '@/lib/services/public-rees';

beforeEach(() => vi.stubEnv('APP_BASE_URL', 'https://re0.io/'));
afterEach(() => vi.unstubAllEnvs());

describe('publicPage', () => {
  it('canonicalises on APP_BASE_URL and names the site image', () => {
    const meta = publicPage({ path: '/pricing', title: 'Pricing', description: 'd', locale: 'en' });
    expect(meta.alternates?.canonical).toBe('https://re0.io/pricing');
    expect(meta.openGraph).toMatchObject({ url: 'https://re0.io/pricing', locale: 'en_US', images: [{ url: '/opengraph-image' }] });
  });

  it('leaves the images key out for a route with its own opengraph-image file', () => {
    const meta = publicPage({ path: '/r/x', title: 'X', description: 'd', locale: 'zh', ownImage: true });
    expect(meta.openGraph && 'images' in meta.openGraph).toBe(false);
    expect(meta.twitter && 'images' in meta.twitter).toBe(false);
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
    const graph = reeJsonLd(ree, { home: 'Home', explore: 'Explore', category: 'Expertise', description: 'About DW200' })['@graph'] as Record<string, unknown>[];
    expect(graph.map((node) => node['@type'])).toEqual(['WebPage', 'BreadcrumbList', 'CreativeWork']);
    expect(graph[2]).toMatchObject({ author: { '@type': 'Organization', name: 'RE0' }, keywords: undefined });
    expect(JSON.stringify(graph)).not.toMatch(/aggregateRating|opengraph-image/);
  });

  it('prices offers in USD from the catalogue', () => {
    const offers = pricingJsonLd({ plan: defaultPrice('plan'), pack: defaultPrice('pack') }, 'd').offers as Record<string, unknown>[];
    expect(offers.map((offer) => [offer.price, offer.priceCurrency])).toEqual([
      [(defaultPrice('plan').priceMinor / 100).toFixed(2), 'USD'],
      [(defaultPrice('pack').priceMinor / 100).toFixed(2), 'USD'],
    ]);
  });
});
