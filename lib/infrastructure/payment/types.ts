/**
 * The shapes and errors shared by the payment boundary and its adapters.
 * See ./provider for what the boundary is for.
 */
import type { BillingDocumentKind, ProviderDocumentInput } from '@/lib/domain/billing';

/** The provider-side states a subscription row can hold. Mirrors the enum. */
export type ProviderSubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'trialing' | 'paused';

export interface CheckoutInput {
  kind: BillingDocumentKind;
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

/** A provider subscription as a notification describes it. */
export interface ProviderSubscriptionNotice {
  externalId: string;
  customerId: string | null;
  status: ProviderSubscriptionStatus;
  /** Null when the notification carried no current period (a cancelled one). */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** From the checkout's custom data; null on a subscription nobody tagged. */
  workspaceId: string | null;
  planVersionId: string | null;
  observedAt: Date;
}

/** A provider billing document, as it currently stands at the provider. */
export interface ProviderDocumentNotice {
  document: ProviderDocumentInput;
  workspaceId: string | null;
  planVersionId: string | null;
  /** The provider subscription this document bills, when it bills one. */
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
    | { subject: 'subscription'; subscription: ProviderSubscriptionNotice }
    /*
     * `document` is null for a transaction that is not yet a billing document
     * at all -- a checkout opened and abandoned, which the provider tracks
     * and the mirror has no business listing.
     */
    | { subject: 'document'; document: ProviderDocumentNotice | null }
    | { subject: 'ignored' }
  );

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
  /** A signed, short-lived link into the provider's customer portal. */
  portalUrl(input: { customerId: string }): Promise<string>;
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
