import { describe, expect, it } from 'vitest';
import {
  applyShowcaseDraft,
  buildShowcaseDraftPrompt,
  parseShowcaseDraft,
  parseSlug,
  parseStarterQuestions,
  readShowcaseDocument,
  resolveSlugChange,
  SHOWCASE_LIMITS,
  showcaseFieldsFor,
  showcaseIndexable,
  showcasePagesAllowed,
  showcaseRedirectable,
  showcaseTransition,
  sniffImageType,
  suggestSlug,
  afterDnsCheck,
  afterOwnershipCheck,
  afterVercelAdd,
  isOwnHostOf,
  isShowcaseExpired,
  parseCustomHost,
  parseShowcaseExpiry,
  parseShowcasePassword,
  showcaseGate,
  svgLooksSafe,
  validateLead,
  validateShowcaseContent,
  withoutUnlistedSuffix,
  withUnlistedSuffix,
  type ShowcaseDocument,
} from '@/lib/domain/showcase';
import { capabilitiesFor, readCapabilities } from '@/lib/domain/plans';

/**
 * A library shared as a page: the rules the dashboard form, the draft
 * generator and the public page share (lib/domain/showcase.ts).
 */
describe('validateShowcaseContent', () => {
  it('keeps a page with only a name, trimmed, and drops empty entries', () => {
    const result = validateShowcaseContent({
      name: '  Acme  ',
      facts: 'founded 2021\n\n  Shanghai ',
      features: [{ title: '', body: '' }, { title: 'Reports', body: 'Daily' }],
      links: [{ label: '', url: '' }],
    });
    expect(result).toEqual({
      ok: true,
      content: {
        name: 'Acme',
        tagline: '',
        summary: '',
        facts: ['founded 2021', 'Shanghai'],
        features: [{ title: 'Reports', body: 'Daily' }],
        audience: '',
        pricing: '',
        links: [],
        ctas: [],
      },
    });
  });

  it('names the field that breaks a rule', () => {
    expect(validateShowcaseContent({ name: '' })).toEqual({ ok: false, field: 'name' });
    expect(validateShowcaseContent({ name: 'a', tagline: 'x'.repeat(SHOWCASE_LIMITS.tagline + 1) })).toEqual({ ok: false, field: 'tagline' });
    expect(validateShowcaseContent({ name: 'a', facts: ['1', '2', '3', '4', '5'] })).toEqual({ ok: false, field: 'facts' });
    expect(validateShowcaseContent({ name: 'a', links: [{ label: 'Site', url: 'ftp://x' }] })).toEqual({ ok: false, field: 'links' });
    expect(validateShowcaseContent({ name: 'a', ctas: [{ label: 'x', url: 'https://a.test' }, { label: 'y', url: 'https://b.test' }, { label: 'z', url: 'https://c.test' }] })).toEqual({ ok: false, field: 'ctas' });
    expect(validateShowcaseContent({ name: 'a', features: [{ title: '', body: 'no title' }] })).toEqual({ ok: false, field: 'features' });
  });

  it('reads a stored document without trusting its shape', () => {
    const document = readShowcaseDocument({ content: { name: 'Acme', links: 'nope' }, origin: { name: 'generated', tagline: 'odd' }, evidence: { name: 'About' } });
    expect(document.content.name).toBe('Acme');
    expect(document.content.links).toEqual([]);
    expect(document.origin).toEqual({ name: 'generated' });
    expect(document.evidence).toEqual({ name: 'About' });
    expect(readShowcaseDocument(null).content.name).toBe('');
  });
});

describe('fields by kind', () => {
  it('shows company and product fields in page order', () => {
    expect(showcaseFieldsFor('company')).toEqual(['name', 'tagline', 'summary', 'facts', 'links', 'ctas']);
    expect(showcaseFieldsFor('product')).toEqual(['name', 'tagline', 'summary', 'features', 'audience', 'pricing', 'links', 'ctas']);
  });
});

