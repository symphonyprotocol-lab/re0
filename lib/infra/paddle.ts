/**
 * Paddle Billing (rebuild-proposal.md 2.3, 6): signature checks, the
 * checkout transaction, the subscription calls, and the shapes of the
 * notifications we read. Paddle is merchant of record; nothing here touches
 * card data. Moved from the old `lib/infrastructure/payment/paddle.ts`: the
 * mechanisms only, the business rules are in `lib/domain/billing.ts` and
 * `lib/services/billing.ts`.
 *
 * Prices are catalogue prices created once in Paddle (PADDLE_PLAN_PRICE_ID,
 * PADDLE_PACK_PRICE_ID); the server creates every checkout transaction and
 * tags it with the buyer, so nothing the browser does can change what is
 * charged or who is credited.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PADDLE_SIGNATURE_TOLERANCE_SECONDS } from '@/lib/constants';
import type { CheckoutOrder } from '@/lib/domain/billing';

export type PaddleEnvironment = 'sandbox' | 'production';

export interface PaddleConfig {
  apiKey: string;
  webhookSecret: string;
  /** Public by design: Paddle.js runs in the browser with it. */
  clientToken: string;
  environment: PaddleEnvironment;
  planPriceId: string;
  packPriceId: string;
  /**
   * The page a transaction's checkout link opens. Paddle will not take
   * `localhost`, so local development points only this at a tunnel
   * (PADDLE_CHECKOUT_BASE_URL) and leaves APP_BASE_URL alone.
   */
  checkoutUrl: string;
}

const API_BASE: Record<PaddleEnvironment, string> = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
};

export class PaddleNotConfigured extends Error {
  constructor() {
    super('Paddle is not configured');
    this.name = 'PaddleNotConfigured';
  }
}

export class PaddleError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PaddleError';
  }
}

/**
 * The deployment's Paddle settings, or null when any is missing: a key
 * without a webhook secret could take money it would never hear about.
 */
export function paddleConfig(env: NodeJS.ProcessEnv = process.env): PaddleConfig | null {
  const apiKey = env.PADDLE_API_KEY?.trim();
  const webhookSecret = env.PADDLE_WEBHOOK_SECRET?.trim();
  const clientToken = env.PADDLE_CLIENT_TOKEN?.trim();
  const planPriceId = env.PADDLE_PLAN_PRICE_ID?.trim();
  const packPriceId = env.PADDLE_PACK_PRICE_ID?.trim();
  const base = (env.PADDLE_CHECKOUT_BASE_URL?.trim() || env.APP_BASE_URL?.trim() || '').replace(/\/+$/, '');
  if (!apiKey || !webhookSecret || !clientToken || !planPriceId || !packPriceId || !base) return null;
  return {
    apiKey,
    webhookSecret,
    clientToken,
    environment: env.PADDLE_ENVIRONMENT?.trim() === 'sandbox' ? 'sandbox' : 'production',
    planPriceId,
    packPriceId,
    checkoutUrl: `${base}/checkout`,
  };
}

export function requirePaddle(): PaddleConfig {
  const config = paddleConfig();
  if (!config) throw new PaddleNotConfigured();
  return config;
}

/* -------------------------------------------------------------- signature */

/**
 * Checks a `Paddle-Signature` header (`ts=…;h1=…`) against the raw body.
 * Every `h1` is tried: during a secret rotation Paddle signs with both.
 */
export function verifyPaddleSignature(rawBody: string, header: string, secret: string, nowMs: number = Date.now()): boolean {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(';')) {
    const [key, value] = part.split('=', 2).map((s) => s.trim());
    if (key === 'ts' && value) timestamp = value;
    else if (key === 'h1' && value) signatures.push(value);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > PADDLE_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}:${rawBody}`, 'utf8').digest('hex'));
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** A header Paddle would send for `rawBody`; for tests and the replay script. */
export function signPaddleBody(rawBody: string, secret: string, nowMs: number = Date.now()): string {
  const ts = Math.floor(nowMs / 1000);
  return `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${rawBody}`, 'utf8').digest('hex')}`;
}

/* ----------------------------------------------------------------- shapes */

