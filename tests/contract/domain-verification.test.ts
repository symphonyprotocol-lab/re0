/**
 * The domain challenge rules (requirement.md 7.3.2): which sources need one,
 * which host it binds to, what counts as the record or file being in place,
 * and when a verified challenge may be spent on an asset.
 */
import { describe, expect, it } from 'vitest';
import {
  dnsChallengeName,
  dnsChallengeValue,
  matchesDnsChallenge,
  matchesWellKnownBody,
  requiresDomainVerification,
  VERIFIED_VALID_MS,
  verificationCovers,
  verificationHost,
  verificationSpendable,
  wellKnownUrl,
} from '@/lib/domain/domain-verification';
import { claimMethodsFor, requiresClaim, SELF_OWNED_SOURCE_TYPES } from '@/lib/domain';

describe('which sources verify a domain', () => {
  it('gates the one host-fetched source and nothing else', () => {
    expect(requiresDomainVerification('website')).toBe(true);
    for (const type of ['github', 'pdf', 'markdown', 'notion'] as const) {
      expect(requiresDomainVerification(type)).toBe(false);
    }
  });

  it('keeps the claim rules in step: a website is claimed by a domain, not self-owned', () => {
    expect(claimMethodsFor('website')).toEqual(['dns_txt', 'well_known']);
    expect(requiresClaim('website')).toBe(true);
    expect(SELF_OWNED_SOURCE_TYPES).not.toContain('website');
  });
});

describe('verificationHost', () => {
  it('is the lowercase host of an https location, without port or trailing dot', () => {
    expect(verificationHost('https://Docs.Example.com/guide')).toBe('docs.example.com');
    expect(verificationHost('https://example.com.:8443/docs')).toBe('example.com');
    expect(verificationHost('  https://api.example.com/reference ')).toBe('api.example.com');
  });

  it('has nothing for what cannot be a source', () => {
    expect(verificationHost('http://example.com')).toBeNull();
    expect(verificationHost('https://user:pw@example.com')).toBeNull();
    expect(verificationHost('https://localhost/')).toBeNull();
    expect(verificationHost('https://[::1]/')).toBeNull();
    expect(verificationHost('not a url')).toBeNull();
  });

  it('covers the exact host only; a subdomain does not inherit', () => {
    expect(verificationCovers('example.com', 'https://example.com/docs')).toBe(true);
    expect(verificationCovers('Example.com', 'https://EXAMPLE.com/docs')).toBe(true);
    expect(verificationCovers('example.com', 'https://docs.example.com/')).toBe(false);
    expect(verificationCovers('docs.example.com', 'https://example.com/')).toBe(false);
  });
});

describe('challenge placement', () => {
  const token = 'AbC123_-xyz';

  it('names the record, its value and the well-known URL', () => {
    expect(dnsChallengeName('docs.example.com')).toBe('_re0-challenge.docs.example.com');
    expect(dnsChallengeValue(token)).toBe(`re0-verify=${token}`);
    expect(wellKnownUrl('docs.example.com', token)).toBe(
      `https://docs.example.com/.well-known/re0-challenge/${token}`,
    );
  });

  it('matches a TXT record that is exactly the value, joined and unquoted', () => {
    expect(matchesDnsChallenge([[`re0-verify=${token}`]], token)).toBe(true);
    expect(matchesDnsChallenge([['v=spf1 -all'], [`"re0-verify=${token}"`]], token)).toBe(true);
    expect(matchesDnsChallenge([['re0-verify=', token]], token)).toBe(true);
    expect(matchesDnsChallenge([[` re0-verify=${token} `]], token)).toBe(true);
  });

  it('does not match a record that carries anything else, or another token', () => {
    expect(matchesDnsChallenge([], token)).toBe(false);
    expect(matchesDnsChallenge([[token]], token)).toBe(false);
    expect(matchesDnsChallenge([[`re0-verify=${token}extra`]], token)).toBe(false);
    expect(matchesDnsChallenge([['re0-verify=other']], token)).toBe(false);
  });

  it('matches a well-known body that is the token, whitespace aside', () => {
    expect(matchesWellKnownBody(`${token}\n`, token)).toBe(true);
    expect(matchesWellKnownBody(`re0-verify=${token}`, token)).toBe(true);
    expect(matchesWellKnownBody(`<html>${token}</html>`, token)).toBe(false);
    expect(matchesWellKnownBody('', token)).toBe(false);
  });
});

describe('verificationSpendable', () => {
  const now = new Date('2026-09-06T12:00:00Z');
  const verified = {
    status: 'verified',
    host: 'docs.example.com',
    verifiedAt: new Date(now.getTime() - 60_000),
    consumedAssetId: null,
  };

  it('spends a fresh, unspent, matching challenge', () => {
    expect(verificationSpendable(verified, 'https://docs.example.com/guide', now)).toBeNull();
  });

  it('refuses one that is pending, spent, stale or for another host', () => {
    expect(verificationSpendable({ ...verified, status: 'pending' }, 'https://docs.example.com/', now)).toBe(
      'challenge_not_found',
    );
    expect(
      verificationSpendable({ ...verified, consumedAssetId: 'lib' }, 'https://docs.example.com/', now),
    ).toBe('challenge_not_found');
    expect(
      verificationSpendable(
        { ...verified, verifiedAt: new Date(now.getTime() - VERIFIED_VALID_MS - 1) },
        'https://docs.example.com/',
        now,
      ),
    ).toBe('challenge_expired');
    expect(verificationSpendable(verified, 'https://example.com/', now)).toBe('source_mismatch');
  });
});
