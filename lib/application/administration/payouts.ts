/**
 * The operator's half of a manual cash payout (publisher-revenue-share.md
 * 3.4). A publisher's request (lib/application/revenue/payout) holds their
 * statements; an operator sends the money from the platform's PayPal account
 * outside this system and then records the outcome here:
 *
 * - paid: the PayPal transaction id goes on the payout, its statements become
 *   `paid`. This is the only place a statement is ever marked paid, so every
 *   `paid` row in the ledger has a transaction id behind it;
 * - failed: the reason goes on the payout, its statements return to `accrued`
 *   and leave it, so the publisher can request again or redeem them as calls.
 *
 * Both take the payout row `FOR UPDATE` and act only on a `requested` one, so
 * two operators pressing at once resolve it once. Both land in the audit
 * chain with a reason (requirement.md 5.3).
 *
 * A library can be suspended or unpublished between the request and the
 * payment. Its statements are then withheld (share doc 5) exactly as the
 * credit path withholds them, so "paid" is refused while the payout covers
 * one; the queue flags such payouts before anyone sends money, and marking
 * them failed returns everything to the ledger, where the withheld part
 * stays put and the rest can be requested again.
 */
import { and, asc, count, desc, eq, inArray, ne, not, sql } from 'drizzle-orm';
import { libraryEarns } from '@/lib/application/revenue/redeem-credit';
import {
  PAYOUT_REFERENCE_MAX_LENGTH,
  PayoutResolveRefused,
  type PayoutStatus,
} from '@/lib/domain';
import { normalizeReason } from '@/lib/domain/admin';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from './audit';

export interface ConsolePayoutRow {
  id: string;
  publisherName: string;
  publisherWorkspaceId: string;
  payeeEmail: string | null;
  amountMinor: number;
  currency: string;
  status: PayoutStatus;
  /** Open payouts only: what they cover. */
  statements: number;
  /** The periods the statements came from, oldest first. */
  periods: string[];
  /**
   * Covered statements whose library no longer earns. Non-zero means the
   * payout cannot be marked paid; it has to be marked failed.
   */
  withheldMinor: number;
  requestedBy: string | null;
  createdAt: Date;
  providerReference: string | null;
  failureReason: string | null;
  resolvedAt: Date | null;
  resolvedByEmail: string | null;
}

export interface ConsolePayouts {
  /** Waiting for an operator, oldest first: the queue. */
  open: ConsolePayoutRow[];
  /** The latest resolved ones, newest first. */
  resolved: ConsolePayoutRow[];
}

const RESOLVED_SHOWN = 20;

export async function consolePayouts(): Promise<ConsolePayouts> {
  const database = db();

  const base = () =>
    database
      .select({
        id: schema.payout.id,
        publisherName: schema.workspace.name,
        publisherWorkspaceId: schema.workspace.id,
        payeeEmail: schema.payout.payeeEmail,
        amountMinor: schema.payout.amountMinor,
        currency: schema.payout.currency,
        status: schema.payout.status,
        requestedBy: schema.payout.requestedBy,
        createdAt: schema.payout.createdAt,
        providerReference: schema.payout.providerReference,
        failureReason: schema.payout.failureReason,
        resolvedAt: schema.payout.resolvedAt,
        resolvedByEmail: schema.administrator.email,
      })
      .from(schema.payout)
      .innerJoin(
        schema.publisherAccount,
        eq(schema.publisherAccount.id, schema.payout.publisherAccountId),
      )
      .innerJoin(schema.workspace, eq(schema.workspace.id, schema.publisherAccount.workspaceId))
      .leftJoin(schema.administrator, eq(schema.administrator.id, schema.payout.resolvedBy));

  const [openRows, resolvedRows] = await Promise.all([
    base()
      .where(eq(schema.payout.status, 'requested'))
      .orderBy(asc(schema.payout.createdAt), asc(schema.payout.id)),
    base()
      .where(ne(schema.payout.status, 'requested'))
      .orderBy(desc(schema.payout.resolvedAt), desc(schema.payout.id))
      .limit(RESOLVED_SHOWN),
  ]);

  /* What each open payout covers, and whether a library in it stopped earning. */
  const openIds = openRows.map((row) => row.id);
  const covered =
    openIds.length === 0
      ? []
      : await database
          .select({
            payoutId: schema.settlement.payoutId,
            statements: count(),
            periods: sql<string[]>`array_agg(distinct ${schema.settlement.periodId} order by ${schema.settlement.periodId})`,
            withheldMinor: sql<number>`coalesce(sum(${schema.settlement.amountMinor}) filter (where not (${libraryEarns()})), 0)::bigint`,
          })
          .from(schema.settlement)
          .innerJoin(schema.library, eq(schema.library.id, schema.settlement.libraryId))
          .where(inArray(schema.settlement.payoutId, openIds))
          .groupBy(schema.settlement.payoutId);
  const byPayout = new Map(covered.map((row) => [row.payoutId, row]));

  const shape = (row: (typeof openRows)[number]): ConsolePayoutRow => ({
    ...row,
    amountMinor: Number(row.amountMinor),
    status: row.status as PayoutStatus,
    statements: byPayout.get(row.id)?.statements ?? 0,
    periods: byPayout.get(row.id)?.periods ?? [],
    withheldMinor: Number(byPayout.get(row.id)?.withheldMinor ?? 0),
  });

  return { open: openRows.map(shape), resolved: resolvedRows.map(shape) };
}

