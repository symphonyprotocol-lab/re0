import { describe, expect, it } from 'vitest';
import {
  embedSnippet,
  frameAncestors,
  isSiteKeyFormat,
  normaliseOrigin,
  originAllowed,
  parseAccent,
  parseDailyLimit,
  parseOrigins,
  SITE_KEY_DAILY_LIMIT_MAX,
  SITE_KEY_MAX_ORIGINS,
  SITE_KEY_PREFIX,
  widgetReady,
} from '@/lib/domain/site-key';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';

/**
 * requirement.md 9.4: a site key is public, so the origin allowlist and the
 * daily limit are what protect the owner. These are the rules the dashboard
 * form, the widget page and the ask route all share.
 */
describe('normaliseOrigin', () => {
  it('keeps scheme and host, lower-cased, without the default port', () => {
    expect(normaliseOrigin('HTTPS://Www.Example.com')).toBe('https://www.example.com');
    expect(normaliseOrigin('https://example.com:443/')).toBe('https://example.com');
    expect(normaliseOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('refuses anything that is more or less than an origin', () => {
    expect(normaliseOrigin('example.com')).toBeNull();
    expect(normaliseOrigin('https://example.com/docs')).toBeNull();
    expect(normaliseOrigin('https://example.com/?q=1')).toBeNull();
    expect(normaliseOrigin('https://example.com/#top')).toBeNull();
    expect(normaliseOrigin('ftp://example.com')).toBeNull();
    expect(normaliseOrigin('https://user:pw@example.com')).toBeNull();
    expect(normaliseOrigin('   ')).toBeNull();
  });
});

describe('parseOrigins', () => {
  it('reads one origin per line, deduplicated', () => {
    const parsed = parseOrigins('https://a.example\n https://A.example \nhttp://localhost:3000, https://b.example');
    expect(parsed).toEqual({
      ok: true,
      origins: ['https://a.example', 'http://localhost:3000', 'https://b.example'],
    });
  });

  it('names what is wrong', () => {
    expect(parseOrigins('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseOrigins('https://a.example\nnot an origin')).toMatchObject({
      ok: false,
      reason: 'invalid',
      line: 'not an origin',
    });
    const many = Array.from({ length: SITE_KEY_MAX_ORIGINS + 1 }, (_, i) => `https://s${i}.example`).join('\n');
    expect(parseOrigins(many)).toEqual({ ok: false, reason: 'too_many' });
  });
});

describe('originAllowed', () => {
  const allowed = ['https://shop.example', 'http://localhost:3000'];
  it('matches exactly, after normalisation', () => {
    expect(originAllowed(allowed, 'https://shop.example')).toBe(true);
    expect(originAllowed(allowed, 'HTTPS://SHOP.EXAMPLE')).toBe(true);
    expect(originAllowed(allowed, 'https://shop.example:443')).toBe(true);
  });
  it('refuses other hosts, other schemes, subdomains and nothing', () => {
    expect(originAllowed(allowed, 'http://shop.example')).toBe(false);
    expect(originAllowed(allowed, 'https://www.shop.example')).toBe(false);
    expect(originAllowed(allowed, 'https://evil.example')).toBe(false);
    expect(originAllowed(allowed, null)).toBe(false);
    expect(originAllowed(allowed, '')).toBe(false);
  });
});

describe('limits and look', () => {
  it('bounds the daily limit to whole numbers in the band', () => {
    expect(parseDailyLimit('200')).toBe(200);
    expect(parseDailyLimit(1)).toBe(1);
    expect(parseDailyLimit(String(SITE_KEY_DAILY_LIMIT_MAX))).toBe(SITE_KEY_DAILY_LIMIT_MAX);
    expect(parseDailyLimit('0')).toBeNull();
    expect(parseDailyLimit('1.5')).toBeNull();
    expect(parseDailyLimit(SITE_KEY_DAILY_LIMIT_MAX + 1)).toBeNull();
    expect(parseDailyLimit('')).toBeNull();
  });
  it('accepts hex colours only', () => {
    expect(parseAccent('#0F9D77')).toBe('#0f9d77');
    expect(parseAccent('#abc')).toBe('#abc');
    expect(parseAccent('red')).toBeNull();
    expect(parseAccent('#12345')).toBeNull();
  });
});

describe('the wire', () => {
  it('recognises the key format and nothing near it', () => {
    expect(isSiteKeyFormat(`${SITE_KEY_PREFIX}${'a'.repeat(32)}`)).toBe(true);
    expect(isSiteKeyFormat(`${SITE_KEY_PREFIX}${'a'.repeat(31)}`)).toBe(false);
    expect(isSiteKeyFormat(`mm_live_${'a'.repeat(32)}`)).toBe(false);
    expect(isSiteKeyFormat(42)).toBe(false);
  });
  it('builds the header and the snippet from the normalised list', () => {
    expect(frameAncestors(['https://shop.example', 'http://localhost:3000'])).toBe(
      'frame-ancestors https://shop.example http://localhost:3000',
    );
    expect(embedSnippet('https://re0.io/widget.js', 'mm_site_x')).toBe(
      '<script src="https://re0.io/widget.js" data-site-key="mm_site_x" async></script>',
    );
  });
});

describe('widgetReady', () => {
  it('needs a published asset with a current version, and nothing less', () => {
    expect(widgetReady({ lifecycleStatus: 'published', hasCurrentVersion: true })).toBe(true);
    expect(widgetReady({ lifecycleStatus: 'published', hasCurrentVersion: false })).toBe(false);
    /* A paused asset keeps its indexed version; the widget still stops. */
    expect(widgetReady({ lifecycleStatus: 'suspended', hasCurrentVersion: true })).toBe(false);
    expect(widgetReady({ lifecycleStatus: 'draft', hasCurrentVersion: true })).toBe(false);
    expect(widgetReady({ lifecycleStatus: 'archived', hasCurrentVersion: true })).toBe(false);
  });
});

describe('copy', () => {
  it('names every refusal the form can return, in both languages', () => {
    const fields = ['name', 'origins_empty', 'origins_invalid', 'origins_too_many', 'daily_limit', 'welcome', 'accent', 'limit', 'denied', 'not_found', 'unavailable'];
    for (const dictionary of [en, zh]) {
      for (const field of fields) {
        expect(dictionary.dashboard.assetDetail.widget.errors[field as keyof typeof dictionary.dashboard.assetDetail.widget.errors]).toBeTruthy();
      }
      expect(dictionary.embed.welcomeDefault.length).toBeGreaterThan(0);
    }
  });
});
