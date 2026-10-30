/**
 * What a creator reads about their own earnings, and how they enter the
 * programme: the dashboard side of the ledger `earning_event` holds.
 *
 * Every figure here is a recomputation, never a stored balance: a period's
 * amount is the sum of the owner's unflagged events in it, which is exactly
 * what `closePeriod` froze for a locked period and what it will freeze for an
 * open one. So the open period shows a running amount rather than an
 * estimate, and locking changes no number.
 *
 * The publisher account is the programme-entry record: agreement version and
 * (later) the payout details. Tax and KYC stay with the payment provider
 * (agent-first-proposal.md 6.9: the platform holds the creators' share only
 * between collection and payout, and no card or bank details).
 */
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { activeCommerceSettings } from '@/lib/application/administration/manage-commerce-config';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { earningPayouts, type EarningPayouts } from './payout';
import { earningCredit, type EarningCredit } from './redeem-credit';
import { creatorBalance } from './balance';

export interface PublisherPeriodEarning {
  periodId: string;
  locked: boolean;
  /** The owner's unflagged events in the period, summed; running while the period is open. */
  amountMinor: number;
}

export interface PublisherEarnings {
  account: {
    taxStatus: string;
    agreementVersion: string | null;
    providerAccountLinked: boolean;
    /** The payout profile (proposal 6.9): where cash goes, and the tax document's record. */
    payeeEmail: string | null;
    taxFormKind: string | null;
    taxFormStatus: 'missing' | 'submitted' | 'verified';
    taxFormSubmittedAt: Date | null;
    taxFormVerifiedAt: Date | null;
  } | null;
  /** Newest first, the last `PERIODS_SHOWN`. */
  periods: PublisherPeriodEarning[];
  /** Sum of the locked periods' amounts, whatever has since become of them. */
  accruedMinor: number;
  /**
   * The statement side: what is past its hold and can become Additional
   * Calls now, what is still held, and what has already been redeemed.
   */
  credit: EarningCredit;
  /**
   * Cash paid by hand over PayPal: the open request, the history, and what
   * has been paid. A request covers the same statements `credit` calls
   * redeemable, once they reach `payoutThresholdMinor`.
   */
  payouts: EarningPayouts;
  payoutThresholdMinor: number;
  holdDays: number;
  /** Earned less discharged; below zero blocks payouts and new paid plans (proposal 6.9). */
  balanceMinor: number;
}

const PERIODS_SHOWN = 12;

export async function publisherEarnings(workspaceId: string): Promise<PublisherEarnings> {
  const database = db();

  const [account] = await database
    .select()
    .from(schema.publisherAccount)
    .where(eq(schema.publisherAccount.workspaceId, workspaceId))
    .orderBy(desc(schema.publisherAccount.createdAt))
    .limit(1);

  const byPeriod = await database
    .select({
      periodId: schema.earningEvent.periodId,
      amountMinor: sql<number>`coalesce(sum(${schema.earningEvent.amountMinor}), 0)::bigint`,
    })
    .from(schema.earningEvent)
    .where(
      and(
        eq(schema.earningEvent.ownerWorkspaceId, workspaceId),
        eq(schema.earningEvent.flagged, false),
      ),
    )
    .groupBy(schema.earningEvent.periodId)
    .orderBy(desc(schema.earningEvent.periodId))
    .limit(PERIODS_SHOWN);

  /* All the period rows at once -- one round trip, not one per period. */
  const periodIds = byPeriod.map((row) => row.periodId);
  const lockedIds =
    periodIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await database
              .select({ id: schema.revenuePeriod.id })
              .from(schema.revenuePeriod)
              .where(
                and(
                  inArray(schema.revenuePeriod.id, periodIds),
                  isNotNull(schema.revenuePeriod.lockedAt),
                ),
              )
          ).map((period) => period.id),
        );

  const [credit, payouts, settings, balance] = await Promise.all([
    earningCredit(account?.id ?? null),
    earningPayouts(account?.id ?? null),
    activeCommerceSettings(),
    creatorBalance(workspaceId),
  ]);

  const periods = byPeriod.map((row) => ({
    periodId: row.periodId,
    locked: lockedIds.has(row.periodId),
    amountMinor: Number(row.amountMinor),
  }));
  const accruedMinor = periods
    .filter((period) => period.locked)
    .reduce((total, period) => total + period.amountMinor, 0);

  return {
    account: account
      ? {
          taxStatus: account.taxStatus,
          agreementVersion: account.agreementVersion,
          providerAccountLinked: account.providerAccountId !== null,
          payeeEmail: account.payeeEmail,
          taxFormKind: account.taxFormKind,
          taxFormStatus: account.taxFormStatus,
          taxFormSubmittedAt: account.taxFormSubmittedAt,
          taxFormVerifiedAt: account.taxFormVerifiedAt,
        }
      : null,
    periods,
    accruedMinor,
    credit,
    payouts,
    payoutThresholdMinor: settings.payoutThresholdMinor,
    holdDays: settings.payoutHoldDays,
    balanceMinor: balance.balanceMinor,
  };
}

