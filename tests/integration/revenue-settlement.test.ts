/**
 * Closing a revenue period, against a real database. publisher-revenue-share.md
 * 3.2/3.3/8: the pool prices each rate group at its frozen rate, allocation
 * is linear in attributable calls with sum <= pool, a second close returns
 * the locked numbers, and a suspended library's events -- and a related
 * caller's -- void at close, exactly once, and never for a period already
 * locked.
 *
 * All fixture rows live in 2019 and 2020 periods, which nothing else writes to, so
 * the aggregates here are exact regardless of what parallel suites meter.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { closePeriod, livePeriodPool, publisherEarnings } = await import(
  '@/lib/application/revenue'
);
const { libraryUsageLog } = await import('@/lib/application/libraries');
const { generateSettlements, listSettlements } = await import(
  '@/lib/application/administration/settlements'
);
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const libraries: string[] = [];
const planVersions: string[] = [];
const periods: string[] = [];
const publisherAccounts: string[] = [];
const users: string[] = [];
const administratorId = crypto.randomUUID();
const administratorEmail = `settle-admin-${Date.now()}@example.test`;

async function publisherAccount(workspaceId: string): Promise<string> {
  const id = uuidv7();
  publisherAccounts.push(id);
  await db().insert(schema.publisherAccount).values({
    id,
    workspaceId,
    taxStatus: 'complete',
    agreementVersion: 'v1',
  });
  return id;
}

/** One paid invoice inside the period, so the pool has something in it. */
async function revenue(at: Date, workspaceId: string, amountMinor: number): Promise<void> {
  await db().insert(schema.billingDocument).values({
    id: uuidv7(),
    workspaceId,
    provider: 'stripe',
    externalId: `inv_${uuidv7()}`,
    number: `INV-${uuidv7().slice(0, 8)}`,
    kind: 'subscription' as const,
    status: 'paid' as const,
    amountMinor,
    refundedMinor: 0,
    issuedAt: at,
    paidAt: at,
  });
}

async function workspace(name: string): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name });
  return id;
}

