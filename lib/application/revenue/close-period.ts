/**
 * Closing a revenue period. agent-first-proposal.md 6.9, architecture.md
 * 11.4: settlement is a batch outside the request path, reads the earning
 * ledger and the period row, and can be re-run -- a second close of a locked
 * period returns the frozen numbers instead of computing new ones.
 *
 * The whole close runs in one transaction against a `FOR UPDATE` lock on the
 * period row, so two concurrent closes serialise and the per-owner sums and
 * the period total read one consistent snapshot. There is no pool and no
 * allocation: every event already carries its amount (the creator's share of
 * one collection, or the negative of a refund), so a close is a sum per owner
 * and nothing else, recomputable from the events alone.
 *
 * Accounting only. No statement or payout row is written here; the console's
 * `generateSettlements` turns the sums into statements.
 */
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface PeriodAllocation {
  ownerWorkspaceId: string;
  /** The owner's unflagged events in the period, summed; negative when refunds outweighed income. */
  amountMinor: number;
}

export interface ClosedPeriod {
  periodId: string;
  currency: string;
  /** All owners together, as frozen on the period row. */
  totalAmountMinor: number;
  allocations: PeriodAllocation[];
  alreadyLocked: boolean;
}

const PERIOD_ID = /^(\d{4})-(\d{2})$/;

export async function closePeriod(periodId: string): Promise<ClosedPeriod> {
  const match = PERIOD_ID.exec(periodId);
  if (!match) throw new AppError('invalid_request', 'a period id looks like 2026-08');
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const end = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  if (Number.isNaN(start.getTime()) || start.getUTCMonth() !== Number(match[2]) - 1) {
    throw new AppError('invalid_request', 'a period id looks like 2026-08');
  }
  if (end.getTime() > Date.now()) {
    throw new AppError('invalid_request', 'the period is not over yet');
  }

  const database = db();
  return database.transaction(async (tx) => {
    /* The period row is the lock. Insert-if-absent, then FOR UPDATE. */
    await tx
      .insert(schema.revenuePeriod)
      .values({ id: periodId })
      .onConflictDoNothing({ target: schema.revenuePeriod.id });
    const [period] = await tx
      .select()
      .from(schema.revenuePeriod)
      .where(eq(schema.revenuePeriod.id, periodId))
      .for('update');

    const allocations = await ownerSums(tx, periodId);

    if (period?.lockedAt) {
      return {
        periodId,
        currency: period.currency,
        totalAmountMinor: Number(period.totalAmountMinor),
        allocations,
        alreadyLocked: true,
      };
    }

    const totalAmountMinor = allocations.reduce((total, owner) => total + owner.amountMinor, 0);
    await tx
      .update(schema.revenuePeriod)
      .set({ totalAmountMinor, lockedAt: new Date() })
      .where(eq(schema.revenuePeriod.id, periodId));

    return {
      periodId,
      currency: period?.currency ?? 'USD',
      totalAmountMinor,
      allocations,
      alreadyLocked: false,
    };
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

/**
 * Per-owner sums of the period's unflagged events. Owners that net to zero
 * are left out: a statement for nothing is nothing to hold or pay.
 */
async function ownerSums(tx: Tx, periodId: string): Promise<PeriodAllocation[]> {
  const owners = await tx
    .select({
      ownerWorkspaceId: schema.earningEvent.ownerWorkspaceId,
      amountMinor: sql<number>`coalesce(sum(${schema.earningEvent.amountMinor}), 0)::bigint`,
    })
    .from(schema.earningEvent)
    .where(and(eq(schema.earningEvent.periodId, periodId), eq(schema.earningEvent.flagged, false)))
    .groupBy(schema.earningEvent.ownerWorkspaceId)
    .orderBy(schema.earningEvent.ownerWorkspaceId);

  return owners
    .map((owner) => ({ ownerWorkspaceId: owner.ownerWorkspaceId, amountMinor: Number(owner.amountMinor) }))
    .filter((owner) => owner.amountMinor !== 0);
}
