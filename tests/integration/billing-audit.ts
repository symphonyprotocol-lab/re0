/**
 * The knowledge billing invariant (docs/audit/credit-import-audit.md): for
 * every processing run -- ready or failed, since a failure keeps what it
 * spent (P1) -- the credits charged are at least the cost of every receipt
 * the run recorded (suppliers and our own transfer), rounded up once.
 * Charged means taken from the balance plus what the balance could not cover
 * and is now owed. The ledger agrees with the runs, no reservation is left
 * open, and a ready source carries no unresolved receipt.
 */
import { and, eq, gt } from 'drizzle-orm';
import { expect } from 'vitest';
import { providerTotal } from '@/lib/domain/provider-cost';
import { db, schema } from '@/lib/infra/db';

export interface RunBill {
  status: string;
  error: string | null;
  /** Supplier cost of the run's receipts, in credits, rounded up once. */
  cost: number;
  charged: number;
  owed: number;
  receipts: number;
  unresolved: number;
}

export async function knowledgeBill(knowledgeId: string): Promise<{ runs: RunBill[]; net: number; owed: number; open: number }> {
  const [runs, entries, holds, [row]] = await Promise.all([
    db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.knowledgeId, knowledgeId)).orderBy(schema.knowledgeCostRun.createdAt),
    db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, knowledgeId)),
    db().select().from(schema.creditHold).where(and(eq(schema.creditHold.refId, knowledgeId), eq(schema.creditHold.status, 'held'))),
    db().select({ activity: schema.knowledge.activity }).from(schema.knowledge).where(eq(schema.knowledge.id, knowledgeId)),
  ]);
  const settledOwed = (row?.activity ?? []).filter((entry) => entry.code === 'settled' || entry.code === 'refunded').map((entry) => Number(entry.detail?.owed ?? 0));
  const bills = runs.map((run, at) => {
    const known = run.charges.filter((charge) => charge.costUsd !== null);
    const owed = settledOwed[at] ?? 0;
    return {
      status: run.status,
      error: run.error,
      cost: known.length > 0 ? providerTotal(known).credits : 0,
      charged: run.chargedCredits ?? 0,
      owed,
      receipts: run.charges.length,
      unresolved: run.charges.length - known.length,
    };
  });
  return {
    runs: bills,
    net: -entries.reduce((sum, entry) => sum + entry.delta, 0),
    owed: bills.reduce((sum, run) => sum + run.owed, 0),
    open: holds.length,
  };
}

/**
 * Asserts the invariant for a source whose runs have all finished: each run
 * charged ≥ its cost (ready runs have no unresolved receipt; a run that
 * spent nothing charged nothing), and the ledger's net debit plus what is
 * owed equals the sum charged.
 */
export async function expectChargedAtLeastCost(knowledgeId: string): Promise<RunBill[]> {
  const bill = await knowledgeBill(knowledgeId);
  expect(bill.open).toBe(0);
  expect(bill.runs.length).toBeGreaterThan(0);
  for (const run of bill.runs) {
    expect(['ready', 'failed']).toContain(run.status);
    expect(run.charged).toBeGreaterThanOrEqual(run.cost);
    if (run.receipts === 0) expect(run.charged).toBe(0);
  }
  for (const run of bill.runs.filter((entry) => entry.status === 'ready')) {
    expect(run.receipts).toBeGreaterThan(0);
    expect(run.unresolved).toBe(0);
  }
  expect(bill.net + bill.owed).toBe(bill.runs.reduce((sum, run) => sum + run.charged, 0));
  return bill.runs;
}

/** What a user owes: open `credit_debt` rows. */
export async function debtOf(userId: string): Promise<number> {
  const rows = await db().select({ remaining: schema.creditDebt.remaining }).from(schema.creditDebt)
    .where(and(eq(schema.creditDebt.userId, userId), gt(schema.creditDebt.remaining, 0)));
  return rows.reduce((sum, row) => sum + Number(row.remaining), 0);
}
