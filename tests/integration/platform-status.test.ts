/**
 * The public status page against a real database. requirement.md 13.3: the
 * platform's own tables are the monitor, so every figure the page prints must
 * come back out of the rows the product wrote -- the API log, the operation
 * log and the review queue -- and nothing else.
 *
 * The database may hold other rows, so today's figures are asserted as a
 * difference between a reading taken before the fixture and one taken after,
 * and the historical days are dated far enough back that only this file
 * writes them.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { platformStatus } = await import('@/lib/application/status');
const { dayKey, shareBps, STATUS_WINDOW_DAYS } = await import('@/lib/domain/status');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const DAY_MS = 24 * 60 * 60 * 1000;

const stamp = Date.now();
/* Mid-morning UTC, so "three days ago" is unambiguously three days ago. */
const now = new Date(
  Date.UTC(
    new Date(stamp).getUTCFullYear(),
    new Date(stamp).getUTCMonth(),
    new Date(stamp).getUTCDate(),
    12,
  ),
);
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

const workspaceId = crypto.randomUUID();
const assetIds: string[] = [];
const versionIds: string[] = [];
const requestLogIds: string[] = [];
const operationIds: string[] = [];

type Status = Awaited<ReturnType<typeof platformStatus>>;
let before: Status;
let withPlatformOnly: Status;
let after: Status;

async function asset(input: {
  lifecycleStatus: 'submitted' | 'published';
  isPlatformAsset: boolean;
  versionAt?: Date;
}): Promise<string> {
  const database = db();
  const id = crypto.randomUUID();
  assetIds.push(id);
  await database.insert(schema.asset).values({
    id,
    publicId: `/status-${stamp}/${assetIds.length}`,
    title: `Status fixture ${assetIds.length}`,
    ownerWorkspaceId: input.isPlatformAsset ? null : workspaceId,
    isPlatformAsset: input.isPlatformAsset,
    kind: 'website',
    lifecycleStatus: input.lifecycleStatus,
    indexStatus: 'ready',
    createdAt: daysAgo(30),
  });
  if (input.versionAt) {
    const versionId = uuidv7();
    versionIds.push(versionId);
    await database.insert(schema.assetVersion).values({
      id: versionId,
      assetId: id,
      label: '20200101-aaaaaaaa',
      sourceDigest: `status-${stamp}-${assetIds.length}`,
      parserVersion: 'test',
      chunkerVersion: 'test',
      embeddingModel: 'test',
      indexStatus: 'ready',
      createdAt: input.versionAt,
    });
  }
  return id;
}

/** `requests` served that day, `failures` of them 5xx, each `latencyMs` long. */
async function apiDay(at: Date, requests: number, failures: number, latencyMs = 40) {
  const rows = Array.from({ length: requests }, (_, index) => {
    const id = crypto.randomUUID();
    requestLogIds.push(id);
    return {
      id,
      workspaceId: null,
      requestId: `req_status_${stamp}_${id}`,
      operation: 'context',
      statusCode: index < failures ? 500 : 200,
      latencyMs,
      createdAt: at,
    };
  });
  await db().insert(schema.requestLog).values(rows);
}

/** `finished` fetch operations that day, `failed` of them failed. */
async function operationDay(assetId: string, at: Date, finished: number, failed: number) {
  const rows = Array.from({ length: finished }, (_, index) => {
    const id = crypto.randomUUID();
    operationIds.push(id);
    return {
      id,
      assetId,
      operationType: 'refresh',
      sourceDigest: `status-op-${stamp}-${id}`,
      status: index < failed ? 'failed' : 'succeeded',
      createdAt: at,
      updatedAt: at,
    };
  });
  await db().insert(schema.workflowOperation).values(rows);
}

function component(status: Status, id: string) {
  return status.components.find((entry) => entry.id === id)!;
}

function stripDay(status: Status, id: string, day: string) {
  const entry = component(status, id).strip.find((row) => row.day === day);
  if (!entry) throw new Error(`${day} is not on the ${id} strip`);
  return entry.health;
}

