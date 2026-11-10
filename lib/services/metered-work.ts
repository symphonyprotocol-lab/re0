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

/** A metered run kept open across several pieces of work, settled once (`closeMeteredRun`). */
export interface MeteredRun {
  holdId: string;
  runId: string;
  input: MeteredWork;
}

/**
 * Opens a run: its hold (1 credit to prove the balance when the work can be
 * refused, else 0) and its `knowledge_cost_run` row in `processing`.
 * `runId` names the run (unique); `refId` is what the ledger entries point at.
 */
export async function openMeteredRun(input: MeteredWork, options: { runId?: string; refId?: string } = {}, now = new Date()): Promise<MeteredRun> {
  const runId = options.runId ?? crypto.randomUUID();
  const holdId = await db().transaction(async (tx) => {
    const id = await placeHold(tx, { userId: input.userId, kind: 'knowledge', amount: input.refuse ? 1 : 0, refId: options.refId ?? runId, reeId: input.reeId, note: input.title }, now);
    await tx.insert(schema.knowledgeCostRun).values({
      id, knowledgeId: null, reeId: input.reeId, userId: input.userId, title: input.title, reeName: input.reeName,
      kind: input.kind, runId, status: 'processing', metered: true, createdAt: now,
    });
    return id;
  });
  return { holdId, runId, input };
}

/** The open run named `runId`, if there is one. */
export async function openRunNamed(runId: string, input: MeteredWork): Promise<MeteredRun | null> {
  const [row] = await db()
    .select({ id: schema.knowledgeCostRun.id })
    .from(schema.knowledgeCostRun)
    .where(and(eq(schema.knowledgeCostRun.runId, runId), eq(schema.knowledgeCostRun.status, 'processing')))
    .limit(1);
  return row ? { holdId: row.id, runId, input } : null;
}

const lockedRun = async (tx: Tx, holdId: string) => {
  const [run] = await tx.select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.id, holdId)).for('update');
  return run!;
};

/**
 * Runs `work` with every supplier call and transfer in it recorded on `run`
 * (as each receipt arrives, in its own transaction, so a function that dies
 * later loses none of them). Does not settle: see `closeMeteredRun`.
 */
export async function meterInto<T>(run: MeteredRun, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const { holdId, runId, input } = run;
  const prices = await providerPrices();
  const inflight = new Map<symbol, string>();
  const record = async (charge: ProviderCharge): Promise<void> => {
    const refusal = await db().transaction(async (tx) => {
      const current = await lockedRun(tx, holdId);
      if (current.charges.some((entry) => entry.id === charge.id)) return null;
      await tx.update(schema.knowledgeCostRun).set({ charges: sql`${schema.knowledgeCostRun.charges} || ${JSON.stringify([charge])}::jsonb` }).where(eq(schema.knowledgeCostRun.id, holdId));
      if (current.status !== 'processing') {
        await chargeLateReceipt(tx, runId);
        return null;
      }
      if (!input.refuse || charge.costUsd === null) return null;
      const known = [...current.charges, charge].filter((entry) => entry.costUsd !== null);
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
        const current = await lockedRun(tx, holdId);
        const known = current.charges.filter((entry) => entry.costUsd !== null);
        await reserveKnowledgeUsage(tx, holdId, providerTotal([...known, ...[...inflight.values()].map((cost) => ({ costUsd: cost }))]).credits, { reeId: input.reeId, note: input.title });
      });
    } catch (error) {
      inflight.delete(key);
      throw error;
    }
    return () => { inflight.delete(key); };
  };
  /* Optional work is never sent to a supplier whose price is unknown beforehand (it could not be reserved). */
  return withProviderMeter({ runId, prices, record, ...(input.refuse ? { reserve, requireRate: true } : {}) }, async () => {
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
}

/**
 * Settles an open run at everything it recorded (`settleRun`) and closes it
 * `ready` or `failed`. A run already closed (by another closer, or the
 * reaper) is left as it is (null). Answers the credits charged now.
 */
export async function closeMeteredRun(run: MeteredRun, error: string | null): Promise<number | null> {
  return db().transaction(async (tx) => {
    const current = await lockedRun(tx, run.holdId);
    if (current.status !== 'processing') return null;
    // A success with a receipt nobody can price is billed as a failure would be, never as zero.
    const settled = await settleRun(tx, run.holdId, current.charges, { reeId: run.input.reeId, note: run.input.title });
    await tx.update(schema.knowledgeCostRun)
      .set({ status: error === null ? 'ready' : 'failed', error, chargedCredits: settled?.charged ?? 0 })
      .where(eq(schema.knowledgeCostRun.id, run.holdId));
    return settled?.charged ?? 0;
  });
}

/** Runs `work` with every supplier call and transfer in it billed to `input.userId`, settled at once. */
export async function meteredWork<T>(input: MeteredWork, work: () => Promise<T>): Promise<T> {
  const run = await openMeteredRun(input);
  const outcome = await meterInto(run, work);
  await closeMeteredRun(run, outcome.ok ? null : outcome.error instanceof InsufficientCredits ? 'insufficient_credits' : 'failed');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** How long a one-shot metered run (profile, example questions) may stay open: far past any function's life. */
export const METERED_RUN_STALE_MS = 30 * 60_000;

/**
 * The backstop for a function that died between placing a run's hold and
 * settling it (a timeout, a deploy): every metered run still `processing`
 * past `METERED_RUN_STALE_MS` is settled at the receipts it recorded and
 * failed as `abandoned` -- what it spent is charged, what it reserved and
 * never used goes back. A re-embed run belongs to its job and stays open
 * while that job runs; `settleReembedRuns` closes it once the job is over.
 * Answers how many runs it closed.
 */
export async function reapMeteredRuns(now = new Date(), limit = 200): Promise<number> {
  const cutoff = new Date(now.getTime() - METERED_RUN_STALE_MS);
  const stale = await db().execute<{ id: string; run_id: string; user_id: string; ree_id: string | null; kind: string; title: string; ree_name: string }>(sql`
    select r.id, r.run_id, r.user_id, r.ree_id, r.kind, r.title, r.ree_name
    from ${schema.knowledgeCostRun} r
    where r.status = 'processing' and r.knowledge_id is null and r.metered and r.kind in ('profile', 'suggestions')
      and r.created_at < ${cutoff}
    order by r.created_at
    limit ${limit}`);
  let closed = 0;
  for (const row of stale.rows) {
    const input: MeteredWork = { userId: row.user_id, reeId: row.ree_id, kind: row.kind as MeteredKind, title: row.title, reeName: row.ree_name, refuse: row.kind === 'suggestions' };
    if ((await closeMeteredRun({ holdId: row.id, runId: row.run_id, input }, 'abandoned')) !== null) closed += 1;
  }
  return closed;
}
