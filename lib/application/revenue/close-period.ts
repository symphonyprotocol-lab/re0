/**
 * Closing a revenue period. publisher-revenue-share.md 3.2/3.3,
 * architecture.md 11.4: settlement is a batch outside the request path, reads
 * earning events and the period row, and can be re-run -- a second close of a
 * locked period returns the frozen numbers instead of computing new ones.
 *
 * The whole close runs in one transaction against a `FOR UPDATE` lock on the
 * period row, so two concurrent closes serialise and every aggregate reads
 * one consistent snapshot:
 *
 *   1. voiding -- earning events of libraries suspended *now* are marked
 *      `flagged` (the acceptance rule: suspension voids the current period's
 *      unpaid earnings, and never touches periods already locked), and so
 *      are events whose caller is related to the owner by now;
 *   2. the pool -- net revenue from the period's billing documents, times the
 *      attributable share, times each event group's frozen share rate. Rates
 *      are grouped, not averaged: a Pro caller's calls carry Pro's rate;
 *   3. allocation -- linear in attributable calls per owner, floors
 *      everywhere, so sum(allocations) <= pool by construction and every
 *      number is recomputable from usage and earning events alone.
 *
 * Stage 1 of the share doc: accounting only. No payout rows are written here.
 */
import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { allocatablePoolMinor, settlementAmountMinor } from '@/lib/domain';
import { PLAN_CURRENCY } from '@/lib/domain/plans';
import { BUILD_ENTRYPOINT } from '@/lib/domain/build-billing';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { ref } from '@/lib/application/administration/column-ref';
import { workspacesRelated } from '@/lib/application/plans/related-workspaces';

export interface PeriodAllocation {
  ownerWorkspaceId: string;
  attributableCalls: number;
  amountMinor: number;
}

export interface ClosedPeriod {
  periodId: string;
  netRevenueMinor: number;
  totalBilledCalls: number;
  totalAttributableCalls: number;
  /** Call-weighted average of the frozen per-event rates; display only. */
  shareRateBps: number;
  poolMinor: number;
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
      .values({
        id: periodId,
        netRevenueMinor: 0,
        totalBilledCalls: 0,
        totalAttributableCalls: 0,
        shareRateBps: 0,
        poolMinor: 0,
      })
      .onConflictDoNothing({ target: schema.revenuePeriod.id });
    const [period] = await tx
      .select()
      .from(schema.revenuePeriod)
      .where(eq(schema.revenuePeriod.id, periodId))
      .for('update');

    if (period?.lockedAt) {
      return {
        periodId,
        netRevenueMinor: period.netRevenueMinor,
        totalBilledCalls: period.totalBilledCalls,
        totalAttributableCalls: period.totalAttributableCalls,
        shareRateBps: period.shareRateBps,
        poolMinor: period.poolMinor,
        allocations: await allocations(tx, periodId, period.poolMinor, period.totalAttributableCalls),
        alreadyLocked: true,
      };
    }

    /*
     * Voiding, frozen at lock time: events of a library that is suspended
     * right now are flagged and excluded from everything below. A suspension
     * after this close never reopens the ledger -- the locked branch above
     * returns without ever running this update.
     */
    await tx
      .update(schema.earningEvent)
      .set({ flagged: true })
      .where(
        and(
          eq(schema.earningEvent.periodId, periodId),
          eq(schema.earningEvent.flagged, false),
          inArray(
            schema.earningEvent.libraryId,
            tx
              .select({ id: schema.library.id })
              .from(schema.library)
              .where(eq(schema.library.lifecycleStatus, 'suspended')),
          ),
        ),
      );

    /*
     * Related callers, re-judged at lock time (share doc 5). The call-time
     * gate in commitCall sees the links that existed then; a link made later
     * in the period -- the reader subscribes under the publisher's customer,
     * or one person takes admin of both -- reaches back over the period's
     * open events here, and stops at locked periods like the voiding above.
     */
    await tx
      .update(schema.earningEvent)
      .set({ flagged: true })
      .where(
        and(
          eq(schema.earningEvent.periodId, periodId),
          eq(schema.earningEvent.flagged, false),
          sql`exists(
            select 1 from ${schema.usageEvent} u
            where u.request_id = ${ref(schema.earningEvent.requestId)}
              and ${workspacesRelated(sql.raw('u.workspace_id'), ref(schema.earningEvent.ownerWorkspaceId))}
          )`,
        ),
      );

    const { netRevenueMinor, totalBilledCalls, totalAttributableCalls, shareRateBps, poolMinor } =
      await periodPool(tx, periodId, start, end);

    await tx
      .update(schema.revenuePeriod)
      .set({
        netRevenueMinor,
        totalBilledCalls,
        totalAttributableCalls,
        shareRateBps,
        poolMinor,
        lockedAt: new Date(),
      })
      .where(eq(schema.revenuePeriod.id, periodId));

