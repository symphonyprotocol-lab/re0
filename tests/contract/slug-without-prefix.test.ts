/**
 * Both id fields -- the admin console's and the import wizard's -- show the
 * namespace prefix inside the input and keep only the slug as state, so a
 * pasted full id folds back instead of doubling (requirement.md 6.1).
 */
import { describe, expect, it } from 'vitest';
import { slugWithoutPrefix } from '@/lib/domain/asset';

describe('slugWithoutPrefix', () => {
  it('strips the namespace a pasted id repeats', () => {
    expect(slugWithoutPrefix('/websites/ethereum/whitepaper', '/websites/')).toBe('ethereum/whitepaper');
    expect(slugWithoutPrefix('websites/ethereum', '/websites/')).toBe('ethereum');
    expect(slugWithoutPrefix('/Websites//ethereum', '/websites/')).toBe('ethereum');
  });

  it('keeps nested segments and a plain slug as typed', () => {
    expect(slugWithoutPrefix('ethereum/whitepaper', '/websites/')).toBe('ethereum/whitepaper');
    expect(slugWithoutPrefix('apage', '/websites/')).toBe('apage');
    expect(slugWithoutPrefix('website/typo', '/websites/')).toBe('website/typo');
  });

  it('only drops leading slashes for a repository id', () => {
    expect(slugWithoutPrefix('/vercel/ai', '/')).toBe('vercel/ai');
    expect(slugWithoutPrefix('vercel/ai', '/')).toBe('vercel/ai');
  });
});
