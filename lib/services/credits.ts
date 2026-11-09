/**
 * The credit ledger against the database (rebuild-proposal.md 2.3, 4). Every
 * function takes the caller's transaction: a hold, a settlement or a release
 * moves grants and appends the matching `credit_entry` row together, or not
 * at all. Grants are locked `FOR UPDATE` so two holds cannot spend the same
 * credit.
 */
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { CreditEntryReason } from '@/db/schema';
import { type GrantSource } from '@/lib/constants';
import { offsetDebts } from '@/lib/domain/billing';
import {
  allocate,
  availableOf,
  releaseFrom,
  settlement,
  settlementNote,
  type Allocation,
  type SpendableGrant,
} from '@/lib/domain/credits';
import { welcomeCredits } from '@/lib/services/signup-reward';
import { schema, type Executor, type Tx } from '@/lib/infra/db';

export { InsufficientCredits } from '@/lib/domain/credits';

type HoldKind = 'chat' | 'knowledge' | 'video' | 'payout';

/**
 * The reasons each hold kind writes when it is taken, settled and released.
 * A question to someone else's Ree holds the owner's query fee apart from
 * the base fee (`ledger: 'chat_fee'`), so the ledger shows the two as
 * `query_base` and `query_fee_paid` (2.3).
 */
const REASONS: Record<'chat' | 'knowledge' | 'chat_fee' | 'chat_verify' | 'chat_synthesis' | 'payout' | VideoLedger, { hold: CreditEntryReason; settle: CreditEntryReason; release: CreditEntryReason }> = {
  chat: { hold: 'query_hold', settle: 'query_base', release: 'query_refund' },
  chat_fee: { hold: 'query_fee_paid', settle: 'query_fee_paid', release: 'query_refund' },
  /* 回答核验: the check fee of one answering Ree, held with the question, to the platform. */
  chat_verify: { hold: 'verify_hold', settle: 'verify_settle', release: 'verify_refund' },
  /* Ree 圆桌: one synthesis of a question's answers, to the platform. */
  chat_synthesis: { hold: 'synthesis_hold', settle: 'synthesis_settle', release: 'synthesis_refund' },
  knowledge: { hold: 'knowledge_hold', settle: 'knowledge_settle', release: 'knowledge_refund' },
  /* Step 6: a payout request holds earned credits; payment settles the whole hold, rejection or failure releases it. */
  payout: { hold: 'payout_hold', settle: 'payout_paid', release: 'payout_release' },
  /* Step 7: a `video` hold is a script or an export; both are given back as `video_refund`. */
  video_script: { hold: 'video_script', settle: 'video_script', release: 'video_refund' },
  video_export: { hold: 'video_export', settle: 'video_export', release: 'video_refund' },
};

type Ledger = keyof typeof REASONS;
/** Which ledger a `video` hold writes; every video hold, settlement and release names one. */
type VideoLedger = 'video_script' | 'video_export';
type SubLedger = 'chat_fee' | 'chat_verify' | 'chat_synthesis' | VideoLedger;

function reasonsFor(kind: string, ledger?: SubLedger) {
  return REASONS[(ledger ?? kind) as Ledger];
}

export async function grantWelcome(tx: Tx, userId: string, now = new Date()): Promise<void> {
  const { credits } = await welcomeCredits(tx);
  if (credits === 0) return;
  const [grant] = await tx
    .insert(schema.creditGrant)
    .values({ userId, source: 'welcome', amount: credits, remaining: credits, createdAt: now })
    .returning({ id: schema.creditGrant.id });
  await tx.insert(schema.creditEntry).values({
    userId,
    delta: credits,
    reason: 'welcome',
    refId: grant!.id,
    allocations: [{ grantId: grant!.id, source: 'welcome', amount: credits }],
    createdAt: now,
  });
}

/**
 * Credits arriving: a grant and its entry, then any open debt (a refund that
 * found the credits already spent) paid off from it first, oldest debt
 * first, with a `debt_offset` entry against the new grant (2.3).
 */