describeWithDb('the public status page', () => {
  beforeAll(async () => {
    const database = db();
    before = await platformStatus(now);
    await database.insert(schema.workspace).values({ id: workspaceId, name: 'status-test' });

    /*
     * A platform asset stuck in review. It is not work a reviewer can pick
     * up, so the public page must not report a queue the console says is
     * empty -- that divergence is the point of this fixture.
     */
    await asset({
      lifecycleStatus: 'submitted',
      isPlatformAsset: true,
      versionAt: daysAgo(9),
    });
    withPlatformOnly = await platformStatus(now);

    /* One user submission waiting nine days (overdue) and one an hour. */
    await asset({ lifecycleStatus: 'submitted', isPlatformAsset: false, versionAt: daysAgo(9) });
    await asset({
      lifecycleStatus: 'submitted',
      isPlatformAsset: false,
      versionAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const host = await asset({
      lifecycleStatus: 'published',
      isPlatformAsset: false,
      versionAt: daysAgo(30),
    });

    /* Two adjacent bad days, one good day before them, a quiet day between. */
    await apiDay(daysAgo(40), 40, 0);
    await apiDay(daysAgo(38), 40, 4); // 1000 bps
    await apiDay(daysAgo(37), 40, 2); //  500 bps
    /* Below the traffic floor: one bad request in a quiet day is not an outage. */
    await apiDay(daysAgo(35), 4, 1);
    /* Today, quietly. */
    await apiDay(now, 5, 0, 25);

    await operationDay(host, daysAgo(38), 4, 2); // 5000 bps
    await operationDay(host, daysAgo(36), 4, 0);

    after = await platformStatus(now);
  });

  afterAll(async () => {
    const database = db();
    if (requestLogIds.length > 0) {
      await database.delete(schema.requestLog).where(inArray(schema.requestLog.id, requestLogIds));
    }
    if (operationIds.length > 0) {
      await database
        .delete(schema.workflowOperation)
        .where(inArray(schema.workflowOperation.id, operationIds));
    }
    if (versionIds.length > 0) {
      await database
        .delete(schema.assetVersion)
        .where(inArray(schema.assetVersion.id, versionIds));
    }
    if (assetIds.length > 0) {
      await database.delete(schema.asset).where(inArray(schema.asset.id, assetIds));
    }
    await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
  });

  it('buckets the API log by UTC day and judges each against its traffic', async () => {
    expect(stripDay(after, 'retrieval', dayKey(daysAgo(40)))).toBe('ok');
    expect(stripDay(after, 'retrieval', dayKey(daysAgo(39)))).toBeNull();
    expect(stripDay(after, 'retrieval', dayKey(daysAgo(38)))).toBe('degraded');
    expect(stripDay(after, 'retrieval', dayKey(daysAgo(37)))).toBe('degraded');
    /* Four requests, one of them failed: not enough traffic to mean anything. */
    expect(stripDay(after, 'retrieval', dayKey(daysAgo(35)))).toBe('ok');
    expect(after.windowDays).toBe(STATUS_WINDOW_DAYS);
    expect(component(after, 'retrieval').strip).toHaveLength(STATUS_WINDOW_DAYS);
  });

  it('reads the success rate off the request log itself', async () => {
    const since = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        (STATUS_WINDOW_DAYS - 1) * DAY_MS,
    );
    const [totals] = await db()
      .select({
        requests: sql<number>`count(*)::int`,
        failures: sql<number>`(count(*) filter (where ${schema.requestLog.statusCode} >= 500))::int`,
      })
      .from(schema.requestLog)
      .where(sql`${schema.requestLog.createdAt} >= ${since}`);

    expect(component(after, 'retrieval').successBps).toBe(
      10_000 - shareBps(totals!.failures, totals!.requests),
    );
    /* Today's line under the name is today's rows, and nobody else's. */
    expect(component(after, 'retrieval').today.requests).toBe(
      (component(before, 'retrieval').today.requests ?? 0) + 5,
    );
  });

  it('derives the incidents from the runs of degraded days', async () => {
    const retrieval = after.incidents.filter(
      (incident) =>
        incident.component === 'retrieval' && incident.to === dayKey(daysAgo(37)),
    );
    expect(retrieval).toHaveLength(1);
    expect(retrieval[0]).toMatchObject({
      from: dayKey(daysAgo(38)),
      to: dayKey(daysAgo(37)),
      days: 2,
      peakFailureBps: 1_000,
      ongoing: false,
    });

    const indexing = after.incidents.filter(
      (incident) => incident.component === 'indexing' && incident.to === dayKey(daysAgo(38)),
    );
    expect(indexing).toHaveLength(1);
    expect(indexing[0]).toMatchObject({ days: 1, peakFailureBps: 5_000, ongoing: false });
  });

  it('buckets finished builds and refreshes by the day they finished', async () => {
    expect(stripDay(after, 'indexing', dayKey(daysAgo(38)))).toBe('degraded');
    expect(stripDay(after, 'indexing', dayKey(daysAgo(36)))).toBe('ok');
    expect(stripDay(after, 'indexing', dayKey(daysAgo(37)))).toBeNull();
  });

  it('leaves the refresh schedule alone when nothing is scheduled', async () => {
    /* The fixture assets carry no sources, so nothing became due. */
    expect(after.refresh).toEqual(before.refresh);
  });
});
