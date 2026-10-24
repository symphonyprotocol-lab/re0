/**
 * Subscription-billing use cases. Route Handlers, server components and the
 * webhook enter here.
 *
 * The reads and the writes are deliberately asymmetric: the console only
 * reads, because requirement.md 5.3 puts every human billing action at the
 * Payment Provider, and the only thing that writes is the webhook the provider
 * itself drives. Checkout and the portal write nothing -- they hand the buyer
 * to the provider, and the webhook reports back what happened there. The
 * console's backfill is the webhook's path too, fed by reading the provider's
 * API instead of waiting for a notification that was lost.
 */
export {
  BACKFILL_REFUSALS,
  backfillProviderDocument,
  BackfillRefused,
  type BackfillRefusal,
  type BackfillResult,
} from './backfill';
export {
  billingSummary,
  getBillingDocument,
  listBillingDocuments,
  startOfUtcMonth,
  type BillingDocumentDetail,
  type BillingDocumentRow,
  type BillingListInput,
  type BillingSummary,
} from './list-documents';
export {
  mirrorProviderDocument,
  type MirrorProviderDocumentInput,
  type MirrorProviderDocumentResult,
} from './mirror';
export {
  BILLING_ROLES,
  billingPortalUrl,
  CheckoutRefused,
  isCheckoutRefusal,
  startCheckout,
  type CheckoutRefusal,
} from './checkout';
export {
  hasInvoice,
  invoiceDownloadUrl,
  InvoiceRefused,
  isInvoiceRefusal,
  type InvoiceRefusal,
} from './invoice';
export {
  applyPaymentNotification,
  receivePaymentWebhook,
  workspaceProviderCustomer,
  type PaymentWebhookOutcome,
} from './webhook';