describe('slug', () => {
  it('folds a typed slug and refuses the short, the long and the reserved', () => {
    expect(parseSlug('  Acme Analytics! ')).toBe('acme-analytics');
    expect(parseSlug('Café')).toBe('cafe');
    expect(parseSlug('ab')).toBeNull();
    expect(parseSlug('a'.repeat(SHOWCASE_LIMITS.slug.max + 1))).toBeNull();
    expect(parseSlug('admin')).toBeNull();
    expect(parseSlug('API')).toBeNull();
    expect(parseSlug(42)).toBeNull();
  });

  it('suggests one from a title, or nothing for a title without Latin letters', () => {
    expect(suggestSlug('Acme 科技')).toBe('acme');
    expect(suggestSlug('科技公司')).toBeNull();
    expect(suggestSlug('Go')).toBe('go-page');
  });

  it('reads the base back off an unlisted slug, and only off one', () => {
    expect(withoutUnlistedSuffix('acme-deadbeef')).toBe('acme');
    expect(withoutUnlistedSuffix('build-deadbeef-01234567')).toBe('build-deadbeef');
  });

  it('moves a page between public and unlisted without losing or leaking its address', () => {
    const suffix = '0123abcd';
    /* public -> unlisted: a fresh suffix, and the old address must not redirect. */
    expect(resolveSlugChange({ currentSlug: 'acme', currentAccess: 'public', typedSlug: null, nextAccess: 'unlisted', suffix })).toEqual({
      slug: 'acme-0123abcd',
      redirectFromOld: false,
    });
    /* unlisted, untouched save: the form posts the base, the slug stays. */
    expect(resolveSlugChange({ currentSlug: 'acme-0123abcd', currentAccess: 'unlisted', typedSlug: 'acme', nextAccess: 'unlisted', suffix: 'ffffffff' })).toEqual({
      slug: 'acme-0123abcd',
      redirectFromOld: false,
    });
    /* unlisted, the owner typed the whole address: still unchanged. */
    expect(resolveSlugChange({ currentSlug: 'acme-0123abcd', currentAccess: 'unlisted', typedSlug: 'acme-0123abcd', nextAccess: 'unlisted', suffix: 'ffffffff' }).slug).toBe('acme-0123abcd');
    /* unlisted -> public: the base comes back, and the old address may redirect. */
    expect(resolveSlugChange({ currentSlug: 'acme-0123abcd', currentAccess: 'unlisted', typedSlug: null, nextAccess: 'public', suffix })).toEqual({
      slug: 'acme',
      redirectFromOld: true,
    });
    /* a public slug that happens to end in eight hex digits is not a suffix. */
    expect(resolveSlugChange({ currentSlug: 'build-deadbeef', currentAccess: 'public', typedSlug: null, nextAccess: 'public', suffix }).slug).toBe('build-deadbeef');
    expect(resolveSlugChange({ currentSlug: 'build-deadbeef', currentAccess: 'public', typedSlug: null, nextAccess: 'unlisted', suffix }).slug).toBe('build-deadbeef-0123abcd');
    /* a rename while unlisted re-mints the suffix. */
    expect(resolveSlugChange({ currentSlug: 'acme-0123abcd', currentAccess: 'unlisted', typedSlug: 'acme-co', nextAccess: 'unlisted', suffix: 'ffffffff' }).slug).toBe('acme-co-ffffffff');
  });

  it('adds an unlisted suffix within the length limit', () => {
    expect(withUnlistedSuffix('acme', 'ABCDEF0123')).toBe('acme-abcdef01');
    const long = withUnlistedSuffix('a'.repeat(48), 'deadbeef');
    expect(long.length).toBeLessThanOrEqual(SHOWCASE_LIMITS.slug.max);
    expect(long.endsWith('-deadbeef')).toBe(true);
  });
});

describe('starter questions', () => {
  it('reads one per line, deduplicated, within the limits', () => {
    expect(parseStarterQuestions('What is it?\n\nwhat is it?\nWhat is it?\nPricing?')).toEqual({
      ok: true,
      questions: ['What is it?', 'what is it?', 'Pricing?'],
    });
    expect(parseStarterQuestions(Array.from({ length: 7 }, (_, i) => `q${i}`))).toEqual({ ok: false });
    expect(parseStarterQuestions(['x'.repeat(SHOWCASE_LIMITS.starterQuestions.chars + 1)])).toEqual({ ok: false });
  });
});

