/**
 * Anonymous chat's shared daily caps -- per Ree, over the platform, per
 * client address -- as an administrator sets them in the console's pricing
 * page. No row means the defaults in lib/constants.ts, so nothing changes
 * before the first save. The reservation (anonymous-chat.ts) reads them
 * through a short in-process cache: a save is seen at once by the server
 * that made it and by every other within `ANONYMOUS_LIMITS_CACHE_MS`.
 * Lowering a cap below today's count only refuses new questions; nothing
 * already counted changes.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { ANONYMOUS_IP_ROUNDS_PER_DAY, ANONYMOUS_LIMITS_CACHE_MS, ANONYMOUS_PLATFORM_ROUNDS_PER_DAY, ANONYMOUS_REE_ROUNDS_PER_DAY } from '@/lib/constants';
import { ANONYMOUS_LIMIT_FIELDS, anonymousDay, validAnonymousLimit, type AnonymousChatLimits } from '@/lib/domain/anonymous-chat';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

export const DEFAULT_ANONYMOUS_LIMITS: AnonymousChatLimits = {
  reeRoundsPerDay: ANONYMOUS_REE_ROUNDS_PER_DAY,
  platformRoundsPerDay: ANONYMOUS_PLATFORM_ROUNDS_PER_DAY,
  ipRoundsPerDay: ANONYMOUS_IP_ROUNDS_PER_DAY,
  revision: 'default',
};

/** The caps as stored, read now. */
export async function anonymousChatLimits(executor: Executor = db()): Promise<AnonymousChatLimits> {
  const [row] = await executor
    .select({
      reeRoundsPerDay: schema.anonymousChatSettings.reeRoundsPerDay,
      platformRoundsPerDay: schema.anonymousChatSettings.platformRoundsPerDay,
      ipRoundsPerDay: schema.anonymousChatSettings.ipRoundsPerDay,
      revision: schema.anonymousChatSettings.revision,
    })
    .from(schema.anonymousChatSettings)
    .where(eq(schema.anonymousChatSettings.id, 1))
    .limit(1);
  return row ?? DEFAULT_ANONYMOUS_LIMITS;
}

let cached: { at: number; limits: Promise<AnonymousChatLimits> } | null = null;

/** The caps the reservation enforces: the stored ones, read at most every `ANONYMOUS_LIMITS_CACHE_MS`. */
export function currentAnonymousChatLimits(now = Date.now()): Promise<AnonymousChatLimits> {
  if (!cached || now - cached.at >= ANONYMOUS_LIMITS_CACHE_MS) {
    const limits = anonymousChatLimits();
    const entry = { at: now, limits };
    cached = entry;
    /* A failed read is not kept: the next request reads again. */
    limits.catch(() => {
      if (cached === entry) cached = null;
    });
  }
  return cached.limits;
}

/** Drops this server's cached caps (after a save here; tests). */
export function forgetAnonymousChatLimits(): void {
  cached = null;
}

/**
 * The console's save: every cap a whole number from 1 to
 * `ANONYMOUS_LIMIT_MAX`, against the revision the form was loaded with, in
 * one transaction with its audit entry.
 */
export async function saveAnonymousChatLimits(administratorId: string, input: Record<string, unknown>): Promise<AnonymousChatLimits> {
  if (!ANONYMOUS_LIMIT_FIELDS.every((field) => validAnonymousLimit(input[field])) || typeof input.revision !== 'string') {
    throw new AdminInputError('invalid_anonymous_limits');
  }
  const values = {
    reeRoundsPerDay: input.reeRoundsPerDay as number,
    platformRoundsPerDay: input.platformRoundsPerDay as number,
    ipRoundsPerDay: input.ipRoundsPerDay as number,
  };
  const saved = await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settings:anonymous_chat'))`);
    const before = await anonymousChatLimits(tx);
    if (input.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const next = { ...values, revision: randomUUID() };
    await tx
      .insert(schema.anonymousChatSettings)
      .values({ ...next, updatedBy: administratorId })
      .onConflictDoUpdate({ target: schema.anonymousChatSettings.id, set: { ...next, updatedBy: administratorId, updatedAt: new Date() } });
    await audit(tx, { administratorId, action: 'anonymous_chat.update', target: 'limits', before, after: next });
    return next;
  });
  forgetAnonymousChatLimits();
  return saved;
}

/** Today's (UTC) anonymous answers over the platform, beside the cap in the console. */
export async function anonymousRoundsToday(now = new Date()): Promise<number> {
  const [row] = await db()
    .select({ rounds: schema.anonymousChatQuota.rounds })
    .from(schema.anonymousChatQuota)
    .where(and(eq(schema.anonymousChatQuota.keyHash, 'all:'), eq(schema.anonymousChatQuota.day, anonymousDay(now))))
    .limit(1);
  return row?.rounds ?? 0;
}
