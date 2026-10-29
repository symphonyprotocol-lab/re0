/**
 * Manual cash payouts, against a real database. agent-first-proposal.md 6.9:
 * a request holds every statement past its hold (at least the $20 threshold)
 * for one PayPal address, takes them out of reach of the credit path, allows
 * one open request per creator; an operator marks it paid with the PayPal
 * transaction id -- the only way a statement becomes `paid` -- or failed,
 * which returns the statements to `accrued`.
 *
 * Fixture rows live in 2018 periods, isolated from every parallel suite.
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

const { earningPayouts, publisherEarnings, redeemEarningsAsCalls, requestPayout } = await import(
  '@/lib/application/revenue'
);
const { consolePayouts, markPayoutFailed, markPayoutPaid, settlementSummary } = await import(
  '@/lib/application/administration'
);
const { PAYOUT_HOLD_DAYS } = await import('@/lib/domain');
const { hashApiKey } = await import('@/lib/application/auth/api-key');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { POST: payoutPost } = await import('@/app/api/v1/revenue/payout/route');
const { GET: revenueGet } = await import('@/app/api/v1/revenue/route');

const DAY = 24 * 60 * 60 * 1000;
const workspaces: string[] = [];
const periods: string[] = [];
const publisherAccounts: string[] = [];
const administratorId = uuidv7();
const ACTOR = { kind: 'user' as const, id: crypto.randomUUID() };
const OPERATOR = { administratorId, email: 'payout-ops@example.test' };

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

async function lockedPeriod(id: string, lockedAt: Date): Promise<void> {
  periods.push(id);
  await db().insert(schema.revenuePeriod).values({ id, currency: 'USD', totalAmountMinor: 0, lockedAt });
}

async function statement(input: {
  periodId: string;
  publisherAccountId: string;
  amountMinor: number;
}): Promise<string> {
  const id = uuidv7();
  await db().insert(schema.settlement).values({
    id,
    periodId: input.periodId,
    publisherAccountId: input.publisherAccountId,
    amountMinor: input.amountMinor,
    currency: 'USD',
    status: 'accrued',
  });
  return id;
}

async function statuses(ids: string[]) {
  const rows = await db()
    .select({
      id: schema.settlement.id,
      status: schema.settlement.status,
      payoutId: schema.settlement.payoutId,
    })
    .from(schema.settlement)
    .where(inArray(schema.settlement.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function apiKeyFor(workspaceId: string, scopes: string[]): Promise<{ key: string; id: string }> {
  const key = `mm_test_${crypto.randomUUID().replace(/-/g, '')}`;
  const id = uuidv7();
  await db().insert(schema.apiKey).values({
    id,
    workspaceId,
    name: 'payout key',
    keyHash: await hashApiKey(key),
    keyPrefix: 'mm_test_',
    lastFour: key.slice(-4),
    scopes,
    environment: 'test',
  });
  return { key, id };
}

function payoutRequest(key: string, body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v1/revenue/payout', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describeWithDb('manual payouts', () => {
  afterAll(async () => {
    const database = db();
    if (publisherAccounts.length > 0) {
      await database
        .delete(schema.settlement)
        .where(inArray(schema.settlement.publisherAccountId, publisherAccounts));
      await database
        .delete(schema.payout)
        .where(inArray(schema.payout.publisherAccountId, publisherAccounts));
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
    await database.delete(schema.auditLog).where(eq(schema.auditLog.administratorId, administratorId));
    await database.delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
  });

  it('holds what is past its hold, pays it with a transaction id, and only then marks it paid', async () => {
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: OPERATOR.email,
      username: 'payout-ops',
      passwordHash: 'unused',
      status: 'active',
    });

    const now = new Date();
    const owner = await workspace('payout-owner');
    const account = await publisherAccount(owner);
    await lockedPeriod('2018-01', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 20) * DAY));
    await lockedPeriod('2018-02', new Date(now.getTime() - 5 * DAY));

    const a = await statement({ periodId: '2018-01', publisherAccountId: account, amountMinor: 1_500 });
    const b = await statement({ periodId: '2018-01', publisherAccountId: account, amountMinor: 900 });
    /* Still inside the hold: stays out of the request. */
    const held = await statement({ periodId: '2018-02', publisherAccountId: account, amountMinor: 700 });

    await expect(
      requestPayout({ workspaceId: owner, actor: ACTOR, payeeEmail: 'not an email', now }),
    ).rejects.toMatchObject({ code: 'invalid_email' });

    const requested = await requestPayout({
      workspaceId: owner,
      actor: ACTOR,
      payeeEmail: '  Publisher@Example.TEST ',
      now,
    });
    expect(requested).toMatchObject({
      amountMinor: 2_400,
      currency: 'USD',
      payeeEmail: 'publisher@example.test',
      statements: 2,
    });

    const afterRequest = await statuses([a, b, held]);
    expect(afterRequest.get(a)).toMatchObject({ status: 'held', payoutId: requested.payoutId });
    expect(afterRequest.get(b)).toMatchObject({ status: 'held', payoutId: requested.payoutId });
    expect(afterRequest.get(held)).toMatchObject({ status: 'accrued', payoutId: null });

    /* Held statements are out of reach of the credit path and of a second request. */
    await expect(
      redeemEarningsAsCalls({ workspaceId: owner, actor: ACTOR, now }),
    ).rejects.toMatchObject({ code: 'nothing_redeemable' });
    await expect(
      requestPayout({ workspaceId: owner, actor: ACTOR, payeeEmail: 'publisher@example.test', now }),
    ).rejects.toMatchObject({ code: 'payout_pending' });

    const earnings = await publisherEarnings(owner);
    expect(earnings.credit.redeemableMinor).toBe(0);
    expect(earnings.payouts.open).toMatchObject({
      id: requested.payoutId,
      amountMinor: 2_400,
      status: 'requested',
      payeeEmail: 'publisher@example.test',
    });

    const queue = await consolePayouts();
    const queued = queue.open.find((row) => row.id === requested.payoutId);
    expect(queued).toMatchObject({
      statements: 2,
      periods: ['2018-01'],
      publisherWorkspaceId: owner,
    });

    /* Still owed while it waits: counted in the console's total, and broken out. */
    const summary = await settlementSummary();
    expect(summary.inPayoutMinor).toBeGreaterThanOrEqual(2_400);
    expect(summary.accruedMinor).toBeGreaterThanOrEqual(summary.inPayoutMinor);

    await expect(
      markPayoutPaid({ actor: OPERATOR, payoutId: requested.payoutId, reference: '  ', reason: 'sent' }),
    ).rejects.toMatchObject({ code: 'reference_required' });
    await expect(
      markPayoutPaid({ actor: OPERATOR, payoutId: requested.payoutId, reference: 'TX1', reason: ' ' }),
    ).rejects.toMatchObject({ code: 'reason_required' });

    const paid = await markPayoutPaid({
      actor: OPERATOR,
      payoutId: requested.payoutId,
      reference: '9XK12345AB678901C',
      reason: 'sent from the platform PayPal account',
    });
    expect(paid).toMatchObject({ status: 'paid', amountMinor: 2_400, statements: 2 });

    const afterPaid = await statuses([a, b]);
    expect(afterPaid.get(a)).toMatchObject({ status: 'paid', payoutId: requested.payoutId });
    expect(afterPaid.get(b)).toMatchObject({ status: 'paid', payoutId: requested.payoutId });

    const [row] = await db().select().from(schema.payout).where(eq(schema.payout.id, requested.payoutId));
    expect(row).toMatchObject({
      status: 'paid',
      method: 'paypal',
      providerReference: '9XK12345AB678901C',
      resolvedBy: administratorId,
      requestedBy: `user:${ACTOR.id}`,
    });
    expect(row?.resolvedAt).toBeInstanceOf(Date);

    const audit = await db()
      .select({ action: schema.auditLog.action, reason: schema.auditLog.reason })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, requested.payoutId));
    expect(audit).toEqual([{ action: 'payout.paid', reason: 'sent from the platform PayPal account' }]);

    /* Resolved once: a second press is refused rather than repeated. */
    await expect(
      markPayoutFailed({ actor: OPERATOR, payoutId: requested.payoutId, reason: 'late' }),
    ).rejects.toMatchObject({ code: 'payout_resolved' });

    const payouts = await earningPayouts(account);
    expect(payouts.open).toBeNull();
    expect(payouts.paidMinor).toBe(2_400);
    expect(payouts.lastPayeeEmail).toBe('publisher@example.test');
  });

  it('returns a failed payout to the creator, who may request again', async () => {
    const now = new Date();
    const owner = await workspace('payout-owner-failed');
    const account = await publisherAccount(owner);
    await lockedPeriod('2018-03', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    const a = await statement({ periodId: '2018-03', publisherAccountId: account, amountMinor: 2_000 });

    const first = await requestPayout({ workspaceId: owner, actor: ACTOR, payeeEmail: 'wrong@example.test', now });
    const failed = await markPayoutFailed({
      actor: OPERATOR,
      payoutId: first.payoutId,
      reason: 'no PayPal account at that email',
    });
    expect(failed).toMatchObject({ status: 'failed', statements: 1 });
    expect((await statuses([a])).get(a)).toMatchObject({ status: 'accrued', payoutId: null });

    const view = await earningPayouts(account);
    expect(view.open).toBeNull();
    expect(view.history[0]).toMatchObject({
      id: first.payoutId,
      status: 'failed',
      failureReason: 'no PayPal account at that email',
    });
    /* The address that failed is not offered again. */
    expect(view.lastPayeeEmail).toBeNull();

    const second = await requestPayout({ workspaceId: owner, actor: ACTOR, payeeEmail: 'right@example.test', now });
    expect(second).toMatchObject({ amountMinor: 2_000, statements: 1 });
    expect((await statuses([a])).get(a)).toMatchObject({ status: 'held', payoutId: second.payoutId });
  });

  it('refuses under the threshold and without a publisher account', async () => {
    const now = new Date();
    const owner = await workspace('payout-owner-small');
    const account = await publisherAccount(owner);
    await lockedPeriod('2018-04', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    const a = await statement({ periodId: '2018-04', publisherAccountId: account, amountMinor: 1_999 });

    await expect(
      requestPayout({ workspaceId: owner, actor: ACTOR, payeeEmail: 'small@example.test', now }),
    ).rejects.toMatchObject({ code: 'below_threshold' });
    expect((await statuses([a])).get(a)).toMatchObject({ status: 'accrued' });

    const stranger = await workspace('payout-stranger');
    await expect(
      requestPayout({ workspaceId: stranger, actor: ACTOR, payeeEmail: 'x@example.test', now }),
    ).rejects.toMatchObject({ code: 'no_account' });
  });

  /* A refund period's negative statement comes along and lowers the cash sent. */
  it('nets a negative statement into the request', async () => {
    const now = new Date();
    const owner = await workspace('payout-owner-refund');
    const account = await publisherAccount(owner);
    await lockedPeriod('2018-09', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 2) * DAY));
    await lockedPeriod('2018-10', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    const income = await statement({ periodId: '2018-09', publisherAccountId: account, amountMinor: 3_000 });
    const refund = await statement({ periodId: '2018-10', publisherAccountId: account, amountMinor: -500 });

    const requested = await requestPayout({ workspaceId: owner, actor: ACTOR, payeeEmail: 'net@example.test', now });
    expect(requested).toMatchObject({ amountMinor: 2_500, statements: 2 });
    const rows = await statuses([income, refund]);
    expect(rows.get(income)).toMatchObject({ status: 'held', payoutId: requested.payoutId });
    expect(rows.get(refund)).toMatchObject({ status: 'held', payoutId: requested.payoutId });
  });

  it('gives two racing requests one payout between them', async () => {
    const now = new Date();
    const owner = await workspace('payout-owner-race');
    const account = await publisherAccount(owner);
    await lockedPeriod('2018-05', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    await statement({ periodId: '2018-05', publisherAccountId: account, amountMinor: 5_000 });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        requestPayout({ workspaceId: owner, actor: ACTOR, payeeEmail: 'race@example.test', now }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes.filter((entry) => entry.status === 'rejected')) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'payout_pending' });
    }
    const rows = await db()
      .select({ amountMinor: schema.payout.amountMinor })
      .from(schema.payout)
      .where(eq(schema.payout.publisherAccountId, account));
    expect(rows).toEqual([{ amountMinor: 5_000 }]);
  });

  it('requests through the API with the management scope only', async () => {
    const owner = await workspace('payout-owner-api');
    const account = await publisherAccount(owner);
    await lockedPeriod('2018-06', new Date(Date.now() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    await statement({ periodId: '2018-06', publisherAccountId: account, amountMinor: 2_500 });

    const readOnly = await apiKeyFor(owner, ['knowledge:search']);
    const refused = await payoutPost(payoutRequest(readOnly.key, { paypalEmail: 'api@example.test' }));
    expect(refused.status).toBe(403);

    const { key, id: keyId } = await apiKeyFor(owner, ['retrieval', 'admin:keys']);
    const invalid = await payoutPost(payoutRequest(key, { paypalEmail: 'nope' }));
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { message: string } }).error.message).toContain('invalid_email');

    const response = await payoutPost(payoutRequest(key, { paypalEmail: 'api@example.test' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { payoutId: string; amountMinor: number };
    expect(body.amountMinor).toBe(2_500);

    const [row] = await db()
      .select({ requestedBy: schema.payout.requestedBy, payeeEmail: schema.payout.payeeEmail })
      .from(schema.payout)
      .where(eq(schema.payout.id, body.payoutId));
    expect(row).toEqual({ requestedBy: `api_key:${keyId}`, payeeEmail: 'api@example.test' });
  });

  it('shows the PayPal address only to keys that may request a payout', async () => {
    const now = new Date();
    const owner = await workspace('payout-owner-read');
    const account = await publisherAccount(owner);
    await lockedPeriod('2018-08', new Date(now.getTime() - (PAYOUT_HOLD_DAYS + 1) * DAY));
    await statement({ periodId: '2018-08', publisherAccountId: account, amountMinor: 2_000 });
    await requestPayout({ workspaceId: owner, actor: ACTOR, payeeEmail: 'private@example.test', now });

    const read = (key: string) =>
      revenueGet(
        new NextRequest('http://localhost/api/v1/revenue', {
          headers: { authorization: `Bearer ${key}` },
        }),
      );
    type Body = { payouts: { open: { payeeEmail: string | null; amountMinor: number }; lastPayeeEmail: string | null } };

    const readOnly = await apiKeyFor(owner, ['knowledge:search']);
    const hidden = (await (await read(readOnly.key)).json()) as Body;
    expect(hidden.payouts.open).toMatchObject({ payeeEmail: null, amountMinor: 2_000 });
    expect(hidden.payouts.lastPayeeEmail).toBeNull();

    const manager = await apiKeyFor(owner, ['retrieval', 'admin:keys']);
    const shown = (await (await read(manager.key)).json()) as Body;
    expect(shown.payouts.open.payeeEmail).toBe('private@example.test');
  });
});
