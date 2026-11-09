/**
 * Fixed-window request counters in `rate_bucket` (explore search, sharing,
 * MCP, redeem codes). Windows of up to an hour only: the hourly rank job
 * clears older ones (`clearRateBuckets`).
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/infra/db';

function windowStartOf(windowSeconds: number, now: Date): Date {
  const windowMs = windowSeconds * 1_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Counts one hit against `key` in a fixed window and answers whether it is
 * still within `limit`. A key over its limit keeps counting, so hammering
 * does not open the window early.
 */
export async function hitRateBucket(key: string, limit: number, windowSeconds: number, now = new Date()): Promise<boolean> {
  const windowStart = windowStartOf(windowSeconds, now);
  const [row] = await db()
    .insert(schema.rateBucket)
    .values({ key, windowStart, hits: 1 })
    .onConflictDoUpdate({ target: [schema.rateBucket.key, schema.rateBucket.windowStart], set: { hits: sql`${schema.rateBucket.hits} + 1` } })
    .returning({ hits: schema.rateBucket.hits });
  return (row?.hits ?? 0) <= limit;
}

/**
 * Hits so far in `key`'s current window, without counting one, and the
 * seconds until that window closes: for limits that only count failures,
 * checked before the attempt and hit after it fails.
 */
export async function peekRateBucket(key: string, windowSeconds: number, now = new Date()): Promise<{ hits: number; retryAfter: number }> {
  const windowStart = windowStartOf(windowSeconds, now);
  const [row] = await db()
    .select({ hits: schema.rateBucket.hits })
    .from(schema.rateBucket)
    .where(and(eq(schema.rateBucket.key, key), eq(schema.rateBucket.windowStart, windowStart)))
    .limit(1);
  return { hits: row?.hits ?? 0, retryAfter: Math.max(1, Math.ceil((windowStart.getTime() + windowSeconds * 1_000 - now.getTime()) / 1_000)) };
}

/** Old windows, cleared by the hourly rank job. */
export async function clearRateBuckets(now = new Date()): Promise<void> {
  await db().delete(schema.rateBucket).where(lt(schema.rateBucket.windowStart, new Date(now.getTime() - 3_600_000)));
}
