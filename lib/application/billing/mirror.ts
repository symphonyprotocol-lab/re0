/**
 * Use case: write what the Payment Provider reported into the console's mirror.
 *
 * This is steps 2 and 5 of architecture.md 11.3 -- record the verified event
 * once, project it onto the document it describes -- and nothing else. It does
 * not charge, refund, retry or reissue: re0 never moves money
 * (requirement.md 4.3), so the only thing this side of the boundary does with a
 * payment is find out about it.
 *
 * The webhook (./webhook) is the caller, and it composes the two halves below
 * -- `recordPaymentEvent` and `writeProviderDocument` -- inside a transaction
 * of its own, because a pack's grant has to land in that same transaction.
 * `mirrorProviderDocument` is the two of them alone, for a backfill.
 *
 * It deliberately does not touch `subscription`. Mapping a provider's
 * subscription lifecycle onto ours (step 3) needs the subscription resolved
 * to a Plan Version (step 4), and doing half of that here -- flipping a status
 * without re-resolving the version -- would leave a workspace billing against
 * a row nobody chose. That is the webhook's, which knows the provider.
 */
import { and, eq, lte } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import {
  hasBillingPeriod,
  isCollected,
  parseProviderDocument,
  type BillingDocumentDraft,
  type ProviderDocumentInput,
} from '@/lib/domain/billing';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import type { Tx } from '@/lib/application/plans/quota';

export interface MirrorProviderDocumentInput extends ProviderDocumentInput {
  /** Whose document this is. Resolved by the caller from the provider customer. */
  workspaceId: string;
  subscriptionId?: string | null;
  addonGrantId?: string | null;
  /** The immutable version the order was priced against. requirement.md 4.3 */
  planVersionId?: string | null;
  /**
   * The verified event carrying this state.
   *
   * Optional because a backfill reconciling against the provider's API has no
   * event to point at, and refusing to mirror without one would mean the only
   * way to repair a missed webhook is to ask the provider to redeliver it.
   */
  event?: { externalEventId: string; payload: unknown } | null;
  /**
   * When the provider says this state was true. Defaults to now, which is the
   * best a backfill can honestly claim.
   */
  observedAt?: Date;
}

export interface MirrorProviderDocumentResult {
  /** Null only when the event was a redelivery, so nothing was written. */
  documentId: string | null;
  /** True when this document had never been mirrored before. */
  created: boolean;
  /**
   * Why nothing was written, when nothing was.
   *
   * `redelivered` is the provider sending an event we already processed;
   * `stale` is an event that describes a state older than the row already
   * holds, which is what unordered webhook delivery looks like from here.
   */
  skipped?: 'redelivered' | 'stale';
}

/**
 * Records the event and projects it, idempotently.
 *
 * Two different idempotency keys are doing two different jobs, and conflating
 * them is the bug this is shaped to avoid. `(provider, external_event_id)`
 * makes a redelivered webhook a no-op. `(provider, external_id)` makes the
 * document one row that moves through states rather than a row per notification
 * -- which is what lets the console filter on `status` at all.
 *
 * Both live in one transaction. An event recorded without its projection would
 * be permanently swallowed on the retry, because the retry would see the event
 * already processed and stop.
 */
export async function mirrorProviderDocument(
  input: MirrorProviderDocumentInput,
): Promise<MirrorProviderDocumentResult> {
  const draft = parseProviderDocument(input);

  return db().transaction(async (tx) => {
    let lastEventId: string | null = null;

    if (input.event) {
      lastEventId = await recordPaymentEvent(tx, draft.provider, input.event);
      /*
       * Nothing inserted means this event has already been through here. The
       * projection it produced is already in place, so re-applying it would at
       * best be a no-op and at worst -- with events arriving out of order --
       * would roll the document back to a state it has since left.
       */
      if (!lastEventId) return { documentId: null, created: false, skipped: 'redelivered' as const };
    }

    return writeProviderDocument(tx, draft, input, lastEventId);
  });
}

/**
 * Appends a verified event to `payment_event`, once.
 *
 * Returns the new row's id, or null when `(provider, external_event_id)` is
 * already there -- a redelivery, which the caller must treat as done.
 */
export async function recordPaymentEvent(
  tx: Tx,
  provider: string,
  event: { externalEventId: string; payload: unknown },
): Promise<string | null> {
  const [recorded] = await tx
    .insert(schema.paymentEvent)
    .values({
      id: uuidv7(),
      provider,
      externalEventId: event.externalEventId,
      payload: event.payload as Record<string, unknown>,
    })
    .onConflictDoNothing({
      target: [schema.paymentEvent.provider, schema.paymentEvent.externalEventId],
    })
    .returning({ id: schema.paymentEvent.id });
  return recorded?.id ?? null;
}

/**
 * Projects a validated document onto `billing_document`, guarded against
 * stale state. `lastEventId` is the event that carried it, when one did.
 */
