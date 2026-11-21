/**
 * Earned credits besides a payout against the database
 * (docs/design/earned-credits.md): the console's settings, what the balance
 * tab shows of them, and a conversion into Pack credits. Deductions from a
 * Plan or Pack live with checkout (billing.ts).
 *
 * A conversion takes earned credits in the earned spend order -- earnings
 * paid from free credits first, then those maturing last, so what is
 * withdrawable now stays longest -- writes one `earned_convert` entry for
 * them and adds Pack grants (`earned_converted`) worth `convertRateBp` /
 * 10,000 of them: one for what was converted from earnings paid for by
 * askers (`converted_paid`, counted as paid money onwards) and one for the
 * rest. Credits held for a payout or a checkout are not there to convert.
 * It cannot be undone.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { allocate, InsufficientCredits, isDeductible, isWithdrawable } from '@/lib/domain/credits';
import { checkConversion, DEFAULT_EARNED_SETTINGS, parseEarnedSettings, splitConversion, type ConvertRefusal, type EarnedSettings } from '@/lib/domain/earned';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';
import { addGrant, grantsOf, moveGrants } from '@/lib/services/credits';

export interface EarnedSettingsView extends EarnedSettings {
  /** `default` until the first save. */
  revision: string;
}

/** The settings as stored, read now; the defaults until the console saves some. */
export async function earnedSettings(executor: Executor = db()): Promise<EarnedSettingsView> {
  const [row] = await executor.select().from(schema.earnedSettings).where(eq(schema.earnedSettings.id, 1)).limit(1);
  if (!row) return { ...DEFAULT_EARNED_SETTINGS, revision: 'default' };
  return {
    convertEnabled: row.convertEnabled,
    convertRateBp: row.convertRateBp,
    convertMinCredits: row.convertMinCredits,
    deductEnabled: row.deductEnabled,
    deductCreditsPerCent: row.deductCreditsPerCent,
    deductMaxPercent: row.deductMaxPercent,
    deductMinChargeMinor: row.deductMinChargeMinor,
    revision: row.revision,
  };
}

/** The console's save, against the revision the form was loaded with, with its audit entry. Applies to conversions and checkouts after it. */
export async function saveEarnedSettings(administratorId: string, raw: Record<string, unknown>): Promise<EarnedSettingsView> {
  const input = parseEarnedSettings(raw);
  if (!input || typeof raw.revision !== 'string') throw new AdminInputError('invalid_earned_settings');
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settings:earned'))`);
    const before = await earnedSettings(tx);
    if (raw.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const revision = randomUUID();
    const values = { ...input, revision, updatedBy: administratorId, updatedAt: new Date() };
    await tx.insert(schema.earnedSettings).values(values).onConflictDoUpdate({ target: schema.earnedSettings.id, set: values });
    await audit(tx, { administratorId, action: 'earned.settings.update', target: 'earned_settings', before, after: { ...input, revision } });
    return { ...input, revision };
  });
}

export interface EarnedBalance {
  total: number;
  /** A payout may draw on these now. */
  withdrawable: number;
  /** Paid for by askers, still in their maturity period. */
  maturing: number;
  /** Paid from free credits: never withdrawable, only convertible. */
  locked: number;
  /** What a Plan or Pack may be paid with: what is withdrawable now (review B1). */
  deductible: number;
  /** Of the total, what came from invitation rewards (and the earnings they paid for). */
  invite: number;
  /** Held by checkouts not paid yet (not in `total`): released when another checkout uses earned credits, or after `EARNED_CHECKOUT_HOLD_MS`. */
  checkoutHeld: number;
  /** The soonest maturing earnings: when (UTC day of the first) and how much matures that day, and how many more maturing grants come later. */
  nextMaturesAt: Date | null;
  nextMaturing: number;
  laterMaturing: number;
}

/** The earned credits not held for a payout or a checkout, by what they may do. */
export async function earnedBalance(executor: Executor, userId: string, now = new Date()): Promise<EarnedBalance> {
  const rows = await executor
    .select({ remaining: schema.creditGrant.remaining, withdrawableAt: schema.creditGrant.withdrawableAt, inviteFunded: schema.creditGrant.inviteFunded })
    .from(schema.creditGrant)
    .where(and(eq(schema.creditGrant.userId, userId), eq(schema.creditGrant.source, 'earned'), gt(schema.creditGrant.remaining, 0)));
  const out: EarnedBalance = { total: 0, withdrawable: 0, maturing: 0, locked: 0, deductible: 0, invite: 0, checkoutHeld: 0, nextMaturesAt: null, nextMaturing: 0, laterMaturing: 0 };
  const [held] = await executor
    .select({ amount: sql<string>`coalesce(sum(${schema.creditHold.amount}), 0)` })
    .from(schema.creditHold)
    .where(and(eq(schema.creditHold.userId, userId), eq(schema.creditHold.kind, 'deduction'), eq(schema.creditHold.status, 'held')));
  out.checkoutHeld = Number(held?.amount ?? 0);
  for (const row of rows) {
    const grant = { source: 'earned' as const, remaining: row.remaining, withdrawableAt: row.withdrawableAt };
    out.total += row.remaining;
    if (isWithdrawable(grant, now)) out.withdrawable += row.remaining;
    else if (row.withdrawableAt) out.maturing += row.remaining;
    else out.locked += row.remaining;
    if (isDeductible(grant, now)) out.deductible += row.remaining;
    if (row.inviteFunded) out.invite += row.remaining;
  }
  /* Earnings matured on the same calendar day (UTC) show as one amount; an invitation reward is withdrawable when credited, so never here. */
  const pending = rows.filter((row) => row.withdrawableAt && row.withdrawableAt.getTime() > now.getTime());
  for (const row of pending) if (!out.nextMaturesAt || row.withdrawableAt!.getTime() < out.nextMaturesAt.getTime()) out.nextMaturesAt = row.withdrawableAt;
  const day = (date: Date) => date.toISOString().slice(0, 10);
  for (const row of pending) {
    if (day(row.withdrawableAt!) === day(out.nextMaturesAt!)) out.nextMaturing += row.remaining;
    else out.laterMaturing += 1;
  }
  return out;
}

