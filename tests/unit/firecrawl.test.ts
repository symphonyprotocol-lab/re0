import { describe, expect, it } from 'vitest';
import { firecrawlCooldown, parseFirecrawlKey, rotatesFirecrawlKey } from '@/lib/domain/firecrawl';

describe('Firecrawl key rules', () => {
  it('requires a name, a real boolean and a nonempty key on creation', () => {
    expect(parseFirecrawlKey({ name: ' Main ', apiKey: ' fc-secret ', enabled: true }, true)).toEqual({ name: 'Main', apiKey: 'fc-secret', enabled: true });
    for (const input of [
      { name: '', apiKey: 'fc-secret', enabled: true },
      { name: 'Main', apiKey: '', enabled: true },
      { name: 'Main', apiKey: 'has spaces', enabled: true },
      { name: 'Main', apiKey: 'fc-secret', enabled: 'true' },
    ]) expect(parseFirecrawlKey(input, true)).toHaveProperty('error');
    expect(parseFirecrawlKey({ name: 'Main', apiKey: '', enabled: false })).toEqual({ name: 'Main', apiKey: '', enabled: false });
    expect(parseFirecrawlKey({ name: 'Main', apiKey: '', enabled: true, isFallback: true })).toEqual({ name: 'Main', apiKey: '', enabled: true, isFallback: true });
    expect(parseFirecrawlKey({ name: 'Main', apiKey: '', enabled: true, isFallback: 'true' })).toEqual({ error: 'is_fallback' });
  });

  it('honors bounded Retry-After seconds and HTTP dates', () => {
    const now = Date.UTC(2026, 10, 3);
    expect(firecrawlCooldown(429, '90', now)?.getTime()).toBe(now + 90_000);
    expect(firecrawlCooldown(429, new Date(now + 120_000).toUTCString(), now)?.getTime()).toBe(now + 120_000);
    expect(firecrawlCooldown(429, 'bad', now)?.getTime()).toBe(now + 60_000);
    expect(firecrawlCooldown(429, '9999999', now)?.getTime()).toBe(now + 86_400_000);
    expect(firecrawlCooldown(401, null, now)?.getTime()).toBe(now + 300_000);
    expect(firecrawlCooldown(200, null, now)).toBeNull();
  });

  it('retries only key-specific failures', () => {
    for (const status of [401, 402, 403, 429]) expect(rotatesFirecrawlKey(status)).toBe(true);
    for (const status of [200, 400, 413, 422, 500, 503]) expect(rotatesFirecrawlKey(status)).toBe(false);
  });
});
