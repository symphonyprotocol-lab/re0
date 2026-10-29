/**
 * Closing a revenue period, against a real database. agent-first-proposal.md
 * 6.9: a close sums each owner's unflagged events, a second close returns the
 * locked numbers, flagged events stay out, and the console turns the sums
 * into one statement per publisher account, idempotently and audited.
 *
 * All fixture rows live in 2019-2021 periods, which nothing else writes to, so
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

const { closePeriod, publisherEarnings } = await import('@/lib/application/revenue');
const { generateSettlements, listSettlements, settlementPeriods } = await import(
  '@/lib/application/administration/settlements'
);
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const periods: string[] = [];
const publisherAccounts: string[] = [];
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

async function workspace(name: string): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name });
  return id;
}

/** Amounts recorded for `owner` in a period; a negative one is a refund. */
async function earned(input: {
  period: string;
  at: Date;
  owner: string;
  amounts: number[];
  flagged?: boolean;
}): Promise<void> {
  await db().insert(schema.earningEvent).values(
    input.amounts.map((amountMinor) => ({
      id: uuidv7(),
      ownerWorkspaceId: input.owner,
      amountMinor,
      source: amountMinor < 0 ? 'refund' : 'channel_subscription',
      reference: `txn_${uuidv7()}`,
      periodId: input.period,
      flagged: input.flagged ?? false,
      createdAt: input.at,
    })),
  );
}

