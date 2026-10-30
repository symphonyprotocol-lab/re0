/**
 * Build quota: a library build's seat in the call ledger. library-build-billing.md 4.
 *
 * The same ledger, the same lock and the same deduction order as `quota.ts`,
 * with two differences a build forces. Its price is not known until chunking
 * has measured it, so the seat is reserved at the quoted cap and resized once
 * the figure is in. And it is committed with the version's publication, in
 * that transaction, so a build that fails or produces nothing never bills.
 *
 * The four verbs run in the order the operation runs them: `openBuildCharge`
 * before fetching, `settleBuildCharge` after chunking (before embedding,
 * which is what costs the platform money), `commitBuildCharge` inside
 * `publishVersion`, and `releaseBuildCharge` on every other outcome.
 *
 * Shadow mode (library-build-billing.md 11, phase 1) runs the same path with
 * no reservation and a zero-weight event, so the `build_detail` column fills
 * with what each build *would* have cost.
 */
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import {
  BUILD_ENTRYPOINT,
  buildBillingMode,
  buildRequestId,
  priceBuild,
  quoteBuildCap,
  type BuildBillingMode,
  type BuildDetail,
  type BuildFacts,
  type BuildRates,
} from '@/lib/domain/build-billing';
import { INGESTION_LIMITS, type OperationTrigger } from '@/lib/domain/ingestion';
import { requiresDomainVerification } from '@/lib/domain/domain-verification';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { countConsumption, oldestGrantWithBalance, planWindow, type Tx } from './quota';
import { workspaceStorage } from './storage';

/** How the deployment is billing builds right now. */
export function currentBuildBillingMode(): BuildBillingMode {
  return buildBillingMode(process.env.BUILD_BILLING_MODE);
}

export interface BuildQuote {
  mode: BuildBillingMode;
  rates: BuildRates;
  /** The most this build can cost, from the storage left in the workspace or a tighter estimate. */
  maxCalls: number;
  planAllowanceRemaining: number;
  addonBalanceRemaining: number;
  /** Whether the workspace can start a build at all: remaining >= base. */
  affordable: boolean;
}

/**
 * library-build-billing.md 4.1: what the wizard and the rebuild button show
 * before anything is queued. Read-only; the reservation happens when the
 * operation starts.
 */
export async function quoteBuild(input: {
  workspaceId: string;
  /** Sources that fetch pages from a host count the crawl limit; the rest fetch none. */
  fetchesPages: boolean;
  /** Upload bytes, repository size -- when the wizard knows one. */
  estimatedBytes?: number;
  /** The library being rebuilt, whose own bytes the build replaces rather than adds to. */
  libraryId?: string;
}): Promise<BuildQuote> {
  return db().transaction(async (tx) => {
    const window = await planWindow(tx, input.workspaceId);
    const counted = await countConsumption(tx, input.workspaceId, window.periodStart, window.periodEnd);
    const remaining = remainingOf(window.allowance, counted);
    const storage = await workspaceStorage(input.workspaceId, { excludeLibraryId: input.libraryId, executor: tx });
    const maxCalls = quoteBuildCap({
      rates: window.buildRates,
      capacityBytes: storage.remainingBytes,
      pageLimit: input.fetchesPages ? INGESTION_LIMITS.maxCrawlPages : 0,
      estimatedBytes: input.estimatedBytes,
    });
    const mode = currentBuildBillingMode();
    return {
      mode,
      rates: window.buildRates,
      maxCalls,
      ...remaining,
      affordable:
        mode !== 'enforce' ||
        remaining.planAllowanceRemaining + remaining.addonBalanceRemaining >= window.buildRates.baseCalls,
    };
  });
}

/**
 * The gate a queueing verb runs before it writes an operation row: in
 * enforce mode a workspace that cannot cover the base fee is refused with
 * `quota_exceeded` rather than queued into a build that can only fail.
 */
export async function assertBuildAffordable(input: {
  workspaceId: string;
  fetchesPages: boolean;
}): Promise<BuildQuote> {
  const quote = await quoteBuild(input);
  if (!quote.affordable) {
    throw new AppError(
      'quota_exceeded',
      'the monthly allowance and call pack balance cannot cover a build',
    );
  }
  return quote;
}

