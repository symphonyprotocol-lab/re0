/**
 * Use case: apply a verified Payment Provider notification. architecture.md 11.3.
 *
 * The five steps, and where each happens:
 *
 * 1. Raw body and signature -- the adapter (`verifyWebhook`), before anything
 *    here runs.
 * 2. Idempotent record keyed on `(provider, external_event_id)` --
 *    `recordPaymentEvent`, first thing in the transaction.
 * 3. Provider state onto the internal subscription -- `projectSubscription`.
 *    Which row is then in force is lib/application/plans/in-force's call;
 *    nothing here touches the Free row signup wrote.
 * 4. The immutable Plan Version -- frozen on the subscription row when it is
 *    first written, and on every billing document and pack grant.
 * 5. The outcome is the mirror row; historical usage is never touched.
 *
 * Everything an event changes is written in one transaction with its
 * `payment_event` row. That is what makes a retry safe in both directions: a
 * failure anywhere rolls the event back too, so the provider's retry finds it
 * unprocessed and does the whole thing again; and a success records it, so the
 * retry is a no-op.
 *
 * Notifications that cannot be placed -- a workspace that does not exist, a
 * document the mirror refuses -- are still recorded, with their payload, and
 * acknowledged. Retrying them would fail the same way forever, and the payload
 * in `payment_event` is what an operator reconciles from.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import {
  BillingMirrorRefused,
  isCollected,
  parseProviderDocument,
  type BillingDocumentDraft,
} from '@/lib/domain/billing';
import { uuidv7 } from '@/lib/domain/id';
import type { PlanTierId } from '@/lib/domain/plans';
import {
  paymentAdapter,
  type PaymentNotification,
  type ProviderDocumentNotice,
  type ProviderSubscriptionNotice,
} from '@/lib/infrastructure/payment/provider';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { PLAN_VERSION_NEWEST_FIRST } from '@/lib/application/plans/configuration';
import type { Tx } from '@/lib/application/plans/quota';

/**
 * Provider subscription states that are still a billing relationship: the
 * card is charged, or will be again. `past_due` and `paused` grant nothing,
 * but buying a second subscription beside one of them is still paying twice.
 */
export const LIVE_PROVIDER_STATUSES = ['active', 'trialing', 'past_due', 'paused'] as const;
import { recordPaymentEvent, writeProviderDocument } from './mirror';

export type PaymentWebhookOutcome =
  /** Written. */
  | 'applied'
  /** This event was already processed. */
  | 'redelivered'
  /** The row already holds a newer state than this event describes. */
  | 'stale'
  /** Not an event re0 acts on. Not recorded. */
  | 'ignored'
  /** Recorded, but no workspace could be found to apply it to. */
  | 'unresolved'
  /** Recorded, but the mirror refused the document it describes. */
  | 'refused';

/** Verifies and applies one webhook delivery. Throws `WebhookRejected` on a bad signature. */
export async function receivePaymentWebhook(
  rawBody: string,
  signature: string | null,
): Promise<PaymentWebhookOutcome> {
  const notification = await paymentAdapter().verifyWebhook(rawBody, signature);
  return applyPaymentNotification(notification);
}

export async function applyPaymentNotification(
  notification: PaymentNotification,
): Promise<PaymentWebhookOutcome> {
  /*
   * Ignored events are not recorded. Paddle sends whatever the endpoint is
   * subscribed to, including customer and address events that carry personal
   * data, and a log of payloads we never act on is personal data held for no
   * purpose.
   */
  if (notification.subject === 'ignored') return 'ignored';
  if (notification.subject === 'document' && !notification.document) return 'ignored';

  /*
   * Parsed before the transaction, so a refusal can still record the event
   * that caused it: a refusal thrown inside the transaction would roll the
   * record back with it.
   */
  let draft: BillingDocumentDraft | null = null;
  let refused = false;
  if (notification.subject === 'document' && notification.document) {
    try {
      draft = parseProviderDocument(notification.document.document);
    } catch (error) {
      if (!(error instanceof BillingMirrorRefused)) throw error;
      console.error(`payment webhook: ${notification.externalEventId} refused: ${error.code}`);
      refused = true;
    }
  }

  return db().transaction(async (tx) => {
    const eventId = await recordPaymentEvent(tx, notification.provider, notification);
    if (!eventId) return 'redelivered';
    if (refused) return 'refused';

    if (notification.subject === 'subscription') {
      return projectSubscription(tx, notification.subscription);
    }
    return projectDocument(tx, notification.document!, draft!, eventId);
  });
}

/* ----------------------------------------------------------- subscription */

async function workspaceExists(tx: Tx, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await tx
    .select({ id: schema.workspace.id })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, id));
  return row?.id ?? null;
}

/**
 * The Plan Version a purchase binds to: the one tagged at checkout when it is
 * a version of the tier being bought, otherwise the tier's newest.
 *
 * The fallback exists for a subscription created outside our checkout -- by
 * support, in Paddle's dashboard -- which has no tag. Binding it to the live
 * version is what a fresh checkout would have done at that moment.
 */
