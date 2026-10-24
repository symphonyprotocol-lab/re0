/**
 * Paddle Billing, behind the payment boundary (./provider).
 *
 * Three decisions shape this file.
 *
 * **The Plan Version is the price.** Checkout sends a non-catalogue price built
 * from the version being bought, against one of two Paddle products (Pro, and
 * the Additional Calls pack). Paddle's catalogue therefore holds no amounts of
 * ours: a version minted in the console is what the next checkout charges,
 * and a subscription keeps the price it started on through every renewal --
 * which is requirement.md 4.3's "a plan change only affects new
 * subscriptions" carried out by the provider rather than re-implemented here.
 *
 * **A webhook is a prompt, not the record.** A transaction or adjustment event
 * is answered by fetching the transaction and its adjustments as they stand
 * now, and mirroring that. Paddle does not order its notifications, and a
 * refund arrives as an adjustment that says nothing about the transaction's
 * total; re-reading the source after every event gives the mirror one complete
 * picture instead of a sum of partial ones. Subscription events carry their
 * whole entity already and are used as sent.
 *
 * **Custom data names the buyer.** Every checkout is a transaction this server
 * creates, tagged with the workspace and the Plan Version, and Paddle carries
 * that tag onto the subscription and its renewals. It is trustworthy because
 * the tag is written server side and only ever read back from a signed
 * notification or an authenticated API call.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  isBillingDocumentKind,
  isCollected,
  type BillingDocumentKind,
  type BillingDocumentStatus,
} from '@/lib/domain/billing';
import { configuredBaseUrl } from '@/lib/http/base-url';
import {
  PaymentProviderError,
  WebhookRejected,
  type CheckoutInput,
  type CheckoutState,
  type PaymentAdapter,
  type PaymentNotification,
  type ProviderDocumentNotice,
  type ProviderSubscriptionNotice,
  type ProviderSubscriptionStatus,
} from './types';

export const PADDLE_PROVIDER = 'paddle';

/* ------------------------------------------------------------------ config */

export type PaddleEnvironment = 'sandbox' | 'production';

export interface PaddleConfig {
  apiKey: string;
  webhookSecret: string;
  /** Public by design: Paddle.js runs in the browser with it. */
  clientToken: string;
  environment: PaddleEnvironment;
  proProductId: string;
  addonProductId: string;
  /**
   * Where the checkout page lives; Paddle's payment link must point here, on a
   * domain approved in the Paddle dashboard.
   */
  checkoutPageUrl: string;
}

const API_BASE: Record<PaddleEnvironment, string> = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
};

/**
 * The deployment's Paddle settings, or null when any is missing.
 *
 * All or nothing: a deployment with an API key but no webhook secret could
 * take money it would never hear about, and one without a client token would
 * send buyers to a checkout page that cannot open.
 */
export function paddleConfig(env: NodeJS.ProcessEnv = process.env): PaddleConfig | null {
  const apiKey = env.PADDLE_API_KEY?.trim();
  const webhookSecret = env.PADDLE_WEBHOOK_SECRET?.trim();
  const clientToken = env.PADDLE_CLIENT_TOKEN?.trim();
  const proProductId = env.PADDLE_PRO_PRODUCT_ID?.trim();
  const addonProductId = env.PADDLE_ADDON_PRODUCT_ID?.trim();
  const baseUrl = configuredBaseUrl(env);
  /*
   * Paddle approves checkout domains and will not take `localhost`, so local
   * development points the checkout alone at a tunnel. Only the checkout page:
   * moving APP_BASE_URL there would also move the OAuth callbacks, the
   * same-origin check and the session cookie's name.
   */
  const checkoutBaseUrl = env.PADDLE_CHECKOUT_BASE_URL?.trim().replace(/\/+$/, '') || baseUrl;
  if (!apiKey || !webhookSecret || !clientToken || !proProductId || !addonProductId || !baseUrl) {
    return null;
  }
  return {
    apiKey,
    webhookSecret,
    clientToken,
    environment: env.PADDLE_ENVIRONMENT?.trim() === 'sandbox' ? 'sandbox' : 'production',
    proProductId,
    addonProductId,
    checkoutPageUrl: `${checkoutBaseUrl}/checkout`,
  };
}

