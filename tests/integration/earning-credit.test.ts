/**
 * Redeeming settled earnings as Additional Calls, against a real database.
 * agent-first-proposal.md 6.9: statements past their hold convert at the
 * pack rate into one grant on the creator's workspace, held statements stay
 * accrued, a negative statement nets against the positives, two racing
 * redeems produce one grant, and nothing is written to `payout`.
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
    capabilities: {},
    createdAt: new Date('2100-01-01T00:00:00Z'),
  });
}

const ACTOR = { kind: 'user' as const, id: crypto.randomUUID() };

async function lockedPeriod(id: string, lockedAt: Date): Promise<void> {
  periods.push(id);
  await db().insert(schema.revenuePeriod).values({ id, currency: 'USD', totalAmountMinor: 0, lockedAt });
}

async function statement(input: {
  periodId: string;
  publisherAccountId: string;
  amountMinor: number;
  status?: 'accrued' | 'voided';
  currency?: string;
}): Promise<string> {
  const id = uuidv7();
  await db().insert(schema.settlement).values({
    id,
    periodId: input.periodId,
    publisherAccountId: input.publisherAccountId,
    amountMinor: input.amountMinor,
    currency: input.currency ?? 'USD',
    status: input.status ?? 'accrued',
  });
  return id;
}

async function apiKeyFor(
  workspaceId: string,
  scopes: string[] = ['retrieval', 'admin:keys'],
): Promise<{ key: string; id: string }> {
  const key = `mm_test_${crypto.randomUUID().replace(/-/g, '')}`;
  const id = uuidv7();
  await db().insert(schema.apiKey).values({
    id,
    workspaceId,
    name: 'credit key',
    keyHash: await hashApiKey(key),
    keyPrefix: 'mm_test_',
    lastFour: key.slice(-4),
    scopes,
    environment: 'test',
  });
  return { key, id };
}

function creditRequest(key: string): NextRequest {
  return new NextRequest('http://localhost/api/v1/revenue/credit', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
  });
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

    const released = new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 15) * DAY);
    const recent = new Date(now.getTime() - 10 * DAY);
    await lockedPeriod('2022-01', released);
    await lockedPeriod('2022-02', recent);

    const a = await statement({ periodId: '2022-01', publisherAccountId: account, amountMinor: 1_234 });
    const b = await statement({ periodId: '2022-01', publisherAccountId: account, amountMinor: 66 });
    /* Voided by an operator: never redeemable, whatever its period. */
    const voided = await statement({ periodId: '2022-01', publisherAccountId: account, amountMinor: 999, status: 'voided' });
    const held = await statement({ periodId: '2022-02', publisherAccountId: account, amountMinor: 500 });

    const before = await earningCredit(account, now);
    expect(before.pack).toEqual({ priceMinor: 500, calls: 5_000 });
    expect(before.redeemableMinor).toBe(1_300);
    expect(before.redeemableStatements).toBe(2);
    expect(before.redeemableCalls).toBe(13_000);
    expect(before.heldMinor).toBe(500);
    expect(before.nextReleaseAt?.getTime()).toBe(recent.getTime() + PAYOUT_HOLD_DAYS * DAY);
    expect(before.redeemedMinor).toBe(0);
    expect(before.redemptions).toEqual([]);

    const redeemed = await redeemEarningsAsCalls({ workspaceId: owner, actor: ACTOR, now });
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
      redeemedBy: `user:${ACTOR.id}`,
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
    await expect(
      redeemEarningsAsCalls({ workspaceId: owner, actor: ACTOR, now }),
    ).rejects.toMatchObject({ code: 'nothing_redeemable' });

    /* The API says the same, as a client error rather than a server fault. */
    const { key } = await apiKeyFor(owner);
    const response = await creditPost(creditRequest(key));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('nothing_redeemable');
  });

  it('redeems through the API once the hold has passed', async () => {
    const owner = await workspace('credit-owner-api');
    const account = await publisherAccount(owner);
    await lockedPeriod('2022-03', new Date(Date.now() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    await statement({ periodId: '2022-03', publisherAccountId: account, amountMinor: 250 });

    /* A key without the management scope may read earnings but not spend them. */
    const readOnly = await apiKeyFor(owner, ['knowledge:search']);
    const refused = await creditPost(creditRequest(readOnly.key));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('access_denied');

    const { key, id: keyId } = await apiKeyFor(owner);
    const response = await creditPost(creditRequest(key));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { grantId: string; amountMinor: number; calls: number };
    expect(body).toMatchObject({ amountMinor: 250, calls: 2_500 });

    const [grant] = await db()
      .select({
        workspaceId: schema.addonGrant.workspaceId,
        calls: schema.addonGrant.callsGranted,
        redeemedBy: schema.addonGrant.redeemedBy,
      })
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.id, body.grantId));
    expect(grant).toEqual({ workspaceId: owner, calls: 2_500, redeemedBy: `api_key:${keyId}` });
  });

  /* A refund period's statement is below zero and reduces what the rest buys. */
  it('nets a negative statement against the positive ones', async () => {
    const now = new Date();
    const owner = await workspace('credit-owner-refund');
    const account = await publisherAccount(owner);
    await lockedPeriod('2022-05', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 2) * DAY));
    await lockedPeriod('2022-08', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    const income = await statement({ periodId: '2022-05', publisherAccountId: account, amountMinor: 1_000 });
    const refund = await statement({ periodId: '2022-08', publisherAccountId: account, amountMinor: -300 });

    const before = await earningCredit(account, now);
    expect(before).toMatchObject({ redeemableMinor: 700, redeemableStatements: 2, redeemableCalls: 7_000 });

    const redeemed = await redeemEarningsAsCalls({ workspaceId: owner, actor: ACTOR, now });
    expect(redeemed).toMatchObject({ amountMinor: 700, calls: 7_000, statements: 2 });

    const rows = await db()
      .select({ id: schema.settlement.id, status: schema.settlement.status })
      .from(schema.settlement)
      .where(inArray(schema.settlement.id, [income, refund]));
    expect(rows.every((row) => row.status === 'redeemed')).toBe(true);
  });

  it('shows as redeemable only what the redeem converts', async () => {
    const now = new Date();
    const owner = await workspace('credit-owner-currency');
    const account = await publisherAccount(owner);
    await lockedPeriod('2022-07', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    await statement({ periodId: '2022-07', publisherAccountId: account, amountMinor: 400 });
    const foreign = await statement({
      periodId: '2022-07',
      publisherAccountId: account,
      amountMinor: 900,
      currency: 'EUR',
    });

    const before = await earningCredit(account, now);
    expect(before).toMatchObject({ redeemableMinor: 400, redeemableStatements: 1, redeemableCalls: 4_000 });

    const redeemed = await redeemEarningsAsCalls({ workspaceId: owner, actor: ACTOR, now });
    expect(redeemed).toMatchObject({ amountMinor: before.redeemableMinor, calls: before.redeemableCalls });

    /* The foreign statement waits for a rail that can price it, and is not shown as convertible meanwhile. */
    const [row] = await db()
      .select({ status: schema.settlement.status })
      .from(schema.settlement)
      .where(eq(schema.settlement.id, foreign));
    expect(row?.status).toBe('accrued');
    expect((await earningCredit(account, now)).redeemableMinor).toBe(0);
  });

  it('gives two racing redeems one grant between them', async () => {
    const now = new Date();
    const owner = await workspace('credit-owner-race');
    const account = await publisherAccount(owner);
    await lockedPeriod('2022-06', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    await statement({ periodId: '2022-06', publisherAccountId: account, amountMinor: 1_000 });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => redeemEarningsAsCalls({ workspaceId: owner, actor: ACTOR, now })),
    );
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(3);
    for (const outcome of lost) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'nothing_redeemable' });
    }

    const grants = await db()
      .select({ calls: schema.addonGrant.callsGranted })
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.publisherAccountId, account));
    expect(grants).toEqual([{ calls: 10_000 }]);
  });

  it('refuses a workspace without a publisher account', async () => {
    const stranger = await workspace('credit-stranger');
    await expect(
      redeemEarningsAsCalls({ workspaceId: stranger, actor: ACTOR }),
    ).rejects.toBeInstanceOf(EarningCreditRefused);
    await expect(
      redeemEarningsAsCalls({ workspaceId: stranger, actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'no_account' });
  });

  it('leaves a zero statement accrued rather than minting an empty grant', async () => {
    const owner = await workspace('credit-owner-small');
    const account = await publisherAccount(owner);
    await lockedPeriod('2022-04', new Date(Date.now() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    const id = await statement({ periodId: '2022-04', publisherAccountId: account, amountMinor: 0 });

    await expect(
      redeemEarningsAsCalls({ workspaceId: owner, actor: ACTOR }),
    ).rejects.toMatchObject({ code: 'nothing_redeemable' });
    const [row] = await db()
      .select({ status: schema.settlement.status })
      .from(schema.settlement)
      .where(eq(schema.settlement.id, id));
    expect(row?.status).toBe('accrued');
  });
});
