/**
 * The anonymous limit on reading and listening (architecture.md 11.2:
 * "公开频道里免费资产的阅读与收听"). A session-less request for an article's
 * full text, or for `/media/{id}` -- which signs a fresh URL to the private
 * bucket every time, with the egress on the platform -- counts against a
 * window per caller address, hashed as the retrieval limit hashes it. The
 * limiter fails closed (`strictRateLimit`): one that cannot count refuses.
 * A signed-in reader is not limited here; their reads are an account's.
 *
 * The Markdown representation of a page (app/api/page-markdown) fetches the
 * page on the reader's behalf, so the page would see the server's address
 * and every Markdown reader would share one window. The renderer forwards
 * the reader's address signed with the session secret (`readerHeader`), and
 * the page counts that address instead; an unsigned or forged one is
 * ignored.
 */
import { clientAddress, type HeaderBag } from '@/lib/http/client-address';
import type { RateLimitRule, RateLimitVerdict } from '@/lib/infrastructure/cache/redis';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';
import { hmacSha256, timingSafeEqual } from '@/lib/infrastructure/crypto/tokens';

/**
 * A reader opens a few pages and plays an episode or two in ten minutes; a
 * scraper wants the catalogue. Sixty is far above the first and far below
 * the second.
 */
export const ANONYMOUS_READING_RULE: RateLimitRule = { limit: 60, windowSeconds: 600 };

/** The reader's address, as the Markdown renderer forwards it: `<hmac>:<address>`. */
export const READER_HEADER = 'x-re0-reader';

function secret(): string {
  const value = process.env.SESSION_SIGNING_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SIGNING_SECRET is not set (needs at least 32 characters)');
  return value;
}

/**
 * The header the renderer adds to its fetch of the page, naming the reader it
 * fetches for. None without a signing secret: the page then counts the
 * renderer, which is the safe direction to be wrong in.
 */
export async function readerHeader(headers: HeaderBag): Promise<[string, string] | null> {
  const key = process.env.SESSION_SIGNING_SECRET;
  if (!key || key.length < 32) return null;
  const address = clientAddress(headers) ?? 'unknown';
  return [READER_HEADER, `${await hmacSha256(key, `reader|${address}`)}:${address}`];
}

/** Who is reading: the renderer's signed reader when it is genuine, else the caller itself. */
async function readerAddress(headers: HeaderBag): Promise<string> {
  const forwarded = headers.get(READER_HEADER);
  const cut = forwarded?.indexOf(':') ?? -1;
  if (forwarded && cut > 0) {
    const address = forwarded.slice(cut + 1);
    if (timingSafeEqual(await hmacSha256(secret(), `reader|${address}`), forwarded.slice(0, cut))) return address;
  }
  return clientAddress(headers) ?? 'unknown';
}

/** One more full text or signed file for a session-less reader, or a refusal with how long to wait. */
export async function anonymousRead(headers: HeaderBag): Promise<RateLimitVerdict> {
  const key = `ratelimit:reading:${await hmacSha256(secret(), await readerAddress(headers))}`;
  return strictRateLimit(key, ANONYMOUS_READING_RULE);
}
