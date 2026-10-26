/**
 * Call quota. architecture.md 11.1.
 *
 * Reservation and usage event are billing facts: they live in one Postgres
 * transaction with the business data. Never move this counting into Redis.
 *
 * Deduction order is fixed: plan allowance first, then the addon balance.
 * The addon balance has no expiry and rolls across periods, so eligibility must
 * be decided by reading the balance, never by a validity window.
 *
 * Concurrency: architecture.md 11.1 forbids "SELECT the remainder, then plain
 * INSERT". Two things make this correct instead: the workspace row is locked
 * (`FOR UPDATE`) for the duration of the reservation *and* the commit
 * transaction, which serialises one workspace's counting, and `request_id` is
 * unique on both the reservation and the event, which makes a replay of the
 * same request a no-op rather than a second charge. Per-workspace
 * serialisation is the cost; it lasts three reads and one insert.
 *
 * The commit takes the same lock because it counts too: the daily
 * attributable cap is read and then inserted against, and under READ
 * COMMITTED concurrent commits would each read the same count and every one
 * of them would pass a cap they jointly exceed.
 */
import { and, asc, eq, gte, lt, or, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import {
  DAILY_ATTRIBUTABLE_CALL_CAP,
  isRevenueEligible,
  nextDebitSource,
  revenuePeriodId,
  type DebitSource,
  type LifecycleStatus,
  type Visibility,
} from '@/lib/domain';
import { DEFAULT_BUILD_RATES, type BuildRates } from '@/lib/domain/build-billing';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { IN_FORCE_FIRST, subscriptionInForce, windowInForce } from '@/lib/application/plans/in-force';
import { PLAN_VERSION_NEWEST_FIRST } from './configuration';
import { workspacesRelated } from './related-workspaces';

/**
 * How long a pending reservation can hold a seat.
 *
 * `releaseCall` runs in the request's own error path, so it never runs for a
 * request that was killed outright -- a function timeout, an instance
 * eviction, an OOM. Those reservations stayed `pending` for ever while `held`
 * below counted every one of them against the allowance, so each killed
 * request silently cost the workspace a call for the rest of the billing
 * period, with no sweeper and no way for anyone to get it back. Longer than
 * any request can plausibly run, so a seat this old is abandoned, not held.
 */
const RESERVATION_TTL_MS = 15 * 60 * 1000;

/**
 * How long a build's seat can stay pending. A build is released or committed
 * by the operation that holds it, but an operation whose worker died -- a
 * function timeout, an eviction -- never reaches that code, and its seat can
 * be the workspace's entire remaining balance. Longer than any build can run
 * (the drain function is capped at five minutes), so a seat this old belongs
 * to a dead worker. `drainOperations` reaps the operation on the same clock.
 */
export const BUILD_RESERVATION_TTL_MS = 60 * 60 * 1000;

export interface QuotaState {
  planAllowanceRemaining: number;
  addonBalanceRemaining: number;
}

export function chooseDebitSource(state: QuotaState): DebitSource {
  const source = nextDebitSource(state);
  if (source === null) {
    throw new AppError('quota_exceeded', 'monthly allowance and call pack balance are both empty');
  }
  return source;
}

export interface ReservedCall {
  reservationId: string;
  workspaceId: string;
  requestId: string;
  debitSource: DebitSource;
  /** The oldest grant with balance now; `commitCall` pays from it if it still has some, else the next. */
  addonGrantId: string | null;
  /**
   * The plan version the call bills against, pinned at reservation. The
   * earning event freezes this id and its share rate (11.4: historical
   * periods settle at the values of their time). Null only when no plan
   * version exists at all, in which case nothing can earn either.
   */
  planVersionId: string | null;
  shareRateBps: number;
  /** Remaining after this reservation -- what the response reports. */
  planAllowanceRemaining: number;
  addonBalanceRemaining: number;
}

/**
 * Reserve one call before retrieval starts. Throws `quota_exceeded` when the
 * plan allowance and the addon balance are both empty. A replayed
 * `request_id` returns the existing reservation instead of a second one.
 */
export async function reserveCall(input: {
  workspaceId: string;
  requestId: string;
}): Promise<ReservedCall> {
  const database = db();

  return database.transaction(async (tx) => {
    /* Serialises this workspace's reservations; also proves it exists. */
    const [locked] = await tx
      .select({ id: schema.workspace.id })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, input.workspaceId))
      .for('update');
    if (!locked) throw new AppError('access_denied', 'no such workspace');

    /*
     * Abandoned seats go back before anything is counted. Safe under the lock
     * just taken, and safe against a slow request that does eventually finish:
     * `commitCall` updates the reservation by id and does not require it to
     * still be pending.
     */
    await sweepAbandonedSeats(tx, input.workspaceId);

    const { allowance, periodStart, periodEnd, planVersionId, shareRateBps } = await planWindow(
      tx,
      input.workspaceId,
    );

    const counted = await countConsumption(tx, input.workspaceId, periodStart, periodEnd);

    /*
     * A replay of the same request must not be admitted twice -- or refused
     * because its own first pass holds the last seat. The existing reservation
     * is looked up first, and when it is still pending, its own seat is
     * excluded before the quota is re-derived.
     */
    const [existing] = await tx
      .select({ id: schema.usageReservation.id, status: schema.usageReservation.status })
      .from(schema.usageReservation)
      .where(eq(schema.usageReservation.requestId, input.requestId));

    const ownSeat = existing?.status === 'pending' ? 1 : 0;
    const held = Math.max(0, (counted?.held ?? 0) - ownSeat);
    const planRemaining = Math.max(0, allowance - (counted?.events ?? 0));
    const addonRemaining = Math.max(0, counted?.addon ?? 0);

    /*
     * Held reservations follow the same deduction order as committed calls:
     * plan allowance first, and only the excess spills onto the addon balance.
     * Counting them against the plan alone would let two back-to-back calls
     * both be admitted on the last addon call -- commitCall's guarded update
     * would then silently no-op for the loser while its usage event was still
     * written, a call served and never paid for.
     */
    const effectivePlanRemaining = Math.max(0, planRemaining - held);
    const spill = Math.max(0, held - planRemaining);
    const effectiveAddonRemaining = Math.max(0, addonRemaining - spill);

    const debitSource = chooseDebitSource({
      planAllowanceRemaining: effectivePlanRemaining,
      addonBalanceRemaining: effectiveAddonRemaining,
    });

    const addonGrantId =
      debitSource === 'addon' ? await oldestGrantWithBalance(tx, input.workspaceId) : null;

    let reservationId = existing?.id;
    if (!reservationId) {
      reservationId = uuidv7();
      await tx.insert(schema.usageReservation).values({
        id: reservationId,
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        status: 'pending',
      });
    } else if (existing?.status === 'released') {
      /*
       * A request whose seat went back is being served again -- the
       * playground retrying a missed question under the same request id
       * (retrieval/gather.ts). It was just admitted above without its old
       * seat, so it has to hold one again: left `released`, it would be
       * invisible to every other reservation while it runs. The clock
       * restarts with it, for the abandoned-seat sweep.
       */
      await tx
        .update(schema.usageReservation)
        .set({ status: 'pending', createdAt: new Date() })
        .where(eq(schema.usageReservation.id, reservationId));
    }

    /* This reservation occupies a seat: report what is left after it. */
    return {
      reservationId,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      debitSource,
      addonGrantId,
      planVersionId,
      shareRateBps,
      planAllowanceRemaining:
        debitSource === 'plan' ? effectivePlanRemaining - 1 : effectivePlanRemaining,
      addonBalanceRemaining:
        debitSource === 'addon' ? effectiveAddonRemaining - 1 : effectiveAddonRemaining,
    };
  });
}

