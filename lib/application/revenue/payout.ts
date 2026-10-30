/**
 * Requesting a cash payout, and reading the payouts back. agent-first-
 * proposal.md 6.9: no payout service is connected, so cash is paid by hand.
 * The creator asks for everything past its hold to go to a PayPal address;
 * the statements it covers move from `accrued` to `held`, which takes them
 * out of reach of the credit path, and wait for an operator. The operator's
 * side -- marking the payout `paid` with the PayPal transaction id, or
 * `failed` -- is lib/application/administration/payouts.
 *
 * What a request covers is exactly what the credit button would convert: the
 * same hold, USD only, negatives netted. The one rule of its own is the
 * threshold -- cash pays a per-transfer fee, credit does not.
 *
 * Concurrency follows the redeem: the publisher account row is locked first
 * and the statements `FOR UPDATE`, so a request racing a redeem (or a second
 * request) sees the other's committed statuses and takes only what is left.
 * The partial unique index on open payouts backs the one-open-request rule.
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  normalizePayeeEmail,
  PAYOUT_METHOD,
  PayoutRefused,
  type PayoutStatus,
} from '@/lib/domain';
import { activeCommerceSettings } from '@/lib/application/administration/manage-commerce-config';
import { hasNegativeBalance } from './balance';
import { uuidv7 } from '@/lib/domain/id';
import { PLAN_CURRENCY } from '@/lib/domain/plans';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { redeemedByTag, releasable, type RedeemActor } from './redeem-credit';

export interface PublisherPayout {
  id: string;
  createdAt: Date;
  amountMinor: number;
  currency: string;
  payeeEmail: string | null;
  status: PayoutStatus;
  /** The PayPal transaction id, once paid. */
  providerReference: string | null;
  failureReason: string | null;
  resolvedAt: Date | null;
}

export interface EarningPayouts {
  /** The request waiting for an operator, if any. */
  open: PublisherPayout | null;
  /** Newest first, open one included. */
  history: PublisherPayout[];
  /** Everything marked paid so far. */
  paidMinor: number;
  /**
   * The address of the latest request that did not fail, to prefill the
   * next. A failed one is skipped: the address is the usual reason it failed.
   */
  lastPayeeEmail: string | null;
}

const PAYOUTS_SHOWN = 12;

export async function earningPayouts(accountId: string | null): Promise<EarningPayouts> {
  if (!accountId) return { open: null, history: [], paidMinor: 0, lastPayeeEmail: null };
  const database = db();

  /*
   * The newest rows are enough for everything but the paid total: the open
   * request, if any, is always the newest row (a request cannot be made while
   * another is open), and the prefill only looks back as far as the history.
   */
  const [rows, [paid]] = await Promise.all([
    database
      .select({
        id: schema.payout.id,
        createdAt: schema.payout.createdAt,
        amountMinor: schema.payout.amountMinor,
        currency: schema.payout.currency,
        payeeEmail: schema.payout.payeeEmail,
        status: schema.payout.status,
        providerReference: schema.payout.providerReference,
        failureReason: schema.payout.failureReason,
        resolvedAt: schema.payout.resolvedAt,
      })
      .from(schema.payout)
      .where(eq(schema.payout.publisherAccountId, accountId))
      .orderBy(desc(schema.payout.createdAt), desc(schema.payout.id))
      .limit(PAYOUTS_SHOWN),
    database
      .select({ minor: sql<number>`coalesce(sum(${schema.payout.amountMinor}), 0)::bigint` })
      .from(schema.payout)
      .where(and(eq(schema.payout.publisherAccountId, accountId), eq(schema.payout.status, 'paid'))),
  ]);

  const payouts = rows.map((row) => ({
    ...row,
    amountMinor: Number(row.amountMinor),
    status: row.status as PayoutStatus,
  }));
  return {
    open: payouts[0]?.status === 'requested' ? payouts[0] : null,
    history: payouts,
    paidMinor: Number(paid?.minor ?? 0),
    lastPayeeEmail:
      payouts.find((payout) => payout.status !== 'failed' && payout.payeeEmail)?.payeeEmail ?? null,
  };
}

