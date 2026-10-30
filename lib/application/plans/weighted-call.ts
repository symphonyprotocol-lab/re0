/**
 * A seat of more than one Call: the A2A `ask` answer (agent-first-proposal.md
 * 8.2), which costs 10 Calls where a retrieval costs 1.
 *
 * The same ledger, lock and deduction order as `quota.ts` and
 * `build-quota.ts`: the workspace row is locked, abandoned seats go back,
 * consumption is summed by weight, and the seat is held at its full weight
 * so concurrent callers cannot both spend the last Calls. A seat may be
 * committed at a lower weight than it was held at -- an answer that degraded
 * to a chunk list is billed as one retrieval -- and its plan and pack shares
 * are split the way a build's are.
 *
 * `daily` caps how many committed events of one operation, plus the seats
 * still pending for it, a workspace may have since UTC midnight. The seats
 * are recognised by their request id prefix, because a reservation carries
 * no operation of its own.
 */
import { and, eq, gte, like, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { availableOf, consumeGrants, remainingOf } from './build-quota';
import { countConsumption, oldestGrantWithBalance, planWindow, sweepAbandonedSeats, type Tx } from './quota';

export interface WeightedSeat {
  reservationId: string;
  workspaceId: string;
  requestId: string;
  calls: number;
}

/** Start of the UTC day `now` falls in: when a daily cap resets. */
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function reserveCalls(input: {
  workspaceId: string;
  /** Must start with `daily.requestPrefix` when a cap is given. */
  requestId: string;
  calls: number;
  daily?: { operation: string; requestPrefix: string; limit: number; message: string };
}): Promise<WeightedSeat> {
  if (!Number.isInteger(input.calls) || input.calls < 1) throw new Error('a seat holds at least one call');
  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: schema.workspace.id })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, input.workspaceId))
      .for('update');
    if (!locked) throw new AppError('access_denied', 'no such workspace');
    await sweepAbandonedSeats(tx, input.workspaceId);

    if (input.daily) await assertUnderDailyCap(tx, input.workspaceId, input.daily);

    const window = await planWindow(tx, input.workspaceId);
    const counted = await countConsumption(tx, input.workspaceId, window.periodStart, window.periodEnd);
    if (availableOf(window.allowance, counted) < input.calls) {
      throw new AppError('quota_exceeded', 'the monthly allowance and call pack balance cannot cover this call');
    }
    const reservationId = uuidv7();
    await tx.insert(schema.usageReservation).values({
      id: reservationId,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      status: 'pending',
      kind: 'retrieval',
      calls: input.calls,
    });
    return { reservationId, workspaceId: input.workspaceId, requestId: input.requestId, calls: input.calls };
  });
}

async function assertUnderDailyCap(
  tx: Tx,
  workspaceId: string,
  daily: { operation: string; requestPrefix: string; limit: number; message: string },
): Promise<void> {
  const since = utcDayStart();
  const [events] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.usageEvent)
    .where(
      and(
        eq(schema.usageEvent.workspaceId, workspaceId),
        eq(schema.usageEvent.operation, daily.operation),
        gte(schema.usageEvent.createdAt, since),
      ),
    );
  const [held] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.usageReservation)
    .where(
      and(
        eq(schema.usageReservation.workspaceId, workspaceId),
        eq(schema.usageReservation.status, 'pending'),
        like(schema.usageReservation.requestId, `${daily.requestPrefix}%`),
        gte(schema.usageReservation.createdAt, since),
      ),
    );
  if (Number(events?.n ?? 0) + Number(held?.n ?? 0) >= daily.limit) {
    throw new AppError('rate_limited', daily.message);
  }
}

/**
 * Bills the seat at `calls` (at most what it held): one usage event of that
 * weight, the plan allowance first and the pack for the rest, the
 * reservation committed. Replay-safe on the request id.
 */
export async function commitCalls(
  seat: WeightedSeat,
  input: {
    calls: number;
    libraryId: string;
    versionId: string;
    operation: string;
    entrypoint: string;
    latencyMs: number | null;
    returnedTokens: number | null;
  },
): Promise<void> {
  const calls = Math.min(seat.calls, Math.max(1, Math.floor(input.calls)));
  await db().transaction(async (tx) => {
    await tx
      .select({ id: schema.workspace.id })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, seat.workspaceId))
      .for('update');
    const window = await planWindow(tx, seat.workspaceId);
    const counted = await countConsumption(tx, seat.workspaceId, window.periodStart, window.periodEnd);
    const [own] = await tx
      .select({ calls: schema.usageReservation.calls, status: schema.usageReservation.status })
      .from(schema.usageReservation)
      .where(eq(schema.usageReservation.id, seat.reservationId));
    const ownSeat = own?.status === 'pending' ? own.calls : 0;
    const { planAllowanceRemaining } = remainingOf(window.allowance, { ...counted, held: counted.held - ownSeat });
    const planCalls = Math.min(calls, planAllowanceRemaining);
    const addonCalls = calls - planCalls;
    const debitSource = planCalls === calls ? 'plan' : planCalls === 0 ? 'addon' : 'split';
    const addonGrantId = addonCalls > 0 ? await oldestGrantWithBalance(tx, seat.workspaceId) : null;

    const written = await tx
      .insert(schema.usageEvent)
      .values({
        id: uuidv7(),
        workspaceId: seat.workspaceId,
        requestId: seat.requestId,
        libraryId: input.libraryId,
        versionId: input.versionId,
        operation: input.operation,
        entrypoint: input.entrypoint,
        debitSource,
        addonGrantId,
        statusCode: 200,
        latencyMs: input.latencyMs,
        inputTokens: null,
        returnedTokens: input.returnedTokens,
        calls,
      })
      .onConflictDoNothing({ target: schema.usageEvent.requestId })
      .returning({ id: schema.usageEvent.id });
    await tx
      .update(schema.usageReservation)
      .set({ status: 'committed', calls })
      .where(eq(schema.usageReservation.id, seat.reservationId));
    if (written.length > 0 && addonCalls > 0) await consumeGrants(tx, seat.workspaceId, addonCalls);
  });
}

/** Nothing was served: the seat goes back. Idempotent. */
export async function releaseCalls(seat: WeightedSeat): Promise<void> {
  await db()
    .update(schema.usageReservation)
    .set({ status: 'released' })
    .where(and(eq(schema.usageReservation.id, seat.reservationId), eq(schema.usageReservation.status, 'pending')));
}