async function planVersion(shareRateBps: number): Promise<string> {
  const id = uuidv7();
  planVersions.push(id);
  await db().insert(schema.planVersion).values({
    id,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 100_000,
    libraryLimit: 10,
    librarySizeBytesLimit: 1_000_000,
    apiKeyLimit: 5,
    shareRateBps,
    capabilities: {},
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  return id;
}

async function library(slug: string, owner: string, lifecycle = 'published'): Promise<string> {
  const id = crypto.randomUUID();
  libraries.push(id);
  await db().insert(schema.library).values({
    id,
    publicId: `/websites/${slug}`,
    title: `Settlement fixture ${slug}`,
    ownerWorkspaceId: owner,
    isPlatformLibrary: false,
    visibility: 'public',
    lifecycleStatus: lifecycle as 'published',
    indexStatus: 'ready',
  });
  return id;
}

/** N billed calls in the period, of which `earning` also earned for `owner`. */
async function calls(input: {
  period: string;
  at: Date;
  reader: string;
  libraryId: string;
  owner: string;
  planVersionId: string;
  shareRateBps: number;
  billed: number;
  earning: number;
}): Promise<void> {
  const database = db();
  const ids = Array.from({ length: input.billed }, () => `req_settle_${uuidv7()}`);
  await database.insert(schema.usageEvent).values(
    ids.map((requestId) => ({
      id: uuidv7(),
      workspaceId: input.reader,
      requestId,
      libraryId: input.libraryId,
      operation: 'context',
      entrypoint: 'rest',
      debitSource: 'plan',
      statusCode: 200,
      createdAt: input.at,
    })),
  );
  if (input.earning === 0) return;
  await database.insert(schema.earningEvent).values(
    ids.slice(0, input.earning).map((requestId) => ({
      id: uuidv7(),
      requestId,
      libraryId: input.libraryId,
      ownerWorkspaceId: input.owner,
      planVersionId: input.planVersionId,
      shareRateBps: input.shareRateBps,
      periodId: input.period,
      createdAt: input.at,
    })),
  );
}

describeWithDb('revenue settlement', () => {
  afterAll(async () => {
    const database = db();
    if (libraries.length > 0) {
      await database.delete(schema.settlement).where(inArray(schema.settlement.libraryId, libraries));
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
    await database
      .delete(schema.auditLog)
      .where(eq(schema.auditLog.administratorId, administratorId));
    await database
      .delete(schema.administrator)
      .where(eq(schema.administrator.id, administratorId));
    if (publisherAccounts.length > 0) {
      await database
        .delete(schema.publisherAccount)
        .where(inArray(schema.publisherAccount.id, publisherAccounts));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.billingDocument)
        .where(inArray(schema.billingDocument.workspaceId, workspaces));
      await database
        .delete(schema.workspaceMember)
        .where(inArray(schema.workspaceMember.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (users.length > 0) {
      await database.delete(schema.user).where(inArray(schema.user.id, users));
    }
    if (planVersions.length > 0) {
      await database
        .delete(schema.planVersion)
        .where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('prices rate groups separately, allocates linearly, and locks', async () => {
    periods.push('2020-06');
    const at = new Date('2020-06-15T00:00:00Z');
    const reader = await workspace('settle-reader');
    const ownerA = await workspace('settle-owner-a');
    const ownerB = await workspace('settle-owner-b');
    const planPro = await planVersion(2_000);
    const planPlus = await planVersion(2_500);
    const libA = await library('settle-a', ownerA);
    const libB = await library('settle-b', ownerB);

    await calls({ period: '2020-06', at, reader, libraryId: libA, owner: ownerA, planVersionId: planPro, shareRateBps: 2_000, billed: 5, earning: 5 });
    await calls({ period: '2020-06', at, reader, libraryId: libB, owner: ownerB, planVersionId: planPlus, shareRateBps: 2_500, billed: 3, earning: 3 });
    /* Twelve billed calls that earned nothing dilute the attributable share. */
    await calls({ period: '2020-06', at, reader, libraryId: libA, owner: ownerA, planVersionId: planPro, shareRateBps: 2_000, billed: 12, earning: 0 });

    await db().insert(schema.billingDocument).values([
      {
        id: uuidv7(),
        workspaceId: reader,
        provider: 'stripe',
        externalId: `inv_${uuidv7()}`,
        number: 'INV-1',
        kind: 'subscription' as const,
        status: 'paid' as const,
        amountMinor: 10_000,
        refundedMinor: 0,
        issuedAt: at,
        paidAt: at,
      },
      {
        /* Fully refunded: contributes zero to net revenue. */
        id: uuidv7(),
        workspaceId: reader,
        provider: 'stripe',
        externalId: `inv_${uuidv7()}`,
        number: 'INV-2',
        kind: 'subscription' as const,
        status: 'refunded' as const,
        amountMinor: 5_000,
        refundedMinor: 5_000,
        issuedAt: at,
        paidAt: at,
      },
    ]);

    const closed = await closePeriod('2020-06');
    expect(closed.alreadyLocked).toBe(false);
    expect(closed.netRevenueMinor).toBe(10_000);
    expect(closed.totalBilledCalls).toBe(20);
    expect(closed.totalAttributableCalls).toBe(8);
    // 2000bps group: floor(10000 * 2000 * (5/20) / 10000) = 500
    // 2500bps group: floor(10000 * 2500 * (3/20) / 10000) = 375
    expect(closed.poolMinor).toBe(875);
    expect(closed.shareRateBps).toBe(2_187); // floor((2000*5 + 2500*3) / 8)

    const byOwner = new Map(closed.allocations.map((a) => [a.ownerWorkspaceId, a]));
    expect(byOwner.get(ownerA)).toMatchObject({ attributableCalls: 5, amountMinor: 546 });
    expect(byOwner.get(ownerB)).toMatchObject({ attributableCalls: 3, amountMinor: 328 });
    const total = closed.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    expect(total).toBeLessThanOrEqual(closed.poolMinor);

    /* A second close returns the frozen numbers, byte for byte. */
    const again = await closePeriod('2020-06');
    expect(again.alreadyLocked).toBe(true);
    expect(again.poolMinor).toBe(closed.poolMinor);
    expect(again.allocations).toEqual(closed.allocations);
  });

  it('splits earnings by library, and the live estimate matches the close', async () => {
    periods.push('2019-03', '2019-04');
    const reader = await workspace('settle-split-reader');
    const owner = await workspace('settle-split-owner');
    const plan = await planVersion(2_000);
    const first = await library('settle-split-1', owner);
    const second = await library('settle-split-2', owner);

    for (const [period, at] of [
      ['2019-03', new Date('2019-03-10T00:00:00Z')],
      ['2019-04', new Date('2019-04-10T00:00:00Z')],
    ] as const) {
      await calls({ period, at, reader, libraryId: first, owner, planVersionId: plan, shareRateBps: 2_000, billed: 3, earning: 3 });
      await calls({ period, at, reader, libraryId: second, owner, planVersionId: plan, shareRateBps: 2_000, billed: 2, earning: 2 });
      await revenue(at, reader, 10_000);
    }
    /* The owner's own call is served and logged, but earns nothing. */
    await calls({ period: '2019-04', at: new Date('2019-04-11T00:00:00Z'), reader: owner, libraryId: first, owner, planVersionId: plan, shareRateBps: 2_000, billed: 1, earning: 0 });

    await closePeriod('2019-03');
    const live = await livePeriodPool('2019-04');
    // floor(10000 * 2000 * (5/6) / 10000) = 1666
    expect(live).toMatchObject({ totalAttributableCalls: 5, totalBilledCalls: 6, poolMinor: 1_666 });

    const before = await publisherEarnings(owner, { periodId: '2019-04', pool: live });
    const byId = new Map(before.libraries.map((entry) => [entry.libraryId, entry]));
    // 2019-03 pool: floor(10000 * 2000 * 1 / 10000) = 2000, split 3:2
    expect(byId.get(first)).toMatchObject({ settledMinor: 1_200, settledCalls: 3 });
    expect(byId.get(second)).toMatchObject({ settledMinor: 800, settledCalls: 2 });
    const openFirst = byId.get(first)!.periods.find((period) => period.periodId === '2019-04');
    expect(openFirst).toMatchObject({ locked: false, amountMinor: null, estimateMinor: 999 });
    expect(before.libraries[0]!.libraryId).toBe(first);

    /* Closing with nothing new changes no figure: the estimate was the close. */
    await closePeriod('2019-04');
    const after = await publisherEarnings(owner);
    const closedFirst = after.libraries
      .find((entry) => entry.libraryId === first)!
      .periods.find((period) => period.periodId === '2019-04');
    expect(closedFirst).toMatchObject({ locked: true, amountMinor: 999, estimateMinor: null });

    const log = await libraryUsageLog({ workspaceId: owner, libraryId: first, page: 1 });
    expect(log.total).toBe(7);
    expect(log.entries[0]).toMatchObject({ caller: 'self', earning: 'none' });
    expect(log.entries.filter((entry) => entry.caller === 'reader' && entry.earning === 'earned')).toHaveLength(6);
  });

  it('voids a suspended library at close, and only then', async () => {
    periods.push('2020-07');
    const at = new Date('2020-07-15T00:00:00Z');
    const reader = await workspace('settle-reader-2');
    const ownerC = await workspace('settle-owner-c');
    const ownerD = await workspace('settle-owner-d');
    const plan = await planVersion(2_000);
    const suspended = await library('settle-suspended', ownerC, 'suspended');
    const healthy = await library('settle-healthy', ownerD);

    await calls({ period: '2020-07', at, reader, libraryId: suspended, owner: ownerC, planVersionId: plan, shareRateBps: 2_000, billed: 4, earning: 4 });
    await calls({ period: '2020-07', at, reader, libraryId: healthy, owner: ownerD, planVersionId: plan, shareRateBps: 2_000, billed: 4, earning: 4 });
    await db().insert(schema.billingDocument).values({
      id: uuidv7(),
      workspaceId: reader,
      provider: 'stripe',
      externalId: `inv_${uuidv7()}`,
      number: 'INV-3',
      kind: 'subscription' as const,
      status: 'paid' as const,
      amountMinor: 8_000,
      refundedMinor: 0,
      issuedAt: at,
      paidAt: at,
    });

    const closed = await closePeriod('2020-07');
    expect(closed.totalAttributableCalls).toBe(4);
    expect(closed.allocations.map((a) => a.ownerWorkspaceId)).toEqual([ownerD]);

    const voided = await db()
      .select()
      .from(schema.earningEvent)
      .where(
        and(eq(schema.earningEvent.libraryId, suspended), eq(schema.earningEvent.flagged, true)),
      );
    expect(voided).toHaveLength(4);
  });

  /**
   * Share doc 5, re-judged at close: the call-time gate saw no link, but by
   * lock time one person runs both the reader's workspace and the owner's.
   * The reader's events void; an unrelated reader's stand.
   */
  it('voids calls from a workspace related to the owner by close', async () => {
    periods.push('2020-08');
    const at = new Date('2020-08-15T00:00:00Z');
    const related = await workspace('settle-related-reader');
    const stranger = await workspace('settle-stranger-reader');
    const owner = await workspace('settle-related-owner');
    const plan = await planVersion(2_000);
    const libraryId = await library('settle-related', owner);

    await calls({ period: '2020-08', at, reader: related, libraryId, owner, planVersionId: plan, shareRateBps: 2_000, billed: 3, earning: 3 });
    await calls({ period: '2020-08', at, reader: stranger, libraryId, owner, planVersionId: plan, shareRateBps: 2_000, billed: 2, earning: 2 });
    await revenue(at, stranger, 5_000);

    const userId = crypto.randomUUID();
    users.push(userId);
    await db().insert(schema.user).values({ id: userId, email: `settle-${userId}@example.test` });
    await db().insert(schema.workspaceMember).values([
      { workspaceId: owner, userId, role: 'owner' as const },
      { workspaceId: related, userId, role: 'admin' as const },
    ]);

    const closed = await closePeriod('2020-08');
    expect(closed.totalAttributableCalls).toBe(2);
    expect(closed.allocations).toEqual([
      expect.objectContaining({ ownerWorkspaceId: owner, attributableCalls: 2 }),
    ]);

    const voided = await db()
      .select()
      .from(schema.earningEvent)
      .where(
        and(eq(schema.earningEvent.libraryId, libraryId), eq(schema.earningEvent.flagged, true)),
      );
    expect(voided).toHaveLength(3);
  });

  it('materialises statements, defers accountless owners, and audits the run', async () => {
    periods.push('2021-01');
    const at = new Date('2021-01-15T00:00:00Z');
    const reader = await workspace('gen-reader');
    const ownerA = await workspace('gen-owner-a');
    const ownerB = await workspace('gen-owner-b');
    const plan = await planVersion(2_000);
    const libA1 = await library('gen-a1', ownerA);
    const libA2 = await library('gen-a2', ownerA);
    const libB1 = await library('gen-b1', ownerB);
    /* Only owner A signed the agreement; B's events wait for next time. */
    await publisherAccount(ownerA);
    await db().insert(schema.administrator).values({
      id: administratorId,
      username: 'Settlement Operator',
      email: administratorEmail,
      status: 'active',
    });

    const call = (libraryId: string, owner: string, n: number) =>
      calls({ period: '2021-01', at, reader, libraryId, owner, planVersionId: plan, shareRateBps: 2_000, billed: n, earning: n });
    await call(libA1, ownerA, 6);
    await call(libA2, ownerA, 4);
    await call(libB1, ownerB, 10);
    await revenue(at, reader, 10_000);

    const result = await generateSettlements({
      actor: { administratorId, email: administratorEmail },
      periodId: '2021-01',
      reason: 'monthly statements for 2021-01',
    });

    // 20 billed, 20 attributable, 2000bps of 10000 = a pool of 2000.
    expect(result.poolMinor).toBe(2_000);
    expect(result.totalAttributableCalls).toBe(20);
    expect(result.alreadyLocked).toBe(false);
    expect(result.created).toBe(2);
    expect(result.withoutAccount).toBe(1);
    expect(result.createdMinor).toBe(1_000);

    const rows = await db()
      .select()
      .from(schema.settlement)
      .where(eq(schema.settlement.periodId, '2021-01'));
    expect(rows).toHaveLength(2);
    const byLibrary = new Map(rows.map((row) => [row.libraryId, row]));
    expect(byLibrary.get(libA1)).toMatchObject({ attributableCalls: 6, amountMinor: 600, status: 'accrued' });
    expect(byLibrary.get(libA2)).toMatchObject({ attributableCalls: 4, amountMinor: 400, status: 'accrued' });
    expect(byLibrary.has(libB1)).toBe(false);
    /* Every statement commits to what it asserts, so it cannot be rewritten. */
    for (const row of rows) expect(row.statementDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);

    /* The one console action that puts a number against a publisher's name
       leaves an entry naming who did it, why, and what changed. */
    const [entry] = await db()
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'settlement.generate'),
          eq(schema.auditLog.targetId, '2021-01'),
        ),
      );
    expect(entry?.administratorId).toBe(administratorId);
    expect(entry?.targetType).toBe('revenue_period');
    expect(entry?.reason).toBe('monthly statements for 2021-01');
    expect(entry?.result).toBe('success');
    expect(entry?.beforeValue).toMatchObject({ locked: false, statements: 0 });
    expect(entry?.afterValue).toMatchObject({
      locked: true,
      statements: 2,
      created: 2,
      createdMinor: 1_000,
      withoutAccount: 1,
      poolMinor: 2_000,
    });

    /* Idempotent: a second press writes nothing and changes no amount. */
    const again = await generateSettlements({
      actor: { administratorId, email: administratorEmail },
      periodId: '2021-01',
      reason: 'pressed twice by mistake',
    });
    expect(again.alreadyLocked).toBe(true);
    expect(again.created).toBe(0);
    expect(again.createdMinor).toBe(0);
    expect(again.alreadyPresent).toBe(2);
    const after = await db()
      .select()
      .from(schema.settlement)
      .where(eq(schema.settlement.periodId, '2021-01'));
    expect(after).toHaveLength(2);
    expect(new Map(after.map((row) => [row.id, row]))).toEqual(
      new Map(rows.map((row) => [row.id, row])),
    );

    /* And once B accepts, only their rows appear -- nothing is lost. */
    await publisherAccount(ownerB);
    const third = await generateSettlements({
      actor: { administratorId, email: administratorEmail },
      periodId: '2021-01',
      reason: 'owner b accepted the agreement',
    });
    expect(third.created).toBe(1);
    expect(third.withoutAccount).toBe(0);
    expect(third.createdMinor).toBe(1_000);
  });

  it('leaves a period that has not ended alone', async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await expect(
      generateSettlements({
        actor: { administratorId, email: administratorEmail },
        periodId: current,
        reason: 'too early',
      }),
    ).rejects.toMatchObject({ code: 'period_invalid' });

    /* Nothing was locked and nothing was written on the way to the refusal. */
    const rows = await db()
      .select()
      .from(schema.revenuePeriod)
      .where(eq(schema.revenuePeriod.id, current));
    expect(rows).toHaveLength(0);
  });

  it('pages the ledger without repeating or dropping a statement', async () => {
    periods.push('2021-02');
    const at = new Date('2021-02-10T00:00:00Z');
    const reader = await workspace('page-reader');
    const owner = await workspace('page-owner');
    const plan = await planVersion(2_000);
    await publisherAccount(owner);

    /* More than one page, in ONE period: `generateSettlements` inserts the
       run in a single statement, so every row shares a `created_at`. */
    const count = 55;
    for (let index = 0; index < count; index += 1) {
      const libraryId = await library(`page-${index}`, owner);
      await calls({ period: '2021-02', at, reader, libraryId, owner, planVersionId: plan, shareRateBps: 2_000, billed: 2, earning: 2 });
    }
    await revenue(at, reader, 50_000);

    const generated = await generateSettlements({
      actor: { administratorId, email: administratorEmail },
      periodId: '2021-02',
      reason: 'statements for 2021-02',
    });
    expect(generated.created).toBe(count);

    const created = await db()
      .select({ createdAt: schema.settlement.createdAt })
      .from(schema.settlement)
      .where(eq(schema.settlement.periodId, '2021-02'));
    expect(new Set(created.map((row) => row.createdAt.getTime())).size).toBe(1);

    const first = await listSettlements({ period: '2021-02', limit: 50, offset: 0 });
    const second = await listSettlements({ period: '2021-02', limit: 50, offset: 50 });
    expect(first.total).toBe(count);
    expect(first.rows).toHaveLength(50);
    expect(second.rows).toHaveLength(count - 50);

    const ids = [...first.rows, ...second.rows].map((row) => row.id);
    expect(new Set(ids).size).toBe(count);
    /* The tiebreaker in the flesh: one total order across the page boundary. */
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
    const all = await db()
      .select({ id: schema.settlement.id })
      .from(schema.settlement)
      .where(eq(schema.settlement.periodId, '2021-02'));
    expect(new Set(ids)).toEqual(new Set(all.map((row) => row.id)));
  });

  it('refuses an unfinished or malformed period', async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await expect(closePeriod(current)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(closePeriod('not-a-period')).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