async function planVersionFor(
  tx: Tx,
  tier: PlanTierId,
  tagged: string | null,
): Promise<{ id: string; monthlyCalls: number } | null> {
  if (tagged) {
    const [version] = await tx
      .select({ id: schema.planVersion.id, monthlyCalls: schema.planVersion.monthlyCalls })
      .from(schema.planVersion)
      .where(and(eq(schema.planVersion.id, tagged), eq(schema.planVersion.planId, tier)));
    if (version) return version;
  }
  const [newest] = await tx
    .select({ id: schema.planVersion.id, monthlyCalls: schema.planVersion.monthlyCalls })
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, tier))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  return newest ?? null;
}

/**
 * Upserts the subscription row a provider subscription maps to.
 *
 * The Plan Version is written on insert and never again. A renewal or a
 * payment-method change arrives as `subscription.updated`, and re-resolving
 * the version on it would migrate the subscriber to whatever the console
 * minted since -- requirement.md 4.3 says a plan change only reaches new
 * subscriptions.
 */
async function projectSubscription(
  tx: Tx,
  notice: ProviderSubscriptionNotice,
): Promise<PaymentWebhookOutcome> {
  const [existing] = await tx
    .select({
      id: schema.subscription.id,
      workspaceId: schema.subscription.workspaceId,
      periodStart: schema.subscription.periodStart,
      periodEnd: schema.subscription.periodEnd,
    })
    .from(schema.subscription)
    .where(eq(schema.subscription.providerSubscriptionId, notice.externalId));

  const workspaceId = existing?.workspaceId ?? (await workspaceExists(tx, notice.workspaceId));
  if (!workspaceId) {
    console.error(`payment webhook: subscription ${notice.externalId} names no known workspace`);
    return 'unresolved';
  }

  const version = existing ? null : await planVersionFor(tx, 'pro', notice.planVersionId);
  if (!existing && !version) {
    console.error('payment webhook: no Pro plan version to bind a subscription to');
    return 'unresolved';
  }

  /*
   * A cancelled subscription reports no current period. The row keeps the one
   * it had; a subscription first seen already cancelled gets a zero-length
   * window at the moment it was observed, which no quota check will ever land
   * inside.
   */
  const periodStart = notice.periodStart ?? existing?.periodStart ?? notice.observedAt;
  const periodEnd = notice.periodEnd ?? existing?.periodEnd ?? notice.observedAt;

  /* Same guard as the document mirror: equal times pass, older ones do not. */
  const newer = or(
    isNull(schema.subscription.observedAt),
    lte(schema.subscription.observedAt, notice.observedAt),
  );
  const state = {
    status: notice.status,
    periodStart,
    periodEnd,
    observedAt: notice.observedAt,
  };

  const [written] = existing
    ? await tx
        .update(schema.subscription)
        .set({ ...state, ...(notice.customerId ? { providerCustomerId: notice.customerId } : {}) })
        .where(and(eq(schema.subscription.id, existing.id), newer))
        .returning({ id: schema.subscription.id })
    : await tx
        .insert(schema.subscription)
        .values({
          id: uuidv7(),
          workspaceId,
          planVersionId: version!.id,
          providerCustomerId: notice.customerId,
          providerSubscriptionId: notice.externalId,
          ...state,
        })
        /*
         * Two first events for one subscription racing each other: the loser
         * becomes an update of the winner's row, under the same guard, rather
         * than a unique violation the provider would retry.
         */
        .onConflictDoUpdate({
          target: schema.subscription.providerSubscriptionId,
          setWhere: newer,
          set: state,
        })
        .returning({ id: schema.subscription.id });

  if (!written) return 'stale';

  /*
   * A second live provider subscription for one workspace is two charges on
   * one card. Checkout refuses to start one (./checkout), but a subscription
   * created in the provider's dashboard, or a checkout that slipped past, can
   * still arrive. re0 does not cancel or refund on the provider's behalf
   * (requirement.md 4.3), so it is said loudly for support to resolve there.
   */
  if (!existing && (notice.status === 'active' || notice.status === 'trialing')) {
    const [other] = await tx
      .select({ id: schema.subscription.providerSubscriptionId })
      .from(schema.subscription)
      .where(
        and(
          eq(schema.subscription.workspaceId, workspaceId),
          isNotNull(schema.subscription.providerSubscriptionId),
          ne(schema.subscription.providerSubscriptionId, notice.externalId),
          inArray(schema.subscription.status, LIVE_PROVIDER_STATUSES),
        ),
      )
      .limit(1);
    if (other) {
      console.error(
        `payment webhook: workspace ${workspaceId} now has two live subscriptions (${other.id}, ${notice.externalId})`,
      );
    }
  }
  return 'applied';
}

/* --------------------------------------------------------------- document */

