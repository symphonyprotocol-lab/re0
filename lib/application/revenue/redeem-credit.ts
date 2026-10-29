/**
 * Redeeming settled earnings as Additional Calls. agent-first-proposal.md
 * 6.9: a statement past its hold can be turned into a grant on the creator's
 * own workspace, priced at the Additional Calls version in force, with no
 * minimum. The platform still holds no funds beyond the creators' share in
 * transit: a grant is an entitlement on our service, and `payout` is not
 * written here -- cash goes through the manual PayPal request in ./payout,
 * which takes the same statements and so excludes them from this path.
 *
 * What is redeemable is decided by the hold the payout rail uses too --
 * accrued statements whose period locked at least PAYOUT_HOLD_DAYS ago. The
 * whole redeemable amount converts at once, negatives netted against
 * positives: a refund period's statement is below zero, and it reduces what
 * the surrounding periods buy rather than being skipped. A statement is
 * either accrued or redeemed; there is no partial state, which is what keeps
 * every row recomputable from events plus the grant it became.
 *
 * Concurrency: the redeemable rows are read `FOR UPDATE`, and Postgres
 * re-evaluates the `status = 'accrued'` predicate on the committed row once
 * the lock is granted. Two redeems racing therefore split nothing: the second
 * sees the first's `redeemed` rows and converts only what is left, which is
 * usually nothing. The publisher account row is locked first, so the two
 * never even reach the statements at the same time.
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  creditCallsFor,
  EarningCreditRefused,
  PAYOUT_HOLD_DAYS,
  type PackRate,
} from '@/lib/domain';
import { holdEndsAt } from '@/lib/domain/admin';
import { PLAN_CURRENCY } from '@/lib/domain/plans';
import { uuidv7 } from '@/lib/domain/id';
import type { WorkspaceRole } from '@/lib/application/libraries/delete';
import type { Tx } from '@/lib/application/plans/quota';
import { db, schema } from '@/lib/infrastructure/postgres/client';

/** Turning earnings into calls spends them; only those who run the workspace may. */
export function canRedeemEarnings(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Who pressed the button, recorded on the grant as `kind:id`. A redemption
 * spends money-equivalent value, and a workspace with several admins must be
 * able to say which session or key did it (requirement.md 5.3 keeps the same
 * rule for console mutations).
 */
export interface RedeemActor {
  kind: 'user' | 'api_key';
  id: string;
}

export function redeemedByTag(actor: RedeemActor): string {
  return `${actor.kind}:${actor.id}`;
}

export interface EarningRedemption {
  id: string;
  createdAt: Date;
  /** Earnings consumed, in minor units. */
  amountMinor: number;
  currency: string;
  callsGranted: number;
  callsConsumed: number;
}

export interface EarningCredit {
  /** The pack rate the conversion is priced at; null when no version exists. */
  pack: PackRate | null;
  /** Accrued statements past their hold: what the button converts right now. */
  redeemableMinor: number;
  redeemableStatements: number;
  /** What `redeemableMinor` buys at the pack rate. */
  redeemableCalls: number;
  /** Accrued statements still inside the hold window. */
  heldMinor: number;
  /** When the earliest held statement becomes redeemable; null if none held. */
  nextReleaseAt: Date | null;
  /** Everything redeemed so far. */
  redeemedMinor: number;
  redeemedCalls: number;
  redemptions: EarningRedemption[];
}

const REDEMPTIONS_SHOWN = 12;

/**
 * `locked_at + hold <= now`: the statement has left the refund window.
 * Shared with the cash payout request, which releases on the same hold.
 */
export function pastHold(now: Date) {
  return sql`${schema.revenuePeriod.lockedAt} + make_interval(days => ${PAYOUT_HOLD_DAYS}) <= ${now}`;
}

async function packRate(database: ReturnType<typeof db> | Tx): Promise<PackRate | null> {
  const [row] = await database
    .select({ priceMinor: schema.planVersion.priceMinor, calls: schema.planVersion.monthlyCalls })
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'addon'))
    .orderBy(desc(schema.planVersion.createdAt), desc(schema.planVersion.id))
    .limit(1);
  return row ?? null;
}

/**
 * The creator's credit position, recomputed from statements and grants on
 * every read like the rest of the earnings screen. `accountId` may be null
 * for a workspace that has not accepted the agreement: then nothing is
 * redeemable, but the pack rate is still reported so the screen can say what
 * accepting would unlock.
 */
