/**
 * Billing paid work that is not one knowledge source's processing run, and
 * the settlement every run shares (docs/audit/credit-import-audit.md).
 *
 * The rule is the knowledge rule: the owner pays every supplier and transfer
 * cost the work incurs, rounded up once per run; a failure keeps what was
 * spent and returns only what was reserved and never used; whatever the
 * balance cannot cover is owed (`takeOrOwe`). Each run is a `knowledge` hold
 * and a `knowledge_cost_run` row (`kind` names the work, `knowledge_id` is
 * empty), so the admin cost report lists it with the rest.
 */
import { and, eq, sql } from 'drizzle-orm';
import { providerTotal, type ProviderCharge } from '@/lib/domain/provider-cost';
import { drainProviderCalls, flushTransfer, withProviderMeter } from '@/lib/infra/ai/provider-meter';
import { db, schema, type Tx } from '@/lib/infra/db';
import { chargeKnowledgeShortfall, InsufficientCredits, placeHold, releaseHold, reserveKnowledgeUsage, settleHold, takeOrOwe } from '@/lib/services/credits';
import { providerPrices } from '@/lib/services/provider-pricing';

export interface RunSettlement {
  /** Credits the run cost the owner: taken from the balance plus owed. */
  charged: number;
  released: number;
  owed: number;
  /** True when nothing was spent and the whole reservation went back. */
  refunded: boolean;
}

/**
 * Closes a run's hold at what the run spent: every resolved receipt, rounded
 * up once. A receipt nobody could price keeps the whole reservation (its cost
 * is unknown, so nothing reserved for it is given back). Nothing spent: the
 * whole hold is released.
 */
export async function settleRun(
  tx: Tx,
  holdId: string,
  charges: readonly Pick<ProviderCharge, 'costUsd'>[],
  options: { reeId: string | null; note?: string | null },
): Promise<RunSettlement | null> {
  const [hold] = await tx.select().from(schema.creditHold).where(and(eq(schema.creditHold.id, holdId), eq(schema.creditHold.status, 'held'))).for('update');
  if (!hold) return null;
  const resolved = charges.filter((charge) => charge.costUsd !== null);
  const known = resolved.length > 0 ? providerTotal(resolved).credits : 0;
  const spent = resolved.length < charges.length ? Math.max(known, hold.amount) : known;
  if (spent === 0) {
    const released = await releaseHold(tx, holdId, { reeId: options.reeId, note: options.note });
    return { charged: 0, released: released ?? 0, owed: 0, refunded: true };
  }
  const owed = await chargeKnowledgeShortfall(tx, holdId, spent, options);
  const settled = await settleHold(tx, holdId, spent, options);
  return { charged: (settled?.charged ?? 0) + owed, released: settled?.released ?? 0, owed, refunded: false };
}

/**
 * A receipt that arrived after its run was closed (a worker presumed dead
 * whose call still answered): its run is billed the difference between what
 * all its resolved receipts now cost and what it was charged. Answers the
 * credits charged now.
 */
export async function chargeLateReceipt(tx: Tx, runId: string): Promise<number> {
  const [run] = await tx.select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.runId, runId)).for('update');
  if (!run || run.status === 'pending' || run.status === 'processing') return 0;
  const resolved = run.charges.filter((charge) => charge.costUsd !== null);
  const due = (resolved.length > 0 ? providerTotal(resolved).credits : 0) - (run.chargedCredits ?? 0);
  if (due <= 0) return 0;
  await takeOrOwe(tx, { userId: run.userId, amount: due, reason: 'knowledge_hold', refId: run.knowledgeId ?? run.id, reeId: run.reeId, note: `${run.title} (late receipt)` });
  await tx.update(schema.knowledgeCostRun).set({ chargedCredits: (run.chargedCredits ?? 0) + due }).where(eq(schema.knowledgeCostRun.id, run.id));
  return due;
}

export type MeteredKind = 'profile' | 'suggestions' | 'reembed';

