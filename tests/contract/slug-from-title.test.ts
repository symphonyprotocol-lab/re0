/**
 * The import wizard fills the Asset ID in from the title
 * (requirement.md 6.1 fixes the shape of a slug; the wizard only proposes one).
 */
import { describe, expect, it } from 'vitest';
import { normalizePublicId, slugFromTitle } from '@/lib/domain/asset';

describe('slugFromTitle', () => {
  it('folds a title to one slug segment', () => {
    expect(slugFromTitle('Next.js Docs')).toBe('next.js-docs');
    expect(slugFromTitle('  Ethereum  Whitepaper (2024) ')).toBe('ethereum-whitepaper-2024');
    expect(slugFromTitle('Café Menü')).toBe('cafe-menu');
  });

  it('always yields something normalizePublicId accepts, or nothing', () => {
    for (const title of ['---Hello---', 'A'.repeat(200), '__init__', '20240101-deadbeef']) {
      const slug = slugFromTitle(title);
      if (slug) expect(normalizePublicId('website', `/websites/${slug}`)).toBe(`/websites/${slug}`);
    }
    expect(slugFromTitle('20240101-deadbeef')).toBe('');
  });

  it('gives nothing for a title without slug characters', () => {
    expect(slugFromTitle('以太坊白皮书')).toBe('');
    expect(slugFromTitle('   ')).toBe('');
  });
});
