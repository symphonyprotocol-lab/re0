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

export interface RateRule {
  key: string;
  limit: number;
  windowSeconds: number;
}

export type RateSlots = { ok: true; release: () => Promise<void> } | { ok: false; retryAfter: number };

/**
 * For limits that count only failures: takes one slot in every rule's
 * window at once, before the attempt, so parallel attempts cannot all see
 * room. Over any limit, every slot is given back and the answer is the
 * seconds until the last full window closes. `release` gives the slots back
 * for an attempt that turned out not to count; a failure keeps them.
 * Attempts still in flight hold their slots, so at most `limit` failures
 * plus in-flight attempts are ever admitted per window.
 */
export async function takeRateSlots(rules: readonly RateRule[], now = new Date()): Promise<RateSlots> {
  const taken = await Promise.all(
    rules.map(async (rule) => {
      const windowStart = windowStartOf(rule.windowSeconds, now);
      const [row] = await db()
        .insert(schema.rateBucket)
        .values({ key: rule.key, windowStart, hits: 1 })
        .onConflictDoUpdate({ target: [schema.rateBucket.key, schema.rateBucket.windowStart], set: { hits: sql`${schema.rateBucket.hits} + 1` } })
        .returning({ hits: schema.rateBucket.hits });
      const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + rule.windowSeconds * 1_000 - now.getTime()) / 1_000));
      return { key: rule.key, windowStart, over: (row?.hits ?? 0) > rule.limit, retryAfter };
    }),
  );
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await Promise.all(
      taken.map((slot) =>
        db()
          .update(schema.rateBucket)
          .set({ hits: sql`greatest(${schema.rateBucket.hits} - 1, 0)` })
          .where(and(eq(schema.rateBucket.key, slot.key), eq(schema.rateBucket.windowStart, slot.windowStart))),
      ),
    );
  };
  const over = taken.filter((slot) => slot.over);
  if (over.length === 0) return { ok: true, release };
  await release();
  return { ok: false, retryAfter: Math.max(...over.map((slot) => slot.retryAfter)) };
}

/** Old windows, cleared by the hourly rank job. */
export async function clearRateBuckets(now = new Date()): Promise<void> {
  await db().delete(schema.rateBucket).where(lt(schema.rateBucket.windowStart, new Date(now.getTime() - 3_600_000)));
}
