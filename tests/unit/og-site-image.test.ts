/**
 * The site's link preview per language (`/og/site/[lang]`): drawn with the
 * fetched font, the English card when the Chinese font cannot be fetched,
 * and nothing for another language.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { offlineOgAssets } from '../fixtures/og-offline';

const fonts = vi.hoisted(() => ({ available: true }));
vi.mock('@/lib/og/font', async (original) => {
  const actual = await original<typeof import('@/lib/og/font')>();
  const { fixtureOgFonts } = await import('../fixtures/og-offline');
  return { ...actual, ogFonts: vi.fn(async () => (fonts.available ? fixtureOgFonts(actual.OG_FONT_FAMILY) : null)) };
});
offlineOgAssets();

const { GET } = await import('@/app/og/site/[lang]/route');
const { ogFonts } = await import('@/lib/og/font');
const get = (lang: string) => GET(new Request(`http://localhost:3000/og/site/${lang}`), { params: Promise.resolve({ lang }) });

beforeEach(() => {
  fonts.available = true;
  vi.mocked(ogFonts).mockClear();
});

describe('/og/site/[lang]', () => {
  it('draws the card in each language, asking the font for its own words', async () => {
    for (const lang of ['zh', 'en']) {
      const response = await get(lang);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
    }
    const asked = vi.mocked(ogFonts).mock.calls.map(([text]) => text);
    expect(asked[0]).toContain('问一次');
    expect(asked[1]).toContain('Ask once.');
  });

  it('falls back to the English card, briefly cached, without the Chinese font', async () => {
    fonts.available = false;
    const response = await get('zh');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
  });

  it('has no card for another language', async () => {
    expect((await get('fr')).status).toBe(404);
  });
});