/** One build's open seat, carried from `openBuildCharge` to its close. */
export interface BuildCharge {
  operationId: string;
  workspaceId: string;
  planVersionId: string | null;
  rates: BuildRates;
  mode: BuildBillingMode;
  /** Null in shadow mode: nothing is held. */
  reservationId: string | null;
  quotedCalls: number;
}

/**
 * library-build-billing.md 4.2: called by the worker once it has claimed the
 * operation and before the first byte is fetched.
 *
 * Returns null when the build is not the owner's bill: a platform library, a
 * library with no owner, or an operation the platform triggered (5.4). In
 * enforce mode the quoted cap -- or what is left, when that is less -- is
 * held under the workspace lock; a workspace that cannot cover the base fee
 * is refused here, which the worker records as a `quota_exceeded` failure.
 * A retry of the same operation finds its own seat by request id.
 */
export async function openBuildCharge(input: {
  operationId: string;
  libraryId: string;
  trigger: OperationTrigger | string;
}): Promise<BuildCharge | null> {
  if (input.trigger === 'platform') return null;
  const database = db();

  const [library] = await database
    .select({
      ownerWorkspaceId: schema.library.ownerWorkspaceId,
      isPlatformLibrary: schema.library.isPlatformLibrary,
    })
    .from(schema.library)
    .where(eq(schema.library.id, input.libraryId))
    .limit(1);
  if (!library || library.isPlatformLibrary || !library.ownerWorkspaceId) return null;
  const workspaceId = library.ownerWorkspaceId;

  const sources = await database
    .select({ type: schema.source.type })
    .from(schema.source)
    .where(eq(schema.source.libraryId, input.libraryId));
  const fetchesPages = sources.some((source) => requiresDomainVerification(source.type));

  const mode = currentBuildBillingMode();
  const requestId = buildRequestId(input.operationId);

  return database.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: schema.workspace.id })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, workspaceId))
      .for('update');
    if (!locked) return null;

    const window = await planWindow(tx, workspaceId);
    const storage = await workspaceStorage(workspaceId, { excludeLibraryId: input.libraryId, executor: tx });
    const cap = quoteBuildCap({
      rates: window.buildRates,
      capacityBytes: storage.remainingBytes,
      pageLimit: fetchesPages ? INGESTION_LIMITS.maxCrawlPages : 0,
    });

    if (mode !== 'enforce') {
      return {
        operationId: input.operationId,
        workspaceId,
        planVersionId: window.planVersionId,
        rates: window.buildRates,
        mode,
        reservationId: null,
        quotedCalls: cap,
      };
    }

    const counted = await countConsumption(tx, workspaceId, window.periodStart, window.periodEnd);
    const [existing] = await tx
      .select({
        id: schema.usageReservation.id,
        status: schema.usageReservation.status,
        calls: schema.usageReservation.calls,
      })
      .from(schema.usageReservation)
      .where(eq(schema.usageReservation.requestId, requestId));
    const ownSeat = existing?.status === 'pending' ? existing.calls : 0;
    const available = availableOf(window.allowance, { ...counted, held: counted.held - ownSeat });

    if (available < window.buildRates.baseCalls) {
      throw new AppError(
        'quota_exceeded',
        'the monthly allowance and call pack balance cannot cover a build',
      );
    }
    const held = Math.max(window.buildRates.baseCalls, Math.min(cap, available));

    let reservationId = existing?.id;
    if (!reservationId) {
      reservationId = uuidv7();
      await tx.insert(schema.usageReservation).values({
        id: reservationId,
        workspaceId,
        requestId,
        status: 'pending',
        kind: 'build',
        calls: held,
      });
    } else if (existing?.status !== 'committed') {
      /* A retry after a released attempt takes its seat back; a still-pending
         seat is resized to today's figure. A committed one is a replay of a
         published build and is left as the ledger has it. */
      await tx
        .update(schema.usageReservation)
        .set({ status: 'pending', calls: held })
        .where(eq(schema.usageReservation.id, reservationId));
    }

    await tx
      .update(schema.workflowOperation)
      .set({ reservationId, quotedCalls: held })
      .where(eq(schema.workflowOperation.id, input.operationId));

    return {
      operationId: input.operationId,
      workspaceId,
      planVersionId: window.planVersionId,
      rates: window.buildRates,
      mode,
      reservationId,
      quotedCalls: held,
    };
  });
}