export async function addGrant(
  tx: Tx,
  input: {
    userId: string;
    source: GrantSource;
    amount: number;
    reason: CreditEntryReason;
    refId: string;
    expiresAt?: Date | null;
    periodStart?: Date | null;
    purchaseId?: string | null;
    note?: string | null;
    /** The Ree the credits came from (step 4's query fees), so per-Ree statistics can attribute them. */
    reeId?: string | null;
  },
  now = new Date(),
): Promise<{ grantId: string; offset: number }> {
  const [grant] = await tx
    .insert(schema.creditGrant)
    .values({
      userId: input.userId,
      source: input.source,
      amount: input.amount,
      remaining: input.amount,
      expiresAt: input.expiresAt ?? null,
      periodStart: input.periodStart ?? null,
      purchaseId: input.purchaseId ?? null,
      createdAt: now,
    })
    .returning({ id: schema.creditGrant.id });
  const grantId = grant!.id;
  await tx.insert(schema.creditEntry).values({
    userId: input.userId,
    delta: input.amount,
    reason: input.reason,
    refId: input.refId,
    reeId: input.reeId ?? null,
    note: input.note ?? null,
    allocations: [{ grantId, source: input.source, amount: input.amount }],
    createdAt: now,
  });
  const debts = await tx
    .select({ id: schema.creditDebt.id, remaining: schema.creditDebt.remaining })
    .from(schema.creditDebt)
    .where(and(eq(schema.creditDebt.userId, input.userId), gt(schema.creditDebt.remaining, 0)))
    .orderBy(asc(schema.creditDebt.createdAt))
    .for('update');
  const offsets = offsetDebts(debts, input.amount);
  const offset = offsets.reduce((sum, entry) => sum + entry.amount, 0);
  if (offset === 0) return { grantId, offset };
  for (const entry of offsets) {
    await tx
      .update(schema.creditDebt)
      .set({
        remaining: sql`${schema.creditDebt.remaining} - ${entry.amount}`,
        clearedAt: sql`case when ${schema.creditDebt.remaining} = ${entry.amount} then ${now.toISOString()}::timestamptz else null end`,
      })
      .where(eq(schema.creditDebt.id, entry.debtId));
  }
  await tx
    .update(schema.creditGrant)
    .set({ remaining: sql`${schema.creditGrant.remaining} - ${offset}` })
    .where(eq(schema.creditGrant.id, grantId));
  await tx.insert(schema.creditEntry).values({
    userId: input.userId,
    delta: -offset,
    reason: 'debt_offset',
    refId: offsets[0]!.debtId,
    note: `debts ${offsets.map((entry) => `${entry.debtId}:${entry.amount}`).join(', ')}`,
    allocations: [{ grantId, source: input.source, amount: offset }],
    createdAt: now,
  });
  return { grantId, offset };
}

/**
 * Plan credits whose period ended by `cutoff` are written off: remaining to
 * zero, one `expire` entry per grant. Locked rows are skipped, so the cron
 * and a renewal never fight over one; whatever is skipped goes next run.
 * Idempotent: an expired grant has nothing left to expire. Credits a later
 * hold release returns to an expired grant are written off the same way.
 */
export async function expirePlanGrants(
  tx: Tx,
  options: { userId?: string; cutoff: Date; limit?: number },
  now = new Date(),
): Promise<number> {
  const conditions = [eq(schema.creditGrant.source, 'plan'), gt(schema.creditGrant.remaining, 0), lte(schema.creditGrant.expiresAt, options.cutoff)];
  if (options.userId) conditions.push(eq(schema.creditGrant.userId, options.userId));
  const query = tx
    .select({
      id: schema.creditGrant.id,
      userId: schema.creditGrant.userId,
      remaining: schema.creditGrant.remaining,
      purchaseId: schema.creditGrant.purchaseId,
      expiresAt: schema.creditGrant.expiresAt,
    })
    .from(schema.creditGrant)
    .where(and(...conditions))
    .orderBy(asc(schema.creditGrant.expiresAt));
  const due = await (options.limit ? query.limit(options.limit) : query).for('update', { skipLocked: true });
  for (const grant of due) {
    await tx.update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.id, grant.id));
    await tx.insert(schema.creditEntry).values({
      userId: grant.userId,
      delta: -grant.remaining,
      reason: 'expire',
      refId: grant.purchaseId ?? grant.id,
      note: `plan period ended ${grant.expiresAt!.toISOString()}`,
      allocations: [{ grantId: grant.id, source: 'plan', amount: grant.remaining }],
      createdAt: now,
    });
  }
  return due.length;
}

export async function grantsOf(executor: Executor, userId: string, lock: boolean): Promise<SpendableGrant[]> {
  const query = executor
    .select({
      id: schema.creditGrant.id,
      source: schema.creditGrant.source,
      remaining: schema.creditGrant.remaining,
      expiresAt: schema.creditGrant.expiresAt,
      createdAt: schema.creditGrant.createdAt,
    })
    .from(schema.creditGrant)
    .where(and(eq(schema.creditGrant.userId, userId), sql`${schema.creditGrant.remaining} > 0`));
  return lock ? query.for('update') : query;
}

export async function balanceOf(executor: Executor, userId: string, now = new Date()): Promise<number> {
  return availableOf(await grantsOf(executor, userId, false), now);
}

