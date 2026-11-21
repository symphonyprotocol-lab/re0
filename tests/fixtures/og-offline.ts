/**
 * Link-preview cards (`next/og`) drawn without the network, for tests.
 *
 * Two things reach out when a card is drawn: `ogFonts` (lib/og/font.ts),
 * which tests replace with `fixtureOgFonts`, and next/og itself, which
 * fetches a Google font for any glyph the given fonts lack (the fixture is
 * Latin only, so Chinese, "→" ...) and a CDN image for an emoji. On a slow
 * network that alone ran a test past its timeout. `offlineOgAssets` answers
 * those requests at once with an empty stylesheet -- next/og then finds no
 * font and draws the card without those glyphs -- and fails any other
 * request off this machine; local servers (the fake model API) still work.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, vi } from 'vitest';
import type { OgFont } from '@/lib/og/font';

/** The Latin face next/og ships with, under the cards' family, in the weights asked for. */
export function fixtureOgFonts(family: string, weights: readonly (400 | 700)[] = [400, 700]): OgFont[] {
  const data = readFileSync(createRequire(import.meta.url).resolve('next/dist/compiled/@vercel/og/noto-sans-v27-latin-regular.ttf'));
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return weights.map((weight) => ({ name: family, data: buffer, weight, style: 'normal' }));
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** For the test file it is called in: no request leaves the machine while cards are drawn. */
export function offlineOgAssets(): void {
  beforeAll(() => {
    const local = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (LOCAL.has(url.hostname)) return local(input, init);
      if (url.hostname === 'fonts.googleapis.com') return new Response('', { headers: { 'content-type': 'text/css' } });
      throw new Error(`offline test: no request to ${url.hostname}`);
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
}