describe('status', () => {
  it('moves draft to published, published to disabled and back, and nothing past taken_down but reinstate', () => {
    expect(showcaseTransition('draft', 'publish')).toBe('published');
    expect(showcaseTransition('published', 'publish')).toBeNull();
    expect(showcaseTransition('published', 'disable')).toBe('disabled');
    expect(showcaseTransition('disabled', 'restore')).toBe('published');
    expect(showcaseTransition('disabled', 'publish')).toBe('published');
    expect(showcaseTransition('draft', 'disable')).toBeNull();
    expect(showcaseTransition('published', 'take_down')).toBe('taken_down');
    expect(showcaseTransition('taken_down', 'publish')).toBeNull();
    expect(showcaseTransition('taken_down', 'take_down')).toBeNull();
    expect(showcaseTransition('taken_down', 'reinstate')).toBe('disabled');
  });

  it('indexes only a public, published page, and redirects an old slug only to one', () => {
    expect(showcaseIndexable({ status: 'published', access: 'public' })).toBe(true);
    expect(showcaseIndexable({ status: 'published', access: 'unlisted' })).toBe(false);
    expect(showcaseIndexable({ status: 'disabled', access: 'public' })).toBe(false);
    expect(showcaseRedirectable({ status: 'published', access: 'unlisted' })).toBe(false);
    expect(showcaseRedirectable({ status: 'published', access: 'public' })).toBe(true);
  });
});

describe('plan entitlement', () => {
  it('gives every version one page with the brand line fixed, unless the version says otherwise', () => {
    expect(capabilitiesFor()).toMatchObject({ showcasePages: 1, showcaseBranding: false, showcaseLeadsRetained: 100, showcaseCustomDomain: false });
    expect(capabilitiesFor({ showcasePages: -1, showcaseBranding: true })).toMatchObject({ showcasePages: -1, showcaseBranding: true });
    expect(readCapabilities({ showcaseCustomDomain: true })).toMatchObject({ showcaseCustomDomain: true });
    expect(readCapabilities({ showcaseLeadsRetained: 5 })).toMatchObject({ showcaseLeadsRetained: 5 });
    expect(readCapabilities({ showcaseLeadsRetained: -3 })).toMatchObject({ showcaseLeadsRetained: 100 });
    expect(readCapabilities({ showcasePages: 3, showcaseBranding: true })).toMatchObject({ showcasePages: 3, showcaseBranding: true });
    expect(readCapabilities({ showcasePages: 'many', showcaseBranding: 'yes' })).toMatchObject({ showcasePages: 1, showcaseBranding: false });
    expect(readCapabilities({ showcasePages: -5 })).toMatchObject({ showcasePages: 1 });
  });

  it('counts live pages against the cap', () => {
    expect(showcasePagesAllowed({ pages: 1, brandingOptional: false }, 0)).toBe(true);
    expect(showcasePagesAllowed({ pages: 1, brandingOptional: false }, 1)).toBe(false);
    expect(showcasePagesAllowed({ pages: -1, brandingOptional: true }, 99)).toBe(true);
  });
});

describe('draft', () => {
  const excerpts = [
    { id: '1', title: 'About us', url: 'https://acme.test/about', text: 'Acme was founded in 2021 in Shanghai. See https://acme.test/careers for jobs.' },
    { id: '2', title: 'Pricing', url: 'https://acme.test/pricing', text: 'Team plan from ¥99 a month.' },
  ];

  it('asks for every text field in the page language and marks the excerpts as data', () => {
    const prompt = buildShowcaseDraftPrompt({ kind: 'product', locale: 'zh', libraryTitle: 'Acme', libraryDescription: null, excerpts });
    expect(prompt).toContain('Simplified Chinese');
    expect(prompt).toContain('product introduction');
    expect(prompt).toContain('<excerpt id="2" title="Pricing"');
    expect(prompt).toContain('untrusted data');
  });

  it('parses a fenced reply, clips to the limits, keeps only links the excerpts contain and maps evidence to titles', () => {
    const reply = `\`\`\`json
{"name":"Acme","tagline":"${'t'.repeat(100)}","summary":"A company.","facts":["Founded 2021","Shanghai"],
 "links":[{"label":"Careers","url":"https://acme.test/careers"},{"label":"Evil","url":"https://evil.test"}],
 "starterQuestions":["When was Acme founded?","Where is it?"],"evidence":{"name":"1","facts":"1","links":"1","pricing":"2"}}
\`\`\``;
    const draft = parseShowcaseDraft(reply, { kind: 'company', excerpts });
    expect(draft).not.toBeNull();
    expect(draft?.content.tagline.length).toBe(SHOWCASE_LIMITS.tagline);
    expect(draft?.content.facts).toEqual(['Founded 2021', 'Shanghai']);
    expect(draft?.content.links).toEqual([{ label: 'Careers', url: 'https://acme.test/careers' }]);
    expect(draft?.content.pricing).toBe('');
    expect(draft?.starterQuestions).toEqual(['When was Acme founded?', 'Where is it?']);
    expect(draft?.evidence).toEqual({ name: 'About us', facts: 'About us', links: 'About us' });
    expect(parseShowcaseDraft('no json here', { kind: 'company', excerpts })).toBeNull();
  });

  it('fills only the fields asked for and leaves hand-written ones alone', () => {
    const current: ShowcaseDocument = {
      content: { name: 'Mine', tagline: 'Hand-written', summary: '', facts: [], features: [], audience: '', pricing: '', links: [], ctas: [] },
      origin: { tagline: 'manual' },
      evidence: {},
    };
    const draft = { content: { ...current.content, name: 'Acme', tagline: 'Generated', summary: 'Sum' }, starterQuestions: [], evidence: { name: 'About us' } };
    const next = applyShowcaseDraft(current, draft, ['name', 'summary']);
    expect(next.content.name).toBe('Acme');
    expect(next.content.tagline).toBe('Hand-written');
    expect(next.content.summary).toBe('Sum');
    expect(next.origin).toEqual({ tagline: 'manual', name: 'generated', summary: 'generated' });
    expect(next.evidence).toEqual({ name: 'About us' });
  });
});

