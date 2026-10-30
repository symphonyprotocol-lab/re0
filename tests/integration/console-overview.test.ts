/**
 * The operations overview against a real database: every tile reads the table
 * that owns it, the review queue measures its wait from the build that
 * submitted the library, and a session without a capability gets no figure
 * for it -- not a zero, nothing (requirement.md 5.3).
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database. The
 * database may hold other rows, so every expectation is a difference between
 * a reading taken before the fixture and one taken after.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { consoleOverview, healthNeedsAttention } = await import(
  '@/lib/application/administration/overview'
);
const { recordAudit } = await import('@/lib/application/administration/audit');
const { ADMIN_CAPABILITIES } = await import('@/lib/domain/admin');
const { dayKey } = await import('@/lib/domain/overview');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const database = db;
const { uuidv7 } = await import('@/lib/domain/id');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const stamp = Date.now();
const now = new Date(stamp);
const userIds: string[] = [];
const workspaceId = crypto.randomUUID();
const libraryIds: string[] = [];
const versionIds: string[] = [];
const operationIds: string[] = [];
const requestIds: string[] = [];
let auditHash: string | null = null;

type Overview = Awaited<ReturnType<typeof consoleOverview>>;
let before: Overview;
let after: Overview;

const everything = { range: 30 as const, capabilities: ADMIN_CAPABILITIES, now };

async function user(createdAt: Date): Promise<string> {
  const id = crypto.randomUUID();
  userIds.push(id);
  await db()
    .insert(schema.user)
    .values({ id, email: `overview-${stamp}-${userIds.length}@example.test`, createdAt });
  return id;
}

async function version(libraryId: string, createdAt: Date, label: string): Promise<void> {
  const versionId = uuidv7();
  versionIds.push(versionId);
  await db()
    .insert(schema.libraryVersion)
    .values({
      id: versionId,
      libraryId,
      label,
      sourceDigest: `digest-${label}`,
      parserVersion: 'test',
      chunkerVersion: 'test',
      embeddingModel: 'test',
      indexStatus: 'ready',
      createdAt,
    });
}

async function library(input: {
  lifecycleStatus: 'submitted' | 'published';
  indexStatus: 'ready' | 'failed';
  createdAt: Date;
  versionAt?: Date;
}): Promise<string> {
  const id = crypto.randomUUID();
  libraryIds.push(id);
  await db()
    .insert(schema.library)
    .values({
      id,
      publicId: `/overview-${stamp}/${libraryIds.length}`,
      title: `Overview fixture ${libraryIds.length}`,
      ownerWorkspaceId: workspaceId,
      kind: 'website',
      lifecycleStatus: input.lifecycleStatus,
      indexStatus: input.indexStatus,
      createdAt: input.createdAt,
    });
  if (input.versionAt) await version(id, input.versionAt, 'v1');
  return id;
}

describeWithDb('the operations overview', () => {
  beforeAll(async () => {
    const database = db();
    before = await consoleOverview(everything);

    await database.insert(schema.workspace).values({ id: workspaceId, name: 'overview-test' });

    /* Two accounts this window, one the window before, one long ago. */
    await user(new Date(stamp - 2 * DAY_MS));
    await user(new Date(stamp - 3 * DAY_MS));
    await user(new Date(stamp - 40 * DAY_MS));
    await user(new Date(stamp - 400 * DAY_MS));

    /*
     * A library created a year ago, submitted by a build three hours ago and
     * rebuilt by its owner since: the queue must say it has waited three
     * hours -- not a year, and not "just now" because of the rebuild. A
     * second one has waited two days, which is overdue. A third is indexed
     * and published.
     */
    const resubmitted = await library({
      lifecycleStatus: 'submitted',
      indexStatus: 'ready',
      createdAt: new Date(stamp - 365 * DAY_MS),
      versionAt: new Date(stamp - 3 * HOUR_MS),
    });
    await version(resubmitted, new Date(stamp - 5 * 60 * 1000), 'v2');
    await library({
      lifecycleStatus: 'submitted',
      indexStatus: 'ready',
      createdAt: new Date(stamp - 2 * DAY_MS),
    });
    await library({
      lifecycleStatus: 'published',
      indexStatus: 'failed',
      createdAt: new Date(stamp - 1 * DAY_MS),
    });

    /* One build failed an hour ago, one is still waiting. */
    for (const [status, updatedAt] of [
      ['failed', new Date(stamp - HOUR_MS)],
      ['pending', now],
    ] as const) {
      const id = uuidv7();
      operationIds.push(id);
      await database.insert(schema.workflowOperation).values({
        id,
        libraryId: libraryIds[2]!,
        operationType: 'refresh',
        sourceDigest: `overview-${stamp}-${status}`,
        status,
        createdAt: updatedAt,
        updatedAt,
      });
    }

    /* Nine requests answered and one that fell over, all in the last day. */
    for (let index = 0; index < 10; index += 1) {
      const id = uuidv7();
      requestIds.push(id);
      await database.insert(schema.requestLog).values({
        id,
        workspaceId,
        requestId: `overview-${stamp}-${index}`,
        operation: 'query_docs',
        statusCode: index === 0 ? 500 : 200,
        createdAt: new Date(stamp - index * HOUR_MS),
      });
    }

    auditHash = await recordAudit({
      administratorId: null,
      action: 'user.suspend',
      targetType: 'user',
      targetId: userIds[0]!,
      result: 'success',
    });

    after = await consoleOverview(everything);
  });

  afterAll(async () => {
    const database = db();
    if (auditHash) await database.delete(schema.auditLog).where(eq(schema.auditLog.hash, auditHash));
    if (requestIds.length > 0) {
      await database.delete(schema.requestLog).where(inArray(schema.requestLog.id, requestIds));
    }
    if (operationIds.length > 0) {
      await database
        .delete(schema.workflowOperation)
        .where(inArray(schema.workflowOperation.id, operationIds));
    }
    if (versionIds.length > 0) {
      await database.delete(schema.libraryVersion).where(inArray(schema.libraryVersion.id, versionIds));
    }
    if (libraryIds.length > 0) {
      await database.delete(schema.library).where(inArray(schema.library.id, libraryIds));
    }
    await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
    if (userIds.length > 0) await database.delete(schema.user).where(inArray(schema.user.id, userIds));
  });

  it('counts accounts in this window and the one before it', () => {
    expect(after.users!.total - before.users!.total).toBe(4);
    expect(after.users!.inWindow - before.users!.inWindow).toBe(2);
    expect(after.users!.inPreviousWindow - before.users!.inPreviousWindow).toBe(1);
  });

  it('plots each sign-up on the UTC day it happened', () => {
    const delta = new Map(
      after.growth!.map((point, index) => [
        dayKey(point.day),
        point.users - (before.growth![index]?.users ?? 0),
      ]),
    );
    expect(delta.get(dayKey(new Date(stamp - 2 * DAY_MS)))).toBe(1);
    expect(delta.get(dayKey(new Date(stamp - 3 * DAY_MS)))).toBe(1);
    expect(after.growth).toHaveLength(30);
    expect(dayKey(after.growth![29]!.day)).toBe(dayKey(now));
  });

  it('counts libraries in this window and the one before it', () => {
    expect(after.libraries!.total - before.libraries!.total).toBe(3);
    expect(after.libraries!.inWindow - before.libraries!.inWindow).toBe(2);
  });

  it('reads service health from the request log and the operation queue', () => {
    expect(after.health.api.requests - before.health.api.requests).toBe(10);
    expect(after.health.api.failures - before.health.api.failures).toBe(1);
    expect(after.health.builds.open - before.health.builds.open).toBe(1);
    expect(after.health.builds.failed - before.health.builds.failed).toBe(1);
    expect(after.health.index.failed - before.health.index.failed).toBe(1);
    expect(after.health.index.ready - before.health.index.ready).toBe(2);
    expect(healthNeedsAttention(after.health)).toBe(true);
  });

  it('shows the newest audit entry first as activity', () => {
    expect(after.activity![0]?.action).toBe('user.suspend');
    expect(after.activity![0]?.targetId).toBe(userIds[0]);
  });

  it('leaves out every part a session has no capability for', async () => {
    const support = await consoleOverview({ range: 7, capabilities: ['users'], now });
    expect(support.users).not.toBeNull();
    expect(support.growth).toHaveLength(7);
    /* Who paid is billing data: a users-only session gets neither series nor rate. */
    expect(support.growthIncludesPaid).toBe(false);
    expect(support.conversionBps).toBeNull();
    expect(support.growth!.every((point) => point.paid === 0)).toBe(true);
    expect(support.libraries).toBeNull();
    expect(support.revenue).toBeNull();
    expect(support.activity).toBeNull();
  });
});