/**
 * What the earning decision needs to know about the target library -- loaded
 * by the caller before the call was admitted, so the judgment inside the
 * transaction uses fields already determined and never a post-hoc query
 * (architecture.md 11.4).
 */
export interface EarningLibraryFacts {
  visibility: Visibility;
  lifecycleStatus: LifecycleStatus;
  ownerWorkspaceId: string | null;
  isPlatformLibrary: boolean;
  /**
   * requirement.md 7.3: `owner_workspace_id` alone proves access, not rights.
   * Sources gated behind a claim (github, website, llms_txt) earn only after
   * one verified; self-owned source types are rights-verified by creation.
   * Workspaces could otherwise mint a library over someone else's repository
   * and collect its share without ever passing the claim.
   */
  rightsVerified: boolean;
  /**
   * expert-library-prd.md 4.4: the console's expert tag, and whether the
   * owner workspace is on a paid plan at the moment of the call. Both are
   * read with the library, before the reservation, so the judgment inside
   * the transaction uses facts already determined.
   */
  expertTaggedAt: Date | null;
  ownerSubscribed: boolean;
}

/**
 * Finalise a served call: one usage event, the reservation committed, an
 * addon deduction when that is the source, and -- when the target library is
 * eligible -- one earning event, all in one transaction and replay-safe via
 * unique `request_id`s. architecture.md 11.1 and 11.4: the earning event is a
 * billing fact and must never be an asynchronous afterthought.
 */