describe('images', () => {
  const text = (value: string) => new TextEncoder().encode(value);

  it('reads the type off the bytes, not the browser', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffImageType(text('  <svg></svg>'))).toBe('image/svg+xml');
    expect(sniffImageType(text('<html><svg></svg></html>'))).toBeNull();
    expect(sniffImageType(text('GIF89a'))).toBeNull();
  });

  it('keeps only an SVG that cannot run or load anything', () => {
    expect(svgLooksSafe('<svg><circle r="4"/></svg>')).toBe(true);
    expect(svgLooksSafe('<svg><script>alert(1)</script></svg>')).toBe(false);
    expect(svgLooksSafe('<svg onload="alert(1)"></svg>')).toBe(false);
    expect(svgLooksSafe('<svg><a href="javascript:alert(1)">x</a></svg>')).toBe(false);
    expect(svgLooksSafe('<svg><image href="https://evil.test/x.png"/></svg>')).toBe(false);
    expect(svgLooksSafe('<svg><foreignObject></foreignObject></svg>')).toBe(false);
  });
});

describe('leads', () => {
  it('takes an address and trims the rest', () => {
    expect(validateLead({ email: '  Ada@Example.com ', name: ' Ada ', message: '' })).toEqual({
      ok: true,
      lead: { email: 'ada@example.com', name: 'Ada', message: null },
    });
    expect(validateLead({ email: 'ada@example.com', message: '  How much is Solo? ' })).toMatchObject({
      ok: true,
      lead: { name: null, message: 'How much is Solo?' },
    });
  });

  it('names the field that is wrong', () => {
    expect(validateLead({ email: '' })).toEqual({ ok: false, field: 'email' });
    expect(validateLead({ email: 'not an address' })).toEqual({ ok: false, field: 'email' });
    expect(validateLead({ email: 'a@b' })).toEqual({ ok: false, field: 'email' });
    expect(validateLead({ email: 'ada@example.com', name: 'x'.repeat(61) })).toEqual({ ok: false, field: 'name' });
    expect(validateLead({ email: 'ada@example.com', message: 'x'.repeat(1001) })).toEqual({ ok: false, field: 'message' });
  });

});

