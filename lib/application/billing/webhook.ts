/**
 * Use case: apply a verified Payment Provider notification. architecture.md 11.3.
 *
 * The steps, and where each happens:
 *
 * 1. Raw body and signature -- the adapter (`verifyWebhook`), before anything
 *    here runs.
 * 2. Idempotent record keyed on `(provider, external_event_id)` --
 *    `recordPaymentEvent`, first thing in the transaction.
 * 3. The immutable Plan Version -- frozen on every billing document and pack
 *    grant.
 * 4. The outcome is the mirror row, the pack grant and the buyer's storage
 *    tier; historical usage is never touched.
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
 *
 * Two things are sold: the Additional Calls pack (agent-first-proposal.md
 * 8.1), whose notifications change a workspace's pack balance and its
 * owners' storage tier, and channel subscriptions (6.9), whose
 * notifications change the subscriber's access and tier and write the
 * creator's share to the channel income ledger. Any other subscription
 * event is reported as ignored by the adapter.
 */
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  BillingMirrorRefused,
  isCollected,
  parseProviderDocument,
  type BillingDocumentDraft,
} from '@/lib/domain/billing';
import { uuidv7 } from '@/lib/domain/id';
import {
  paymentAdapter,
  type PaymentAdapter,
  type PaymentNotification,
  type ProviderDocumentNotice,
} from '@/lib/infrastructure/payment/provider';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { PLAN_VERSION_NEWEST_FIRST } from '@/lib/application/plans/configuration';
import type { Tx } from '@/lib/application/plans/quota';
import { extendStorageTier } from '@/lib/application/plans/storage';
import { applyChannelSubscription, applyChannelTransaction } from '@/lib/application/channels/subscriptions';
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
  const adapter = paymentAdapter();
  const notification = await adapter.verifyWebhook(rawBody, signature);
  return applyPaymentNotification(notification, adapter);
}

/**
 * `adapter` is the provider a channel refund cancels its subscription at
 * (subscriptions.ts `stopAtProvider`); the deployment's when not given.
 */
export async function applyPaymentNotification(
  notification: PaymentNotification,
  adapter?: PaymentAdapter,
): Promise<PaymentWebhookOutcome> {
  /*
   * Ignored events are not recorded. Paddle sends whatever the endpoint is
   * subscribed to, including customer and address events that carry personal
   * data, and a log of payloads we never act on is personal data held for no
   * purpose.
   */
  if (notification.subject === 'ignored') return 'ignored';
  if (notification.subject === 'channel_transaction' || notification.subject === 'channel_subscription') {
    return applyChannelNotification(notification, adapter);
  }
  if (!notification.document) return 'ignored';
  const notice = notification.document;

  /*
   * Parsed before the transaction, so a refusal can still record the event
   * that caused it: a refusal thrown inside the transaction would roll the
   * record back with it.
   */
  let draft: BillingDocumentDraft | null = null;
  try {
    draft = parseProviderDocument(notice.document);
  } catch (error) {
    if (!(error instanceof BillingMirrorRefused)) throw error;
    console.error(`payment webhook: ${notification.externalEventId} refused: ${error.code}`);
  }

  return db().transaction(async (tx) => {
    const eventId = await recordPaymentEvent(tx, notification.provider, notification);
    if (!eventId) return 'redelivered';
    if (!draft) return 'refused';
    return projectDocument(tx, notice, draft, eventId);
  });
}

/* ---------------------------------------------------------------- channel */

/**
 * A subscription event that outran the transaction creating its row: thrown
 * so the event rolls back unrecorded and the provider's retry finds it
 * again, by which time the transaction has landed.
 */
const SUBSCRIPTION_WAIT_MS = 24 * 60 * 60 * 1000;

export class ChannelSubscriptionNotYetKnown extends Error {
  constructor(externalId: string) {
    super(`channel subscription ${externalId} is not known yet`);
    this.name = 'ChannelSubscriptionNotYetKnown';
  }
}

/**
 * A channel subscription's money or state (agent-first-proposal.md 6.9):
 * recorded and applied in one transaction like a document, so a retry is
 * either a full redo or a no-op. Nothing is mirrored as the subscriber's
 * billing document -- it is the creator's sale, sold through re0's account.
 */