export interface SettledBuildCharge {
  /** What the ledger will debit: the price in enforce mode, 0 in shadow. */
  calls: number;
  detail: BuildDetail;
}

/**
 * library-build-billing.md 4.3: chunking has measured the build. The seat is
 * resized to the real price, and a price the workspace cannot cover --
 * counted under the lock, its own seat excluded -- throws `quota_exceeded`
 * before a single vector is requested.
 */
export async function settleBuildCharge(
  charge: BuildCharge,
  facts: BuildFacts,
): Promise<SettledBuildCharge> {
  const billed = priceBuild(facts, charge.rates);
  const detail: BuildDetail = {
    ...facts,
    planVersionId: charge.planVersionId,
    baseCalls: charge.rates.baseCalls,
    tokensPerCall: charge.rates.tokensPerCall,
    pagesPerCall: charge.rates.pagesPerCall,
    billedCalls: billed,
    planCalls: 0,
    addonCalls: 0,
    mode: charge.mode,
  };
  const database = db();

  /*
   * Shadow mode: the priced figure is still written onto the operation, so
   * the refresh gate has a history to read the day enforcement is switched
   * on; only the ledger weight stays at zero.
   */
  if (charge.mode !== 'enforce' || charge.reservationId === null) {
    await database
      .update(schema.workflowOperation)
      .set({ chargedCalls: billed })
      .where(eq(schema.workflowOperation.id, charge.operationId));
    return { calls: 0, detail };
  }

  const reservationId = charge.reservationId;
  await database.transaction(async (tx) => {
    await tx
      .select({ id: schema.workspace.id })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, charge.workspaceId))
      .for('update');

    const window = await planWindow(tx, charge.workspaceId);
    const counted = await countConsumption(tx, charge.workspaceId, window.periodStart, window.periodEnd);
    const ownSeat = await pendingSeat(tx, reservationId);
    const available = availableOf(window.allowance, { ...counted, held: counted.held - ownSeat });

    if (billed > available) {
      throw new AppError(
        'quota_exceeded',
        'the build costs more than the allowance and call pack balance can cover',
      );
    }
    await tx
      .update(schema.usageReservation)
      .set({ calls: billed })
      .where(eq(schema.usageReservation.id, reservationId));
    await tx
      .update(schema.workflowOperation)
      .set({ chargedCalls: billed })
      .where(eq(schema.workflowOperation.id, charge.operationId));
  });

  return { calls: billed, detail };
}

/**
 * library-build-billing.md 4.4: the ledger entry, written inside the
 * publication transaction. Plan allowance first, then the pack balance, the
 * pack consumed oldest grant first for as many calls as spill past the
 * allowance. Replay-safe on the unique request id: a publication retried
 * after a commit writes nothing and consumes nothing twice.
 */
