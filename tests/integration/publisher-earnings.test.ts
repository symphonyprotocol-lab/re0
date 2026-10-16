/**
 * The publisher's view of their earnings, against a real database.
 * publisher-revenue-share.md stage 2: every figure is recomputed from the
 * ledger (a locked period re-derives the same amount closePeriod allocated),
 * an unlocked period shows calls and no amount, and the account exists only
 * after the agreement is accepted.
 *
 * Fixture rows live in 2021 periods, isolated from every parallel suite.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.API_KEY_HASH_SECRET ??= 'test-api-key-hash-secret-000000000000';

const { closePeriod } = await import('@/lib/application/revenue');
const { hashApiKey } = await import('@/lib/application/auth/api-key');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { GET: revenueGet, POST: revenuePost } = await import('@/app/api/v1/revenue/route');

const workspaces: string[] = [];
const libraries: string[] = [];
const planVersions: string[] = [];
const periods: string[] = [];

async function workspace(name: string): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name });
  return id;
}

async function apiKeyFor(workspaceId: string): Promise<string> {
  const key = `mm_test_${crypto.randomUUID().replace(/-/g, '')}`;
  await db().insert(schema.apiKey).values({
    id: uuidv7(),
    workspaceId,
    name: 'earnings key',
    keyHash: await hashApiKey(key),
    keyPrefix: 'mm_test_',
    lastFour: key.slice(-4),
    /* Accepting the agreement is an account change and needs the management scope. */
    scopes: ['retrieval', 'admin:keys'],
    environment: 'test',
  });
  return key;
}

async function ledger(input: {
  period: string;
  at: Date;
  owner: string;
  reader: string;
  earning: number;
  extraBilled: number;
}): Promise<void> {
  const database = db();
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 100_000,
    libraryLimit: 10,
    librarySizeBytesLimit: 1_000_000,
    apiKeyLimit: 5,
    shareRateBps: 2_000,
    capabilities: {},
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  const libraryId = crypto.randomUUID();
  libraries.push(libraryId);
  await database.insert(schema.library).values({
    id: libraryId,
    publicId: `/websites/earnings-${crypto.randomUUID().slice(0, 13)}`,
    title: 'Earnings view fixture',
    ownerWorkspaceId: input.owner,
    isPlatformLibrary: false,
    visibility: 'public',
    lifecycleStatus: 'published',
    indexStatus: 'ready',
  });

  const ids = Array.from(
    { length: input.earning + input.extraBilled },
    () => `req_earnview_${uuidv7()}`,
  );
  await database.insert(schema.usageEvent).values(
    ids.map((requestId) => ({
      id: uuidv7(),
      workspaceId: input.reader,
      requestId,
      libraryId,
      operation: 'context',
      entrypoint: 'rest',
      debitSource: 'plan',
      statusCode: 200,
      createdAt: input.at,
    })),
  );
  await database.insert(schema.earningEvent).values(
    ids.slice(0, input.earning).map((requestId) => ({
      id: uuidv7(),
      requestId,
      libraryId,
      ownerWorkspaceId: input.owner,
      planVersionId,
      shareRateBps: 2_000,
      periodId: input.period,
      createdAt: input.at,
    })),
  );
  await database.insert(schema.billingDocument).values({
    id: uuidv7(),
    workspaceId: input.reader,
    provider: 'stripe',
    externalId: `inv_${uuidv7()}`,
    number: 'INV-E',
    kind: 'subscription' as const,
    status: 'paid' as const,
    amountMinor: 10_000,
    refundedMinor: 0,
    issuedAt: input.at,
    paidAt: input.at,
  });
}

function get(key: string): NextRequest {
  return new NextRequest('https://api.example.test/api/v1/revenue', {
    headers: { authorization: `Bearer ${key}` },
  });
}

function post(key: string, body: unknown): NextRequest {
  return new NextRequest('https://api.example.test/api/v1/revenue', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describeWithDb('publisher earnings view', () => {
  afterAll(async () => {
    const database = db();
    if (libraries.length > 0) {
      await database
        .delete(schema.earningEvent)
        .where(inArray(schema.earningEvent.libraryId, libraries));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.libraryId, libraries));
      await database.delete(schema.library).where(inArray(schema.library.id, libraries));
    }
    if (periods.length > 0) {
      await database.delete(schema.revenuePeriod).where(inArray(schema.revenuePeriod.id, periods));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.publisherAccount)
        .where(inArray(schema.publisherAccount.workspaceId, workspaces));
      await database
        .delete(schema.billingDocument)
        .where(inArray(schema.billingDocument.workspaceId, workspaces));
      await database.delete(schema.apiKey).where(inArray(schema.apiKey.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database
        .delete(schema.planVersion)
        .where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('recomputes locked amounts, shows unlocked calls, and gates on the agreement', async () => {
    periods.push('2021-03', '2021-04');
    const owner = await workspace('earnings-owner');
    const reader = await workspace('earnings-reader');
    const key = await apiKeyFor(owner);

    await ledger({
      period: '2021-03',
      at: new Date('2021-03-10T00:00:00Z'),
      owner,
      reader,
      earning: 5,
      extraBilled: 5,
    });
    await ledger({
      period: '2021-04',
      at: new Date('2021-04-10T00:00:00Z'),
      owner,
      reader,
      earning: 3,
      extraBilled: 0,
    });

    const closed = await closePeriod('2021-03');
    const expected = closed.allocations.find((a) => a.ownerWorkspaceId === owner)!;
    expect(expected.amountMinor).toBeGreaterThan(0);

    const response = await revenueGet(get(key));
    expect(response.status).toBe(200);
    const earnings = (await response.json()) as {
      account: unknown;
      accruedMinor: number;
      periods: { periodId: string; locked: boolean; attributableCalls: number; amountMinor: number | null }[];
    };

    /* No account until the agreement is accepted -- but the ledger still shows. */
    expect(earnings.account).toBeNull();

    const march = earnings.periods.find((p) => p.periodId === '2021-03')!;
    expect(march.locked).toBe(true);
    expect(march.attributableCalls).toBe(5);
    /* The dashboard's recomputation lands on closePeriod's allocation exactly. */
    expect(march.amountMinor).toBe(expected.amountMinor);

    const april = earnings.periods.find((p) => p.periodId === '2021-04')!;
    expect(april.locked).toBe(false);
    expect(april.attributableCalls).toBe(3);
    expect(april.amountMinor).toBeNull();

    expect(earnings.accruedMinor).toBe(expected.amountMinor);

    /* Accepting the agreement opens the account, idempotently. */
    const first = await revenuePost(post(key, { agreementVersion: 'pub-2026-01' }));
    expect(first.status).toBe(200);
    const second = await revenuePost(post(key, { agreementVersion: 'pub-2026-02' }));
    const a = (await first.json()) as { accountId: string };
    const b = (await second.json()) as { accountId: string };
    expect(b.accountId).toBe(a.accountId);

    const after = (await (await revenueGet(get(key))).json()) as {
      account: { agreementVersion: string; providerAccountLinked: boolean } | null;
    };
    expect(after.account?.agreementVersion).toBe('pub-2026-02');
    expect(after.account?.providerAccountLinked).toBe(false);

    /* A stranger's key sees an empty ledger, not this one. */
    const stranger = await workspace('earnings-stranger');
    const strangerKey = await apiKeyFor(stranger);
    const empty = (await (await revenueGet(get(strangerKey))).json()) as {
      periods: unknown[];
      accruedMinor: number;
    };
    expect(empty.periods).toHaveLength(0);
    expect(empty.accruedMinor).toBe(0);
  });
});
