/**
 * The payout minimum (docs/design/invitations.md, "Payout minimum"): one
 * site-wide value an administrator sets on the console's payout review
 * page (`payout_settings`, default `PAYOUT_MIN_CREDITS`), and an optional
 * per-account value set on the console's user page
 * (`user.payout_min_credits`). An account's effective minimum is its own
 * when set, lower or higher, otherwise the site-wide one. Read inside the
 * payout request's transaction, never cached. A change applies to requests
 * made after it; a request already made is not judged again. Every other
 * payout gate is untouched.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { PAYOUT_MIN_CREDITS } from '@/lib/constants';
import { isUuid } from '@/lib/domain/list';
import { validPayoutMinimum } from '@/lib/domain/payouts';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

export interface PayoutMinimumSetting {
  credits: number;
  /** `default` until the first save. */
  revision: string;
}

/** The site-wide minimum as stored, read now. */
export async function sitePayoutMinimum(executor: Executor = db()): Promise<PayoutMinimumSetting> {
  const [row] = await executor
    .select({ credits: schema.payoutSettings.minCredits, revision: schema.payoutSettings.revision })
    .from(schema.payoutSettings)
    .where(eq(schema.payoutSettings.id, 1))
    .limit(1);
  return row ?? { credits: PAYOUT_MIN_CREDITS, revision: 'default' };
}

/** An account's minimum: its own override, else the site-wide value. */
export async function effectivePayoutMinimum(executor: Executor, override: number | null): Promise<{ credits: number; override: boolean }> {
  if (override !== null) return { credits: override, override: true };
  return { credits: (await sitePayoutMinimum(executor)).credits, override: false };
}

/** The console's save of the site-wide minimum, against the revision the form was loaded with, with its audit entry. */
export async function saveSitePayoutMinimum(administratorId: string, input: Record<string, unknown>): Promise<PayoutMinimumSetting> {
  if (!validPayoutMinimum(input.credits) || typeof input.revision !== 'string') throw new AdminInputError('invalid_payout_minimum');
  const credits = input.credits;
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settings:payout_minimum'))`);
    const before = await sitePayoutMinimum(tx);
    if (input.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const next = { credits, revision: randomUUID() };
    await tx
      .insert(schema.payoutSettings)
      .values({ minCredits: credits, revision: next.revision, updatedBy: administratorId })
      .onConflictDoUpdate({ target: schema.payoutSettings.id, set: { minCredits: credits, revision: next.revision, updatedBy: administratorId, updatedAt: new Date() } });
    await audit(tx, { administratorId, action: 'payout.minimum.update', target: 'payout_minimum', before, after: next });
    return next;
  });
}

/**
 * Sets (`{ credits }`) or clears (`{ credits: null }`) one account's own
 * minimum, with an audit entry naming the account and both values.
 */
export async function setUserPayoutMinimum(administratorId: string, userId: string, input: Record<string, unknown>): Promise<{ credits: number | null }> {
  if (!isUuid(userId)) throw new AdminInputError('not_found');
  const credits = input.credits === null ? null : input.credits;
  if (credits !== null && !validPayoutMinimum(credits)) throw new AdminInputError('invalid_payout_minimum');
  return db().transaction(async (tx) => {
    const [account] = await tx.select({ id: schema.user.id, before: schema.user.payoutMinCredits }).from(schema.user).where(eq(schema.user.id, userId)).for('update');
    if (!account) throw new AdminInputError('not_found');
    await tx.update(schema.user).set({ payoutMinCredits: credits }).where(eq(schema.user.id, userId));
    await audit(tx, { administratorId, action: 'user.payout_minimum', target: userId, before: { credits: account.before }, after: { credits } });
    return { credits };
  });
}
