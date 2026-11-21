/**
 * One limiter for user routes: `USER_RATE_LIMITS[name]` unless the console
 * stored other values, counted in `rate_bucket` per account (per client
 * address when signed out). Over any window the route answers 429 with
 * `retry-after` before doing any work. Accounts the console exempted pass
 * every limit without being counted (lib/services/rate-limit-settings.ts).
 */
import { clientIp } from '@/lib/http/client-ip';
import { fail } from '@/lib/http/respond';
import { hitRateBucket } from '@/lib/services/rate-limit';
import { effectiveRateRules, type RateLimitName } from '@/lib/services/rate-limit-settings';

export type { RateLimitName };

/** `null` when the request may go ahead; otherwise the 429 to return. */
export async function rateLimited(
  name: RateLimitName,
  caller: { userId: string | null; headers: Headers },
  now = new Date(),
): Promise<Response | null> {
  const rules = await effectiveRateRules(name, caller.userId);
  if (!rules) return null;
  const who = caller.userId ? `user:${caller.userId}` : `ip:${clientIp(caller.headers) ?? 'unknown'}`;
  let retryAfter = 0;
  for (const rule of rules) {
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
