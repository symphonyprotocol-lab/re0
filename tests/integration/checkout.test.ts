/**
 * The rules that must hold before a checkout is opened, against a real
 * database and a stand-in for Paddle's API.
 *
 * Paddle is replaced at `fetch`, not at the adapter, so the adapter's own
 * request shapes and the use case's reading of them are both exercised. The
 * stand-in keeps the transactions it was asked to create.
 *
 * agent-first-proposal.md 8.1: the Additional Calls pack is the only thing
 * sold, and anyone who administers a workspace may buy one -- no subscription
 * is asked for first, and every click is a pack of its own.
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
  PADDLE_ADDON_PRODUCT_ID: 'pro_test_pack',
  PADDLE_ENVIRONMENT: 'sandbox',
  APP_BASE_URL: 'https://re0.test',
};

const { startCheckout, billingPortalUrl, CheckoutRefused } = await import(
  '@/lib/application/billing/checkout'
);
const { PLAN_VERSION_NEWEST_FIRST } = await import('@/lib/application/plans/configuration');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaceId = uuidv7();
const owner = { workspaceId, role: 'owner' };

/* ------------------------------------------------------------ fake Paddle */

const transactions = new Map<string, { status: string; body: unknown }>();
let created = 0;

async function fakePaddle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
  if (init?.method === 'POST' && url.pathname === '/transactions') {
    const id = `txn_test_${++created}`;
    transactions.set(id, { status: 'ready', body: JSON.parse(String(init.body)) });
    return json({ id, checkout: { url: `${PADDLE_ENV.APP_BASE_URL}/checkout?_ptxn=${id}` } });
  }
  const read = /^\/transactions\/(txn_[\w]+)$/.exec(url.pathname);
  if (read && transactions.has(read[1]!)) return json({ id: read[1], status: transactions.get(read[1]!)!.status });
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

/** The Free row signup writes, optionally already carrying a provider customer. */
async function addFreeSubscription(providerCustomerId: string | null) {
  const [free] = await db()
    .select({ id: schema.planVersion.id })
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'free'))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  const now = Date.now();
  await db()
    .insert(schema.subscription)
    .values({
      id: uuidv7(),
      workspaceId,
      planVersionId: free!.id,
      status: 'active',
      providerCustomerId,
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
      expect(await refusal(startCheckout({ workspaceId, role }))).toBe('forbidden');
    }
    expect(created).toBe(0);
  });

  it('refuses when no provider is configured', async () => {
    const key = process.env.PADDLE_WEBHOOK_SECRET;
    delete process.env.PADDLE_WEBHOOK_SECRET;
    try {
      expect(await refusal(startCheckout(owner))).toBe('not_connected');
    } finally {
      process.env.PADDLE_WEBHOOK_SECRET = key;
    }
  });

  it('sells a pack to a workspace with no subscription at all', async () => {
    const url = await startCheckout(owner);
    expect(url).toContain('_ptxn=');

    const id = new URL(url).searchParams.get('_ptxn')!;
    const body = transactions.get(id)!.body as { items: { price: { product_id: string } }[]; custom_data: Record<string, string> };
    expect(body.items[0]!.price.product_id).toBe(PADDLE_ENV.PADDLE_ADDON_PRODUCT_ID);
    expect(body.custom_data).toMatchObject({ re0_workspace_id: workspaceId, re0_kind: 'pack' });

    const [recorded] = await db()
      .select({ kind: schema.paymentCheckout.kind, externalId: schema.paymentCheckout.externalId })
      .from(schema.paymentCheckout)
      .where(eq(schema.paymentCheckout.workspaceId, workspaceId));
    expect(recorded).toEqual({ kind: 'pack', externalId: id });
  });

  it('opens a pack of its own for every click', async () => {
    const first = await startCheckout(owner);
    const second = await startCheckout(owner);
    expect(second).not.toBe(first);
    expect(created).toBe(2);
  });

  it('attaches the purchase to the customer the workspace already is', async () => {
    await addFreeSubscription('ctm_test');
    const url = await startCheckout(owner);
    const id = new URL(url).searchParams.get('_ptxn')!;
    expect((transactions.get(id)!.body as { customer_id?: string }).customer_id).toBe('ctm_test');
  });

  it('opens the portal only for a workspace that has paid', async () => {
    expect(await refusal(billingPortalUrl(owner))).toBe('no_customer');
    await addFreeSubscription('ctm_test');
    expect(await billingPortalUrl(owner)).toBe('https://customer-portal.paddle.test/overview');
  });
});
