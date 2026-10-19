import { describe, expect, it } from 'vitest';
import { pagesOf } from '@/lib/domain/widget';

const chunk = (chunkId: string, sourceUrl: string, documentTitle: string, section: string | null) => ({
  chunkId,
  citation: { sourceUrl, documentTitle, section },
});

describe('widget source pages', () => {
  it('collapses passages to one page each, in order of first appearance', () => {
    const pages = pagesOf([
      chunk('a', 'https://x.test/pricing', 'Pricing', 'Solo'),
      chunk('b', 'https://x.test/', 'Home', null),
      chunk('c', 'https://x.test/pricing', 'Pricing', 'Free'),
      chunk('d', 'https://x.test/pricing', 'Pricing', 'Solo'),
    ]);
    expect(pages.map((page) => page.url)).toEqual(['https://x.test/pricing', 'https://x.test/']);
    expect(pages[0]?.chunkIds).toEqual(['a', 'c', 'd']);
    expect(pages[1]?.chunkIds).toEqual(['b']);
  });

  it('keeps a section only when every passage of the page shares it', () => {
    const [agreed, mixed] = pagesOf([
      chunk('a', 'https://x.test/help', 'Help', 'Returns'),
      chunk('b', 'https://x.test/help', 'Help', 'Returns'),
      chunk('c', 'https://x.test/pricing', 'Pricing', 'Solo'),
      chunk('d', 'https://x.test/pricing', 'Pricing', null),
    ]);
    expect(agreed?.section).toBe('Returns');
    expect(mixed?.section).toBeNull();
  });

  it('returns nothing for nothing', () => {
    expect(pagesOf([])).toEqual([]);
  });
});