export async function moveGrants(tx: Tx, allocations: readonly Allocation[], direction: -1 | 1): Promise<void> {
  for (const entry of allocations) {
    if (entry.amount === 0) continue;
    await tx
      .update(schema.creditGrant)
      .set({ remaining: sql`${schema.creditGrant.remaining} + ${direction * entry.amount}` })
      .where(eq(schema.creditGrant.id, entry.grantId));
  }
}

export interface HoldInput {
  userId: string;
  kind: 'chat' | 'knowledge' | 'payout' | 'video';
  amount: number;
  refId: string;
  reeId?: string | null;
  note?: string | null;
  /** `chat_fee`: the query-fee part of a question, written as `query_fee_paid`; `chat_verify`: its check fee; `chat_synthesis`: a synthesis of its answers; a video hold's script or export. */
  ledger?: SubLedger;
  /** Only these grants may pay (a payout draws on earned credits alone, 2.3). */
  sources?: readonly GrantSource[];
}

/**
 * Takes `amount` out of the user's grants into a hold and writes the hold
 * entry. Throws `InsufficientCredits` when the balance cannot cover it --
 * nothing is overdrawn.
 */
export async function placeHold(tx: Tx, input: HoldInput, now = new Date()): Promise<string> {
  const grants = (await grantsOf(tx, input.userId, true)).filter((grant) => !input.sources || input.sources.includes(grant.source));
  const allocations = allocate(grants, input.amount, now);
  await moveGrants(tx, allocations, -1);
  const [hold] = await tx
    .insert(schema.creditHold)
    .values({
      userId: input.userId,
      kind: input.kind,
      amount: input.amount,
      allocations,
      refId: input.refId,
      createdAt: now,
    })
    .returning({ id: schema.creditHold.id });
  await tx.insert(schema.creditEntry).values({
    userId: input.userId,
    delta: -input.amount,
    reason: reasonsFor(input.kind, input.ledger).hold,
    refId: input.refId,
    reeId: input.reeId ?? null,
    note: input.note ?? null,
    allocations,
    createdAt: now,
  });
  return hold!.id;
}

async function openHold(tx: Tx, holdId: string) {
  const [hold] = await tx
    .select()
    .from(schema.creditHold)
    .where(and(eq(schema.creditHold.id, holdId), eq(schema.creditHold.status, 'held')))
    .for('update');
  return hold ?? null;
}

/** Increase a knowledge reservation to its measured cost before embedding.
 * The caller locks the source first. Allocation and the extra ledger debit
 * are atomic; failure leaves the original reservation intact for refund.
 */
export async function reserveKnowledgeUsage(
  tx: Tx,
  holdId: string,
  actual: number,
  options: { reeId: string | null; note?: string | null },
  now = new Date(),
): Promise<number> {
  if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('invalid knowledge price');
  const hold = await openHold(tx, holdId);
  if (!hold || hold.kind !== 'knowledge') throw new Error('knowledge reservation unavailable');
  const extra = Math.max(0, actual - hold.amount);
  if (extra === 0) return 0;
  const allocations = allocate(await grantsOf(tx, hold.userId, true), extra, now);
  await moveGrants(tx, allocations, -1);
  await tx.update(schema.creditHold).set({ amount: actual, allocations: [...hold.allocations, ...allocations] }).where(eq(schema.creditHold.id, holdId));
  await tx.insert(schema.creditEntry).values({
    userId: hold.userId,
    delta: -extra,
    reason: 'knowledge_hold',
    refId: hold.refId,
    reeId: options.reeId,
    note: options.note ?? null,
    allocations,
    createdAt: now,
  });
  return extra;
}

/**
 * Takes `amount` from the balance as far as it goes and owes the rest: one
 * entry (written even when the balance is empty, so the ledger shows what is
 * owed) and, for the part nothing could cover, a `credit_debt` row the next
 * credits to arrive pay off first (as a refund's shortfall is, 2.3). For
 * costs already incurred, which are never undercounted. Returns what was
 * taken, its allocations, and the debt.
 */
export async function takeOrOwe(
  tx: Tx,
  input: { userId: string; amount: number; reason: CreditEntryReason; refId: string | null; reeId?: string | null; note?: string | null },
  now = new Date(),
): Promise<{ taken: number; owed: number; allocations: Allocation[] }> {
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new Error('invalid charge');
  if (input.amount === 0) return { taken: 0, owed: 0, allocations: [] };
  const grants = await grantsOf(tx, input.userId, true);
  const taken = Math.min(input.amount, availableOf(grants, now));
  const allocations = taken > 0 ? allocate(grants, taken, now) : [];
  await moveGrants(tx, allocations, -1);
  const owed = input.amount - taken;
  await tx.insert(schema.creditEntry).values({
    userId: input.userId,
    delta: -taken,
    reason: input.reason,
    refId: input.refId,
    reeId: input.reeId ?? null,
    note: owed > 0 ? `${input.note ?? ''}${input.note ? ': ' : ''}${owed} owed` : (input.note ?? null),
    allocations,
    createdAt: now,
  });
  if (owed > 0) await tx.insert(schema.creditDebt).values({ userId: input.userId, amount: owed, remaining: owed, createdAt: now });
  return { taken, owed, allocations };
}