export async function writeProviderDocument(
  tx: Tx,
  draft: BillingDocumentDraft,
  input: Omit<MirrorProviderDocumentInput, keyof ProviderDocumentInput | 'event'>,
  lastEventId: string | null,
): Promise<MirrorProviderDocumentResult> {
  const observedAt = input.observedAt ?? new Date();
  const documentId = uuidv7();
  const [written] = await tx
    .insert(schema.billingDocument)
    .values({
      id: documentId,
      workspaceId: input.workspaceId,
      provider: draft.provider,
      externalId: draft.externalId,
      /*
       * The fallbacks live here rather than in the draft, because they are
       * only ever right for a row being created. A provider that issues no
       * number still needs something in the column an operator searches by,
       * and the external id is what they would paste into the provider's own
       * console anyway.
       */
      number: draft.number ?? draft.externalId,
      kind: draft.kind,
      status: draft.status,
      amountMinor: draft.amountMinor,
      refundedMinor: draft.refundedMinor ?? 0,
      currency: draft.currency,
      method: draft.method,
      subscriptionId: input.subscriptionId ?? null,
      addonGrantId: input.addonGrantId ?? null,
      planVersionId: input.planVersionId ?? null,
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      issuedAt: draft.issuedAt ?? observedAt,
      /*
       * Same fallback as `issuedAt`, but only for a document whose money
       * actually arrived: a `paid` document mirrored without a stated
       * payment time would otherwise carry a null and be invisible to
       * every revenue figure keyed on `paid_at`. The draft already
       * derives null for uncollected states, so the fallback never
       * invents a payment time for them.
       */
      paidAt: draft.paidAt ?? (isCollected(draft.status) ? observedAt : null),
      lastEventId,
      observedAt,
    })
    .onConflictDoUpdate({
      target: [schema.billingDocument.provider, schema.billingDocument.externalId],
      /*
       * The out-of-order guard. A provider retries and reorders, so an event
       * describing an older state can land after a newer one; without this,
       * a late `paid` notification would overwrite a `refunded` document and
       * the console would report money the platform no longer has.
       *
       * Equal timestamps are allowed through: a provider that stamps a batch
       * with one instant would otherwise never update past the first of them.
       */
      setWhere: lte(schema.billingDocument.observedAt, observedAt),
      /*
       * An update writes what this event spoke about and leaves the rest of
       * the row alone.
       *
       * That asymmetry is the whole shape of this clause. A provider's later
       * notifications about one document -- a refund, a failed retry, a void
       * -- carry the id, the state and the money, and routinely nothing else.
       * Treating their silence as a value is how a `charge.refunded` erases
       * the payment time of the sale it refunds, taking the whole document
       * out of every revenue figure keyed on `paid_at`, and how it replaces
       * the invoice number an operator searches by with a machine id.
       *
       * The exceptions below are the fields where a null is a *derivation*
       * rather than a silence, and there the null has to be written.
       */
      set: {
        /*
         * `workspaceId` is not here at all. A document does not change hands,
         * and an adapter resolving the customer differently on a later
         * notification would otherwise move a paid invoice onto someone
         * else's account.
         */
        status: draft.status,
        /* Always stated by an event, so always written. */
        amountMinor: draft.amountMinor,
        currency: draft.currency,
        observedAt,
        ...(draft.number ? { number: draft.number } : {}),
        ...(draft.method ? { method: draft.method } : {}),
        ...(draft.issuedAt ? { issuedAt: draft.issuedAt } : {}),
        /*
         * A document that is no longer collected has no payment time, and
         * that null is a fact this event established rather than a gap in it
         * -- a voided invoice must not keep the timestamp of a payment that
         * was reversed. While it is still collected, only a stated time is
         * written.
         */
        ...(isCollected(draft.status)
          ? draft.paidAt
            ? { paidAt: draft.paidAt }
            : {}
          : { paidAt: null }),
        /*
         * And the same for the refund itself. A document that is no longer
         * collected cannot carry one, so the zero is written; while it is,
         * only a stated figure is -- otherwise a re-notification of the
         * original payment would wipe the refund recorded against it.
         */
        ...(isCollected(draft.status)
          ? draft.refundedMinor === null
            ? {}
            : { refundedMinor: draft.refundedMinor }
          : { refundedMinor: 0 }),
        /*
         * Same distinction for the period. A pack has none by rule, so the
         * null is written; a subscription's is only overwritten when this
         * event carried one.
         */
        ...(hasBillingPeriod(draft.kind)
          ? draft.periodStart || draft.periodEnd
            ? { periodStart: draft.periodStart, periodEnd: draft.periodEnd }
            : {}
          : { periodStart: null, periodEnd: null }),
        /*
         * The link back to source only moves with the state it explains. A
         * backfill with no event must not blank out the event id that told us
         * what the row currently says.
         */
        ...(lastEventId ? { lastEventId } : {}),
        /*
         * The order's own links are filled in the first time they are known
         * and never cleared afterwards: an adapter that cannot resolve the
         * subscription for one notification should not unlink a document that
         * an earlier one already placed.
         */
        ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
        ...(input.addonGrantId ? { addonGrantId: input.addonGrantId } : {}),
        ...(input.planVersionId ? { planVersionId: input.planVersionId } : {}),
      },
    })
    .returning({ id: schema.billingDocument.id });

  /*
   * No row back means the guard refused the update: the document is newer
   * than this event. The event stays recorded -- it did arrive, and a second
   * delivery of it should still be a no-op.
   */
  if (!written) {
    const [existing] = await tx
      .select({ id: schema.billingDocument.id })
      .from(schema.billingDocument)
      .where(
        and(
          eq(schema.billingDocument.provider, draft.provider),
          eq(schema.billingDocument.externalId, draft.externalId),
        ),
      );
    return { documentId: existing?.id ?? null, created: false, skipped: 'stale' as const };
  }

  return { documentId: written.id, created: written.id === documentId };
}
