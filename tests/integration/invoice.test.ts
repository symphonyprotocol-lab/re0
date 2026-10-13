/**
 * Downloading a document's invoice, against a real database and a stand-in
 * for Paddle's API.
 *
 * Paddle is replaced at `fetch`, as in ./checkout.test.ts, so the adapter's
 * request is exercised too: the stand-in only answers the invoice path, and
 * records which transactions it was asked about.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

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

const { invoiceDownloadUrl, InvoiceRefused } = await import('@/lib/application/billing/invoice');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaceId = uuidv7();
const otherWorkspaceId = uuidv7();
const owner = { workspaceId, role: 'owner' };

/* ------------------------------------------------------------ fake Paddle */

const asked: string[] = [];

async function fakePaddle(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const invoice = /^\/transactions\/(txn_[\w]+)\/invoice$/.exec(url.pathname);
  if (invoice && url.searchParams.get('disposition') === 'attachment') {
    asked.push(invoice[1]!);
    return new Response(
      JSON.stringify({ data: { url: `https://invoices.paddle.test/${invoice[1]}.pdf` } }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InvoiceRefused) return error.code;
    throw error;
  }
  return 'none';
}

async function addDocument(input: {
  workspaceId?: string;
  status: 'paid' | 'refunded' | 'open' | 'void';
  amountMinor?: number;
  provider?: string;
}): Promise<string> {
  const id = uuidv7();
  await db()
    .insert(schema.billingDocument)
    .values({
      id,
      workspaceId: input.workspaceId ?? workspaceId,
      provider: input.provider ?? 'paddle',
      externalId: `txn_${id.replaceAll('-', '')}`,
      number: `INV-${id.slice(-6)}`,
      kind: 'subscription',
      status: input.status,
      amountMinor: input.amountMinor ?? 500,
      currency: 'USD',
      issuedAt: new Date(),
    });
  return id;
}

describeWithDb('downloading an invoice', () => {
  beforeAll(async () => {
    Object.assign(process.env, PADDLE_ENV);
    vi.stubGlobal('fetch', vi.fn(fakePaddle));
    await db()
      .insert(schema.workspace)
      .values([
        { id: workspaceId, name: 'Invoice Fixture' },
        { id: otherWorkspaceId, name: 'Invoice Fixture (other)' },
      ]);
  });

  beforeEach(async () => {
    await db()
      .delete(schema.billingDocument)
      .where(inArray(schema.billingDocument.workspaceId, [workspaceId, otherWorkspaceId]));
    asked.length = 0;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db()
      .delete(schema.billingDocument)
      .where(inArray(schema.billingDocument.workspaceId, [workspaceId, otherWorkspaceId]));
    await db().delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
    await db().delete(schema.workspace).where(eq(schema.workspace.id, otherWorkspaceId));
    for (const key of Object.keys(PADDLE_ENV)) delete process.env[key];
  });

  it("hands back the provider's link for a paid document, and for a refunded one", async () => {
    const paid = await addDocument({ status: 'paid' });
    const refunded = await addDocument({ status: 'refunded' });
    expect(await invoiceDownloadUrl({ ...owner, documentId: paid })).toMatch(
      /^https:\/\/invoices\.paddle\.test\/txn_\w+\.pdf$/,
    );
    expect(await invoiceDownloadUrl({ ...owner, documentId: refunded })).toMatch(/\.pdf$/);
    expect(asked).toHaveLength(2);
  });

  it('refuses roles that do not administer the workspace', async () => {
    const paid = await addDocument({ status: 'paid' });
    expect(await refusal(invoiceDownloadUrl({ workspaceId, role: 'developer', documentId: paid }))).toBe(
      'forbidden',
    );
    expect(asked).toHaveLength(0);
  });

  it("does not reach another workspace's document, or a malformed id", async () => {
    const theirs = await addDocument({ workspaceId: otherWorkspaceId, status: 'paid' });
    expect(await refusal(invoiceDownloadUrl({ ...owner, documentId: theirs }))).toBe('not_found');
    expect(await refusal(invoiceDownloadUrl({ ...owner, documentId: 'not-a-uuid' }))).toBe(
      'not_found',
    );
    expect(asked).toHaveLength(0);
  });

  it('refuses documents the provider issues no invoice for', async () => {
    for (const document of [
      { status: 'open' as const },
      { status: 'void' as const },
      { status: 'paid' as const, amountMinor: 0 },
      { status: 'paid' as const, provider: 'stripe' },
    ]) {
      const id = await addDocument(document);
      expect(await refusal(invoiceDownloadUrl({ ...owner, documentId: id }))).toBe('unavailable');
    }
    expect(asked).toHaveLength(0);
  });

  it('refuses when no provider is configured', async () => {
    const paid = await addDocument({ status: 'paid' });
    const apiKey = process.env.PADDLE_API_KEY;
    delete process.env.PADDLE_API_KEY;
    try {
      expect(await refusal(invoiceDownloadUrl({ ...owner, documentId: paid }))).toBe(
        'not_connected',
      );
    } finally {
      process.env.PADDLE_API_KEY = apiKey;
    }
  });
});
