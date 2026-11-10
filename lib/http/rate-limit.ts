/**
 * One limiter for user routes: `USER_RATE_LIMITS[name]`, counted in
 * `rate_bucket` per account (per client address when signed out). Over any
 * window the route answers 429 with `retry-after` before doing any work.
 */
import { USER_RATE_LIMITS } from '@/lib/constants';
import { clientIp } from '@/lib/http/conversations';
import { fail } from '@/lib/http/respond';
import { hitRateBucket } from '@/lib/services/rate-limit';

export type RateLimitName = keyof typeof USER_RATE_LIMITS;

/** `null` when the request may go ahead; otherwise the 429 to return. */
export async function rateLimited(
  name: RateLimitName,
  caller: { userId: string | null; headers: Headers },
  now = new Date(),
): Promise<Response | null> {
  const who = caller.userId ? `user:${caller.userId}` : `ip:${clientIp(caller.headers) ?? 'unknown'}`;
  let retryAfter = 0;
  for (const rule of USER_RATE_LIMITS[name]) {
    const allowed = await hitRateBucket(`${name}:${rule.windowSeconds}:${who}`, rule.limit, rule.windowSeconds, now);
    if (allowed) continue;
    const windowMs = rule.windowSeconds * 1_000;
    retryAfter = Math.max(retryAfter, Math.ceil((windowMs - (now.getTime() % windowMs)) / 1_000));
  }
  if (!retryAfter) return null;
  const response = fail('rate_limited', 429, { retryAfter });
  response.headers.set('retry-after', String(retryAfter));
  return response;
}
