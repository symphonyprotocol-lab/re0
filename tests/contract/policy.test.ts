/**
 * The policy evaluator's precedence, as decisions. architecture.md 10.2 is a
 * hierarchy, not a checklist: switches and the blocklist refuse first and
 * nothing overrides them, select mode admits only its list, and "always
 * allow" bypasses exactly the quality thresholds -- no more.
 */
import { describe, expect, it } from 'vitest';
import { assetIdPatternSchema, workspacePolicySchema } from '@/contracts/schemas';
import {
  diffPolicy,
  evaluatePolicy,
  listedIn,
  normalizePolicyMode,
  OPEN_POLICY,
  OPEN_QUALITY,
  parsePolicyEntry,
  parsePolicyList,
  policyDiffIsEmpty,
  PRIVATE_SOURCE_TYPE,
  qualityIsOpen,
  sourceGroupEnabled,
  withSourceGroup,
  type PolicySubject,
  type WorkspacePolicy,
} from '@/lib/domain/policy';

const subject = (overrides: Partial<PolicySubject> = {}): PolicySubject => ({
  publicId: '/websites/target',
  sourceTypes: ['website'],
  trustScore: 80,
  verified: true,
  ageDays: 10,
  ...overrides,
});

const policy = (overrides: Partial<WorkspacePolicy>): WorkspacePolicy => ({
  ...OPEN_POLICY,
  quality: { ...OPEN_POLICY.quality },
  ...overrides,
});

describe('precedence', () => {
  it('the open policy admits everything', () => {
    expect(evaluatePolicy(OPEN_POLICY, subject()).allowed).toBe(true);
  });

  it('a disabled source type refuses, and excepted does not override it', () => {
    const p = policy({
      mode: 'quality',
      sourceTypes: { website: false },
      exceptedAssets: ['/websites/target'],
    });
    expect(evaluatePolicy(p, subject())).toEqual({
      allowed: false,
      reason: 'source_type_disabled',
    });
  });

  it('one disabled source among several still refuses the asset', () => {
    const p = policy({ sourceTypes: { notion: false } });
    expect(evaluatePolicy(p, subject({ sourceTypes: ['github', 'notion'] })).allowed).toBe(false);
  });

  it('the blocklist wins over excepted and over the select allowlist', () => {
    const both = policy({
      mode: 'quality',
      blockedAssets: ['/websites/target'],
      exceptedAssets: ['/websites/target'],
    });
    expect(evaluatePolicy(both, subject())).toEqual({ allowed: false, reason: 'asset_blocked' });

    const selected = policy({
      mode: 'select',
      blockedAssets: ['/websites/target'],
      allowedAssets: ['/websites/target'],
    });
    expect(evaluatePolicy(selected, subject()).allowed).toBe(false);
  });

  it('select mode admits only the allowlist', () => {
    const p = policy({ mode: 'select', allowedAssets: ['/websites/other'] });
    expect(evaluatePolicy(p, subject())).toEqual({
      allowed: false,
      reason: 'not_in_allowlist',
    });
    expect(evaluatePolicy(p, subject({ publicId: '/websites/other' })).allowed).toBe(true);
  });
});

describe('quality thresholds', () => {
  it('refuses below the trust threshold, and excepted bypasses exactly that', () => {
    const p = policy({
      mode: 'quality',
      quality: { ...OPEN_QUALITY, minTrustScore: 90 },
      exceptedAssets: ['/websites/excepted'],
    });
    expect(evaluatePolicy(p, subject({ trustScore: 80 }))).toEqual({
      allowed: false,
      reason: 'below_trust_threshold',
    });
    expect(
      evaluatePolicy(p, subject({ publicId: '/websites/excepted', trustScore: 0 })).allowed,
    ).toBe(true);
  });

  it('requires verification when asked', () => {
    const p = policy({
      mode: 'quality',
      quality: { ...OPEN_QUALITY, requireVerified: true },
    });
    expect(evaluatePolicy(p, subject({ verified: false }))).toEqual({
      allowed: false,
      reason: 'unverified_asset',
    });
  });

  it('refuses stale content, and unknown age passes', () => {
    const p = policy({
      mode: 'quality',
      quality: { ...OPEN_QUALITY, maxAgeDays: 30 },
    });
    expect(evaluatePolicy(p, subject({ ageDays: 45 }))).toEqual({
      allowed: false,
      reason: 'stale_asset',
    });
    expect(evaluatePolicy(p, subject({ ageDays: null })).allowed).toBe(true);
  });

  it('quality thresholds do not apply outside quality mode', () => {
    const p = policy({
      quality: { ...OPEN_QUALITY, requireVerified: true, minTrustScore: 100, maxAgeDays: 1 },
    });
    expect(evaluatePolicy(p, subject({ trustScore: 0, verified: false })).allowed).toBe(true);
  });
});