export async function commitCall(input: {
  reservation: ReservedCall;
  libraryId: string;
  versionId: string;
  operation: string;
  entrypoint: string;
  statusCode: number;
  latencyMs: number | null;
  inputTokens: number | null;
  returnedTokens: number | null;
  /** Omitted by operations that never earn (nothing but query-docs earns). */
  libraryFacts?: EarningLibraryFacts;
}): Promise<void> {
  const database = db();
  const { reservation } = input;

  await database.transaction(async (tx) => {
    /*
     * Same lock as the reservation, for the same reason: the daily
     * attributable cap below is a count followed by an insert, and without it
     * concurrent commits of one workspace all read the count before any of
     * them inserts -- so a burst lands more earning events than the cap
     * allows, which is the anti-self-dealing rule the cap exists to enforce.
     * Taken first, in the same order as `reserveCall`, so the two cannot
     * deadlock against each other.
     */
    await tx
      .select({ id: schema.workspace.id })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, reservation.workspaceId))
      .for('update');

    /*
     * The grant is settled here, under the lock, not trusted from the
     * reservation. `reserveCall` picks the oldest grant with balance but
     * cannot see which grants other pending seats will drain, so two calls
     * reserved back to back on a grant's last call both name it -- and the
     * loser's guarded decrement below used to match nothing, a call served
     * and paid from no pack. The reserved grant is kept while it still has
     * balance; otherwise the next oldest one pays, as a build's would.
     */
    const addonGrantId =
      reservation.debitSource === 'addon' ? await grantForCommit(tx, reservation) : null;

    const written = await tx
      .insert(schema.usageEvent)
      .values({
        id: uuidv7(),
        workspaceId: reservation.workspaceId,
        requestId: reservation.requestId,
        libraryId: input.libraryId,
        versionId: input.versionId,
        operation: input.operation,
        entrypoint: input.entrypoint,
        debitSource: reservation.debitSource,
        addonGrantId,
        statusCode: input.statusCode,
        latencyMs: input.latencyMs,
        inputTokens: input.inputTokens,
        returnedTokens: input.returnedTokens,
      })
      .onConflictDoNothing({ target: schema.usageEvent.requestId })
      .returning({ id: schema.usageEvent.id });

    await tx
      .update(schema.usageReservation)
      .set({ status: 'committed' })
      .where(eq(schema.usageReservation.id, reservation.reservationId));

    /* Balance decrements only when the event was actually written -- a replay
       must not consume the pack twice. requirement.md 4.3. */
    if (written.length > 0 && addonGrantId) {
      await tx
        .update(schema.addonGrant)
        .set({ callsConsumed: sql`${schema.addonGrant.callsConsumed} + 1` })
        .where(
          and(
            eq(schema.addonGrant.id, addonGrantId),
            lt(schema.addonGrant.callsConsumed, schema.addonGrant.callsGranted),
          ),
        );
    } else if (written.length > 0 && reservation.debitSource === 'addon') {
      /* Admitted on a balance that was spent before this commit: served, and
         the platform absorbs it, as a build's shortfall is (build-quota.ts). */
      console.error(
        `quota: call ${reservation.requestId} debited the pack, but workspace ${reservation.workspaceId} has no balance left`,
      );
    }

    /*
     * The earning event, gated exactly as publisher-revenue-share.md 3.1
     * lists: eligible library (public, published, claimed, not the
     * platform's), not the owner calling their own library, an existing plan
     * version to freeze the rate from -- and under the caller's daily
     * attributable cap for this library, counted here in the same
     * transaction. Over the cap the call bills normally and earns nothing.
     * `written.length > 0` plus the unique request id keep replays at one.
     *
     * Section 5 widens "the owner" to every workspace related to it -- one
     * payer or one controller (related-workspaces.ts). Read last, after the
     * cheap gates, so only calls that would otherwise earn pay for it.
     */
    const facts = input.libraryFacts;
    if (
      written.length > 0 &&
      facts &&
      facts.rightsVerified &&
      reservation.planVersionId &&
      facts.ownerWorkspaceId !== reservation.workspaceId &&
      isRevenueEligible(facts) &&
      !(await callerRelatedToOwner(tx, reservation.workspaceId, facts.ownerWorkspaceId!))
    ) {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const [today] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.earningEvent)
        .innerJoin(schema.usageEvent, eq(schema.usageEvent.requestId, schema.earningEvent.requestId))
        .where(
          and(
            eq(schema.earningEvent.libraryId, input.libraryId),
            eq(schema.usageEvent.workspaceId, reservation.workspaceId),
            gte(schema.earningEvent.createdAt, dayStart),
          ),
        );

      if ((today?.n ?? 0) < DAILY_ATTRIBUTABLE_CALL_CAP) {
        await tx
          .insert(schema.earningEvent)
          .values({
            id: uuidv7(),
            requestId: reservation.requestId,
            libraryId: input.libraryId,
            versionId: input.versionId,
            /* isRevenueEligible refused null owners above. */
            ownerWorkspaceId: facts.ownerWorkspaceId!,
            planVersionId: reservation.planVersionId,
            shareRateBps: reservation.shareRateBps,
            periodId: revenuePeriodId(new Date()),
          })
          .onConflictDoNothing({ target: schema.earningEvent.requestId });
      }
    }
  });
}