export async function earningCredit(
  accountId: string | null,
  now: Date = new Date(),
): Promise<EarningCredit> {
  const database = db();

  const [pack, accrued, grants] = await Promise.all([
    packRate(database),
    accountId
      ? database
          .select({
            redeemableMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where ${pastHold(now)}), 0)::bigint`,
            redeemableStatements: sql<number>`(count(*) filter (where ${pastHold(now)}))::int`,
            heldMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where not (${pastHold(now)})), 0)::bigint`,
            earliestHeldLock: sql<Date | null>`min(${schema.revenuePeriod.lockedAt}) filter (where not (${pastHold(now)}))`,
          })
          .from(schema.settlement)
          .innerJoin(schema.revenuePeriod, eq(schema.revenuePeriod.id, schema.settlement.periodId))
          .where(
            and(
              eq(schema.settlement.publisherAccountId, accountId),
              eq(schema.settlement.status, 'accrued'),
              /* What the button can convert: the redeem below prices USD only. */
              eq(schema.settlement.currency, PLAN_CURRENCY),
              isNotNull(schema.revenuePeriod.lockedAt),
            ),
          )
      : Promise.resolve([]),
    accountId
      ? database
          .select({
            id: schema.addonGrant.id,
            createdAt: schema.addonGrant.createdAt,
            amountMinor: schema.addonGrant.priceMinor,
            currency: schema.addonGrant.currency,
            callsGranted: schema.addonGrant.callsGranted,
            callsConsumed: schema.addonGrant.callsConsumed,
          })
          .from(schema.addonGrant)
          .where(eq(schema.addonGrant.publisherAccountId, accountId))
          .orderBy(desc(schema.addonGrant.createdAt), desc(schema.addonGrant.id))
      : Promise.resolve([]),
  ]);

  const position = accrued[0];
  const redeemableMinor = Number(position?.redeemableMinor ?? 0);
  const earliestHeldLock = position?.earliestHeldLock ? new Date(position.earliestHeldLock) : null;

  return {
    pack,
    redeemableMinor,
    redeemableStatements: position?.redeemableStatements ?? 0,
    redeemableCalls: pack ? creditCallsFor(redeemableMinor, pack) : 0,
    heldMinor: Number(position?.heldMinor ?? 0),
    nextReleaseAt: earliestHeldLock ? holdEndsAt(earliestHeldLock, PAYOUT_HOLD_DAYS) : null,
    redeemedMinor: grants.reduce((sum, grant) => sum + grant.amountMinor, 0),
    redeemedCalls: grants.reduce((sum, grant) => sum + grant.callsGranted, 0),
    redemptions: grants.slice(0, REDEMPTIONS_SHOWN),
  };
}

export interface RedeemedEarnings {
  grantId: string;
  amountMinor: number;
  currency: string;
  calls: number;
  statements: number;
}

/**
 * Convert every redeemable statement of the workspace into one grant.
 *
 * Refuses rather than no-ops when there is nothing to convert, so the caller
 * can say why: no publisher account, no pack rate to price with, or no
 * statement past its hold that buys a whole call.
 */
export async function redeemEarningsAsCalls(input: {
  workspaceId: string;
  actor: RedeemActor;
  now?: Date;
}): Promise<RedeemedEarnings> {
  const now = input.now ?? new Date();
  const database = db();

  return database.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: schema.publisherAccount.id })
      .from(schema.publisherAccount)
      .where(eq(schema.publisherAccount.workspaceId, input.workspaceId))
      .for('update');
    if (!account) {
      throw new EarningCreditRefused('no_account', 'the workspace has no publisher account');
    }

    const pack = await packRate(tx);
    if (!pack || pack.priceMinor <= 0 || pack.calls <= 0) {
      throw new EarningCreditRefused('no_pack_rate', 'no Additional Calls version to price with');
    }

    const rows = await tx
      .select({
        id: schema.settlement.id,
        amountMinor: schema.settlement.amountMinor,
        currency: schema.settlement.currency,
      })
      .from(schema.settlement)
      .innerJoin(schema.revenuePeriod, eq(schema.revenuePeriod.id, schema.settlement.periodId))
      .where(
        and(
          eq(schema.settlement.publisherAccountId, account.id),
          eq(schema.settlement.status, 'accrued'),
          isNotNull(schema.revenuePeriod.lockedAt),
          pastHold(now),
        ),
      )
      .for('update', { of: schema.settlement });

    /* One currency per redemption: the pack is priced in USD and so is every
       statement today, but a row in another currency must not be converted
       at the USD rate. It stays accrued for a rail that can price it. */
    const convertible = rows.filter((row) => row.currency === PLAN_CURRENCY);
    const amountMinor = convertible.reduce((sum, row) => sum + Number(row.amountMinor), 0);
    const calls = creditCallsFor(amountMinor, pack);
    if (convertible.length === 0 || calls < 1) {
      throw new EarningCreditRefused(
        'nothing_redeemable',
        'no statement past its hold buys a whole call',
      );
    }

    const grantId = uuidv7();
    await tx.insert(schema.addonGrant).values({
      id: grantId,
      workspaceId: input.workspaceId,
      callsGranted: calls,
      priceMinor: amountMinor,
      currency: PLAN_CURRENCY,
      publisherAccountId: account.id,
      redeemedBy: redeemedByTag(input.actor),
    });
    await tx
      .update(schema.settlement)
      .set({ status: 'redeemed', addonGrantId: grantId })
      .where(
        inArray(
          schema.settlement.id,
          convertible.map((row) => row.id),
        ),
      );

    return { grantId, amountMinor, currency: PLAN_CURRENCY, calls, statements: convertible.length };
  });
}