describe('the stored mode is what the screen showed', () => {
  it('a policy carrying a threshold is a quality policy, whatever its mode says', () => {
    const drafted = policy({ quality: { ...OPEN_QUALITY, minTrustScore: 80 } });
    expect(drafted.mode).toBeNull();
    const stored = normalizePolicyMode(drafted);
    expect(stored.mode).toBe('quality');
    /* Which is the point: the threshold the console showed now refuses. */
    expect(evaluatePolicy(stored, subject({ trustScore: 40 }))).toEqual({
      allowed: false,
      reason: 'below_trust_threshold',
    });
  });

  it('an "always allow" entry makes it a quality policy too', () => {
    expect(normalizePolicyMode(policy({ exceptedAssets: ['/vercel/*'] })).mode).toBe('quality');
  });

  it('a policy that constrains nothing keeps its null mode', () => {
    expect(normalizePolicyMode(OPEN_POLICY).mode).toBeNull();
    expect(normalizePolicyMode(policy({ blockedAssets: ['/a/b'] })).mode).toBeNull();
    expect(normalizePolicyMode(policy({ sourceTypes: { pdf: false } })).mode).toBeNull();
  });

  it('never rewrites a mode that was chosen', () => {
    const selected = policy({ mode: 'select', quality: { ...OPEN_QUALITY, minStars: 10 } });
    expect(normalizePolicyMode(selected)).toBe(selected);
  });

  it('qualityIsOpen answers for the whole block', () => {
    expect(qualityIsOpen(OPEN_QUALITY)).toBe(true);
    expect(qualityIsOpen({ ...OPEN_QUALITY, requireLicense: true })).toBe(false);
    expect(qualityIsOpen({ ...OPEN_QUALITY, minOrganicTraffic: 1 })).toBe(false);
  });

  it('the applied draft carries the mode, so the diff patches it', () => {
    const before = OPEN_POLICY;
    const after = normalizePolicyMode(policy({ quality: { ...OPEN_QUALITY, minTrustScore: 80 } }));
    expect(diffPolicy(before, after)).toEqual({
      mode: 'quality',
      quality: { minTrustScore: 80 },
    });
  });
});

describe('repository and website metrics', () => {
  it('a threshold bites only when the metric is known', () => {
    const p = policy({ mode: 'quality', quality: { ...OPEN_QUALITY, minStars: 1000 } });
    expect(evaluatePolicy(p, subject({ stars: 12 }))).toEqual({
      allowed: false,
      reason: 'below_star_threshold',
    });
    expect(evaluatePolicy(p, subject({ stars: 5000 })).allowed).toBe(true);
    expect(evaluatePolicy(p, subject({ stars: null })).allowed).toBe(true);
    expect(evaluatePolicy(p, subject()).allowed).toBe(true);
  });

  it('a licence is required only of a source known to lack one', () => {
    const p = policy({ mode: 'quality', quality: { ...OPEN_QUALITY, requireLicense: true } });
    expect(evaluatePolicy(p, subject({ hasLicense: false }))).toEqual({
      allowed: false,
      reason: 'unlicensed_asset',
    });
    expect(evaluatePolicy(p, subject({ hasLicense: true })).allowed).toBe(true);
    expect(evaluatePolicy(p, subject({ hasLicense: null })).allowed).toBe(true);
  });

  it('website metrics each carry their own reason', () => {
    const p = policy({
      mode: 'quality',
      quality: { ...OPEN_QUALITY, minBacklinks: 100, minReferringDomains: 10, minOrganicTraffic: 1000 },
    });
    expect(evaluatePolicy(p, subject({ backlinks: 5 })).reason).toBe('below_backlink_threshold');
    expect(evaluatePolicy(p, subject({ referringDomains: 5 })).reason).toBe(
      'below_referring_domain_threshold',
    );
    expect(evaluatePolicy(p, subject({ organicTraffic: 5 })).reason).toBe('below_traffic_threshold');
    expect(
      evaluatePolicy(p, subject({ backlinks: 100, referringDomains: 10, organicTraffic: 1000 }))
        .allowed,
    ).toBe(true);
  });

  it('excepted bypasses the metric thresholds too', () => {
    const p = policy({
      mode: 'quality',
      quality: { ...OPEN_QUALITY, minStars: 1000, requireLicense: true },
      exceptedAssets: ['/websites/target'],
    });
    expect(evaluatePolicy(p, subject({ stars: 0, hasLicense: false })).allowed).toBe(true);
  });
});

