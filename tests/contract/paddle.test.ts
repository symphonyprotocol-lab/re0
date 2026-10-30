/**
 * The Paddle adapter's pure half: the signature check, and the mapping from
 * Paddle's entities onto the mirror's shapes.
 *
 * The network half -- the API calls -- is not here; what matters about it is
 * what it is fed into, and that is these functions.
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import { BACKFILL_REFUSALS } from '@/lib/application/billing/backfill';
import { CHECKOUT_REFUSALS } from '@/lib/application/billing/checkout';
import { parseProviderDocument } from '@/lib/domain/billing';
import {
  checkoutTransactionBody,
  paddleAdapter,
  paddleCheckoutState,
  paddleConfig,
  paddleDocumentStatus,
  readCustomData,
  refundedMinor,
  SIGNATURE_TOLERANCE_SECONDS,
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
/* The one product re0 sells; `pro_` is Paddle's id prefix for every product. */
const ADDON_PRODUCT = 'pro_pack';

const CONFIG: PaddleConfig = {
  apiKey: 'pdl_sdbx_apikey_x',
  webhookSecret: SECRET,
  clientToken: 'test_x',
  environment: 'sandbox',
  addonProductId: ADDON_PRODUCT,
  channelProductId: null,
  checkoutPageUrl: 'https://re0.test/checkout',
};

function transaction(overrides: Partial<PaddleTransaction> = {}): PaddleTransaction {
  return {
    id: 'txn_01',
    status: 'completed',
    customer_id: 'ctm_01',
    subscription_id: null,
    invoice_number: '325-10566',
    currency_code: 'USD',
    custom_data: { re0_workspace_id: WORKSPACE, re0_plan_version_id: VERSION, re0_kind: 'pack' },
    billing_period: null,
    billed_at: '2026-10-02T10:00:01Z',
    created_at: '2026-10-02T09:59:00Z',
    updated_at: '2026-10-02T10:00:05Z',
    items: [{ quantity: 1, price: { product_id: ADDON_PRODUCT } }],
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
    kind: 'pack' as const,
    workspaceId: WORKSPACE,
    planVersionId: VERSION,
    priceMinor: 500,
    currency: 'USD',
    name: 'Re0 Additional Calls',
    customerId: null,
  };

  it('prices a pack from the Plan Version, once, and tags it', () => {
    const body = checkoutTransactionBody(CONFIG, input);
    expect(body.items[0]!.price).toMatchObject({
      product_id: ADDON_PRODUCT,
      unit_price: { amount: '500', currency_code: 'USD' },
    });
    /* One payment: a pack never renews (agent-first-proposal.md 8.1). */
    expect(body.items[0]!.price).not.toHaveProperty('billing_cycle');
    expect(readCustomData(body.custom_data)).toEqual({
      workspaceId: WORKSPACE,
      planVersionId: VERSION,
      kind: 'pack',
    });
    expect(body.checkout.url).toBe(CONFIG.checkoutPageUrl);
    expect(body).not.toHaveProperty('customer_id');
  });

  it('attaches the purchase to the customer the workspace already is', () => {
    const body = checkoutTransactionBody(CONFIG, { ...input, customerId: 'ctm_01' });
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
    const notice = transactionNotice(transaction(), [], ADDON_PRODUCT)!;
    const draft = parseProviderDocument(notice.document);
    expect(draft).toMatchObject({
      provider: 'paddle',
      externalId: 'txn_01',
      number: '325-10566',
      kind: 'pack',
      status: 'paid',
      amountMinor: 500,
      refundedMinor: 0,
      currency: 'USD',
      method: 'card',
      paidAt: new Date('2026-10-02T10:00:03Z'),
      periodStart: null,
    });
    expect(notice).toMatchObject({
      workspaceId: WORKSPACE,
      planVersionId: VERSION,
      subscriptionExternalId: null,
      customerId: 'ctm_01',
      quantity: 1,
    });
  });

  it('turns a refunded transaction into a refunded document dated by the refund', () => {
    const notice = transactionNotice(transaction(), [adjustment()], ADDON_PRODUCT)!;
    expect(notice.document).toMatchObject({ status: 'refunded', refundedMinor: 200 });
    expect(notice.observedAt).toEqual(new Date('2026-10-09T08:00:00Z'));
    expect(() => parseProviderDocument(notice.document)).not.toThrow();
  });

  it('ignores adjustments that belong to another transaction', () => {
    const notice = transactionNotice(transaction(), [adjustment({ transaction_id: 'txn_other' })], ADDON_PRODUCT)!;
    expect(notice.document.status).toBe('paid');
  });

  it('recognises an untagged pack by its product, and still mirrors a legacy subscription charge', () => {
    const pack = transactionNotice(
      transaction({ custom_data: null, items: [{ quantity: 2, price: { product_id: ADDON_PRODUCT } }] }),
      [],
      ADDON_PRODUCT,
    )!;
    expect(pack.document.kind).toBe('pack');
    expect(pack.workspaceId).toBeNull();
    expect(pack.quantity).toBe(2);

    /* A charge from a subscription sold before Pro was removed: money on the account, kept on record. */
    const renewal = transactionNotice(
      transaction({
        custom_data: null,
        subscription_id: 'sub_legacy',
        items: [{ quantity: 1, price: { product_id: 'pro_retired' } }],
        billing_period: { starts_at: '2026-10-02T10:00:00Z', ends_at: '2026-11-02T10:00:00Z' },
      }),
      [],
      ADDON_PRODUCT,
    )!;
    expect(renewal.document.kind).toBe('subscription');
    expect(renewal.subscriptionExternalId).toBe('sub_legacy');
    expect(parseProviderDocument(renewal.document).periodStart).toEqual(new Date('2026-10-02T10:00:00Z'));
  });

  it('leaves out products re0 does not sell', () => {
    const other = transaction({
      custom_data: null,
      items: [{ quantity: 1, price: { product_id: 'pro_someone_else' } }],
    });
    expect(transactionNotice(other, [], ADDON_PRODUCT)).toBeNull();
  });

  it('has the mirror refuse a malformed amount instead of recording zero', () => {
    const noTotal = transactionNotice(transaction({ details: { totals: null } }), [], ADDON_PRODUCT)!;
    expect(() => parseProviderDocument(noTotal.document)).toThrow(/minor units/);

    const badRefund = transactionNotice(transaction(), [adjustment({ totals: { total: '1.5' } })], ADDON_PRODUCT)!;
    expect(() => parseProviderDocument(badRefund.document)).toThrow(/refunded amount/);
  });

  it('states no refund for a document that was never collected', () => {
    const notice = transactionNotice(transaction({ status: 'past_due', payments: [] }), [], ADDON_PRODUCT)!;
    expect(notice.document.status).toBe('failed');
    expect(notice.document).not.toHaveProperty('refundedMinor');
    expect(() => parseProviderDocument(notice.document)).not.toThrow();
  });
});