describeWithDb('revenue settlement', () => {
  afterAll(async () => {
    const database = db();
    if (publisherAccounts.length > 0) {
      await database
        .delete(schema.settlement)
        .where(inArray(schema.settlement.publisherAccountId, publisherAccounts));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.earningEvent)
        .where(inArray(schema.earningEvent.ownerWorkspaceId, workspaces));
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
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
  });

  it('sums each owner, leaves flagged events out, and locks', async () => {
    periods.push('2020-06');
    const at = new Date('2020-06-15T00:00:00Z');
    const ownerA = await workspace('settle-owner-a');
    const ownerB = await workspace('settle-owner-b');
    const ownerC = await workspace('settle-owner-c');

    await earned({ period: '2020-06', at, owner: ownerA, amounts: [800, 800, -300] });
    await earned({ period: '2020-06', at, owner: ownerB, amounts: [1_600] });
    /* A ledger correction: flagged rows are kept but never summed. */
    await earned({ period: '2020-06', at, owner: ownerB, amounts: [5_000], flagged: true });
    /* Income and its full refund net to nothing: no allocation at all. */
    await earned({ period: '2020-06', at, owner: ownerC, amounts: [400, -400] });

    const closed = await closePeriod('2020-06');
    expect(closed.alreadyLocked).toBe(false);
    expect(closed.currency).toBe('USD');
    expect(closed.totalAmountMinor).toBe(2_900);
    expect(closed.allocations).toEqual([
      { ownerWorkspaceId: ownerA, amountMinor: 1_300 },
      { ownerWorkspaceId: ownerB, amountMinor: 1_600 },
    ].sort((a, b) => (a.ownerWorkspaceId < b.ownerWorkspaceId ? -1 : 1)));

    const [period] = await db()
      .select()
      .from(schema.revenuePeriod)
      .where(eq(schema.revenuePeriod.id, '2020-06'));
    expect(Number(period?.totalAmountMinor)).toBe(2_900);
    expect(period?.lockedAt).toBeInstanceOf(Date);

    /* A second close returns the frozen numbers, byte for byte -- even after
       a late event lands in the period. */
    await earned({ period: '2020-06', at, owner: ownerA, amounts: [9_999] });
    const again = await closePeriod('2020-06');
    expect(again.alreadyLocked).toBe(true);
    expect(again.totalAmountMinor).toBe(closed.totalAmountMinor);
  });

  it('shows the creator the same sums, running while the period is open', async () => {
    periods.push('2019-03', '2019-04');
    const owner = await workspace('settle-view-owner');
    await earned({ period: '2019-03', at: new Date('2019-03-10T00:00:00Z'), owner, amounts: [1_200, 800] });
    await earned({ period: '2019-04', at: new Date('2019-04-10T00:00:00Z'), owner, amounts: [500, -100] });

    await closePeriod('2019-03');
    const before = await publisherEarnings(owner);
    const byPeriod = new Map(before.periods.map((period) => [period.periodId, period]));
    expect(byPeriod.get('2019-03')).toMatchObject({ locked: true, amountMinor: 2_000 });
    expect(byPeriod.get('2019-04')).toMatchObject({ locked: false, amountMinor: 400 });
    expect(before.accruedMinor).toBe(2_000);

    /* Closing changes no figure: the running sum was the close. */
    await closePeriod('2019-04');
    const after = await publisherEarnings(owner);
    expect(after.periods.find((period) => period.periodId === '2019-04')).toMatchObject({
      locked: true,
      amountMinor: 400,
    });
    expect(after.accruedMinor).toBe(2_400);

    const views = await settlementPeriods(new Date('2019-05-01T00:00:00Z'));
    expect(views.find((view) => view.id === '2019-04')).toMatchObject({
      locked: true,
      totalAmountMinor: 400,
      events: 2,
      eventsMinor: 400,
      statements: 0,
    });
  });

  it('materialises one statement per publisher, defers accountless owners, and audits the run', async () => {
    periods.push('2021-01');
    const at = new Date('2021-01-15T00:00:00Z');
    const ownerA = await workspace('gen-owner-a');
    const ownerB = await workspace('gen-owner-b');
    /* Only owner A signed the agreement; B's events wait for next time. */
    const accountA = await publisherAccount(ownerA);
    await db().insert(schema.administrator).values({
      id: administratorId,
      username: 'Settlement Operator',
      email: administratorEmail,
      status: 'active',
    });

    await earned({ period: '2021-01', at, owner: ownerA, amounts: [600, 400] });
    await earned({ period: '2021-01', at, owner: ownerB, amounts: [1_000] });

    const result = await generateSettlements({
      actor: { administratorId, email: administratorEmail },
      periodId: '2021-01',
      reason: 'monthly statements for 2021-01',
    });

    expect(result.totalAmountMinor).toBe(2_000);
    expect(result.alreadyLocked).toBe(false);
    expect(result.created).toBe(1);
    expect(result.withoutAccount).toBe(1);
    expect(result.createdMinor).toBe(1_000);

    const rows = await db()
      .select()
      .from(schema.settlement)
      .where(eq(schema.settlement.periodId, '2021-01'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ publisherAccountId: accountA, amountMinor: 1_000, currency: 'USD', status: 'accrued' });
    /* Every statement commits to what it asserts, so it cannot be rewritten. */
    expect(rows[0]?.statementDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);

    /* The one console action that puts a number against a creator's name
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
      statements: 1,
      created: 1,
      createdMinor: 1_000,
      withoutAccount: 1,
      totalAmountMinor: 2_000,
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
    expect(again.alreadyPresent).toBe(1);
    expect(again.withoutAccount).toBe(1);
    const after = await db()
      .select()
      .from(schema.settlement)
      .where(eq(schema.settlement.periodId, '2021-01'));
    expect(after).toEqual(rows);

    /* And once B accepts, only their row appears -- nothing is lost. */
    const accountB = await publisherAccount(ownerB);
    const third = await generateSettlements({
      actor: { administratorId, email: administratorEmail },
      periodId: '2021-01',
      reason: 'owner b accepted the agreement',
    });
    expect(third.created).toBe(1);
    expect(third.withoutAccount).toBe(0);
    expect(third.alreadyPresent).toBe(1);
    expect(third.createdMinor).toBe(1_000);
    const bRows = await db()
      .select({ amountMinor: schema.settlement.amountMinor })
      .from(schema.settlement)
      .where(and(eq(schema.settlement.periodId, '2021-01'), eq(schema.settlement.publisherAccountId, accountB)));
    expect(bRows).toEqual([{ amountMinor: 1_000 }]);
  });

  it('writes a negative statement for a period of refunds', async () => {
    periods.push('2021-03');
    const at = new Date('2021-03-15T00:00:00Z');
    const owner = await workspace('gen-owner-refund');
    const account = await publisherAccount(owner);
    await earned({ period: '2021-03', at, owner, amounts: [-700, 200] });

    const result = await generateSettlements({
      actor: { administratorId, email: administratorEmail },
      periodId: '2021-03',
      reason: 'statements for 2021-03',
    });
    expect(result).toMatchObject({ totalAmountMinor: -500, created: 1, createdMinor: -500 });
    const [row] = await db()
      .select({ amountMinor: schema.settlement.amountMinor, status: schema.settlement.status })
      .from(schema.settlement)
      .where(and(eq(schema.settlement.periodId, '2021-03'), eq(schema.settlement.publisherAccountId, account)));
    expect(row).toEqual({ amountMinor: -500, status: 'accrued' });
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

    /* More than one page, in ONE period: `generateSettlements` inserts the
       run in a single statement, so every row shares a `created_at`. */
    const count = 55;
    for (let index = 0; index < count; index += 1) {
      const owner = await workspace(`page-owner-${index}`);
      await publisherAccount(owner);
      await earned({ period: '2021-02', at, owner, amounts: [100 + index] });
    }

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

    /* The search finds a publisher by workspace name, nothing else needed. */
    const found = await listSettlements({ period: '2021-02', query: 'page-owner-7' });
    expect(found.rows.map((row) => row.publisherName).sort()).toEqual(['page-owner-7']);
  });

  it('refuses an unfinished or malformed period', async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await expect(closePeriod(current)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(closePeriod('not-a-period')).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