describe('the private switch', () => {
  it('refuses a private asset like a disabled source type', () => {
    const p = policy({ sourceTypes: { [PRIVATE_SOURCE_TYPE]: false } });
    expect(evaluatePolicy(p, subject({ sourceTypes: ['pdf', PRIVATE_SOURCE_TYPE] }))).toEqual({
      allowed: false,
      reason: 'source_type_disabled',
    });
    expect(evaluatePolicy(p, subject({ sourceTypes: ['pdf'] })).allowed).toBe(true);
  });

  it('the console switches cover their stored types both ways', () => {
    let p = policy({});
    expect(sourceGroupEnabled(p, 'sites')).toBe(true);
    p = withSourceGroup(p, 'sites', false);
    expect(p.sourceTypes).toEqual({ website: false });
    expect(sourceGroupEnabled(p, 'sites')).toBe(false);
    expect(sourceGroupEnabled(p, 'repos')).toBe(true);
    p = withSourceGroup(p, 'sites', true);
    expect(p.sourceTypes).toEqual({});
  });
});

describe('list entries', () => {
  it('matches an Asset ID whatever case either side was typed in', () => {
    /* GitHub keeps an owner's capitals, so `/Vercel/next.js` is a real id. */
    expect(listedIn(['/vercel/*'], '/Vercel/next.js')).toBe(true);
    expect(listedIn(['/Vercel/Next.js'], '/vercel/next.js')).toBe(true);
    expect(listedIn(['/vercel/next.js'], '/Vercel/Next.js')).toBe(true);
    expect(listedIn(['/vercel/*'], '/VercelLabs/ai')).toBe(false);
    expect(
      evaluatePolicy(policy({ blockedAssets: ['/vercel/*'] }), subject({ publicId: '/Vercel/next.js' }))
        .reason,
    ).toBe('asset_blocked');
  });

  it('an organisation entry covers every asset the owner publishes', () => {
    expect(listedIn(['/vercel/*'], '/vercel/next.js')).toBe(true);
    expect(listedIn(['/vercel/*'], '/vercel/swr/docs')).toBe(true);
    expect(listedIn(['/vercel/*'], '/vercel-labs/ai')).toBe(false);
    expect(listedIn(['/vercel/*'], '/vercel')).toBe(true);
  });

  it('a domain entry covers an asset whose sources live on that host or under it', () => {
    const s = subject({ domains: ['docs.example.com'] });
    expect(listedIn(['docs.example.com'], s)).toBe(true);
    expect(listedIn(['example.com'], s)).toBe(true);
    expect(listedIn(['EXAMPLE.com'], s)).toBe(true);
    expect(listedIn(['ample.com'], s)).toBe(false);
    expect(listedIn(['docs.example.com'], subject())).toBe(false);
  });

  it('a domain in the blocklist refuses, and in the allowlist admits', () => {
    const s = subject({ domains: ['docs.example.com'] });
    expect(evaluatePolicy(policy({ blockedAssets: ['example.com'] }), s).reason).toBe(
      'asset_blocked',
    );
    expect(
      evaluatePolicy(policy({ mode: 'select', allowedAssets: ['example.com'] }), s).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy(policy({ mode: 'select', allowedAssets: ['example.com'] }), subject())
        .reason,
    ).toBe('not_in_allowlist');
  });
});