/*
 * The adapter's network half, against a stubbed `fetch`: only what the review
 * found it getting wrong (docs/reviews/agent-first-p1-p5-review.md M14, M16).
 */
describe('the adapter against a stubbed Paddle API', () => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const CHANNEL_PRODUCT = 'pro_channel';
  const config: PaddleConfig = { ...CONFIG, channelProductId: CHANNEL_PRODUCT };

  function stub(transactionData: PaddleTransaction) {
    requests.length = 0;
    vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string }) => {
      requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      const data = url.includes('/adjustments') ? [] : url.includes('/transactions/') ? transactionData : {};
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never hands a channel transaction to the backfill as the subscriber\'s billing document', async () => {
    stub(
      transaction({
        subscription_id: 'sub_01',
        custom_data: { re0_kind: 'channel', re0_workspace_id: WORKSPACE, re0_channel_plan_version_id: VERSION },
        items: [{ quantity: 1, price: { product_id: CHANNEL_PRODUCT } }],
        details: { totals: { grand_total: '600' } },
      }),
    );
    const snapshot = await paddleAdapter(config).fetchDocument('txn_01');
    expect(snapshot.document).toBeNull();
    expect(snapshot.channelTransaction).toBe(true);

    /* A pack is still a document. */
    stub(transaction());
    const pack = await paddleAdapter(config).fetchDocument('txn_01');
    expect(pack.document?.document.kind).toBe('pack');
    expect(pack.channelTransaction).toBeFalsy();
  });

  it('cancels at the end of the period by default, and now when a refund revoked it', async () => {
    stub(transaction());
    await paddleAdapter(config).cancelSubscription('sub_01');
    await paddleAdapter(config).cancelSubscription('sub_01', { immediately: true });
    expect(requests.map((request) => [request.method, request.url.replace(/^https:\/\/[^/]+/, ''), request.body])).toEqual([
      ['POST', '/subscriptions/sub_01/cancel', { effective_from: 'next_billing_period' }],
      ['POST', '/subscriptions/sub_01/cancel', { effective_from: 'immediately' }],
    ]);
  });
});

describe('backfill copy', () => {
  it('has a message for every refusal the console can show', () => {
    for (const messages of [zh, en]) {
      for (const code of BACKFILL_REFUSALS) expect(messages.admin.billing.backfill.errors[code]).toBeTruthy();
    }
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
