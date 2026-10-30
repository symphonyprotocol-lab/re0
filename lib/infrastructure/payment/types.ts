/**
 * The shapes and errors shared by the payment boundary and its adapters.
 * See ./provider for what the boundary is for.
 */
import type { ProviderDocumentInput } from '@/lib/domain/billing';

export interface CheckoutInput {
  /** Only the Additional Calls pack is sold; nothing opens a subscription checkout. */
  kind: 'pack';
  workspaceId: string;
  /** The immutable version being bought; its price is the price charged. */
  planVersionId: string;
  priceMinor: number;
  currency: string;
  /** What the provider's checkout prints as the line item. */
  name: string;
  /** The provider customer this workspace already is, so purchases attach to it. */
  customerId: string | null;
}

/**
 * A checkout for one channel subscription (agent-first-proposal.md 6.9): a
 * recurring non-catalogue price cut from an immutable channel plan version,
 * against the one Paddle product that stands for channel subscriptions.
 * The subscriber's user and personal workspace are tagged so the webhook
 * knows whose access the payment buys.
 */
export interface ChannelCheckoutInput {
  channelPlanVersionId: string;
  channelId: string;
  userId: string;
  workspaceId: string;
  interval: 'month' | 'year';
  priceMinor: number;
  currency: string;
  /** What the checkout prints as the line item: the channel's title. */
  name: string;
  customerId: string | null;
}

/** One approved or pending money movement back to the buyer on a channel transaction. */
export interface ChannelAdjustmentNotice {
  id: string;
  action: 'refund' | 'chargeback' | 'chargeback_reverse' | 'other';
  status: string;
  /** Ex-tax amount, minor units, always positive. */
  exTaxMinor: number;
  observedAt: Date;
}

/** A channel subscription's transaction, as it stands at the provider. */
export interface ChannelTransactionNotice {
  transactionId: string;
  subscriptionExternalId: string | null;
  customerId: string | null;
  /** Collected (`paid`/`completed`), still `open`, or `other`. */
  state: 'collected' | 'open' | 'other';
  channelPlanVersionId: string | null;
  userId: string | null;
  workspaceId: string | null;
  /** The subtotal net of discounts and before tax: what the creator's share is a share of. */
  exTaxMinor: number;
  currency: string;
  collectedAt: Date | null;
  periodEnd: Date | null;
  adjustments: ChannelAdjustmentNotice[];
  observedAt: Date;
}

/** A channel subscription's own state change (`subscription.*`). */
export interface ChannelSubscriptionNotice {
  subscriptionExternalId: string;
  customerId: string | null;
  status: 'active' | 'past_due' | 'canceled' | 'paused' | 'other';
  /** A cancellation the subscriber has scheduled for the end of the period. */
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  channelPlanVersionId: string | null;
  userId: string | null;
  workspaceId: string | null;
  observedAt: Date;
}

/** A provider billing document, as it currently stands at the provider. */
export interface ProviderDocumentNotice {
  document: ProviderDocumentInput;
  workspaceId: string | null;
  planVersionId: string | null;
  /**
   * The provider subscription this document bills, when it bills one. re0
   * sells no subscription product (agent-first-proposal.md 8.1), so this is
   * set only on a document from a subscription that predates that; it is
   * kept for the mirror's record and binds nothing.
   */
  subscriptionExternalId: string | null;
  customerId: string | null;
  /** How many packs were bought, for a pack document. */
  quantity: number;
  observedAt: Date;
}

interface NotificationEnvelope {
  provider: string;
  externalEventId: string;
  eventType: string;
  payload: unknown;
}

export type PaymentNotification = NotificationEnvelope &
  (
    /*
     * `document` is null for a transaction that is not yet a billing document
     * at all -- a checkout opened and abandoned, which the provider tracks
     * and the mirror has no business listing.
     */
    | { subject: 'document'; document: ProviderDocumentNotice | null }
    /* A channel subscription's money or state (agent-first-proposal.md 6.9). */
    | { subject: 'channel_transaction'; channel: ChannelTransactionNotice }
    | { subject: 'channel_subscription'; channel: ChannelSubscriptionNotice }
    /*
     * Not an event re0 acts on. A subscription event that is not a channel
     * subscription's is among them: nothing else sells a subscription since
     * Pro was removed.
     */
    | { subject: 'ignored' }
  );

/**
 * One provider document as it stands now, read by id rather than announced by
 * a webhook. `document` is null on the same terms as a notification's: not yet
 * a billing document, or not something re0 sells.
 */
export interface ProviderDocumentSnapshot {
  document: ProviderDocumentNotice | null;
  /** The provider's own entities, kept with the backfill's event record. */
  payload: unknown;
}

/**
 * Where a checkout stands at the provider. `open` can still be paid, `paid`
 * has been (or is being) charged, `closed` never will be.
 */
export type CheckoutState = 'open' | 'paid' | 'closed';

export interface PaymentAdapter {
  readonly provider: string;
  /** Opens a checkout for the order; `url` is a page on this site that shows it. */
  createCheckout(input: CheckoutInput): Promise<{ externalId: string; url: string }>;
  checkoutState(externalId: string): Promise<CheckoutState>;
  /**
   * The page on this site that shows an already-open checkout, built from
   * today's settings. A link stored when the checkout was opened would still
   * name the checkout domain of that day.
   */
  checkoutUrl(externalId: string): string;
  /**
   * Opens a checkout for one channel subscription. Throws
   * `PaymentNotConfigured` when the deployment has no channel product.
   */
  createChannelCheckout(input: ChannelCheckoutInput): Promise<{ externalId: string; url: string }>;
  /** Schedules the subscription to end with its current period; access runs to then. */
  cancelSubscription(externalId: string): Promise<void>;
  /** A signed, short-lived link into the provider's customer portal. */
  portalUrl(input: { customerId: string }): Promise<string>;
  /**
   * A short-lived link that downloads the provider's PDF invoice for a
   * collected document. The provider issues it; nothing is rendered here.
   */
  invoiceUrl(externalId: string): Promise<string>;
  /**
   * Reads one document from the provider's API: the console's backfill for
   * a webhook that never arrived. Throws `PaymentProviderError` with the
   * provider's status when it has no such id.
   */
  fetchDocument(externalId: string): Promise<ProviderDocumentSnapshot>;
  /**
   * Verifies the signature over the raw body and turns the event into a
   * notice. Throws `WebhookRejected` when the signature does not hold; any
   * other throw is the provider being unreachable, and the webhook should be
   * retried.
   */
  verifyWebhook(rawBody: string, signature: string | null): Promise<PaymentNotification>;
}

/** The signature did not verify. The request is not from the provider. */
export class WebhookRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRejected';
  }
}

/** This deployment has no provider settings. */
export class PaymentNotConfigured extends Error {
  constructor() {
    super('no payment provider is configured');
    this.name = 'PaymentNotConfigured';
  }
}

/** The provider answered, and the answer was an error. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
