/**
 * Nested Asset IDs (requirement.md 6.1): the slug namespaces group, a
 * repository does not, a typed id is read as the longest asset that could
 * exist, and access-rule entries may cover a whole group.
 */
import { describe, expect, it } from 'vitest';
import { assetIdPatternSchema, assetIdSchema } from '@/contracts/schemas';
import {
  groupNestedIds,
  isVersionLabelShaped,
  assetIdCandidates,
  MAX_NESTED_SLUGS,
  normalizePublicId,
  parentPublicId,
} from '@/lib/domain/asset';
import { evaluatePolicy, assetEntryMatches, listedIn, OPEN_POLICY } from '@/lib/domain/policy';
import { versionLabel } from '@/lib/domain/ingestion';

describe('nested Asset IDs', () => {
  it('nests the slug namespaces, folding case on every segment', () => {
    expect(normalizePublicId('website', '/websites/ethereum/whitepaper')).toBe(
      '/websites/ethereum/whitepaper',
    );
    expect(normalizePublicId('website', 'websites/Ethereum/WhitePaper/')).toBe(
      '/websites/ethereum/whitepaper',
    );
    expect(normalizePublicId('pdf', '/docs/acme/billing/v2-api')).toBe('/docs/acme/billing/v2-api');
    expect(normalizePublicId('notion', '/notion/team/handbook')).toBe('/notion/team/handbook');
  });

  it('keeps a repository at exactly /owner/repository', () => {
    expect(normalizePublicId('github', '/vercel/next.js/docs')).toBeNull();
  });

  it('bounds the depth and refuses an empty or malformed segment', () => {
    const deepest = `/websites/${Array.from({ length: MAX_NESTED_SLUGS }, (_, i) => `l${i}`).join('/')}`;
    expect(normalizePublicId('website', deepest)).toBe(deepest);
    expect(normalizePublicId('website', `${deepest}/one-more`)).toBeNull();
    expect(normalizePublicId('website', '/websites/ethereum//whitepaper')).toBeNull();
    expect(normalizePublicId('website', '/websites/ethereum/white paper')).toBeNull();
  });

  it('refuses a slug that looks like a version label, so pinning keeps working', () => {
    const label = versionLabel('0123456789abcdef', new Date('2026-09-02T00:00:00Z'));
    expect(isVersionLabelShaped(label)).toBe(true);
    expect(isVersionLabelShaped(`${label}.2`)).toBe(true);
    expect(isVersionLabelShaped('whitepaper')).toBe(false);
    expect(normalizePublicId('website', `/websites/ethereum/${label}`)).toBeNull();
    expect(normalizePublicId('website', `/websites/${label}/docs`)).toBeNull();
  });

  it('knows what an asset is nested under', () => {
    expect(parentPublicId('/websites/ethereum/whitepaper')).toBe('/websites/ethereum');
    expect(parentPublicId('/websites/a/b/c')).toBe('/websites/a/b');
    expect(parentPublicId('/websites/ethereum')).toBeNull();
    expect(parentPublicId('/vercel/next.js')).toBeNull();
  });

  it('reads a typed id as the longest asset first, then as a pinned version', () => {
    expect(assetIdCandidates('/websites/ethereum/whitepaper/v2')).toEqual([
      { publicId: '/websites/ethereum/whitepaper/v2', versionLabel: null },
      { publicId: '/websites/ethereum/whitepaper', versionLabel: 'v2' },
      { publicId: '/websites/ethereum', versionLabel: 'whitepaper/v2' },
    ]);
    expect(assetIdCandidates('/vercel/next.js')).toEqual([
      { publicId: '/vercel/next.js', versionLabel: null },
    ]);
    expect(assetIdCandidates('/lonely')).toEqual([]);
  });

  it('groups a catalogue so children follow their parent, in the given order otherwise', () => {
    const ids = [
      '/websites/ethereum/whitepaper',
      '/vercel/next.js',
      '/websites/ethereum',
      '/websites/solana',
      '/websites/ethereum/eips/erc-20',
      '/docs/orphan/child',
    ];
    expect(groupNestedIds(ids, (id) => id)).toEqual([
      '/vercel/next.js',
      '/websites/ethereum',
      '/websites/ethereum/whitepaper',
      '/websites/ethereum/eips/erc-20',
      '/websites/solana',
      '/docs/orphan/child',
    ]);
  });

  it('accepts nested ids and pinned versions at the API boundary, up to the depth', () => {
    for (const id of [
      '/vercel/next.js',
      '/vercel/next.js/14.2',
      '/websites/ethereum/whitepaper',
      '/websites/a/b/c/d',
      '/websites/a/b/c/d/20260902-0123abcd',
    ]) {
      expect(assetIdSchema.safeParse(id).success, id).toBe(true);
    }
    expect(assetIdSchema.safeParse('/websites').success).toBe(false);
    expect(assetIdSchema.safeParse('/websites/a/b/c/d/e/f').success).toBe(false);
    expect(assetIdPatternSchema.safeParse('/websites/ethereum/*').success).toBe(true);
    expect(assetIdPatternSchema.safeParse('/websites/eth*').success).toBe(false);
    expect(assetIdSchema.safeParse('/websites/ethereum/*').success).toBe(false);
  });
});

describe('access-rule entries over a group', () => {
  const subject = (publicId: string) => ({
    publicId,
    sourceTypes: ['website'],
    trustScore: 80,
    verified: true,
    ageDays: 1,
  });

  it('matches a /prefix/* entry against the asset and everything under it', () => {
    expect(assetEntryMatches('/websites/ethereum/*', '/websites/ethereum')).toBe(true);
    expect(assetEntryMatches('/websites/ethereum/*', '/websites/ethereum/whitepaper')).toBe(true);
    expect(assetEntryMatches('/websites/ethereum/*', '/websites/ethereum-classic')).toBe(false);
    expect(assetEntryMatches('/websites/ethereum', '/websites/ethereum/whitepaper')).toBe(false);
    expect(listedIn(['/vercel/next.js', '/websites/ethereum/*'], '/websites/ethereum/eips')).toBe(true);
  });

  it('applies the prefix in select mode and in the block list', () => {
    const select = { ...OPEN_POLICY, mode: 'select' as const, allowedAssets: ['/websites/ethereum/*'] };
    expect(evaluatePolicy(select, subject('/websites/ethereum/whitepaper')).allowed).toBe(true);
    expect(evaluatePolicy(select, subject('/websites/solana')).allowed).toBe(false);

    const blocked = { ...OPEN_POLICY, blockedAssets: ['/websites/ethereum/*'] };
    expect(evaluatePolicy(blocked, subject('/websites/ethereum/whitepaper'))).toMatchObject({
      allowed: false,
      reason: 'asset_blocked',
    });
    expect(evaluatePolicy(blocked, subject('/websites/solana')).allowed).toBe(true);
  });
});