describe('gate', () => {
  const now = new Date('2026-10-20T12:00:00Z');

  it('reads a password within the band, untrimmed', () => {
    expect(parseShowcasePassword('secret1')).toBe('secret1');
    expect(parseShowcasePassword(' six66 ')).toBe(' six66 ');
    expect(parseShowcasePassword('short')).toBeNull();
    expect(parseShowcasePassword('x'.repeat(65))).toBeNull();
    expect(parseShowcasePassword(123)).toBeNull();
  });

  it('reads an expiry, clears on empty and refuses nonsense', () => {
    expect(parseShowcaseExpiry('2026-11-01T00:00:00.000Z')).toEqual(new Date('2026-11-01T00:00:00.000Z'));
    expect(parseShowcaseExpiry('')).toBeNull();
    expect(parseShowcaseExpiry(null)).toBeNull();
    expect(parseShowcaseExpiry('invalid')).toBeUndefined();
    expect(parseShowcaseExpiry(42)).toBeUndefined();
  });

  it('closes an expired page whatever the cookie says, locks a password page until unlocked', () => {
    expect(isShowcaseExpired(null, now)).toBe(false);
    expect(isShowcaseExpired('2026-10-20T11:59:59Z', now)).toBe(true);
    expect(showcaseGate({ hasPassword: true, expiresAt: '2026-10-19T00:00:00Z', unlocked: true }, now)).toBe('expired');
    expect(showcaseGate({ hasPassword: true, expiresAt: null, unlocked: false }, now)).toBe('locked');
    expect(showcaseGate({ hasPassword: true, expiresAt: '2026-12-01T00:00:00Z', unlocked: true }, now)).toBe('open');
    expect(showcaseGate({ hasPassword: false, expiresAt: null, unlocked: false }, now)).toBe('open');
  });
});

describe('custom host', () => {
  const own = ['re0.io', 'localhost:3000', 'vercel.app'];

  it('takes a subdomain, lower-cased, from a host or a pasted URL', () => {
    expect(parseCustomHost('About.Example.com', own)).toBe('about.example.com');
    expect(parseCustomHost('https://About.Example.com/path?x=1', own)).toBe('about.example.com');
    expect(parseCustomHost('docs.sub.example.co.uk.', own)).toBe('docs.sub.example.co.uk');
  });

  it('refuses an apex, our own hosts, and anything that is not a host', () => {
    expect(parseCustomHost('example.com', own)).toBeNull();
    expect(parseCustomHost('re0.io', own)).toBeNull();
    expect(parseCustomHost('pages.re0.io', own)).toBeNull();
    expect(parseCustomHost('my-app.vercel.app', own)).toBeNull();
    expect(parseCustomHost('x.localhost', own)).toBeNull();
    expect(parseCustomHost('bad host.example.com', own)).toBeNull();
    expect(parseCustomHost('-x.example.com', own)).toBeNull();
    expect(parseCustomHost('', own)).toBeNull();
    expect(parseCustomHost(42, own)).toBeNull();
  });

  it('knows a host of ours with or without a port', () => {
    expect(isOwnHostOf('localhost:3000', own)).toBe(true);
    expect(isOwnHostOf('www.re0.io', own)).toBe(true);
    expect(isOwnHostOf('about.example.com', own)).toBe(false);
  });
});

describe('domain check steps', () => {
  it('keeps waiting on a record that is not there yet, and fails only on an expired or exhausted challenge', () => {
    expect(afterOwnershipCheck('ok')).toBeNull();
    expect(afterOwnershipCheck('challenge_not_found')).toEqual({ error: 'record_not_found' });
    expect(afterOwnershipCheck('source_mismatch')).toEqual({ error: 'record_not_found' });
    expect(afterOwnershipCheck('challenge_expired')).toEqual({ status: 'failed', error: 'challenge_expired' });
    expect(afterOwnershipCheck('retry_limit_exceeded')).toEqual({ status: 'failed', error: 'retry_limit_exceeded' });
  });

  it('reads what Vercel asks for, and names a host another account holds', () => {
    expect(afterVercelAdd({ verified: true, verification: [] })).toEqual({ status: 'pending_dns', error: null, vercelTxt: null });
    expect(afterVercelAdd({ verified: false, verification: [{ type: 'TXT', domain: '_vercel.about.acme.test', value: 'vc-domain-verify=...' }] })).toEqual({
      status: 'pending_dns',
      error: null,
      vercelTxt: { name: '_vercel.about.acme.test', value: 'vc-domain-verify=...' },
    });
    expect(afterVercelAdd({ verified: false, verification: [], inUseElsewhere: true })).toEqual({ status: 'failed', error: 'host_in_use_elsewhere' });
  });

  it('goes live once DNS is configured and back to waiting when it breaks', () => {
    expect(afterDnsCheck({ misconfigured: false })).toEqual({ status: 'ready', error: null });
    expect(afterDnsCheck({ misconfigured: true })).toEqual({ status: 'pending_dns', error: null });
  });
});
