/**
 * Redeeming settled earnings as Additional Calls, against a real database.
 * publisher-revenue-share.md 3.4: statements past their hold convert at the
 * pack rate into one grant on the publisher's workspace, held statements stay
 * accrued, the conversion never runs twice over the same rows, and nothing is
 * written to `payout`.
 *
 * Fixture rows live in 2022 periods, isolated from every parallel suite.
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

const { earningCredit, publisherEarnings, redeemEarningsAsCalls } = await import(
  '@/lib/application/revenue'
);
const { EarningCreditRefused, PAYOUT_HOLD_DAYS } = await import('@/lib/domain');
const { hashApiKey } = await import('@/lib/application/auth/api-key');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { POST: creditPost } = await import('@/app/api/v1/revenue/credit/route');

const DAY = 24 * 60 * 60 * 1000;
const workspaces: string[] = [];
const libraries: string[] = [];
const planVersions: string[] = [];
const periods: string[] = [];
const publisherAccounts: string[] = [];

async function workspace(name: string): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name });
  return id;
}

async function publisherAccount(workspaceId: string): Promise<string> {
  const id = uuidv7();
  publisherAccounts.push(id);
  await db()
    .insert(schema.publisherAccount)
    .values({ id, workspaceId, taxStatus: 'complete', agreementVersion: 'v1' });
  return id;
}

/** The pack rate the conversion prices at: $5 for 5,000 calls, newest version. */
async function packVersion(): Promise<void> {
  const id = uuidv7();
  planVersions.push(id);
  await db().insert(schema.planVersion).values({
    id,
    planId: 'addon',
    priceMinor: 500,
    currency: 'USD',
    monthlyCalls: 5_000,
    libraryLimit: 0,
    librarySizeBytesLimit: 0,
    apiKeyLimit: 0,
    shareRateBps: 0,
    capabilities: {},
    createdAt: new Date('2100-01-01T00:00:00Z'),
  });
}

async function library(slug: string, owner: string): Promise<string> {
  const id = crypto.randomUUID();
  libraries.push(id);
  await db().insert(schema.library).values({
    id,
    publicId: `/websites/${slug}`,
    title: `Credit fixture ${slug}`,
    ownerWorkspaceId: owner,
    isPlatformLibrary: false,
    visibility: 'public',
    lifecycleStatus: 'published',
    indexStatus: 'ready',
  });
  return id;
}

async function lockedPeriod(id: string, lockedAt: Date): Promise<void> {
  periods.push(id);
  await db().insert(schema.revenuePeriod).values({
    id,
    netRevenueMinor: 100_000,
    currency: 'USD',
    totalBilledCalls: 1_000,
    totalAttributableCalls: 100,
    shareRateBps: 2_000,
    poolMinor: 20_000,
    lockedAt,
  });
}

async function statement(input: {
  periodId: string;
  publisherAccountId: string;
  libraryId: string;
  amountMinor: number;
  status?: 'accrued' | 'voided';
}): Promise<string> {
  const id = uuidv7();
  await db().insert(schema.settlement).values({
    id,
    periodId: input.periodId,
    publisherAccountId: input.publisherAccountId,
    libraryId: input.libraryId,
    attributableCalls: 10,
    amountMinor: input.amountMinor,
    currency: 'USD',
    status: input.status ?? 'accrued',
  });
  return id;
}

async function apiKeyFor(workspaceId: string): Promise<string> {
  const key = `mm_test_${crypto.randomUUID().replace(/-/g, '')}`;
  await db().insert(schema.apiKey).values({
    id: uuidv7(),
    workspaceId,
    name: 'credit key',
    keyHash: await hashApiKey(key),
    keyPrefix: 'mm_test_',
    lastFour: key.slice(-4),
    scopes: ['retrieval'],
    environment: 'test',
  });
  return key;
}