    return {
      periodId,
      netRevenueMinor,
      totalBilledCalls,
      totalAttributableCalls,
      shareRateBps,
      poolMinor,
      allocations: await allocations(tx, periodId, poolMinor, totalAttributableCalls),
      alreadyLocked: false,
    };
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

export interface PeriodPool {
  netRevenueMinor: number;
  totalBilledCalls: number;
  totalAttributableCalls: number;
  shareRateBps: number;
  poolMinor: number;
}

/**
 * The pool arithmetic of a close, on its own so the dashboard's live estimate
 * runs the very same sums over a period that is still open. Read-only: the
 * voiding that precedes it in a close is the caller's business.
 */
async function periodPool(
  executor: Pick<Tx, 'select'>,
  periodId: string,
  start: Date,
  end: Date,
): Promise<PeriodPool> {
  /*
   * Net revenue: documents collected in the period, refunds already
   * deducted. Windowed by `paid_at` -- when the money arrived -- on the
   * same collected basis as `billingSummary`: a December invoice paid in
   * January is January's revenue, and an `issued_at` window would freeze it
   * out of every pool once December locks. Only USD documents count;
   * a foreign-currency amount summed minor-for-minor into the USD pool
   * would be adding francs to dollars.
   */
  const [revenue] = await executor
    .select({
      net: sql<number>`coalesce(sum(${schema.billingDocument.amountMinor} - ${schema.billingDocument.refundedMinor}), 0)::bigint`,
    })
    .from(schema.billingDocument)
    .where(
      and(
        inArray(schema.billingDocument.status, ['paid', 'refunded']),
        eq(schema.billingDocument.currency, PLAN_CURRENCY),
        gte(schema.billingDocument.paidAt, start),
        lt(schema.billingDocument.paidAt, end),
      ),
    );
  const netRevenueMinor = Number(revenue?.net ?? 0);

  /*
   * Retrieval only. library-build-billing.md 5.5: a build's usage event is
   * a billed call, but it consumed no library's content and can earn
   * nobody anything, so it stays out of both the attributable count and
   * this denominator -- inside it, a workspace that builds a lot would
   * dilute every publisher's share.
   */
  const [billed] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.usageEvent)
    .where(
      and(
        gte(schema.usageEvent.createdAt, start),
        lt(schema.usageEvent.createdAt, end),
        ne(schema.usageEvent.entrypoint, BUILD_ENTRYPOINT),
      ),
    );
  const totalBilledCalls = billed?.n ?? 0;

  /*
   * The pool honours each event's frozen rate: group by rate, price each
   * group's share of revenue at its own rate, sum. Averaging first would
   * quietly move money between publishers whose readers sit on different
   * plans.
   */
  const rateGroups = await executor
    .select({
      shareRateBps: schema.earningEvent.shareRateBps,
      calls: sql<number>`count(*)::int`,
    })
    .from(schema.earningEvent)
    .where(and(eq(schema.earningEvent.periodId, periodId), eq(schema.earningEvent.flagged, false)))
    .groupBy(schema.earningEvent.shareRateBps);

  const totalAttributableCalls = rateGroups.reduce((total, group) => total + group.calls, 0);
  const poolMinor = rateGroups.reduce(
    (total, group) =>
      total +
      allocatablePoolMinor({
        netRevenueMinor,
        shareRateBps: group.shareRateBps,
        totalAttributableCalls: group.calls,
        totalBilledCalls,
      }),
    0,
  );
  const shareRateBps =
    totalAttributableCalls === 0
      ? 0
      : Math.floor(
          rateGroups.reduce((sum, group) => sum + group.shareRateBps * group.calls, 0) /
            totalAttributableCalls,
        );

  return { netRevenueMinor, totalBilledCalls, totalAttributableCalls, shareRateBps, poolMinor };
}

/**
 * What the open period's pool comes to if it closed now: month to date, its
 * unflagged events as they stand. An estimate -- the close still voids events
 * of libraries suspended by then and of callers related by then, and revenue
 * keeps arriving until the month ends.
 */
export async function livePeriodPool(periodId: string): Promise<PeriodPool> {
  const match = PERIOD_ID.exec(periodId);
  if (!match) throw new AppError('invalid_request', 'a period id looks like 2026-08');
  const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  const end = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  return periodPool(db(), periodId, start, end);
}

/**
 * Per-owner allocation, linear in attributable calls -- recomputable at any
 * time from the events plus the locked period row, which is exactly how the
 * share doc's acceptance check re-derives it.
 */
async function allocations(
  tx: Tx,
  periodId: string,
  poolMinor: number,
  totalAttributableCalls: number,
): Promise<PeriodAllocation[]> {
  if (totalAttributableCalls === 0) return [];
  const owners = await tx
    .select({
      ownerWorkspaceId: schema.earningEvent.ownerWorkspaceId,
      calls: sql<number>`count(*)::int`,
    })
    .from(schema.earningEvent)
    .where(and(eq(schema.earningEvent.periodId, periodId), eq(schema.earningEvent.flagged, false)))
    .groupBy(schema.earningEvent.ownerWorkspaceId)
    .orderBy(schema.earningEvent.ownerWorkspaceId);

  return owners.map((owner) => ({
    ownerWorkspaceId: owner.ownerWorkspaceId,
    attributableCalls: owner.calls,
    amountMinor: settlementAmountMinor({
      poolMinor,
      libraryAttributableCalls: owner.calls,
      totalAttributableCalls,
    }),
  }));
}
