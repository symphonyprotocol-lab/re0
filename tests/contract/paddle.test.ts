/**
 * The Paddle adapter's pure half: the signature check, and the mapping from
 * Paddle's entities onto the mirror's shapes.
 *
 * The network half -- the API calls -- is not here; what matters about it is
 * what it is fed into, and that is these functions.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import { CHECKOUT_REFUSALS } from '@/lib/application/billing/checkout';
import { parseProviderDocument } from '@/lib/domain/billing';
import {
  checkoutTransactionBody,
  paddleCheckoutState,
  paddleConfig,
  paddleDocumentStatus,
  paddleSubscriptionStatus,
  readCustomData,
  refundedMinor,
  SIGNATURE_TOLERANCE_SECONDS,
  subscriptionNotice,
  transactionNotice,
  verifyPaddleSignature,
  type PaddleAdjustment,
  type PaddleConfig,
  type PaddleTransaction,
} from '@/lib/infrastructure/payment/paddle';

const SECRET = 'pdl_ntfset_test_secret';
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const BODY = '{"event_id":"evt_01","event_type":"transaction.completed","data":{"id":"txn_01"}}';

function sign(body: string, ts: number, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${ts}:${body}`, 'utf8').digest('hex');
}

const WORKSPACE = '01922f3a-0000-7000-8000-000000000001';
const VERSION = '01922f3a-0000-7000-8000-000000000002';
const PRODUCTS = { pro: 'pro_re0', addon: 'pro_pack' };

const CONFIG: PaddleConfig = {
  apiKey: 'pdl_sdbx_apikey_x',
  webhookSecret: SECRET,
  clientToken: 'test_x',
  environment: 'sandbox',
  proProductId: PRODUCTS.pro,
  addonProductId: PRODUCTS.addon,
  checkoutPageUrl: 'https://re0.test/checkout',
};

function transaction(overrides: Partial<PaddleTransaction> = {}): PaddleTransaction {
  return {
    id: 'txn_01',
    status: 'completed',
    customer_id: 'ctm_01',
    subscription_id: 'sub_01',
    invoice_number: '325-10566',
    currency_code: 'USD',
    custom_data: { re0_workspace_id: WORKSPACE, re0_plan_version_id: VERSION, re0_kind: 'subscription' },
    billing_period: { starts_at: '2026-10-02T10:00:00Z', ends_at: '2026-11-02T10:00:00Z' },
    billed_at: '2026-10-02T10:00:01Z',
    created_at: '2026-10-02T09:59:00Z',
    updated_at: '2026-10-02T10:00:05Z',
    items: [{ quantity: 1, price: { product_id: PRODUCTS.pro } }],
    details: { totals: { grand_total: '500' } },
    payments: [
      { status: 'captured', captured_at: '2026-10-02T10:00:03Z', method_details: { type: 'card' } },
    ],
    ...overrides,
  };
}

function adjustment(overrides: Partial<PaddleAdjustment> = {}): PaddleAdjustment {
  return {
    id: 'adj_01',
    transaction_id: 'txn_01',
    action: 'refund',
    status: 'approved',
    totals: { total: '200' },
    updated_at: '2026-10-09T08:00:00Z',
    ...overrides,
  };
}

describe('verifyPaddleSignature', () => {
  const ts = Math.floor(NOW / 1000);

  it('accepts the signature Paddle computes over ts:body', () => {
    expect(verifyPaddleSignature(BODY, `ts=${ts};h1=${sign(BODY, ts)}`, SECRET, NOW)).toBe(true);
  });

  it('refuses a body changed after signing', () => {
    const header = `ts=${ts};h1=${sign(BODY, ts)}`;
    expect(verifyPaddleSignature(BODY.replace('txn_01', 'txn_02'), header, SECRET, NOW)).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    expect(verifyPaddleSignature(BODY, `ts=${ts};h1=${sign(BODY, ts, 'other')}`, SECRET, NOW)).toBe(false);
  });

  it('refuses a timestamp outside the tolerance, either side', () => {
    const old = ts - SIGNATURE_TOLERANCE_SECONDS - 1;
    const future = ts + SIGNATURE_TOLERANCE_SECONDS + 1;
    expect(verifyPaddleSignature(BODY, `ts=${old};h1=${sign(BODY, old)}`, SECRET, NOW)).toBe(false);
    expect(verifyPaddleSignature(BODY, `ts=${future};h1=${sign(BODY, future)}`, SECRET, NOW)).toBe(false);
  });

  it('accepts any of several h1 values, as during a secret rotation', () => {
    const header = `ts=${ts};h1=${sign(BODY, ts, 'retired')};h1=${sign(BODY, ts)}`;
    expect(verifyPaddleSignature(BODY, header, SECRET, NOW)).toBe(true);
  });

  it('refuses malformed headers without throwing', () => {
    for (const header of ['', 'garbage', `ts=${ts}`, `h1=${sign(BODY, ts)}`, 'ts=abc;h1=00', `ts=${ts};h1=short`]) {
      expect(verifyPaddleSignature(BODY, header, SECRET, NOW)).toBe(false);
    }
  });
});

describe('paddleConfig', () => {
  const env = {
    PADDLE_API_KEY: 'k',
    PADDLE_WEBHOOK_SECRET: 's',
    PADDLE_CLIENT_TOKEN: 't',
    PADDLE_PRO_PRODUCT_ID: 'pro_a',
    PADDLE_ADDON_PRODUCT_ID: 'pro_b',
    APP_BASE_URL: 'https://re0.test/',
  } as unknown as NodeJS.ProcessEnv;

  it('is all or nothing', () => {
    expect(paddleConfig(env)).not.toBeNull();
    for (const key of Object.keys(env)) {
      expect(paddleConfig({ ...env, [key]: '' })).toBeNull();
    }
  });

  it('defaults to production and points the checkout at this site', () => {
    const config = paddleConfig(env)!;
    expect(config.environment).toBe('production');
    expect(config.checkoutPageUrl).toBe('https://re0.test/checkout');
    expect(paddleConfig({ ...env, PADDLE_ENVIRONMENT: 'sandbox' })!.environment).toBe('sandbox');
  });

  it('moves only the checkout page when a checkout base URL is set', () => {
    const config = paddleConfig({
      ...env,
      PADDLE_CHECKOUT_BASE_URL: ' https://tunnel.example.com/ ',
    })!;
    expect(config.checkoutPageUrl).toBe('https://tunnel.example.com/checkout');
    expect(paddleConfig({ ...env, PADDLE_CHECKOUT_BASE_URL: '' })!.checkoutPageUrl).toBe(
      'https://re0.test/checkout',
    );
  });
});

describe('checkoutTransactionBody', () => {
  const input = {
    workspaceId: WORKSPACE,
    planVersionId: VERSION,
    priceMinor: 500,
    currency: 'USD',
    name: 'Re0 Pro',
    customerId: null,
  };

  it('prices a subscription from the Plan Version, monthly, and tags it', () => {
    const body = checkoutTransactionBody(CONFIG, { ...input, kind: 'subscription' });
    expect(body.items[0]!.price).toMatchObject({
      product_id: PRODUCTS.pro,
      unit_price: { amount: '500', currency_code: 'USD' },
      billing_cycle: { interval: 'month', frequency: 1 },
    });
    expect(readCustomData(body.custom_data)).toEqual({
      workspaceId: WORKSPACE,
      planVersionId: VERSION,
      kind: 'subscription',
    });
    expect(body.checkout.url).toBe(CONFIG.checkoutPageUrl);
    expect(body).not.toHaveProperty('customer_id');
  });

  it('sells a pack once, with no billing cycle, to the known customer', () => {
    const body = checkoutTransactionBody(CONFIG, { ...input, kind: 'pack', customerId: 'ctm_01' });
    expect(body.items[0]!.price.product_id).toBe(PRODUCTS.addon);
    expect(body.items[0]!.price).not.toHaveProperty('billing_cycle');
    expect(body.customer_id).toBe('ctm_01');
  });
});

describe('readCustomData', () => {
  it('drops anything that is not our well-formed tag', () => {
    expect(readCustomData(null)).toEqual({ workspaceId: null, planVersionId: null, kind: null });
    expect(
      readCustomData({ re0_workspace_id: "1' or '1'='1", re0_plan_version_id: 7, re0_kind: 'enterprise' }),
    ).toEqual({ workspaceId: null, planVersionId: null, kind: null });
  });
});

describe('subscription mapping', () => {
  it('keeps every state Paddle has, and reads an unknown one as granting nothing', () => {
    for (const status of ['active', 'trialing', 'past_due', 'paused', 'canceled'] as const) {
      expect(paddleSubscriptionStatus(status)).toBe(status);
    }
    expect(paddleSubscriptionStatus('something_new')).toBe('canceled');
  });

  it('reads the period and the tag, and dates the state by the entity', () => {
    const notice = subscriptionNotice({
      id: 'sub_01',
      status: 'active',
      customer_id: 'ctm_01',
      custom_data: { re0_workspace_id: WORKSPACE, re0_plan_version_id: VERSION },
      current_billing_period: { starts_at: '2026-10-02T10:00:00Z', ends_at: '2026-11-02T10:00:00Z' },
      updated_at: '2026-10-02T10:00:06Z',
    });
    expect(notice).toMatchObject({
      externalId: 'sub_01',
      status: 'active',
      workspaceId: WORKSPACE,
      planVersionId: VERSION,
      periodEnd: new Date('2026-11-02T10:00:00Z'),
      observedAt: new Date('2026-10-02T10:00:06Z'),
    });
  });
});

describe('refundedMinor', () => {
  it('counts approved refunds and chargebacks, nets reversals, and ignores the rest', () => {
    expect(
      refundedMinor(
        [
          adjustment({ totals: { total: '100' } }),
          adjustment({ action: 'chargeback', totals: { total: '300' } }),
          adjustment({ action: 'chargeback_reverse', totals: { total: '300' } }),
          adjustment({ status: 'pending_approval', totals: { total: '50' } }),
          adjustment({ status: 'rejected', totals: { total: '50' } }),
          adjustment({ action: 'credit', totals: { total: '50' } }),
        ],
        500,
      ),
    ).toBe(100);
  });

  it('never reports more back than was charged', () => {
    expect(refundedMinor([adjustment({ totals: { total: '900' } })], 500)).toBe(500);
  });
});

describe('paddleCheckoutState', () => {
  it('treats anything on its way to being charged as paid', () => {
    expect(paddleCheckoutState('draft')).toBe('open');
    expect(paddleCheckoutState('ready')).toBe('open');
    expect(paddleCheckoutState('billed')).toBe('paid');
    expect(paddleCheckoutState('paid')).toBe('paid');
    expect(paddleCheckoutState('completed')).toBe('paid');
    expect(paddleCheckoutState('canceled')).toBe('closed');
  });
});

describe('paddleDocumentStatus', () => {
  it('leaves a checkout in progress, or abandoned, out of the mirror', () => {
    expect(paddleDocumentStatus({ status: 'draft', billed_at: null }, 0)).toBeNull();
    expect(paddleDocumentStatus({ status: 'ready', billed_at: null }, 0)).toBeNull();
    expect(paddleDocumentStatus({ status: 'canceled', billed_at: null }, 0)).toBeNull();
  });

  it('maps the billed lifecycle', () => {
    expect(paddleDocumentStatus({ status: 'billed', billed_at: 'x' }, 0)).toBe('open');
    expect(paddleDocumentStatus({ status: 'paid', billed_at: 'x' }, 0)).toBe('paid');
    expect(paddleDocumentStatus({ status: 'completed', billed_at: 'x' }, 0)).toBe('paid');
    expect(paddleDocumentStatus({ status: 'completed', billed_at: 'x' }, 1)).toBe('refunded');
    expect(paddleDocumentStatus({ status: 'past_due', billed_at: 'x' }, 0)).toBe('failed');
    expect(paddleDocumentStatus({ status: 'canceled', billed_at: 'x' }, 0)).toBe('void');
  });
});

describe('transactionNotice', () => {
  it('produces a document the mirror accepts', () => {
    const notice = transactionNotice(transaction(), [], PRODUCTS)!;
    const draft = parseProviderDocument(notice.document);
    expect(draft).toMatchObject({
      provider: 'paddle',
      externalId: 'txn_01',
      number: '325-10566',
      kind: 'subscription',
      status: 'paid',
      amountMinor: 500,
      refundedMinor: 0,
      currency: 'USD',
      method: 'card',
      paidAt: new Date('2026-10-02T10:00:03Z'),
      periodStart: new Date('2026-10-02T10:00:00Z'),
    });
    expect(notice).toMatchObject({
      workspaceId: WORKSPACE,
      planVersionId: VERSION,
      subscriptionExternalId: 'sub_01',
      customerId: 'ctm_01',
    });
  });

  it('turns a refunded transaction into a refunded document dated by the refund', () => {
    const notice = transactionNotice(transaction(), [adjustment()], PRODUCTS)!;
    expect(notice.document).toMatchObject({ status: 'refunded', refundedMinor: 200 });
    expect(notice.observedAt).toEqual(new Date('2026-10-09T08:00:00Z'));
    expect(() => parseProviderDocument(notice.document)).not.toThrow();
  });

  it('ignores adjustments that belong to another transaction', () => {
    const notice = transactionNotice(transaction(), [adjustment({ transaction_id: 'txn_other' })], PRODUCTS)!;
    expect(notice.document.status).toBe('paid');
  });

  it('recognises a renewal nobody tagged by its subscription, and a pack by its product', () => {
    const renewal = transactionNotice(transaction({ custom_data: null }), [], PRODUCTS)!;
    expect(renewal.document.kind).toBe('subscription');
    expect(renewal.workspaceId).toBeNull();

    const pack = transactionNotice(
      transaction({
        custom_data: null,
        subscription_id: null,
        items: [{ quantity: 2, price: { product_id: PRODUCTS.addon } }],
      }),
      [],
      PRODUCTS,
    )!;
    expect(pack.document.kind).toBe('pack');
    expect(pack.quantity).toBe(2);
    expect(parseProviderDocument(pack.document).periodStart).toBeNull();
  });

  it('leaves out products re0 does not sell', () => {
    const other = transaction({
      custom_data: null,
      subscription_id: null,
      items: [{ quantity: 1, price: { product_id: 'pro_someone_else' } }],
    });
    expect(transactionNotice(other, [], PRODUCTS)).toBeNull();
  });

  it('has the mirror refuse a malformed amount instead of recording zero', () => {
    const noTotal = transactionNotice(transaction({ details: { totals: null } }), [], PRODUCTS)!;
    expect(() => parseProviderDocument(noTotal.document)).toThrow(/minor units/);

    const badRefund = transactionNotice(transaction(), [adjustment({ totals: { total: '1.5' } })], PRODUCTS)!;
    expect(() => parseProviderDocument(badRefund.document)).toThrow(/refunded amount/);
  });

  it('states no refund for a document that was never collected', () => {
    const notice = transactionNotice(transaction({ status: 'past_due', payments: [] }), [], PRODUCTS)!;
    expect(notice.document.status).toBe('failed');
    expect(notice.document).not.toHaveProperty('refundedMinor');
    expect(() => parseProviderDocument(notice.document)).not.toThrow();
  });
});

describe('checkout copy', () => {
  it('has a message for every outcome the plan card can be sent back with', () => {
    for (const messages of [zh, en]) {
      const outcomes = messages.dashboard.settings.checkout.outcomes;
      for (const code of [...CHECKOUT_REFUSALS, 'success', 'failed'] as const) {
        expect(outcomes[code]).toBeTruthy();
      }
    }
  });
});