describeWithDb('earning credit', () => {
  afterAll(async () => {
    const database = db();
    if (publisherAccounts.length > 0) {
      await database
        .delete(schema.settlement)
        .where(inArray(schema.settlement.publisherAccountId, publisherAccounts));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.addonGrant).where(inArray(schema.addonGrant.workspaceId, workspaces));
      await database.delete(schema.apiKey).where(inArray(schema.apiKey.workspaceId, workspaces));
    }
    if (publisherAccounts.length > 0) {
      await database
        .delete(schema.publisherAccount)
        .where(inArray(schema.publisherAccount.id, publisherAccounts));
    }
    if (libraries.length > 0) {
      await database.delete(schema.library).where(inArray(schema.library.id, libraries));
    }
    if (periods.length > 0) {
      await database.delete(schema.revenuePeriod).where(inArray(schema.revenuePeriod.id, periods));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('converts statements past their hold into one grant, and only those', async () => {
    const now = new Date();
    await packVersion();
    const owner = await workspace('credit-owner');
    const account = await publisherAccount(owner);
    const lib = await library('credit-a', owner);

    const released = new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 15) * DAY);
    const recent = new Date(now.getTime() - 10 * DAY);
    await lockedPeriod('2022-01', released);
    await lockedPeriod('2022-02', recent);

    const a = await statement({ periodId: '2022-01', publisherAccountId: account, libraryId: lib, amountMinor: 1_234 });
    const b = await statement({ periodId: '2022-01', publisherAccountId: account, libraryId: lib, amountMinor: 66 });
    /* Voided at the lock: never redeemable, whatever its period. */
    const voided = await statement({ periodId: '2022-01', publisherAccountId: account, libraryId: lib, amountMinor: 999, status: 'voided' });
    const held = await statement({ periodId: '2022-02', publisherAccountId: account, libraryId: lib, amountMinor: 500 });

    const before = await earningCredit(account, now);
    expect(before.pack).toEqual({ priceMinor: 500, calls: 5_000 });
    expect(before.redeemableMinor).toBe(1_300);
    expect(before.redeemableStatements).toBe(2);
    expect(before.redeemableCalls).toBe(13_000);
    expect(before.heldMinor).toBe(500);
    expect(before.nextReleaseAt?.getTime()).toBe(recent.getTime() + PAYOUT_HOLD_DAYS * DAY);
    expect(before.redeemedMinor).toBe(0);
    expect(before.redemptions).toEqual([]);

    const redeemed = await redeemEarningsAsCalls({ workspaceId: owner, now });
    expect(redeemed).toMatchObject({ amountMinor: 1_300, calls: 13_000, statements: 2, currency: 'USD' });

    const [grant] = await db()
      .select()
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.id, redeemed.grantId));
    expect(grant).toMatchObject({
      workspaceId: owner,
      publisherAccountId: account,
      callsGranted: 13_000,
      callsConsumed: 0,
      priceMinor: 1_300,
      providerOrderId: null,
    });

    const rows = await db()
      .select({ id: schema.settlement.id, status: schema.settlement.status, grant: schema.settlement.addonGrantId })
      .from(schema.settlement)
      .where(inArray(schema.settlement.id, [a, b, voided, held]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(a)).toMatchObject({ status: 'redeemed', grant: redeemed.grantId });
    expect(byId.get(b)).toMatchObject({ status: 'redeemed', grant: redeemed.grantId });
    expect(byId.get(voided)).toMatchObject({ status: 'voided', grant: null });
    expect(byId.get(held)).toMatchObject({ status: 'accrued', grant: null });

    /* Nothing was paid out: the platform moved no money. */
    const payouts = await db()
      .select({ id: schema.payout.id })
      .from(schema.payout)
      .where(eq(schema.payout.publisherAccountId, account));
    expect(payouts).toEqual([]);

    const after = await publisherEarnings(owner);
    expect(after.credit.redeemableMinor).toBe(0);
    expect(after.credit.heldMinor).toBe(500);
    expect(after.credit.redeemedMinor).toBe(1_300);
    expect(after.credit.redeemedCalls).toBe(13_000);
    expect(after.credit.redemptions).toHaveLength(1);
    expect(after.credit.redemptions[0]).toMatchObject({ id: redeemed.grantId, amountMinor: 1_300, callsGranted: 13_000 });

    /* A second redeem finds the rows already redeemed and converts nothing. */
    await expect(redeemEarningsAsCalls({ workspaceId: owner, now })).rejects.toMatchObject({
      code: 'nothing_redeemable',
    });

    /* The API says the same, as a client error rather than a server fault. */
    const key = await apiKeyFor(owner);
    const response = await creditPost(
      new NextRequest('http://localhost/api/v1/revenue/credit', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('nothing_redeemable');
  });

  it('redeems through the API once the hold has passed', async () => {
    const owner = await workspace('credit-owner-api');
    const account = await publisherAccount(owner);
    const lib = await library('credit-b', owner);
    await lockedPeriod('2022-03', new Date(Date.now() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    await statement({ periodId: '2022-03', publisherAccountId: account, libraryId: lib, amountMinor: 250 });

    const key = await apiKeyFor(owner);
    const response = await creditPost(
      new NextRequest('http://localhost/api/v1/revenue/credit', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { grantId: string; amountMinor: number; calls: number };
    expect(body).toMatchObject({ amountMinor: 250, calls: 2_500 });

    const [grant] = await db()
      .select({ workspaceId: schema.addonGrant.workspaceId, calls: schema.addonGrant.callsGranted })
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.id, body.grantId));
    expect(grant).toEqual({ workspaceId: owner, calls: 2_500 });
  });

  it('refuses a workspace without a publisher account', async () => {
    const stranger = await workspace('credit-stranger');
    await expect(redeemEarningsAsCalls({ workspaceId: stranger })).rejects.toBeInstanceOf(
      EarningCreditRefused,
    );
    await expect(redeemEarningsAsCalls({ workspaceId: stranger })).rejects.toMatchObject({
      code: 'no_account',
    });
  });

  it('leaves an amount below one call accrued', async () => {
    const owner = await workspace('credit-owner-small');
    const account = await publisherAccount(owner);
    const lib = await library('credit-c', owner);
    await lockedPeriod('2022-04', new Date(Date.now() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    /* Zero cents past the hold: the pack rate makes any cent worth ten calls,
       so the only way to be under one call is to have nothing at all. */
    const id = await statement({ periodId: '2022-04', publisherAccountId: account, libraryId: lib, amountMinor: 0 });

    await expect(redeemEarningsAsCalls({ workspaceId: owner })).rejects.toMatchObject({
      code: 'nothing_redeemable',
    });
    const [row] = await db()
      .select({ status: schema.settlement.status })
      .from(schema.settlement)
      .where(eq(schema.settlement.id, id));
    expect(row?.status).toBe('accrued');
  });
});
