/**
 * What a publisher reads about their own earnings, and how they enter the
 * programme. publisher-revenue-share.md stage 2: the dashboard side of the
 * ledger stage 1 writes.
 *
 * Every figure here is a recomputation, never a stored balance: a locked
 * period's amount is re-derived from the frozen period row and the owner's
 * unflagged events -- the same arithmetic closePeriod used -- which is
 * exactly the share doc's acceptance property (any period is independently
 * recomputable from events). An unlocked period shows its call count and no
 * amount, because the pool does not exist until the period closes.
 *
 * The publisher account is the programme-entry record: agreement version and
 * (later) the external payment account. Tax and KYC stay with the payment
 * provider (3.4: the platform holds no bank details and no funds).
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  PAYOUT_HOLD_DAYS,
  PAYOUT_THRESHOLD_MINOR,
  settlementAmountMinor,
} from '@/lib/domain';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import type { PeriodPool } from './close-period';
import { earningPayouts, type EarningPayouts } from './payout';
import { earningCredit, type EarningCredit } from './redeem-credit';

export interface PublisherPeriodEarning {
  periodId: string;
  locked: boolean;
  attributableCalls: number;
  /** Null until the period locks -- there is no pool to allocate from yet. */
  amountMinor: number | null;
  /**
   * The open period's amount if it closed now, from the live pool the caller
   * passed in. Null for a locked period, and for an open one without it.
   */
  estimateMinor: number | null;
}

/** One expert library's share of the same ledger. */
export interface PublisherLibraryEarning {
  libraryId: string;
  publicId: string;
  title: string;
  deleted: boolean;
  /** Tagged now; a library that lost the tag keeps its history. */
  expertTagged: boolean;
  /** Newest first, over the same periods as `PublisherEarnings.periods`. */
  periods: PublisherPeriodEarning[];
  /** Locked periods, all of them -- not only the ones shown. */
  settledMinor: number;
  settledCalls: number;
}

export interface PublisherEarnings {
  account: {
    taxStatus: string;
    agreementVersion: string | null;
    providerAccountLinked: boolean;
  } | null;
  periods: PublisherPeriodEarning[];
  /** Sum of the locked periods' amounts, whatever has since become of them. */
  accruedMinor: number;
  /**
   * Per library. Each amount is floored on its own, so a period's libraries
   * can sum to a few cents under the workspace's amount for it.
   */
  libraries: PublisherLibraryEarning[];
  /**
   * The statement side: what is past its hold and can become Additional
   * Calls now, what is still held, and what has already been redeemed
   * (publisher-revenue-share.md 3.4).
   */
  credit: EarningCredit;
  /**
   * Cash paid by hand over PayPal (3.4): the open request, the history, and
   * what has been paid. A request covers the same statements `credit` calls
   * redeemable, once they reach `payoutThresholdMinor`.
   */
  payouts: EarningPayouts;
  payoutThresholdMinor: number;
  holdDays: number;
}

const PERIODS_SHOWN = 12;

function amountFor(
  period: { poolMinor: number; totalAttributableCalls: number } | undefined,
  calls: number,
): number | null {
  return period
    ? settlementAmountMinor({
        poolMinor: period.poolMinor,
        libraryAttributableCalls: calls,
        totalAttributableCalls: Number(period.totalAttributableCalls),
      })
    : null;
}

/**
 * `live` is the open period's pool as `livePeriodPool` computes it. It is a
 * platform-wide scan, so the caller decides whether and how often to pay for
 * it; without it the open period shows calls and no estimate.
 */