/** The grant a committing addon call is paid from: the reserved one while it has balance, else the oldest that does. */
async function grantForCommit(tx: Tx, reservation: ReservedCall): Promise<string | null> {
  if (reservation.addonGrantId) {
    const [reserved] = await tx
      .select({ id: schema.addonGrant.id })
      .from(schema.addonGrant)
      .where(
        and(
          eq(schema.addonGrant.id, reservation.addonGrantId),
          lt(schema.addonGrant.callsConsumed, schema.addonGrant.callsGranted),
        ),
      );
    if (reserved) return reserved.id;
  }
  return oldestGrantWithBalance(tx, reservation.workspaceId);
}

/** publisher-revenue-share.md 5: a related caller earns its owner nothing. */
async function callerRelatedToOwner(
  tx: Tx,
  callerWorkspaceId: string,
  ownerWorkspaceId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      related: workspacesRelated(
        sql`${callerWorkspaceId}::uuid`,
        sql`${ownerWorkspaceId}::uuid`,
      ).mapWith(
        /* The driver may hand a raw-SQL boolean back as 't'/'f' text. */
        (value): boolean => value === true || value === 't',
      ),
    })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, callerWorkspaceId));
  return row?.related ?? false;
}

/** A platform-internal failure: the seat is released, no event is written. */
export async function releaseCall(reservationId: string): Promise<void> {
  await db()
    .update(schema.usageReservation)
    .set({ status: 'released' })
    .where(
      and(
        eq(schema.usageReservation.id, reservationId),
        eq(schema.usageReservation.status, 'pending'),
      ),
    );
}

