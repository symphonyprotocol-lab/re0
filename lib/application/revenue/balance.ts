/**
 * A creator's balance, and what a negative one stops. agent-first-proposal.md
 * 6.9.
 *
 * The balance is recomputed, never stored: everything the ledger credited
 * the workspace and took back (`earning_event`, unflagged), less what has
 * left the books -- statements paid as cash, held in an open payout request,
 * or redeemed as calls. A chargeback that reverses income already paid out
 * drives it below zero. While it is, the creator can neither withdraw nor
 * open a new paid plan; the platform never collects it, and deleting the
 * account writes it off as a platform cost (`writeOffNegativeBalance`).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { creatorBalanceMinor } from '@/lib/domain/channel-commerce';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';
import type { Tx } from '@/lib/application/plans/quota';

type Executor = Tx | Database;

export interface CreatorBalance {
  earnedMinor: number;
  dischargedMinor: number;
  balanceMinor: number;
}

export async function creatorBalance(workspaceId: string, executor: Executor = db()): Promise<CreatorBalance> {
  const [[earned], [discharged]] = await Promise.all([
    executor
      .select({ minor: sql<string>`coalesce(sum(${schema.earningEvent.amountMinor}), 0)::bigint` })
      .from(schema.earningEvent)
      .where(and(eq(schema.earningEvent.ownerWorkspaceId, workspaceId), eq(schema.earningEvent.flagged, false))),
    executor
      .select({ minor: sql<string>`coalesce(sum(${schema.settlement.amountMinor}), 0)::bigint` })
      .from(schema.settlement)
      .innerJoin(schema.publisherAccount, eq(schema.publisherAccount.id, schema.settlement.publisherAccountId))
      .where(
        and(
          eq(schema.publisherAccount.workspaceId, workspaceId),
          inArray(schema.settlement.status, ['held', 'paid', 'redeemed']),
        ),
      ),
  ]);
  const earnedMinor = Number(earned?.minor ?? 0);
  const dischargedMinor = Number(discharged?.minor ?? 0);
  return { earnedMinor, dischargedMinor, balanceMinor: creatorBalanceMinor({ earnedMinor, dischargedMinor }) };
}

export async function hasNegativeBalance(workspaceId: string, executor: Executor = db()): Promise<boolean> {
  return (await creatorBalance(workspaceId, executor)).balanceMinor < 0;
}

/** `YYYY-MM` of an instant, UTC: the revenue period an event lands in. */
export function periodIdOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * On account deletion: a negative balance is written off rather than
 * collected (proposal 6.9). One `written_off` event of the balance's
 * absolute value brings it to zero; the platform absorbs it. Idempotent per
 * workspace and day through the event's reference. Returns what was written
 * off, 0 when the balance was not negative.
 */
export async function writeOffNegativeBalance(workspaceId: string, now: Date = new Date()): Promise<number> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`balance:${workspaceId}`}))`);
    const { balanceMinor } = await creatorBalance(workspaceId, tx);
    if (balanceMinor >= 0) return 0;
    await tx
      .insert(schema.earningEvent)
      .values({
        id: uuidv7(),
        ownerWorkspaceId: workspaceId,
        amountMinor: -balanceMinor,
        source: 'written_off',
        reference: `written_off:${workspaceId}:${now.toISOString().slice(0, 10)}`,
        periodId: periodIdOf(now),
        createdAt: now,
      })
      .onConflictDoNothing();
    return -balanceMinor;
  });
}