export interface MeteredWork {
  userId: string;
  reeId: string | null;
  kind: MeteredKind;
  /** What the ledger and the cost report call it. */
  title: string;
  reeName: string;
  /**
   * `refuse`: the work is optional, so a balance that cannot cover a call's
   * estimate stops it before the call (`InsufficientCredits`). Otherwise the
   * work must happen (a model switch, the explore index) and what the balance
   * cannot cover is owed.
   */
  refuse: boolean;
}

/** Runs `work` with every supplier call and transfer in it billed to `input.userId`. */
export async function meteredWork<T>(input: MeteredWork, work: () => Promise<T>): Promise<T> {
  const runId = crypto.randomUUID();
  const prices = await providerPrices();
  const now = new Date();
  const holdId = await db().transaction(async (tx) => {
    const id = await placeHold(tx, { userId: input.userId, kind: 'knowledge', amount: input.refuse ? 1 : 0, refId: runId, reeId: input.reeId, note: input.title }, now);
    await tx.insert(schema.knowledgeCostRun).values({
      id, knowledgeId: null, reeId: input.reeId, userId: input.userId, title: input.title, reeName: input.reeName,
      kind: input.kind, runId, status: 'processing', metered: true, createdAt: now,
    });
    return id;
  });
  const inflight = new Map<symbol, string>();
  const locked = async (tx: Tx) => {
    const [run] = await tx.select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.id, holdId)).for('update');
    return run!;
  };
  const record = async (charge: ProviderCharge): Promise<void> => {
    const refusal = await db().transaction(async (tx) => {
      const run = await locked(tx);
      if (run.charges.some((entry) => entry.id === charge.id)) return null;
      await tx.update(schema.knowledgeCostRun).set({ charges: sql`${schema.knowledgeCostRun.charges} || ${JSON.stringify([charge])}::jsonb` }).where(eq(schema.knowledgeCostRun.id, holdId));
      if (run.status !== 'processing') {
        await chargeLateReceipt(tx, runId);
        return null;
      }
      if (!input.refuse || charge.costUsd === null) return null;
      const known = [...run.charges, charge].filter((entry) => entry.costUsd !== null);
      try {
        await reserveKnowledgeUsage(tx, holdId, providerTotal(known).credits, { reeId: input.reeId, note: input.title });
      } catch (error) {
        if (error instanceof InsufficientCredits) return error;
        throw error;
      }
      return null;
    });
    if (refusal) throw refusal;
  };
  const reserve = async (costUsd: string): Promise<() => void> => {
    const key = Symbol('estimate');
    inflight.set(key, costUsd);
    try {
      await db().transaction(async (tx) => {
        const run = await locked(tx);
        const known = run.charges.filter((entry) => entry.costUsd !== null);
        await reserveKnowledgeUsage(tx, holdId, providerTotal([...known, ...[...inflight.values()].map((cost) => ({ costUsd: cost }))]).credits, { reeId: input.reeId, note: input.title });
      });
    } catch (error) {
      inflight.delete(key);
      throw error;
    }
    return () => { inflight.delete(key); };
  };
  const outcome: { ok: true; value: T } | { ok: false; error: unknown } = await withProviderMeter({ runId, prices, record, ...(input.refuse ? { reserve } : {}) }, async () => {
    try {
      const value = await work();
      await flushTransfer();
      return { ok: true as const, value };
    } catch (error) {
      await drainProviderCalls();
      await flushTransfer().catch(() => undefined);
      return { ok: false as const, error };
    }
  });
  // A success with a receipt nobody can price is billed as a failure would be, never as zero.
  await db().transaction(async (tx) => {
    const run = await locked(tx);
    const settled = await settleRun(tx, holdId, run.charges, { reeId: input.reeId, note: input.title });
    const error = outcome.ok ? null : outcome.error instanceof InsufficientCredits ? 'insufficient_credits' : 'failed';
    await tx.update(schema.knowledgeCostRun)
      .set({ status: outcome.ok ? 'ready' : 'failed', error, chargedCredits: settled?.charged ?? 0 })
      .where(eq(schema.knowledgeCostRun.id, holdId));
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
