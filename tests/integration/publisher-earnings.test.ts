/**
 * The creator's view of their earnings, against a real database.
 * agent-first-proposal.md 6.9: every figure is recomputed from the ledger (a
 * locked period shows the same sum closePeriod froze, an open one its running
 * sum), and the account exists only after the agreement is accepted.
 *
 * Fixture rows live in 2021 periods, isolated from every parallel suite.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { inArray } from 'drizzle-orm';

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

/** Amounts recorded for `owner` in a period, as the collection side will write them. */
async function earned(input: { period: string; at: Date; owner: string; amounts: number[] }): Promise<void> {
  await db().insert(schema.earningEvent).values(
    input.amounts.map((amountMinor) => ({
      id: uuidv7(),
      ownerWorkspaceId: input.owner,
      amountMinor,
      source: amountMinor < 0 ? 'refund' : 'channel_subscription',
      reference: `txn_${uuidv7()}`,
      periodId: input.period,
      createdAt: input.at,
    })),
  );
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

describeWithDb('creator earnings view', () => {
  afterAll(async () => {
    const database = db();
    if (workspaces.length > 0) {
      await database
        .delete(schema.earningEvent)
        .where(inArray(schema.earningEvent.ownerWorkspaceId, workspaces));
    }
    if (periods.length > 0) {
      await database.delete(schema.revenuePeriod).where(inArray(schema.revenuePeriod.id, periods));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.publisherAccount)
        .where(inArray(schema.publisherAccount.workspaceId, workspaces));
      await database.delete(schema.apiKey).where(inArray(schema.apiKey.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
  });

  it('sums locked and open periods alike, and gates the account on the agreement', async () => {
    periods.push('2021-03', '2021-04');
    const owner = await workspace('earnings-owner');
    const key = await apiKeyFor(owner);

    /* March: two collections and one refund. April: still open. */
    await earned({ period: '2021-03', at: new Date('2021-03-10T00:00:00Z'), owner, amounts: [800, 800, -300] });
    await earned({ period: '2021-04', at: new Date('2021-04-10T00:00:00Z'), owner, amounts: [400, 400, 400] });

    const closed = await closePeriod('2021-03');
    const expected = closed.allocations.find((a) => a.ownerWorkspaceId === owner)!;
    expect(expected.amountMinor).toBe(1_300);

    const response = await revenueGet(get(key));
    expect(response.status).toBe(200);
    const earnings = (await response.json()) as {
      account: unknown;
      accruedMinor: number;
      periods: { periodId: string; locked: boolean; amountMinor: number }[];
    };

    /* No account until the agreement is accepted -- but the ledger still shows. */
    expect(earnings.account).toBeNull();

    const march = earnings.periods.find((p) => p.periodId === '2021-03')!;
    expect(march.locked).toBe(true);
    /* The dashboard's sum lands on closePeriod's exactly. */
    expect(march.amountMinor).toBe(expected.amountMinor);

    const april = earnings.periods.find((p) => p.periodId === '2021-04')!;
    expect(april.locked).toBe(false);
    expect(april.amountMinor).toBe(1_200);

    /* Only locked periods count as settled. */
    expect(earnings.accruedMinor).toBe(1_300);

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
