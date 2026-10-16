/**
 * The rules that must hold before a checkout is opened, against a real
 * database and a stand-in for Paddle's API.
 *
 * Paddle is replaced at `fetch`, not at the adapter, so the adapter's own
 * request shapes and the use case's reading of them are both exercised. The
 * stand-in keeps the transactions it was asked to create and answers status
 * reads from them; a test moves one to `completed` to play a paid checkout
 * whose webhook has not arrived.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const PADDLE_ENV = {
  PADDLE_API_KEY: 'pdl_sdbx_apikey_test',
  PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_test',
  PADDLE_CLIENT_TOKEN: 'test_token',
  PADDLE_PRO_PRODUCT_ID: 'pro_test_pro',
  PADDLE_ADDON_PRODUCT_ID: 'pro_test_pack',
  PADDLE_ENVIRONMENT: 'sandbox',
  APP_BASE_URL: 'https://re0.test',
};

const { startCheckout, billingPortalUrl, CheckoutRefused } = await import(
  '@/lib/application/billing/checkout'
);
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaceId = uuidv7();
const owner = { workspaceId, role: 'owner' };

/* ------------------------------------------------------------ fake Paddle */

const transactions = new Map<string, { status: string }>();
let created = 0;

async function fakePaddle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
  if (init?.method === 'POST' && url.pathname === '/transactions') {
    const id = `txn_test_${++created}`;
    transactions.set(id, { status: 'ready' });
    return json({ id, checkout: { url: `${PADDLE_ENV.APP_BASE_URL}/checkout?_ptxn=${id}` } });
  }
  const read = /^\/transactions\/(txn_[\w]+)$/.exec(url.pathname);
  if (read && transactions.has(read[1]!)) return json({ id: read[1], ...transactions.get(read[1]!) });
  if (/^\/customers\/[\w]+\/portal-sessions$/.test(url.pathname)) {
    return json({ urls: { general: { overview: 'https://customer-portal.paddle.test/overview' } } });
  }
  return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CheckoutRefused) return error.code;
    throw error;
  }
  return 'none';
}

async function addProviderSubscription(status: 'active' | 'past_due' | 'paused') {
  const [pro] = await db()
    .select({ id: schema.planVersion.id })
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'pro'))
    .limit(1);
  const now = Date.now();
  await db()
    .insert(schema.subscription)
    .values({
      id: uuidv7(),
      workspaceId,
      planVersionId: pro!.id,
      status,
      providerCustomerId: 'ctm_test',
      providerSubscriptionId: `sub_${uuidv7()}`,
      periodStart: new Date(now - 86_400_000),
      periodEnd: new Date(now + 29 * 86_400_000),
    });
}

describeWithDb('starting a checkout', () => {
  beforeAll(async () => {
    Object.assign(process.env, PADDLE_ENV);
    vi.stubGlobal('fetch', vi.fn(fakePaddle));
    await db().insert(schema.workspace).values({ id: workspaceId, name: 'Checkout Fixture' });
  });

  beforeEach(async () => {
    await db().delete(schema.paymentCheckout).where(eq(schema.paymentCheckout.workspaceId, workspaceId));
    await db().delete(schema.subscription).where(eq(schema.subscription.workspaceId, workspaceId));
    transactions.clear();
    created = 0;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db().delete(schema.paymentCheckout).where(eq(schema.paymentCheckout.workspaceId, workspaceId));
    await db().delete(schema.subscription).where(eq(schema.subscription.workspaceId, workspaceId));
    await db().delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
    for (const key of Object.keys(PADDLE_ENV)) delete process.env[key];
  });

  it('refuses roles that do not administer the workspace', async () => {
    for (const role of ['developer', 'viewer']) {
      expect(await refusal(startCheckout({ workspaceId, role, kind: 'subscription' }))).toBe('forbidden');
    }
    expect(created).toBe(0);
  });

  it('refuses when no provider is configured', async () => {
    const key = process.env.PADDLE_WEBHOOK_SECRET;
    delete process.env.PADDLE_WEBHOOK_SECRET;
    try {
      expect(await refusal(startCheckout({ ...owner, kind: 'subscription' }))).toBe('not_connected');
    } finally {
      process.env.PADDLE_WEBHOOK_SECRET = key;
    }
  });

  it('sells packs to Pro only', async () => {
    expect(await refusal(startCheckout({ ...owner, kind: 'pack' }))).toBe('pro_required');
    await addProviderSubscription('active');
    expect(await startCheckout({ ...owner, kind: 'pack' })).toContain('_ptxn=');
  });

  it('refuses a second subscription beside one that is still billing', async () => {
    for (const status of ['active', 'past_due', 'paused'] as const) {
      await db().delete(schema.subscription).where(eq(schema.subscription.workspaceId, workspaceId));
      await addProviderSubscription(status);
      expect(await refusal(startCheckout({ ...owner, kind: 'subscription' }))).toBe('already_subscribed');
    }
    expect(created).toBe(0);
  });

  it('hands back the open checkout instead of opening a second', async () => {
    const first = await startCheckout({ ...owner, kind: 'subscription' });
    const second = await startCheckout({ ...owner, kind: 'subscription' });
    expect(second).toBe(first);
    expect(created).toBe(1);
  });

  it('hands the open checkout back on the checkout domain of today, not of its opening', async () => {
    const first = await startCheckout({ ...owner, kind: 'subscription' });
    const id = new URL(first).searchParams.get('_ptxn')!;
    process.env.PADDLE_CHECKOUT_BASE_URL = 'https://tunnel.re0.test/';
    try {
      expect(await startCheckout({ ...owner, kind: 'subscription' })).toBe(
        `https://tunnel.re0.test/checkout?_ptxn=${id}`,
      );
    } finally {
      delete process.env.PADDLE_CHECKOUT_BASE_URL;
    }
    expect(created).toBe(1);
  });

  it('refuses while a paid checkout waits for its webhook, and reopens once it closed', async () => {
    const first = await startCheckout({ ...owner, kind: 'subscription' });
    const id = new URL(first).searchParams.get('_ptxn')!;

    transactions.set(id, { status: 'completed' });
    expect(await refusal(startCheckout({ ...owner, kind: 'subscription' }))).toBe('pending');

    transactions.set(id, { status: 'canceled' });
    const next = await startCheckout({ ...owner, kind: 'subscription' });
    expect(next).not.toBe(first);
    expect(created).toBe(2);
  });

  it('decides concurrent clicks one at a time', async () => {
    const urls = await Promise.all([
      startCheckout({ ...owner, kind: 'subscription' }),
      startCheckout({ ...owner, kind: 'subscription' }),
    ]);
    expect(urls[0]).toBe(urls[1]);
    expect(created).toBe(1);
  });

  it('opens the portal only for a workspace that has paid', async () => {
    expect(await refusal(billingPortalUrl(owner))).toBe('no_customer');
    await addProviderSubscription('active');
    expect(await billingPortalUrl(owner)).toBe('https://customer-portal.paddle.test/overview');
  });
});