export type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

/**
 * Abandoned seats go back before anything is counted, each kind on its own
 * clock: a retrieval seat after `RESERVATION_TTL_MS`, a build seat -- held
 * for as long as the build runs and normally released or committed by the
 * operation that holds it (`build-quota.ts`) -- after
 * `BUILD_RESERVATION_TTL_MS`, which only a dead worker's seat reaches.
 *
 * Safe under the workspace lock, and safe against a slow request that does
 * eventually finish: `commitCall` updates the reservation by id and does not
 * require it to still be pending.
 */
export async function sweepAbandonedSeats(tx: Tx, workspaceId: string): Promise<void> {
  const now = Date.now();
  await tx
    .update(schema.usageReservation)
    .set({ status: 'released' })
    .where(
      and(
        eq(schema.usageReservation.workspaceId, workspaceId),
        eq(schema.usageReservation.status, 'pending'),
        or(
          and(
            eq(schema.usageReservation.kind, 'retrieval'),
            lt(schema.usageReservation.createdAt, new Date(now - RESERVATION_TTL_MS)),
          ),
          and(
            eq(schema.usageReservation.kind, 'build'),
            lt(schema.usageReservation.createdAt, new Date(now - BUILD_RESERVATION_TTL_MS)),
          ),
        ),
      ),
    );
}

export interface ConsumptionCount {
  /** Calls committed in the period, retrieval and build alike, by weight. */
  events: number;
  /** Calls held by pending reservations in the period, by weight. */
  held: number;
  /** Pack balance, which has no period. */
  addon: number;
}

/**
 * What a workspace has used and is holding. Summed by weight, never counted
 * by row: a build's event and reservation carry the calls it was priced at
 * (library-build-billing.md 5.3), and a retrieval's carry 1.
 */