export interface PayoutActor {
  administratorId: string;
  email: string;
  clientAddress?: string | null;
}

export interface ResolvedPayout {
  payoutId: string;
  status: Exclude<PayoutStatus, 'requested'>;
  amountMinor: number;
  statements: number;
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

/** The payout row, locked, if it is still waiting; refuses otherwise. */
async function openPayout(tx: Tx, payoutId: string) {
  const [payout] = await tx
    .select()
    .from(schema.payout)
    .where(eq(schema.payout.id, payoutId))
    .for('update');
  if (!payout) throw new PayoutResolveRefused('not_found', 'no such payout');
  if (payout.status !== 'requested') {
    throw new PayoutResolveRefused('payout_resolved', `the payout is already ${payout.status}`);
  }
  return payout;
}

/**
 * Record that the money was sent: `reference` is the PayPal transaction id,
 * which is what lets anyone later match this row to the PayPal statement.
 */
export async function markPayoutPaid(input: {
  actor: PayoutActor;
  payoutId: string;
  reference: string;
  reason: string;
}): Promise<ResolvedPayout> {
  const reason = normalizeReason(input.reason);
  const reference = input.reference.trim();
  if (reference.length === 0) {
    throw new PayoutResolveRefused('reference_required', 'the PayPal transaction id is required');
  }
  if (reference.length > PAYOUT_REFERENCE_MAX_LENGTH) {
    throw new PayoutResolveRefused('invalid_input', 'the transaction id is too long');
  }

  const outcome = await db().transaction(async (tx) => {
    const payout = await openPayout(tx, input.payoutId);
    /* Read under the payout lock: a suspension committed before this point is seen. */
    const [withheld] = await tx
      .select({ n: count() })
      .from(schema.settlement)
      .innerJoin(schema.library, eq(schema.library.id, schema.settlement.libraryId))
      .where(
        and(
          eq(schema.settlement.payoutId, payout.id),
          eq(schema.settlement.status, 'held'),
          not(libraryEarns()),
        ),
      );
    if ((withheld?.n ?? 0) > 0) {
      throw new PayoutResolveRefused(
        'payout_withheld',
        'the payout covers a library that is suspended or no longer published',
      );
    }
    await tx
      .update(schema.payout)
      .set({
        status: 'paid',
        providerReference: reference,
        resolvedBy: input.actor.administratorId,
        resolvedAt: new Date(),
      })
      .where(eq(schema.payout.id, payout.id));
    const statements = await tx
      .update(schema.settlement)
      .set({ status: 'paid' })
      .where(and(eq(schema.settlement.payoutId, payout.id), eq(schema.settlement.status, 'held')))
      .returning({ id: schema.settlement.id });
    return { payout, statements: statements.map((row) => row.id) };
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'payout.paid',
    targetType: 'payout',
    targetId: input.payoutId,
    reason,
    beforeValue: {
      status: 'requested',
      amountMinor: Number(outcome.payout.amountMinor),
      payeeEmail: outcome.payout.payeeEmail,
    },
    afterValue: { status: 'paid', providerReference: reference, statements: outcome.statements },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return {
    payoutId: input.payoutId,
    status: 'paid',
    amountMinor: Number(outcome.payout.amountMinor),
    statements: outcome.statements.length,
  };
}

/**
 * Record that the money could not be sent -- a wrong address, a PayPal
 * refusal. The statements go back to `accrued`, unlinked, and the publisher
 * sees the reason on their revenue page.
 */
export async function markPayoutFailed(input: {
  actor: PayoutActor;
  payoutId: string;
  reason: string;
}): Promise<ResolvedPayout> {
  const reason = normalizeReason(input.reason);

  const outcome = await db().transaction(async (tx) => {
    const payout = await openPayout(tx, input.payoutId);
    await tx
      .update(schema.payout)
      .set({
        status: 'failed',
        failureReason: reason,
        resolvedBy: input.actor.administratorId,
        resolvedAt: new Date(),
      })
      .where(eq(schema.payout.id, payout.id));
    const statements = await tx
      .update(schema.settlement)
      .set({ status: 'accrued', payoutId: null })
      .where(and(eq(schema.settlement.payoutId, payout.id), eq(schema.settlement.status, 'held')))
      .returning({ id: schema.settlement.id });
    return { payout, statements: statements.map((row) => row.id) };
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'payout.failed',
    targetType: 'payout',
    targetId: input.payoutId,
    reason,
    beforeValue: {
      status: 'requested',
      amountMinor: Number(outcome.payout.amountMinor),
      payeeEmail: outcome.payout.payeeEmail,
    },
    /* The statements leave the payout here, so the audit row is where the link survives. */
    afterValue: { status: 'failed', releasedStatements: outcome.statements },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return {
    payoutId: input.payoutId,
    status: 'failed',
    amountMinor: Number(outcome.payout.amountMinor),
    statements: outcome.statements.length,
  };
}