export async function commitBuildCharge(
  tx: Tx,
  charge: BuildCharge,
  input: {
    libraryId: string;
    versionId: string;
    /** 'index' for a first build, 'refresh' for a later one. */
    operation: string;
    settled: SettledBuildCharge;
  },
): Promise<void> {
  await tx
    .select({ id: schema.workspace.id })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, charge.workspaceId))
    .for('update');

  const { calls } = input.settled;
  const window = await planWindow(tx, charge.workspaceId);
  const counted = await countConsumption(tx, charge.workspaceId, window.periodStart, window.periodEnd);
  /*
   * The plan share is bounded by what pending retrieval seats have not
   * already spoken for: a retrieval reserved as `plan` commits as `plan`
   * without touching the pack, so a build that took the same last call
   * would leave that retrieval charged to no pool. Own seat excluded, as in
   * `reserveCall`.
   */
  const ownSeat = charge.reservationId ? await pendingSeat(tx, charge.reservationId) : 0;
  const { planAllowanceRemaining } = remainingOf(window.allowance, {
    ...counted,
    held: counted.held - ownSeat,
  });
  const planCalls = Math.min(calls, planAllowanceRemaining);
  const addonCalls = calls - planCalls;
  const debitSource = calls === 0 || planCalls === calls ? 'plan' : planCalls === 0 ? 'addon' : 'split';
  const addonGrantId = addonCalls > 0 ? await oldestGrantWithBalance(tx, charge.workspaceId) : null;

  const written = await tx
    .insert(schema.usageEvent)
    .values({
      id: uuidv7(),
      workspaceId: charge.workspaceId,
      requestId: buildRequestId(charge.operationId),
      libraryId: input.libraryId,
      versionId: input.versionId,
      operation: input.operation,
      entrypoint: BUILD_ENTRYPOINT,
      debitSource,
      addonGrantId,
      statusCode: 200,
      latencyMs: null,
      inputTokens: input.settled.detail.freshTokens,
      returnedTokens: null,
      calls,
      buildDetail: { ...input.settled.detail, planCalls, addonCalls } satisfies BuildDetail,
    })
    .onConflictDoNothing({ target: schema.usageEvent.requestId })
    .returning({ id: schema.usageEvent.id });

  if (charge.reservationId) {
    await tx
      .update(schema.usageReservation)
      .set({ status: 'committed', calls })
      .where(eq(schema.usageReservation.id, charge.reservationId));
  }

  if (written.length > 0 && addonCalls > 0) {
    await consumeGrants(tx, charge.workspaceId, addonCalls);
  }
}

/** Oldest grant first, each drained before the next is touched. */
export async function consumeGrants(tx: Tx, workspaceId: string, calls: number): Promise<void> {
  let remaining = calls;
  const grants = await tx
    .select({
      id: schema.addonGrant.id,
      granted: schema.addonGrant.callsGranted,
      consumed: schema.addonGrant.callsConsumed,
    })
    .from(schema.addonGrant)
    .where(
      and(
        eq(schema.addonGrant.workspaceId, workspaceId),
        lt(schema.addonGrant.callsConsumed, schema.addonGrant.callsGranted),
      ),
    )
    .orderBy(asc(schema.addonGrant.createdAt));
  for (const grant of grants) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, grant.granted - grant.consumed);
    await tx
      .update(schema.addonGrant)
      .set({ callsConsumed: sql`${schema.addonGrant.callsConsumed} + ${take}` })
      .where(eq(schema.addonGrant.id, grant.id));
    remaining -= take;
  }
  /*
   * The settle step checked the balance under the same lock, so a shortfall
   * here means the pack was spent between settle and publish by a retrieval
   * that reserved before the seat was resized. The version is published and
   * the event written; the platform absorbs the difference rather than
   * unpublishing a library over it, and the line below is the alert.
   */
  if (remaining > 0) {
    console.error(`build charge for workspace ${workspaceId} short by ${remaining} pack calls`);
  }
}

/** Every outcome but publication: the seat goes back. Idempotent. */
export async function releaseBuildCharge(charge: BuildCharge | null): Promise<void> {
  if (!charge?.reservationId) return;
  await db()
    .update(schema.usageReservation)
    .set({ status: 'released' })
    .where(
      and(
        eq(schema.usageReservation.id, charge.reservationId),
        eq(schema.usageReservation.status, 'pending'),
      ),
    );
}

async function pendingSeat(tx: Tx, reservationId: string): Promise<number> {
  const [own] = await tx
    .select({ calls: schema.usageReservation.calls, status: schema.usageReservation.status })
    .from(schema.usageReservation)
    .where(eq(schema.usageReservation.id, reservationId));
  return own?.status === 'pending' ? own.calls : 0;
}

export function remainingOf(
  allowance: number,
  counted: { events: number; held: number; addon: number },
): { planAllowanceRemaining: number; addonBalanceRemaining: number } {
  const planRemaining = Math.max(0, allowance - counted.events);
  const held = Math.max(0, counted.held);
  const spill = Math.max(0, held - planRemaining);
  return {
    planAllowanceRemaining: Math.max(0, planRemaining - held),
    addonBalanceRemaining: Math.max(0, counted.addon - spill),
  };
}

export function availableOf(
  allowance: number,
  counted: { events: number; held: number; addon: number },
): number {
  const remaining = remainingOf(allowance, counted);
  return remaining.planAllowanceRemaining + remaining.addonBalanceRemaining;
}