async function projectDocument(
  tx: Tx,
  notice: ProviderDocumentNotice,
  draft: BillingDocumentDraft,
  eventId: string,
): Promise<PaymentWebhookOutcome> {
  const [subscription] = notice.subscriptionExternalId
    ? await tx
        .select({
          id: schema.subscription.id,
          workspaceId: schema.subscription.workspaceId,
          planVersionId: schema.subscription.planVersionId,
          providerCustomerId: schema.subscription.providerCustomerId,
        })
        .from(schema.subscription)
        .where(eq(schema.subscription.providerSubscriptionId, notice.subscriptionExternalId))
    : [];

  /*
   * A document already mirrored keeps its workspace (the mirror never moves
   * one), so that is asked first; then the checkout's tag; then the
   * subscription it bills, which is how a renewal nobody tagged is placed.
   */
  const [mirrored] = await tx
    .select({ workspaceId: schema.billingDocument.workspaceId })
    .from(schema.billingDocument)
    .where(
      and(
        eq(schema.billingDocument.provider, draft.provider),
        eq(schema.billingDocument.externalId, draft.externalId),
      ),
    );
  const workspaceId =
    mirrored?.workspaceId ??
    (await workspaceExists(tx, notice.workspaceId)) ??
    subscription?.workspaceId ??
    null;
  if (!workspaceId) {
    console.error(`payment webhook: document ${draft.externalId} names no known workspace`);
    return 'unresolved';
  }

  let planVersionId = subscription?.planVersionId ?? null;
  let addonGrantId: string | null = null;

  let unplaced = false;
  if (draft.kind === 'pack') {
    const version = await planVersionFor(tx, 'addon', notice.planVersionId);
    planVersionId = version?.id ?? null;
    /*
     * Paid for, with no pack version to say how many calls that buys. The
     * document is still mirrored -- the money did arrive -- but the grant
     * cannot be invented, so the outcome says the purchase is unplaced.
     */
    if (!version && isCollected(draft.status)) {
      console.error(`payment webhook: pack ${draft.externalId} paid, but no Additional Calls version exists`);
      unplaced = true;
    }
    if (version && isCollected(draft.status)) {
      addonGrantId = await grantPack(tx, {
        workspaceId,
        orderId: draft.externalId,
        calls: version.monthlyCalls * notice.quantity,
        priceMinor: draft.amountMinor,
        currency: draft.currency,
      });
    }
  } else if (!planVersionId && notice.planVersionId) {
    planVersionId = (await planVersionFor(tx, 'pro', notice.planVersionId))?.id ?? null;
  }

  /*
   * The customer is learnt here as well as from the subscription, because a
   * `transaction.completed` can arrive before `subscription.created`, and the
   * billing portal needs it as soon as there is anything to manage.
   */
  if (subscription && !subscription.providerCustomerId && notice.customerId) {
    await tx
      .update(schema.subscription)
      .set({ providerCustomerId: notice.customerId })
      .where(eq(schema.subscription.id, subscription.id));
  }

  const result = await writeProviderDocument(
    tx,
    draft,
    {
      workspaceId,
      subscriptionId: subscription?.id ?? null,
      addonGrantId,
      planVersionId,
      observedAt: notice.observedAt,
    },
    eventId,
  );
  if (result.skipped === 'stale') return 'stale';
  return unplaced ? 'unresolved' : 'applied';
}

/**
 * Grants a paid pack's calls, once per provider order.
 *
 * A pack reports `paid` and then `completed`, either may be redelivered, and
 * both are collected states -- so the grant is keyed on the order and the
 * second arrival finds it already there. Refunds do not claw the grant back:
 * requirement.md 4.3 treats a pack's balance as delivered, and reversing a
 * refunded pack's unconsumed calls is a support decision made at the provider,
 * not an automatic one made here.
 */
async function grantPack(
  tx: Tx,
  pack: { workspaceId: string; orderId: string; calls: number; priceMinor: number; currency: string },
): Promise<string | null> {
  const [granted] = await tx
    .insert(schema.addonGrant)
    .values({
      id: uuidv7(),
      workspaceId: pack.workspaceId,
      callsGranted: pack.calls,
      priceMinor: pack.priceMinor,
      currency: pack.currency,
      providerOrderId: pack.orderId,
    })
    .onConflictDoNothing({ target: schema.addonGrant.providerOrderId })
    .returning({ id: schema.addonGrant.id });
  if (granted) return granted.id;

  const [existing] = await tx
    .select({ id: schema.addonGrant.id })
    .from(schema.addonGrant)
    .where(eq(schema.addonGrant.providerOrderId, pack.orderId));
  return existing?.id ?? null;
}

/* ---------------------------------------------------------------- reads */

/**
 * The provider customer a workspace already is, if it has bought anything.
 * Newest first, so a workspace that re-subscribed under a new customer
 * reaches the one its current subscription belongs to.
 */
export async function workspaceProviderCustomer(workspaceId: string): Promise<string | null> {
  const [row] = await db()
    .select({ customerId: schema.subscription.providerCustomerId })
    .from(schema.subscription)
    .where(
      and(
        eq(schema.subscription.workspaceId, workspaceId),
        isNotNull(schema.subscription.providerCustomerId),
      ),
    )
    .orderBy(desc(schema.subscription.periodEnd))
    .limit(1);
  return row?.customerId ?? null;
}