/** One UTC day of the ledger, for the dashboard's and the console's daily trend. */
export interface PublisherDayEarning {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** Unflagged events written that day. */
  events: number;
  /** Their amounts summed; a refund day can go below zero. */
  amountMinor: number;
}

/**
 * The last `days` UTC days, today included, zero-filled. Every event carries
 * its own amount, so a day's figure is simply the sum of what landed on it.
 *
 * `workspaceId` narrows it to one creator; null is the whole platform, what
 * the console's settlements trend plots.
 */
export async function publisherDailyEarnings(
  workspaceId: string | null,
  days: number,
  now: Date = new Date(),
): Promise<PublisherDayEarning[]> {
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  );
  const date = sql<string>`to_char(${schema.earningEvent.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const rows = await db()
    .select({
      date,
      events: sql<number>`count(*)::int`,
      amountMinor: sql<number>`coalesce(sum(${schema.earningEvent.amountMinor}), 0)::bigint`,
    })
    .from(schema.earningEvent)
    .where(
      and(
        workspaceId === null ? undefined : eq(schema.earningEvent.ownerWorkspaceId, workspaceId),
        eq(schema.earningEvent.flagged, false),
        gte(schema.earningEvent.createdAt, since),
      ),
    )
    .groupBy(date);
  const byDate = new Map(rows.map((row) => [row.date, row]));

  return Array.from({ length: days }, (_, index) => {
    const key = new Date(since.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    const day = byDate.get(key);
    return {
      date: key,
      events: day?.events ?? 0,
      amountMinor: Number(day?.amountMinor ?? 0),
    };
  });
}

/**
 * Entering the programme: accept the publisher agreement. Idempotent per
 * workspace -- re-accepting records the newer agreement version on the same
 * account rather than minting a second one.
 */
export async function acceptPublisherAgreement(input: {
  workspaceId: string;
  agreementVersion: string;
}): Promise<{ accountId: string }> {
  const database = db();

  /*
   * The unique index on `workspace_id` is the concurrency guard: two accepts
   * racing here both insert, one row survives, and the update below records
   * the agreement version on whichever that is. No select-then-insert window
   * in which a second account could be minted.
   */
  await database
    .insert(schema.publisherAccount)
    .values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      agreementVersion: input.agreementVersion,
    })
    .onConflictDoNothing({ target: schema.publisherAccount.workspaceId });

  const [account] = await database
    .update(schema.publisherAccount)
    .set({ agreementVersion: input.agreementVersion })
    .where(eq(schema.publisherAccount.workspaceId, input.workspaceId))
    .returning({ id: schema.publisherAccount.id });
  return { accountId: account!.id };
}