export interface RequestedPayout {
  payoutId: string;
  amountMinor: number;
  currency: string;
  payeeEmail: string;
  statements: number;
}

/**
 * Put every statement past its hold into one payout request to the
 * creator's PayPal address -- `payeeEmail` when given, else the payout
 * profile's. Refuses rather than writing a request that cannot be paid: no
 * publisher account, an address PayPal cannot send to, a tax document not
 * yet verified, a negative balance, a request already open, or less than
 * the threshold to send.
 */
export async function requestPayout(input: {
  workspaceId: string;
  actor: RedeemActor;
  payeeEmail?: string;
  now?: Date;
}): Promise<RequestedPayout> {
  const now = input.now ?? new Date();
  const settings = await activeCommerceSettings();

  return db().transaction(async (tx) => {
    const [account] = await tx
      .select({
        id: schema.publisherAccount.id,
        payeeEmail: schema.publisherAccount.payeeEmail,
        taxFormStatus: schema.publisherAccount.taxFormStatus,
      })
      .from(schema.publisherAccount)
      .where(eq(schema.publisherAccount.workspaceId, input.workspaceId))
      .for('update');
    if (!account) {
      throw new PayoutRefused('no_account', 'the workspace has no publisher account');
    }
    const payeeEmail = normalizePayeeEmail(input.payeeEmail ?? account.payeeEmail ?? '');
    if (!payeeEmail) throw new PayoutRefused('invalid_email', 'a PayPal email address is required');
    /* Proposal 6.9: income accrues without them, but nothing is paid out until the profile is complete. */
    if (account.taxFormStatus !== 'verified') {
      throw new PayoutRefused('profile_incomplete', 'the tax document has not been verified yet');
    }
    if (await hasNegativeBalance(input.workspaceId, tx)) {
      throw new PayoutRefused('negative_balance', 'the balance is negative; it clears from future income');
    }

    const [open] = await tx
      .select({ id: schema.payout.id })
      .from(schema.payout)
      .where(
        and(eq(schema.payout.publisherAccountId, account.id), eq(schema.payout.status, 'requested')),
      )
      .limit(1);
    if (open) throw new PayoutRefused('payout_pending', 'a payout request is already open');

    const rows = await tx
      .select({ id: schema.settlement.id, amountMinor: schema.settlement.amountMinor })
      .from(schema.settlement)
      .innerJoin(schema.revenuePeriod, eq(schema.revenuePeriod.id, schema.settlement.periodId))
      .where(
        and(
          eq(schema.settlement.publisherAccountId, account.id),
          eq(schema.settlement.status, 'accrued'),
          /* The PayPal transfer is sent in dollars, like the credit is priced. */
          eq(schema.settlement.currency, PLAN_CURRENCY),
          isNotNull(schema.revenuePeriod.lockedAt),
          /* Past the hold, or negative: a refund nets against the payout at once (redeem-credit.ts `releasable`). */
          releasable(now, settings.payoutHoldDays),
        ),
      )
      .for('update', { of: schema.settlement });

    const amountMinor = rows.reduce((sum, row) => sum + Number(row.amountMinor), 0);
    if (amountMinor < settings.payoutThresholdMinor) {
      throw new PayoutRefused(
        'below_threshold',
        `${amountMinor} is past its hold; a payout needs at least ${settings.payoutThresholdMinor}`,
      );
    }

    const payoutId = uuidv7();
    await tx.insert(schema.payout).values({
      id: payoutId,
      publisherAccountId: account.id,
      amountMinor,
      currency: PLAN_CURRENCY,
      method: PAYOUT_METHOD,
      payeeEmail,
      status: 'requested',
      requestedBy: redeemedByTag(input.actor),
      createdAt: now,
    });
    await tx
      .update(schema.settlement)
      .set({ status: 'held', payoutId })
      .where(
        inArray(
          schema.settlement.id,
          rows.map((row) => row.id),
        ),
      );

    return { payoutId, amountMinor, currency: PLAN_CURRENCY, payeeEmail, statements: rows.length };
  });
}
