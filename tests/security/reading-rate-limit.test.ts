import { afterEach, describe, expect, it } from 'vitest';

/**
 * Anonymous reading and listening go through the fail-closed anonymous limiter
 * (architecture.md 11.2: "公开频道里免费资产的阅读与收听"): `/media/{id}` signs
 * a fresh URL to the private bucket per request, and a full article is the
 * corpus a scraper is after.
 */
process.env.DATABASE_URL ??= 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { GET: media } = await import('@/app/media/[mediaId]/route');
const { resetStrictRateLimit } = await import('@/lib/infrastructure/cache/strict-rate-limit');
const { ANONYMOUS_READING_RULE, anonymousRead, readerHeader } = await import('@/lib/http/reading-limit');

afterEach(() => resetStrictRateLimit());

function mediaRequest(address: string): Promise<Response> {
  /* Not a media id: the answer is a 404 unless the limiter answers first, and no database is read. */
  return media(new Request('https://app.example.test/media/not-a-media-id', { headers: { 'x-forwarded-for': address } }), {
    params: Promise.resolve({ mediaId: 'not-a-media-id' }),
  });
}

describe('anonymous reading rate limit', () => {
  it('refuses /media to a session-less caller past the window, per caller', async () => {
    const statuses: number[] = [];
    for (let at = 0; at < 500; at += 1) {
      const response = await mediaRequest('203.0.113.7');
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
        break;
      }
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((status) => status === 404)).toBe(true);
    expect(statuses).toHaveLength(ANONYMOUS_READING_RULE.limit + 1);
    /* Another caller has its own window. */
    expect((await mediaRequest('198.51.100.9')).status).toBe(404);
  });

  it('counts a Markdown render against the reader it names, and ignores a forged name', async () => {
    const reader = new Headers({ 'x-forwarded-for': '203.0.113.20' });
    const [name, value] = (await readerHeader(reader))!;
    /* The renderer's fetch of the page arrives from the server's own address, naming its reader. */
    const rendered = new Headers({ 'x-forwarded-for': '10.0.0.1', [name]: value });
    for (let at = 0; at < ANONYMOUS_READING_RULE.limit; at += 1) expect((await anonymousRead(rendered)).allowed).toBe(true);
    /* That reader's window is spent, whichever way they come... */
    expect((await anonymousRead(rendered)).allowed).toBe(false);
    expect((await anonymousRead(reader)).allowed).toBe(false);
    /* ...and not the server's: another reader rendered through it reads on. */
    const [other, signed] = (await readerHeader(new Headers({ 'x-forwarded-for': '203.0.113.21' })))!;
    expect((await anonymousRead(new Headers({ 'x-forwarded-for': '10.0.0.1', [other]: signed }))).allowed).toBe(true);
    /* A name the caller wrote itself is not believed: it counts against the caller's own address. */
    const forged = new Headers({ 'x-forwarded-for': '203.0.113.20', [name]: `${'0'.repeat(64)}:198.51.100.77` });
    expect((await anonymousRead(forged)).allowed).toBe(false);
  });
});