/**
 * A knowledge run whose incurred cost is more than its reservation (it ran
 * out of credits after a supplier billed it, or it failed): the cost is the
 * owner's in full. The hold grows by whatever the balance still has
 * (`takeOrOwe`, written as `knowledge_hold`); the rest is owed. Returns the
 * debt. The caller then settles the hold at `actual`.
 */
export async function chargeKnowledgeShortfall(
  tx: Tx,
  holdId: string,
  actual: number,
  options: { reeId: string | null; note?: string | null },
  now = new Date(),
): Promise<number> {
  if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('invalid knowledge price');
  const hold = await openHold(tx, holdId);
  if (!hold || hold.kind !== 'knowledge') throw new Error('knowledge reservation unavailable');
  const need = actual - hold.amount;
  if (need <= 0) return 0;
  const { taken, owed, allocations } = await takeOrOwe(tx, { userId: hold.userId, amount: need, reason: 'knowledge_hold', refId: hold.refId, reeId: options.reeId, note: options.note }, now);
  await tx.update(schema.creditHold).set({ amount: hold.amount + taken, allocations: [...hold.allocations, ...allocations] }).where(eq(schema.creditHold.id, holdId));
  return owed;
}

/**
 * Charges `actual` (capped at what was held) and returns the rest. Always
 * writes the settlement entry -- with delta 0 when the hold was exact -- so
 * the ledger shows a hold and its settlement as a pair.
 */
export async function settleHold(
  tx: Tx,
  holdId: string,
  actual: number,
  options: { reeId?: string | null; note?: string | null; ledger?: SubLedger } = {},
  now = new Date(),
): Promise<{ charged: number; released: number } | null> {
  const hold = await openHold(tx, holdId);
  if (!hold) return null;
  const { charged, released } = settlement(hold.amount, actual);
  const returned = releaseFrom(hold.allocations, released);
  await moveGrants(tx, returned, 1);
  await tx
    .update(schema.creditHold)
    .set({ status: 'settled', closedAt: now })
    .where(eq(schema.creditHold.id, holdId));
  await tx.insert(schema.creditEntry).values({
    userId: hold.userId,
    delta: released,
    reason: reasonsFor(hold.kind, options.ledger).settle,
    refId: hold.refId,
    reeId: options.reeId ?? null,
    note: settlementNote(options.note, charged, hold.amount),
    allocations: returned,
    createdAt: now,
  });
  return { charged, released };
}

/** Returns a whole hold: processing failed, the question went unanswered. */
export async function releaseHold(
  tx: Tx,
  holdId: string,
  options: { reeId?: string | null; note?: string | null; ledger?: SubLedger } = {},
  now = new Date(),
): Promise<number | null> {
  const hold = await openHold(tx, holdId);
  if (!hold) return null;
  await moveGrants(tx, hold.allocations, 1);
  await tx
    .update(schema.creditHold)
    .set({ status: 'released', closedAt: now })
    .where(eq(schema.creditHold.id, holdId));
  await tx.insert(schema.creditEntry).values({
    userId: hold.userId,
    delta: hold.amount,
    reason: reasonsFor(hold.kind, options.ledger).release,
    refId: hold.refId,
    reeId: options.reeId ?? null,
    note: options.note ?? null,
    allocations: hold.allocations,
    createdAt: now,
  });
  return hold.amount;
}

/** The open hold for a reference (a knowledge row being processed), if any. */
export async function heldFor(executor: Executor, refId: string, kind: HoldKind): Promise<string | null> {
  const [hold] = await executor
    .select({ id: schema.creditHold.id })
    .from(schema.creditHold)
    .where(and(eq(schema.creditHold.refId, refId), eq(schema.creditHold.kind, kind), eq(schema.creditHold.status, 'held')))
    .limit(1);
  return hold?.id ?? null;
}

export async function entriesFor(executor: Executor, refIds: string[]) {
  if (refIds.length === 0) return [];
  return executor
    .select()
    .from(schema.creditEntry)
    .where(inArray(schema.creditEntry.refId, refIds))
    .orderBy(schema.creditEntry.createdAt);
}