export async function publisherEarnings(
  workspaceId: string,
  live: { periodId: string; pool: PeriodPool } | null = null,
): Promise<PublisherEarnings> {
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
      calls: sql<number>`count(*)::int`,
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

  /*
   * Per library and period, every period: the history totals cover all of
   * it, the rows only the periods shown above. Libraries x periods is small.
   */
  const byLibraryPeriod = await database
    .select({
      libraryId: schema.earningEvent.libraryId,
      periodId: schema.earningEvent.periodId,
      calls: sql<number>`count(*)::int`,
    })
    .from(schema.earningEvent)
    .where(
      and(
        eq(schema.earningEvent.ownerWorkspaceId, workspaceId),
        eq(schema.earningEvent.flagged, false),
      ),
    )
    .groupBy(schema.earningEvent.libraryId, schema.earningEvent.periodId);

  /* The owner's expert libraries, plus any that earned and have since changed. */
  const libraryRows = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      title: schema.library.title,
      deletedAt: schema.library.deletedAt,
      expertTaggedAt: schema.library.expertTaggedAt,
    })
    .from(schema.library)
    .where(
      or(
        and(
          eq(schema.library.ownerWorkspaceId, workspaceId),
          isNotNull(schema.library.expertTaggedAt),
          isNull(schema.library.deletedAt),
        ),
        byLibraryPeriod.length === 0
          ? undefined
          : inArray(schema.library.id, [...new Set(byLibraryPeriod.map((row) => row.libraryId))]),
      ),
    );

  /* All the period rows at once -- one round trip, not one per period. */
  const periodIds = [...new Set(byLibraryPeriod.map((row) => row.periodId))];
  const periodRows =
    periodIds.length === 0
      ? []
      : await database
          .select({
            id: schema.revenuePeriod.id,
            poolMinor: schema.revenuePeriod.poolMinor,
            totalAttributableCalls: schema.revenuePeriod.totalAttributableCalls,
            lockedAt: schema.revenuePeriod.lockedAt,
          })
          .from(schema.revenuePeriod)
          .where(inArray(schema.revenuePeriod.id, periodIds));
  const lockedById = new Map(
    periodRows.filter((period) => period.lockedAt).map((period) => [period.id, period]),
  );
  const livePool =
    live && !lockedById.has(live.periodId) ? new Map([[live.periodId, live.pool]]) : new Map();

  function periodEarning(periodId: string, calls: number): PublisherPeriodEarning {
    const locked = lockedById.has(periodId);
    return {
      periodId,
      locked,
      attributableCalls: calls,
      amountMinor: locked ? amountFor(lockedById.get(periodId), calls) : null,
      estimateMinor: locked ? null : amountFor(livePool.get(periodId), calls),
    };
  }

  const [credit, payouts] = await Promise.all([
    earningCredit(account?.id ?? null),
    earningPayouts(account?.id ?? null),
  ]);

  const periods = byPeriod.map((row) => periodEarning(row.periodId, row.calls));
  const accruedMinor = periods.reduce((total, period) => total + (period.amountMinor ?? 0), 0);

  const shownPeriods = periods.map((period) => period.periodId);
  const libraries = libraryRows.map((library): PublisherLibraryEarning => {
    const rows = byLibraryPeriod.filter((row) => row.libraryId === library.id);
    const callsByPeriod = new Map(rows.map((row) => [row.periodId, row.calls]));
    let settledMinor = 0;
    let settledCalls = 0;
    for (const row of rows) {
      const amount = amountFor(lockedById.get(row.periodId), row.calls);
      if (amount === null) continue;
      settledMinor += amount;
      settledCalls += row.calls;
    }
    return {
      libraryId: library.id,
      publicId: library.publicId,
      title: library.title,
      deleted: library.deletedAt !== null,
      expertTagged: library.expertTaggedAt !== null,
      periods: shownPeriods
        .filter((periodId) => callsByPeriod.has(periodId))
        .map((periodId) => periodEarning(periodId, callsByPeriod.get(periodId)!)),
      settledMinor,
      settledCalls,
    };
  });
  /* Biggest earners first; a tagged library that has not earned yet goes last. */
  libraries.sort(
    (a, b) =>
      b.settledMinor - a.settledMinor ||
      (b.periods[0]?.attributableCalls ?? 0) - (a.periods[0]?.attributableCalls ?? 0) ||
      a.title.localeCompare(b.title),
  );

  return {
    account: account
      ? {
          taxStatus: account.taxStatus,
          agreementVersion: account.agreementVersion,
          providerAccountLinked: account.providerAccountId !== null,
        }
      : null,
    periods,
    accruedMinor,
    libraries,
    credit,
    payouts,
    payoutThresholdMinor: PAYOUT_THRESHOLD_MINOR,
    holdDays: PAYOUT_HOLD_DAYS,
  };
}

/** One UTC day of earnings, for the dashboard's and the console's daily trend. */
export interface PublisherDayEarning {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  attributableCalls: number;
  /**
   * The day's calls at their period's rate per call: the locked pool for a
   * closed period, the live pool for the open one, zero for an open period
   * without it. Fractional -- the ledger floors per period and per library,
   * not per day, so a period's days sum to within a few cents of its amount.
   */
  amountMinor: number;
}

/**
 * The last `days` UTC days, today included, zero-filled. A day has no amount
 * of its own in the ledger -- allocation is per period -- so this spreads each
 * period's amount over its days in proportion to their calls, which is the
 * same linear rule the period itself is allocated by.
 *
 * `workspaceId` narrows it to one publisher; null is the whole platform, what
 * the console's settlements trend plots.
 */
export async function publisherDailyEarnings(
  workspaceId: string | null,
  days: number,
  live: { periodId: string; pool: PeriodPool } | null = null,
  now: Date = new Date(),
): Promise<PublisherDayEarning[]> {
  const database = db();
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  );
  const date = sql<string>`to_char(${schema.earningEvent.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const rows = await database
    .select({
      date,
      periodId: schema.earningEvent.periodId,
      calls: sql<number>`count(*)::int`,
    })
    .from(schema.earningEvent)
    .where(
      and(
        workspaceId === null ? undefined : eq(schema.earningEvent.ownerWorkspaceId, workspaceId),
        eq(schema.earningEvent.flagged, false),
        gte(schema.earningEvent.createdAt, since),
      ),
    )
    .groupBy(date, schema.earningEvent.periodId);

  const periodIds = [...new Set(rows.map((row) => row.periodId))];
  const locked =
    periodIds.length === 0
      ? []
      : await database
          .select({
            id: schema.revenuePeriod.id,
            poolMinor: schema.revenuePeriod.poolMinor,
            totalAttributableCalls: schema.revenuePeriod.totalAttributableCalls,
          })
          .from(schema.revenuePeriod)
          .where(
            and(
              inArray(schema.revenuePeriod.id, periodIds),
              isNotNull(schema.revenuePeriod.lockedAt),
            ),
          );
  const perCall = new Map(
    locked.map((period) => [
      period.id,
      Number(period.totalAttributableCalls) > 0
        ? Number(period.poolMinor) / Number(period.totalAttributableCalls)
        : 0,
    ]),
  );
  if (live && !perCall.has(live.periodId) && live.pool.totalAttributableCalls > 0) {
    perCall.set(live.periodId, live.pool.poolMinor / live.pool.totalAttributableCalls);
  }

  const byDate = new Map<string, { calls: number; amountMinor: number }>();
  for (const row of rows) {
    const day = byDate.get(row.date) ?? { calls: 0, amountMinor: 0 };
    day.calls += row.calls;
    day.amountMinor += row.calls * (perCall.get(row.periodId) ?? 0);
    byDate.set(row.date, day);
  }

  return Array.from({ length: days }, (_, index) => {
    const key = new Date(since.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    const day = byDate.get(key);
    return {
      date: key,
      attributableCalls: day?.calls ?? 0,
      amountMinor: day?.amountMinor ?? 0,
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