export async function countConsumption(
  tx: Tx,
  workspaceId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ConsumptionCount> {
  const [counted] = await tx
    .select({
      events: sql<number>`(
        select coalesce(sum(${schema.usageEvent.calls}), 0)::int from ${schema.usageEvent}
        where ${schema.usageEvent.workspaceId} = ${workspaceId}
          and ${schema.usageEvent.createdAt} >= ${periodStart}
          and ${schema.usageEvent.createdAt} < ${periodEnd}
      )`,
      held: sql<number>`(
        select coalesce(sum(${schema.usageReservation.calls}), 0)::int from ${schema.usageReservation}
        where ${schema.usageReservation.workspaceId} = ${workspaceId}
          and ${schema.usageReservation.status} = 'pending'
          and ${schema.usageReservation.createdAt} >= ${periodStart}
          and ${schema.usageReservation.createdAt} < ${periodEnd}
      )`,
      addon: sql<number>`(
        select coalesce(sum(${schema.addonGrant.callsGranted} - ${schema.addonGrant.callsConsumed}), 0)::int
        from ${schema.addonGrant}
        where ${schema.addonGrant.workspaceId} = ${workspaceId}
      )`,
    })
    .from(sql`(select 1) as one`);
  return { events: counted?.events ?? 0, held: counted?.held ?? 0, addon: counted?.addon ?? 0 };
}

/**
 * The allowance and the window it applies to. A workspace with a live
 * subscription bills against that subscription's frozen Plan Version and its
 * provider-defined period; without one it is on the newest Free version and a
 * calendar month. requirement.md 4.1.
 */
/**
 * Whether the workspace is on a paid plan right now: an active subscription
 * within its period, to a plan version that is not the free tier. What the
 * playground reads to decide which models a caller may be answered by.
 */
export async function hasPaidSubscription(workspaceId: string): Promise<boolean> {
  const [paid] = await db()
    .select({ planId: schema.planVersion.planId })
    .from(schema.subscription)
    .innerJoin(schema.planVersion, eq(schema.planVersion.id, schema.subscription.planVersionId))
    .where(
      and(eq(schema.subscription.workspaceId, workspaceId), subscriptionInForce()),
    )
    .orderBy(...IN_FORCE_FIRST)
    .limit(1);
  return paid !== undefined && paid.planId !== 'free';
}

export interface PlanWindow {
  allowance: number;
  periodStart: Date;
  periodEnd: Date;
  planVersionId: string | null;
  shareRateBps: number;
  /** library-build-billing.md 3.3: what a build costs on this version. */
  buildRates: BuildRates;
  /** requirement.md 4.1: the per-library content ceiling, which bounds a build's quote. */
  librarySizeBytesLimit: number;
}

export async function planWindow(tx: Tx, workspaceId: string): Promise<PlanWindow> {
  const [active] = await tx
    .select({
      planVersionId: schema.subscription.planVersionId,
      periodStart: schema.subscription.periodStart,
      periodEnd: schema.subscription.periodEnd,
    })
    .from(schema.subscription)
    .where(
      and(eq(schema.subscription.workspaceId, workspaceId), subscriptionInForce()),
    )
    .orderBy(...IN_FORCE_FIRST)
    .limit(1);

  if (active) {
    const [version] = await tx
      .select(PLAN_WINDOW_COLUMNS)
      .from(schema.planVersion)
      .where(eq(schema.planVersion.id, active.planVersionId));
    return {
      allowance: version?.monthlyCalls ?? 0,
      ...windowInForce(active),
      planVersionId: active.planVersionId,
      shareRateBps: version?.shareRateBps ?? 0,
      buildRates: buildRatesOf(version),
      librarySizeBytesLimit: version?.librarySizeBytesLimit ?? 0,
    };
  }

  const [free] = await tx
    .select(PLAN_WINDOW_COLUMNS)
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'free'))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    allowance: free?.monthlyCalls ?? 0,
    periodStart,
    periodEnd,
    planVersionId: free?.id ?? null,
    shareRateBps: free?.shareRateBps ?? 0,
    buildRates: buildRatesOf(free),
    librarySizeBytesLimit: free?.librarySizeBytesLimit ?? 0,
  };
}

const PLAN_WINDOW_COLUMNS = {
  id: schema.planVersion.id,
  monthlyCalls: schema.planVersion.monthlyCalls,
  shareRateBps: schema.planVersion.shareRateBps,
  buildBaseCalls: schema.planVersion.buildBaseCalls,
  buildTokensPerCall: schema.planVersion.buildTokensPerCall,
  buildPagesPerCall: schema.planVersion.buildPagesPerCall,
  librarySizeBytesLimit: schema.planVersion.librarySizeBytesLimit,
};

/** No version at all (a deployment that skipped the seed) builds at the defaults. */
function buildRatesOf(
  version:
    | { buildBaseCalls: number; buildTokensPerCall: number; buildPagesPerCall: number }
    | undefined,
): BuildRates {
  if (!version) return DEFAULT_BUILD_RATES;
  return {
    baseCalls: version.buildBaseCalls,
    tokensPerCall: version.buildTokensPerCall,
    pagesPerCall: version.buildPagesPerCall,
  };
}

export async function oldestGrantWithBalance(tx: Tx, workspaceId: string): Promise<string | null> {
  const [grant] = await tx
    .select({ id: schema.addonGrant.id })
    .from(schema.addonGrant)
    .where(
      and(
        eq(schema.addonGrant.workspaceId, workspaceId),
        lt(schema.addonGrant.callsConsumed, schema.addonGrant.callsGranted),
      ),
    )
    .orderBy(asc(schema.addonGrant.createdAt))
    .limit(1);
  return grant?.id ?? null;
}