/* ------------------------------------------------------------- signature */

/**
 * How far a signature's timestamp may sit from our clock. Paddle's own SDKs
 * allow five seconds; this allows for skew between two clocks we do not
 * control. Replay is not what the window is guarding -- a replayed event hits
 * the `payment_event` key and writes nothing -- so it only has to be tight
 * enough that a leaked signed body goes stale.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Checks a `Paddle-Signature` header (`ts=…;h1=…`) against the raw body.
 *
 * Every `h1` is tried: during a secret rotation Paddle signs with both, and
 * accepting only the first would drop notifications for the length of it.
 */
export function verifyPaddleSignature(
  rawBody: string,
  header: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(';')) {
    const [key, value] = part.split('=', 2).map((s) => s.trim());
    if (key === 'ts' && value) timestamp = value;
    else if (key === 'h1' && value) signatures.push(value);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}:${rawBody}`, 'utf8').digest('hex'),
  );
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/* ---------------------------------------------------------------- shapes */

/** As much of a Paddle transaction as the mirror reads. */
export interface PaddleTransaction {
  id: string;
  status: string;
  customer_id: string | null;
  subscription_id: string | null;
  invoice_number: string | null;
  currency_code: string;
  custom_data: Record<string, unknown> | null;
  billing_period: { starts_at: string; ends_at: string } | null;
  billed_at: string | null;
  created_at: string;
  updated_at: string;
  items: { quantity: number; price: { product_id: string | null } | null }[];
  details: { totals: { grand_total: string } | null } | null;
  payments: {
    status: string;
    captured_at: string | null;
    method_details: { type: string } | null;
  }[];
}

export interface PaddleAdjustment {
  id: string;
  transaction_id: string;
  action: string;
  status: string;
  totals: { total: string } | null;
  updated_at: string;
}

export interface PaddleSubscription {
  id: string;
  status: string;
  customer_id: string | null;
  custom_data: Record<string, unknown> | null;
  current_billing_period: { starts_at: string; ends_at: string } | null;
  updated_at: string;
  /** Only on `subscription.created`: the checkout that started it. */
  transaction_id?: string | null;
}

/* ----------------------------------------------------------- custom data */

/** Keys we write into a transaction's custom data, prefixed so they cannot collide. */
const CUSTOM = {
  workspaceId: 're0_workspace_id',
  planVersionId: 're0_plan_version_id',
  kind: 're0_kind',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Re0CustomData {
  workspaceId: string | null;
  planVersionId: string | null;
  kind: BillingDocumentKind | null;
}

/** Reads our tag back out of custom data, ignoring anything malformed. */
export function readCustomData(custom: Record<string, unknown> | null | undefined): Re0CustomData {
  const uuid = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : null);
  const kind = custom?.[CUSTOM.kind];
  return {
    workspaceId: uuid(custom?.[CUSTOM.workspaceId]),
    planVersionId: uuid(custom?.[CUSTOM.planVersionId]),
    kind: isBillingDocumentKind(kind) ? kind : null,
  };
}

/* --------------------------------------------------------------- mapping */

/**
 * A Paddle amount string in minor units. Anything else is NaN, never zero: a
 * malformed or missing total read as 0 would mirror a paid document worth
 * nothing, and the mirror refuses NaN (`invalid_amount`, `invalid_refund`)
 * where it would have accepted the zero -- so the event is recorded as refused
 * for someone to look at, instead of quietly understating the month.
 */
function minor(amount: string | null | undefined): number {
  if (!amount || !/^\d{1,15}$/.test(amount)) return Number.NaN;
  return Number(amount);
}

function date(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Paddle's subscription states onto ours, one for one.
 *
 * `paused` keeps its own state rather than folding into `canceled`: both grant
 * nothing, but a paused subscription resumes and charges again, and checkout
 * must not sell a second one beside it. Anything Paddle adds later reads as
 * `canceled` -- granting nothing is the safe reading of a state we do not know.
 */
export function paddleSubscriptionStatus(status: string): ProviderSubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'paused':
      return status;
    default:
      return 'canceled';
  }
}

export function subscriptionNotice(subscription: PaddleSubscription): ProviderSubscriptionNotice {
  const custom = readCustomData(subscription.custom_data);
  return {
    externalId: subscription.id,
    customerId: subscription.customer_id,
    status: paddleSubscriptionStatus(subscription.status),
    periodStart: date(subscription.current_billing_period?.starts_at),
    periodEnd: date(subscription.current_billing_period?.ends_at),
    workspaceId: custom.workspaceId,
    planVersionId: custom.planVersionId,
    observedAt: date(subscription.updated_at) ?? new Date(),
  };
}

/**
 * Money that has gone back to the buyer, from a transaction's adjustments.
 *
 * Only approved refunds and chargebacks move money; a pending refund may yet
 * be rejected, and a credit is a balance on the customer rather than cash out.
 * A reversed chargeback brings its money back. Clamped to what was charged,
 * because the mirror refuses more, and a refusal would leave the document
 * reading `paid` about money that has left.
 */
export function refundedMinor(adjustments: PaddleAdjustment[], chargedMinor: number): number {
  let total = 0;
  for (const adjustment of adjustments) {
    if (adjustment.status !== 'approved') continue;
    const amount = minor(adjustment.totals?.total);
    if (adjustment.action === 'refund' || adjustment.action === 'chargeback') total += amount;
    else if (adjustment.action === 'chargeback_reverse') total -= amount;
  }
  return Math.min(Math.max(total, 0), chargedMinor);
}

/**
 * Paddle's transaction states onto the mirror's, or null for a transaction
 * that never became a billing document.
 *
 * `draft` and `ready` are a checkout in progress; one abandoned there stays in
 * those states forever, and listing it on someone's bill would be listing an
 * order they never placed. A `canceled` transaction counts only if it was
 * billed first -- a withdrawn invoice -- and not when it is a checkout closed
 * before anyone paid.
 */
export function paddleDocumentStatus(
  transaction: Pick<PaddleTransaction, 'status' | 'billed_at'>,
  refunded: number,
): BillingDocumentStatus | null {
  switch (transaction.status) {
    case 'billed':
      return 'open';
    case 'paid':
    case 'completed':
      return refunded > 0 ? 'refunded' : 'paid';
    case 'past_due':
      return 'failed';
    case 'canceled':
      return transaction.billed_at ? 'void' : null;
    default:
      return null;
  }
}

/**
 * A checkout transaction's state, as checkout needs it. `billed` counts as
 * paid: an automatically collected transaction is only billed on its way to
 * being charged.
 */
export function paddleCheckoutState(status: string): CheckoutState {
  switch (status) {
    case 'draft':
    case 'ready':
      return 'open';
    case 'billed':
    case 'paid':
    case 'completed':
      return 'paid';
    default:
      return 'closed';
  }
}

/**
 * A transaction, with its adjustments, as the document the mirror holds.
 *
 * Null when it is not ours to mirror: not yet a document (above), or not one
 * of the two things re0 sells -- a Paddle account can sell other products,
 * and their transactions are not this workspace's bill.
 */
export function transactionNotice(
  transaction: PaddleTransaction,
  adjustments: PaddleAdjustment[],
  products: { pro: string; addon: string },
): ProviderDocumentNotice | null {
  const custom = readCustomData(transaction.custom_data);
  const productIds = transaction.items.map((item) => item.price?.product_id);
  const kind: BillingDocumentKind | null =
    custom.kind ??
    (productIds.includes(products.addon)
      ? 'pack'
      : transaction.subscription_id || productIds.includes(products.pro)
        ? 'subscription'
        : null);
  if (!kind) return null;

  const amountMinor = minor(transaction.details?.totals?.grand_total);
  const ownAdjustments = adjustments.filter((a) => a.transaction_id === transaction.id);
  const refunded = refundedMinor(ownAdjustments, amountMinor);
  const status = paddleDocumentStatus(transaction, refunded);
  if (!status) return null;

  const captured = transaction.payments.find((payment) => payment.status === 'captured');
  const observedAt = [transaction.updated_at, ...ownAdjustments.map((a) => a.updated_at)]
    .map(date)
    .filter((value): value is Date => value !== null)
    .reduce<Date | null>((latest, value) => (latest && latest > value ? latest : value), null);

  return {
    document: {
      provider: PADDLE_PROVIDER,
      externalId: transaction.id,
      number: transaction.invoice_number,
      kind,
      status,
      amountMinor,
      /*
       * Stated whenever the document is collected: this is the provider's
       * whole refund history, re-read, not one event's delta -- so a zero here
       * is a fact and not a silence.
       */
      ...(isCollected(status) ? { refundedMinor: refunded } : {}),
      currency: transaction.currency_code,
      method: captured?.method_details?.type ?? null,
      issuedAt: date(transaction.billed_at) ?? date(transaction.created_at),
      paidAt: date(captured?.captured_at),
      periodStart: date(transaction.billing_period?.starts_at),
      periodEnd: date(transaction.billing_period?.ends_at),
    },
    workspaceId: custom.workspaceId,
    planVersionId: custom.planVersionId,
    subscriptionExternalId: transaction.subscription_id,
    customerId: transaction.customer_id,
    quantity: Math.max(1, transaction.items[0]?.quantity ?? 1),
    observedAt: observedAt ?? new Date(),
  };
}

/* ------------------------------------------------------------------- api */

async function call<T>(
  config: PaddleConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE[config.environment]}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new PaymentProviderError(`paddle ${method} ${path}: ${(error as Error).message}`);
  }
  const json = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; detail?: string } }
    | null;
  if (!response.ok || !json || json.data === undefined) {
    /* The error code and detail only -- never the request, which carries the key. */
    const reason = json?.error ? `${json.error.code ?? ''} ${json.error.detail ?? ''}`.trim() : '';
    throw new PaymentProviderError(
      `paddle ${method} ${path}: ${response.status} ${reason}`.trim(),
      response.status,
    );
  }
  return json.data;
}

function getTransaction(config: PaddleConfig, id: string): Promise<PaddleTransaction> {
  return call<PaddleTransaction>(config, 'GET', `/transactions/${encodeURIComponent(id)}`);
}

function listAdjustments(config: PaddleConfig, transactionId: string): Promise<PaddleAdjustment[]> {
  const query = new URLSearchParams({ transaction_id: transactionId, per_page: '50' });
  return call<PaddleAdjustment[]>(config, 'GET', `/adjustments?${query}`);
}

function getSubscription(config: PaddleConfig, id: string): Promise<PaddleSubscription> {
  return call<PaddleSubscription>(config, 'GET', `/subscriptions/${encodeURIComponent(id)}`);
}

/** The body of `POST /transactions` for one checkout. Exported for its test. */
export function checkoutTransactionBody(config: PaddleConfig, input: CheckoutInput) {
  const subscription = input.kind === 'subscription';
  return {
    items: [
      {
        quantity: 1,
        price: {
          product_id: subscription ? config.proProductId : config.addonProductId,
          name: input.name,
          /* Internal to Paddle's dashboard: which version this price was cut from. */
          description: `${input.name} · plan version ${input.planVersionId}`,
          unit_price: { amount: String(input.priceMinor), currency_code: input.currency },
          ...(subscription ? { billing_cycle: { interval: 'month', frequency: 1 } } : {}),
        },
      },
    ],
    currency_code: input.currency,
    ...(input.customerId ? { customer_id: input.customerId } : {}),
    custom_data: {
      [CUSTOM.workspaceId]: input.workspaceId,
      [CUSTOM.planVersionId]: input.planVersionId,
      [CUSTOM.kind]: input.kind,
    },
    checkout: { url: config.checkoutPageUrl },
  };
}

/* ---------------------------------------------------------------- adapter */

export function paddleAdapter(config: PaddleConfig): PaymentAdapter {
  const products = { pro: config.proProductId, addon: config.addonProductId };

  return {
    provider: PADDLE_PROVIDER,

    async createCheckout(input) {
      const transaction = await call<{ id: string; checkout: { url: string | null } | null }>(
        config,
        'POST',
        '/transactions',
        checkoutTransactionBody(config, input),
      );
      const url = transaction.checkout?.url;
      if (!url) throw new PaymentProviderError('paddle returned a transaction without a checkout link');
      return { externalId: transaction.id, url };
    },

    async checkoutState(externalId) {
      return paddleCheckoutState((await getTransaction(config, externalId)).status);
    },

    /* The same shape Paddle hands back from `createCheckout`: the page plus the transaction id. */
    checkoutUrl(externalId) {
      return `${config.checkoutPageUrl}?_ptxn=${encodeURIComponent(externalId)}`;
    },

    async portalUrl({ customerId }) {
      const session = await call<{ urls: { general: { overview: string } } }>(
        config,
        'POST',
        `/customers/${encodeURIComponent(customerId)}/portal-sessions`,
        {},
      );
      return session.urls.general.overview;
    },

    /* Paddle signs a fresh link per request and it expires within the hour. */
    async invoiceUrl(externalId) {
      const invoice = await call<{ url: string }>(
        config,
        'GET',
        `/transactions/${encodeURIComponent(externalId)}/invoice?disposition=attachment`,
      );
      return invoice.url;
    },

    /*
     * The same reads a transaction event triggers, plus the subscription, which
     * a webhook would have delivered as an event of its own. A subscription
     * missing our tag takes it from this transaction, as `verifyWebhook` takes
     * it from the one that started the subscription.
     */
    async fetchDocument(externalId) {
      const [transaction, adjustments] = await Promise.all([
        getTransaction(config, externalId),
        listAdjustments(config, externalId),
      ]);
      const entity = transaction.subscription_id
        ? await getSubscription(config, transaction.subscription_id)
        : null;
      let subscription: ProviderSubscriptionNotice | null = null;
      if (entity) {
        subscription = subscriptionNotice(entity);
        if (!subscription.workspaceId) {
          const origin = readCustomData(transaction.custom_data);
          subscription.workspaceId = origin.workspaceId;
          subscription.planVersionId ??= origin.planVersionId;
        }
      }
      return {
        document: transactionNotice(transaction, adjustments, products),
        subscription,
        payload: { transaction, adjustments, subscription: entity },
      };
    },

    async verifyWebhook(rawBody, signature): Promise<PaymentNotification> {
      if (!signature || !verifyPaddleSignature(rawBody, signature, config.webhookSecret)) {
        throw new WebhookRejected('the Paddle signature does not verify');
      }
      let event: { event_id?: unknown; event_type?: unknown; data?: Record<string, unknown> };
      try {
        event = JSON.parse(rawBody);
      } catch {
        throw new WebhookRejected('the signed body is not JSON');
      }
      if (typeof event.event_id !== 'string' || typeof event.event_type !== 'string' || !event.data) {
        throw new WebhookRejected('the signed body is not a Paddle event');
      }

      const envelope = {
        provider: PADDLE_PROVIDER,
        externalEventId: event.event_id,
        eventType: event.event_type,
        payload: event,
      };
      const entity = event.event_type.split('.')[0];

      if (entity === 'subscription') {
        const data = event.data as unknown as PaddleSubscription;
        const notice = subscriptionNotice(data);
        /*
         * The checkout's tag normally rides onto the subscription. When it has
         * not, the creating event names the transaction that started it, and
         * that transaction carries the tag for certain -- we wrote it.
         */
        if (!notice.workspaceId && data.transaction_id) {
          const origin = readCustomData((await getTransaction(config, data.transaction_id)).custom_data);
          notice.workspaceId = origin.workspaceId;
          notice.planVersionId ??= origin.planVersionId;
        }
        return { ...envelope, subject: 'subscription', subscription: notice };
      }

      if (entity === 'transaction' || entity === 'adjustment') {
        const transactionId = entity === 'transaction' ? event.data.id : event.data.transaction_id;
        if (typeof transactionId !== 'string') return { ...envelope, subject: 'ignored' };
        /*
         * A transaction that was still a checkout in progress when this event
         * fired is not a document yet (`paddleDocumentStatus`), and opening a
         * checkout sends several of these. Two Paddle reads for each would be
         * spent learning only that; a later event re-reads it once it is one.
         */
        if (entity === 'transaction' && (event.data.status === 'draft' || event.data.status === 'ready')) {
          return { ...envelope, subject: 'ignored' };
        }
        const [transaction, adjustments] = await Promise.all([
          getTransaction(config, transactionId),
          listAdjustments(config, transactionId),
        ]);
        return {
          ...envelope,
          subject: 'document',
          document: transactionNotice(transaction, adjustments, products),
        };
      }

      return { ...envelope, subject: 'ignored' };
    },
  };
}