export type ConvertResult = { ok: true; converted: number; received: number; conversionId: string } | { ok: false; error: ConvertRefusal; available?: number };

/**
 * `POST /api/billing/earned/convert` `{credits, rateBp}`: converts `credits`
 * earned credits into Pack credits, or refuses. `rateBp` is the rate the
 * dialog showed; a different current rate is refused (`rate_changed`) so
 * nobody converts at a rate they did not see.
 */
export async function convertEarned(userId: string, input: { credits?: unknown; rateBp?: unknown }, now = new Date()): Promise<ConvertResult> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`earned:${userId}`}))`);
    const settings = await earnedSettings(tx);
    const checked = checkConversion(input.credits, settings, input.rateBp);
    if (!checked.ok) return checked;
    return convertWithin(tx, userId, checked.credits, settings.convertRateBp, now);
  });
}

async function convertWithin(tx: Tx, userId: string, credits: number, rateBp: number, now: Date): Promise<ConvertResult> {
  const grants = await grantsOf(tx, userId, true);
  let allocations;
  try {
    allocations = allocate(grants, credits, now, ['earned']);
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, error: 'insufficient_earned', available: error.available };
    throw error;
  }
  /* Paid-for earnings, grouped by where their money came from (a purchase, an invitation, neither known), so the Pack grants stay traceable. */
  const ids = allocations.map((entry) => entry.grantId);
  const origins = await tx
    .select({ id: schema.creditGrant.id, withdrawableAt: schema.creditGrant.withdrawableAt, fundingPurchaseId: schema.creditGrant.fundingPurchaseId, inviteFunded: schema.creditGrant.inviteFunded })
    .from(schema.creditGrant)
    .where(inArray(schema.creditGrant.id, ids));
  const groups = new Map<string, { fundingPurchaseId: string | null; inviteFunded: boolean; voidUntil: Date | null; earned: number }>();
  let freeEarned = 0;
  for (const entry of allocations) {
    const origin = origins.find((row) => row.id === entry.grantId);
    if (!origin?.withdrawableAt) {
      freeEarned += entry.amount;
      continue;
    }
    /* Still maturing: the Pack may be voided by a refund of what paid for it until the earnings would have matured (review S2). */
    const voidUntil = origin.withdrawableAt.getTime() > now.getTime() ? origin.withdrawableAt : null;
    const key = `${origin.inviteFunded}:${origin.fundingPurchaseId ?? ''}:${voidUntil?.toISOString() ?? ''}`;
    const group = groups.get(key) ?? { fundingPurchaseId: origin.fundingPurchaseId, inviteFunded: origin.inviteFunded, voidUntil, earned: 0 };
    group.earned += entry.amount;
    groups.set(key, group);
  }
  const parts = [...groups.values()];
  const split = splitConversion(parts.map((group) => group.earned), freeEarned, rateBp);
  const received = split.paid.reduce((sum, part) => sum + part, 0) + split.free;
  const conversionId = randomUUID();
  await moveGrants(tx, allocations, -1);
  await tx.insert(schema.creditEntry).values({
    userId,
    delta: -credits,
    reason: 'earned_convert',
    refId: conversionId,
    note: `${credits} earned credits converted at ${rateBp / 100}% into ${received} Pack credits`,
    allocations,
    createdAt: now,
  });
  for (const [index, group] of parts.entries()) {
    const amount = split.paid[index]!;
    if (amount <= 0) continue;
    await addGrant(
      tx,
      { userId, source: 'pack', amount, reason: 'earned_converted', refId: conversionId, convertedPaid: true, fundingPurchaseId: group.fundingPurchaseId, inviteFunded: group.inviteFunded, voidUntil: group.voidUntil, note: group.inviteFunded ? 'converted from invitation earnings' : 'converted from withdrawable earnings' },
      now,
    );
  }
  if (split.free > 0) await addGrant(tx, { userId, source: 'pack', amount: split.free, reason: 'earned_converted', refId: conversionId, converted: true, note: 'converted from earnings paid with free credits' }, now);
  return { ok: true, converted: credits, received, conversionId };
}
