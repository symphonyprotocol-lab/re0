/**
 * The day / month trends behind the revenue, settlements and billing charts,
 * and the billing list's kind and date filters, against a real database.
 *
 * Fixture rows live in 2016-2017, isolated from every parallel suite: the
 * trends are platform-wide, so each read is pinned to a `now` in 2017, and the
 * list-filter rows sit in 2016, outside every trend window.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { billingRevenueTrend, dayParam, listBillingDocuments } = await import(
  '@/lib/application/billing'
);
const { publisherDailyEarnings } = await import('@/lib/application/revenue');
const { recentPeriodIds } = await import('@/lib/domain');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];

async function workspace(name: string): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name });
  return id;
}

async function document(input: {
  workspaceId: string;
  kind: 'subscription' | 'pack';
  status?: 'paid' | 'refunded' | 'open';
  amountMinor: number;
  refundedMinor?: number;
  currency?: string;
  issuedAt: string;
  paidAt: string | null;
}) {
  const id = uuidv7();
  await db().insert(schema.billingDocument).values({
    id,
    workspaceId: input.workspaceId,
    provider: 'test',
    externalId: `trend-${id}`,
    number: `trend-${id.slice(-6)}`,
    kind: input.kind,
    status: input.status ?? 'paid',
    amountMinor: input.amountMinor,
    refundedMinor: input.refundedMinor ?? 0,
    currency: input.currency ?? 'USD',
    issuedAt: new Date(input.issuedAt),
    paidAt: input.paidAt ? new Date(input.paidAt) : null,
  });
  return id;
}

describe('trend helpers', () => {
  it('lists the periods ending with the current one, across a year boundary', () => {
    expect(recentPeriodIds(new Date('2017-02-10T00:00:00Z'), 4)).toEqual([
      '2016-11',
      '2016-12',
      '2017-01',
      '2017-02',
    ]);
  });

  it('accepts only real days as a date filter', () => {
    expect(dayParam('2017-02-28')).toBe('2017-02-28');
    expect(dayParam('2017-02-30')).toBeUndefined();
    expect(dayParam('2017-2-3')).toBeUndefined();
    expect(dayParam(['2017-02-28'])).toBeUndefined();
  });
});

describeWithDb('revenue trends', () => {
  afterAll(async () => {
    const database = db();
    if (workspaces.length > 0) {
      await database
        .delete(schema.earningEvent)
        .where(inArray(schema.earningEvent.ownerWorkspaceId, workspaces));
      await database
        .delete(schema.billingDocument)
        .where(inArray(schema.billingDocument.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
  });

  it('filters the billing list by kind and by issue day, inclusive', async () => {
    const owner = await workspace('trend-billing-list');
    const sub = await document({ workspaceId: owner, kind: 'subscription', amountMinor: 1_000, issuedAt: '2016-06-10T09:00:00Z', paidAt: '2016-06-10T09:00:00Z' });
    const pack = await document({ workspaceId: owner, kind: 'pack', amountMinor: 1_000, issuedAt: '2016-06-20T23:59:00Z', paidAt: '2016-06-21T00:30:00Z' });

    const packs = await listBillingDocuments({ workspaceId: owner, kind: 'pack' });
    expect(packs.rows.map((row) => row.id)).toEqual([pack]);

    /* `to` covers its whole day; `from` starts at its first instant. */
    const june20 = await listBillingDocuments({ workspaceId: owner, from: '2016-06-20', to: '2016-06-20' });
    expect(june20.rows.map((row) => row.id)).toEqual([pack]);
    const early = await listBillingDocuments({ workspaceId: owner, to: '2016-06-19' });
    expect(early.rows.map((row) => row.id)).toEqual([sub]);
    expect((await listBillingDocuments({ workspaceId: owner, kind: 'all' })).total).toBe(2);
  });

  it('plots collected revenue net of refunds, by payment day and month', async () => {
    const owner = await workspace('trend-billing-chart');
    await document({ workspaceId: owner, kind: 'subscription', amountMinor: 1_000, issuedAt: '2017-03-01T08:00:00Z', paidAt: '2017-03-01T08:00:00Z' });
    await document({ workspaceId: owner, kind: 'pack', status: 'refunded', amountMinor: 1_000, refundedMinor: 400, issuedAt: '2017-02-28T20:00:00Z', paidAt: '2017-03-02T01:00:00Z' });
    await document({ workspaceId: owner, kind: 'subscription', amountMinor: 1_000, issuedAt: '2017-01-05T08:00:00Z', paidAt: '2017-01-05T08:00:00Z' });
    /* Not money in: still open, and another currency. */
    await document({ workspaceId: owner, kind: 'pack', status: 'open', amountMinor: 5_000, issuedAt: '2017-03-02T08:00:00Z', paidAt: null });
    await document({ workspaceId: owner, kind: 'pack', amountMinor: 7_000, currency: 'EUR', issuedAt: '2017-03-02T08:00:00Z', paidAt: '2017-03-02T08:00:00Z' });

    const now = new Date('2017-03-02T12:00:00Z');
    const all = await billingRevenueTrend({ days: 3, months: 3, now });
    expect(all.daily).toEqual([
      { bucket: '2017-02-28', netMinor: 0, documents: 0 },
      { bucket: '2017-03-01', netMinor: 1_000, documents: 1 },
      { bucket: '2017-03-02', netMinor: 600, documents: 1 },
    ]);
    expect(all.monthly).toEqual([
      { bucket: '2017-01', netMinor: 1_000, documents: 1 },
      { bucket: '2017-02', netMinor: 0, documents: 0 },
      { bucket: '2017-03', netMinor: 1_600, documents: 2 },
    ]);

    const packs = await billingRevenueTrend({ days: 3, months: 3, kind: 'pack', now });
    expect(packs.monthly.map((point) => point.netMinor)).toEqual([0, 0, 600]);
  });

  it('sums each day’s recorded amounts, flagged rows left out', async () => {
    const owner = await workspace('trend-earnings');
    const event = (createdAt: string, periodId: string, amountMinor: number, flagged = false) => ({
      id: uuidv7(),
      ownerWorkspaceId: owner,
      amountMinor,
      source: amountMinor < 0 ? 'refund' : 'channel_subscription',
      periodId,
      flagged,
      createdAt: new Date(createdAt),
    });
    await db().insert(schema.earningEvent).values([
      event('2017-02-27T10:00:00Z', '2017-02', 10),
      event('2017-02-27T11:00:00Z', '2017-02', 10),
      event('2017-02-27T12:00:00Z', '2017-02', 10),
      /* Flagged: counted nowhere, on any day. */
      event('2017-02-27T13:00:00Z', '2017-02', 500, true),
      event('2017-03-01T09:00:00Z', '2017-03', 80),
      event('2017-03-01T10:00:00Z', '2017-03', -20),
    ]);

    const now = new Date('2017-03-01T12:00:00Z');
    const days = await publisherDailyEarnings(owner, 3, now);
    expect(days).toEqual([
      { date: '2017-02-27', events: 3, amountMinor: 30 },
      { date: '2017-02-28', events: 0, amountMinor: 0 },
      { date: '2017-03-01', events: 2, amountMinor: 60 },
    ]);

    /* The platform-wide series includes this owner's day. */
    const platform = await publisherDailyEarnings(null, 1, now);
    expect(platform[0]?.date).toBe('2017-03-01');
    expect(platform[0]!.amountMinor).toBeGreaterThanOrEqual(60);
  });
});