async function applyChannelNotification(
  notification: Extract<PaymentNotification, { subject: 'channel_transaction' | 'channel_subscription' }>,
  adapter: PaymentAdapter | undefined,
): Promise<PaymentWebhookOutcome> {
  return db().transaction(async (tx) => {
    const eventId = await recordPaymentEvent(tx, notification.provider, notification);
    if (!eventId) return 'redelivered';
    if (notification.subject === 'channel_transaction') {
      return applyChannelTransaction(tx, notification.channel, adapter);
    }
    const outcome = await applyChannelSubscription(tx, notification.channel);
    /*
     * Retried while the first transaction may still be on its way; a day on,
     * none is coming (a checkout whose payment failed), so the event is
     * recorded as unresolved instead of failing every redelivery.
     */
    if (outcome === 'unresolved' && Date.now() - notification.channel.observedAt.getTime() < SUBSCRIPTION_WAIT_MS) {
      throw new ChannelSubscriptionNotYetKnown(notification.channel.subscriptionExternalId);
    }
    return outcome;
  });
}

/* --------------------------------------------------------------- document */

async function workspaceExists(tx: Tx, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await tx
    .select({ id: schema.workspace.id })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, id));
  return row?.id ?? null;
}

/**
 * The pack version a purchase binds to: the one tagged at checkout when it is
 * a pack version, otherwise the newest.
 *
 * The fallback exists for a pack sold outside our checkout -- by support, in
 * Paddle's dashboard -- which has no tag. Binding it to the live version is
 * what a fresh checkout would have done at that moment.
 */
async function packVersionFor(
  tx: Tx,
  tagged: string | null,
): Promise<{ id: string; monthlyCalls: number } | null> {
  if (tagged) {
    const [version] = await tx
      .select({ id: schema.planVersion.id, monthlyCalls: schema.planVersion.monthlyCalls })
      .from(schema.planVersion)
      .where(and(eq(schema.planVersion.id, tagged), eq(schema.planVersion.planId, 'addon')));
    if (version) return version;
  }
  const [newest] = await tx
    .select({ id: schema.planVersion.id, monthlyCalls: schema.planVersion.monthlyCalls })
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'addon'))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  return newest ?? null;
}

async function projectDocument(
  tx: Tx,
  notice: ProviderDocumentNotice,
  draft: BillingDocumentDraft,
  eventId: string,
): Promise<PaymentWebhookOutcome> {
  /*
   * A document already mirrored keeps its workspace (the mirror never moves
   * one), so that is asked first; then the checkout's tag.
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
  const workspaceId = mirrored?.workspaceId ?? (await workspaceExists(tx, notice.workspaceId));
  if (!workspaceId) {
    console.error(`payment webhook: document ${draft.externalId} names no known workspace`);
    return 'unresolved';
  }

  let planVersionId: string | null = null;
  let addonGrantId: string | null = null;
  let unplaced = false;

  if (draft.kind === 'pack') {
    const version = await packVersionFor(tx, notice.planVersionId);
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
    /*
     * agent-first-proposal.md 8.1: the first pack a user buys raises their
     * workspace to the extended storage tier, for good. Done on every
     * collected pack event -- a redelivery, and a pack no version could place
     * (the money arrived; the grant is the operator's to backfill) -- so the
     * promise on the pricing page holds whenever a pack was paid for.
     */
    if (isCollected(draft.status)) await extendStorageTier(tx, workspaceId);
  }

  /*
   * The provider customer is learnt from the first collected document, so the
   * billing portal has something to open as soon as there is a receipt to
   * read there. It sits on the workspace's Free subscription row -- the one
   * row every workspace has (signup writes it) and no purchase replaces.
   */
  if (notice.customerId) {
    await tx
      .update(schema.subscription)
      .set({ providerCustomerId: notice.customerId })
      .where(
        and(eq(schema.subscription.workspaceId, workspaceId), isNull(schema.subscription.providerCustomerId)),
      );
  }

  const result = await writeProviderDocument(
    tx,
    draft,
    {
      workspaceId,
      subscriptionId: null,
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
 * Newest first, so a workspace with more than one subscription row reaches
 * the one most recently in force.
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