describe('parsePolicyEntry', () => {
  it('keeps an Asset ID and its nested wildcard', () => {
    expect(parsePolicyEntry('/vercel/next.js')).toEqual({ entry: '/vercel/next.js', kind: 'asset' });
    expect(parsePolicyEntry(' /websites/ethereum/* ')).toEqual({
      entry: '/websites/ethereum/*',
      kind: 'asset',
    });
    expect(parsePolicyEntry('/websites/ethereum/')).toEqual({
      entry: '/websites/ethereum',
      kind: 'asset',
    });
  });

  it('turns every spelling of an organisation into /owner/*', () => {
    for (const raw of ['vercel', '@vercel', '/vercel', '/vercel/', '/vercel/*']) {
      expect(parsePolicyEntry(raw)).toEqual({ entry: '/vercel/*', kind: 'organisation' });
    }
  });

  it('keeps a domain as a domain, with or without a scheme or path', () => {
    expect(parsePolicyEntry('Docs.Example.com')).toEqual({ entry: 'docs.example.com', kind: 'domain' });
    expect(parsePolicyEntry('https://docs.example.com:8443/guide?x=1')).toEqual({
      entry: 'docs.example.com',
      kind: 'domain',
    });
    expect(parsePolicyEntry('"example.org"')).toEqual({ entry: 'example.org', kind: 'domain' });
  });

  it('refuses a host too long to be a domain rather than storing it as an organisation', () => {
    /* 254 characters: past the domain length gate, inside MAX_ENTRY_LENGTH,
       and every character one `ID_SEGMENT` accepts. */
    const host = `${Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.')}.${'a'.repeat(10)}`;
    expect(host).toHaveLength(254);
    expect(parsePolicyEntry(host)).toBeNull();
    expect(parsePolicyList(host)).toEqual({ entries: [], invalid: [host] });
    /* A host that does fit is still a domain, and a dotless name still an org. */
    expect(parsePolicyEntry(`${'a'.repeat(60)}.com`)?.kind).toBe('domain');
    expect(parsePolicyEntry('vercel-labs')).toEqual({ entry: '/vercel-labs/*', kind: 'organisation' });
  });

  it('refuses what is none of the three shapes', () => {
    for (const raw of ['', '   ', '/', '/*', '/websites/eth*', 'not a domain', 'https://', '/a b/c', `/${'x'.repeat(300)}/y`]) {
      expect(parsePolicyEntry(raw)).toBeNull();
    }
    expect(parsePolicyEntry('/a/b/c/d/e/f/g')).toBeNull();
  });
});

describe('parsePolicyList', () => {
  it('reads lines and CSV cells, drops headers and quotes, folds duplicates, reports the rest', () => {
    const text = 'asset\n"/vercel/next.js", @vercel\r\n/vercel/*;docs.example.com\n\nnope!\n/vercel/next.js\nnope!';
    expect(parsePolicyList(text)).toEqual({
      entries: ['/vercel/next.js', '/vercel/*', 'docs.example.com'],
      invalid: ['nope!'],
    });
  });

  it('an empty paste is empty', () => {
    expect(parsePolicyList('\n \n')).toEqual({ entries: [], invalid: [] });
  });
});

describe('diffPolicy', () => {
  it('an unchanged draft is an empty patch', () => {
    const p = policy({ mode: 'quality', sourceTypes: { pdf: false }, blockedAssets: ['/a/b'] });
    expect(policyDiffIsEmpty(diffPolicy(p, { ...p }))).toBe(true);
    expect(policyDiffIsEmpty(diffPolicy(OPEN_POLICY, OPEN_POLICY))).toBe(true);
  });

  it('carries only what changed, as the PATCH the API takes', () => {
    const base = policy({
      mode: 'quality',
      sourceTypes: { pdf: false, notion: false },
      quality: { ...OPEN_QUALITY, minTrustScore: 60 },
      blockedAssets: ['/a/b', '/c/d'],
      exceptedAssets: ['/e/f'],
    });
    const next = policy({
      mode: 'select',
      sourceTypes: { notion: false, github: false },
      quality: { ...OPEN_QUALITY, minTrustScore: 80, minStars: 500 },
      blockedAssets: ['/c/d', 'example.com'],
      exceptedAssets: ['/e/f'],
      allowedAssets: ['/vercel/*'],
    });
    expect(diffPolicy(base, next)).toEqual({
      mode: 'select',
      sourceTypes: { enable: ['pdf'], disable: ['github'] },
      quality: { minTrustScore: 80, minStars: 500 },
      blocked: { add: ['example.com'], remove: ['/a/b'] },
      allowed: { add: ['/vercel/*'] },
    });
  });

  it('dropping the mode is sent as clear', () => {
    expect(diffPolicy(policy({ mode: 'quality' }), policy({ mode: null }))).toEqual({
      mode: 'clear',
    });
  });
});

describe('contract schema', () => {
  it('accepts the three entry shapes in their stored form and nothing looser', () => {
    for (const entry of ['/vercel/next.js', '/websites/ethereum/*', '/vercel/*', 'docs.example.com']) {
      expect(assetIdPatternSchema.safeParse(entry).success, entry).toBe(true);
    }
    for (const entry of ['vercel', '@vercel', '/websites/eth*', 'https://docs.example.com', '/*', 'localhost']) {
      expect(assetIdPatternSchema.safeParse(entry).success, entry).toBe(false);
    }
  });

  it('the wire shape carries every quality threshold', () => {
    const parsed = workspacePolicySchema.safeParse({
      ...policy({ mode: 'quality', quality: { ...OPEN_QUALITY, minStars: 500, requireLicense: true } }),
    });
    expect(parsed.success).toBe(true);
    expect(workspacePolicySchema.safeParse({ ...OPEN_POLICY, quality: { requireVerified: false } }).success).toBe(false);
  });
});