export interface PaddleTransaction {
  id: string;
  status: string;
  customer_id: string | null;
  subscription_id: string | null;
  /** `web` for a checkout, `subscription_recurring` for a renewal, … */
  origin?: string | null;
  currency_code: string;
  custom_data: Record<string, unknown> | null;
  billing_period: { starts_at: string; ends_at: string } | null;
  items: { quantity: number; price: { id: string } | null; price_id?: string }[];
  details: { totals: { grand_total: string } | null } | null;
  updated_at?: string;
}

export interface PaddleSubscription {
  id: string;
  status: string;
  customer_id: string | null;
  custom_data: Record<string, unknown> | null;
  current_billing_period: { starts_at: string; ends_at: string } | null;
  /** A change that takes effect later: `cancel`, `pause` or `resume`. */
  scheduled_change?: { action: string; effective_at: string } | null;
  items?: { price: { id: string } | null }[];
  updated_at: string;
  /** Only on `subscription.created`: the checkout that started it. */
  transaction_id?: string | null;
}

export interface PaddleAdjustment {
  id: string;
  transaction_id: string;
  subscription_id?: string | null;
  /** `refund`, `credit`, `chargeback`, `chargeback_reverse`, `chargeback_warning`, … */
  action: string;
  /** `pending_approval`, `approved`, `rejected`, `reversed`. */
  status: string;
  totals: { total: string } | null;
}

export interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at?: string;
  data: Record<string, unknown>;
}

/** The signed body as an event, or null when it is not one. */
export function parsePaddleEvent(rawBody: string): PaddleEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  const { event_id, event_type, data } = event as Record<string, unknown>;
  if (typeof event_id !== 'string' || typeof event_type !== 'string' || !data || typeof data !== 'object') return null;
  return event as PaddleEvent;
}

/* ------------------------------------------------------------ custom data */

/** Keys we write into a transaction's custom data; Paddle carries them onto the subscription. */
export const CUSTOM = { userId: 're0_user_id', kind: 're0_kind' } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function customUserId(custom: Record<string, unknown> | null | undefined): string | null {
  const value = custom?.[CUSTOM.userId];
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/** A Paddle amount string in minor units, or NaN -- never a silent zero. */
export function minorUnits(amount: string | null | undefined): number {
  if (!amount || !/^\d{1,15}$/.test(amount)) return Number.NaN;
  return Number(amount);
}

export function paddleDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* -------------------------------------------------------------------- api */

async function call<T>(config: PaddleConfig, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE[config.environment]}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new PaddleError(`paddle ${method} ${path}: ${(error as Error).message}`);
  }
  const json = (await response.json().catch(() => null)) as { data?: T; error?: unknown; meta?: unknown } | null;
  if (!response.ok || !json || json.data === undefined) {
    throw new PaddleError(`paddle ${method} ${path}: ${response.status} ${paddleErrorReason(json)}`.trim(), response.status);
  }
  return json.data;
}

const MAX_FIELD_ERRORS = 5;
const MAX_ERROR_PART = 200;

function clip(value: unknown, max = MAX_ERROR_PART): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * What Paddle said about a failed call, for the log: the error code and
 * detail, the field-level validation errors (`error.errors[]`, where a
 * `400 bad_request` puts the useful part), and `meta.request_id` for Paddle
 * support. Only fields of the response are read, and each is clipped --
 * never the request, which carries the key.
 */
export function paddleErrorReason(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const { error, meta } = json as { error?: unknown; meta?: unknown };
  const parts: string[] = [];
  if (error && typeof error === 'object') {
    const { code, detail, errors } = error as { code?: unknown; detail?: unknown; errors?: unknown };
    const head = `${clip(code, 64)} ${clip(detail)}`.trim();
    if (head) parts.push(head);
    if (Array.isArray(errors) && errors.length > 0) {
      const items = errors.slice(0, MAX_FIELD_ERRORS).map((item) => {
        const { field, message } = (item && typeof item === 'object' ? item : {}) as { field?: unknown; message?: unknown };
        const name = clip(field, 100);
        const text = clip(message);
        return name && text ? `${name}: ${text}` : name || text || '?';
      });
      const more = errors.length > MAX_FIELD_ERRORS ? `; +${errors.length - MAX_FIELD_ERRORS} more` : '';
      parts.push(`[${items.join('; ')}${more}]`);
    }
  }
  const requestId = meta && typeof meta === 'object' ? clip((meta as { request_id?: unknown }).request_id, 64) : '';
  if (requestId) parts.push(`(request_id ${requestId})`);
  return parts.join(' ');
}

export interface CheckoutPrice {
  priceId: string;
  priceMinor: number;
  regularPriceMinor: number;
}

/** The body of `POST /transactions` for one checkout. Exported for its test. */
export function checkoutTransactionBody(config: PaddleConfig, order: CheckoutOrder, userId: string, price?: CheckoutPrice) {
  return {
    items: [{ price_id: price?.priceId ?? (order.kind === 'plan' ? config.planPriceId : config.packPriceId), quantity: order.quantity }],
    ...(price ? { currency_code: 'USD' } : {}),
    ...(price && price.priceMinor < price.regularPriceMinor
      ? {
          discount: {
            description: 'RE0 limited-time promotion',
            type: 'flat_per_seat',
            amount: String(price.regularPriceMinor - price.priceMinor),
            currency_code: 'USD',
            recur: false,
          },
        }
      : {}),
    custom_data: { [CUSTOM.userId]: userId, [CUSTOM.kind]: order.kind },
    checkout: { url: config.checkoutUrl },
  };
}

export async function createCheckoutTransaction(config: PaddleConfig, order: CheckoutOrder, userId: string, price?: CheckoutPrice): Promise<{ id: string }> {
  const transaction = await call<{ id: string }>(config, 'POST', '/transactions', checkoutTransactionBody(config, order, userId, price));
  return { id: transaction.id };
}

/** Stops renewal: the subscription stays active to the end of the period, then cancels. */
export function cancelAtPeriodEnd(config: PaddleConfig, subscriptionId: string): Promise<PaddleSubscription> {
  return call<PaddleSubscription>(config, 'POST', `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    effective_from: 'next_billing_period',
  });
}

/** Withdraws a scheduled cancellation, so the subscription renews again. */
export function resumeRenewal(config: PaddleConfig, subscriptionId: string): Promise<PaddleSubscription> {
  return call<PaddleSubscription>(config, 'PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, { scheduled_change: null });
}

/** Price versions are created instead of modifying prices already used by subscriptions. */
export async function provisionPrice(config: PaddleConfig, kind: 'plan' | 'pack', amount: number, sourcePriceId: string): Promise<string> {
  const source = await call<{ id: string; product_id: string; tax_mode: string; unit_price: { amount: string; currency_code: string }; billing_cycle: { interval: string; frequency: number } | null; quantity: { minimum: number; maximum: number }; unit_price_overrides?: unknown[]; trial_period?: unknown }>(config, 'GET', `/prices/${encodeURIComponent(sourcePriceId)}`);
  const cycleMatches = kind === 'plan' ? source.billing_cycle?.interval === 'month' && source.billing_cycle.frequency === 1 : source.billing_cycle === null;
  if (Number(source.unit_price.amount) === amount && source.unit_price.currency_code === 'USD' && cycleMatches && !source.trial_period && !source.unit_price_overrides?.length && source.quantity.minimum === 1 && source.quantity.maximum === (kind === 'plan' ? 1 : 10)) return source.id;
  const price = await call<{ id: string }>(config, 'POST', '/prices', {
    product_id: source.product_id,
    description: `RE0 ${kind} USD ${amount / 100}`,
    name: kind === 'plan' ? 'Plan' : 'Pack',
    unit_price: { amount: String(amount), currency_code: 'USD' },
    billing_cycle: kind === 'plan' ? { interval: 'month', frequency: 1 } : null,
    trial_period: null,
    tax_mode: source.tax_mode,
    quantity: { minimum: 1, maximum: kind === 'plan' ? 1 : 10 },
  });
  return price.id;
}

/** Withdraws a price version our catalogue never recorded, so nobody can be charged it. */
export async function archivePrice(config: PaddleConfig, id: string): Promise<void> {
  await call(config, 'PATCH', `/prices/${encodeURIComponent(id)}`, { status: 'archived' });
}

/** Idempotent: a transaction an earlier, interrupted replacement already canceled counts as canceled. */
export async function cancelCheckoutTransaction(config: PaddleConfig, id: string): Promise<void> {
  const path = `/transactions/${encodeURIComponent(id)}`;
  try {
    await call(config, 'PATCH', path, { status: 'canceled' });
  } catch (error) {
    if (!(error instanceof PaddleError) || error.status === undefined) throw error;
    const current = await call<Pick<PaddleTransaction, 'status'>>(config, 'GET', path);
    if (current.status !== 'canceled') throw error;
  }
}
