/**
 * The refresh scheduler against a real database (architecture.md 8.4).
 *
 * What a unit test cannot show: that a daily source nobody has checked is
 * queued on the first pass and not again on the second, that a manual source
 * is left alone, that a source checked within its interval is not due, and
 * that the rows it writes are marked as the scheduler's rather than an
 * operator's. Runs only when TEST_DATABASE_URL points at a disposable
 * database -- these tests write rows.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { createPlatformLibrary } =
  await import('@/lib/application/administration/manage-platform-libraries');
const { refreshSchedule, scheduleDueRefreshes } =
  await import('@/lib/application/ingestion/schedule-refreshes');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const slug = `schedule-fixture-${Date.now()}`;
const created: string[] = [];

describeWithDb('refresh scheduler', () => {
  afterAll(async () => {
    const database = db();
    if (created.length === 0) return;
    await database
      .delete(schema.workflowOperation)
      .where(inArray(schema.workflowOperation.libraryId, created));
    await database.delete(schema.source).where(inArray(schema.source.libraryId, created));
    await database.delete(schema.library).where(inArray(schema.library.id, created));
    await database
      .delete(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'platform_library'),
          inArray(schema.auditLog.targetId, created),
        ),
      );
  });

  it('queues a never-checked daily source once, and leaves a manual one alone', async () => {
    const daily = await createPlatformLibrary({
      actor,
      title: 'Scheduled Fixture',
      publicId: `/websites/${slug}-daily`,
      sourceType: 'website',
      location: 'https://example.test/daily',
      refreshPolicy: 'daily',
      reason: 'integration test fixture',
    });
    created.push(daily.libraryId);
    const manual = await createPlatformLibrary({
      actor,
      title: 'Manual Fixture',
      publicId: `/websites/${slug}-manual`,
      sourceType: 'website',
      location: 'https://example.test/manual',
      refreshPolicy: 'manual',
      reason: 'integration test fixture',
    });
    created.push(manual.libraryId);

    const first = await scheduleDueRefreshes();
    const ours = first.filter((row) => created.includes(row.libraryId));
    expect(ours).toHaveLength(1);
    expect(ours[0]!.libraryId).toBe(daily.libraryId);
    /* Every source of the library was due, so the whole library is queued. */
    expect(ours[0]!.sourceId).toBeNull();

    const [row] = await db()
      .select({
        trigger: schema.workflowOperation.trigger,
        status: schema.workflowOperation.status,
      })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, ours[0]!.operationId));
    expect(row).toEqual({ trigger: 'scheduled', status: 'pending' });

    /* The open row covers the source: a second pass queues nothing more. */
    const second = await scheduleDueRefreshes();
    expect(second.filter((r) => created.includes(r.libraryId))).toHaveLength(0);

    const schedule = await refreshSchedule();
    const dailyView = schedule.find((s) => s.libraryId === daily.libraryId);
    const manualView = schedule.find((s) => s.libraryId === manual.libraryId);
    expect(dailyView?.open).toBe(true);
    expect(manualView?.dueAt).toBeNull();
    expect(manualView?.open).toBe(false);
  });

  it('queues only the due source of a library whose other source is manual', async () => {
    const mixed = await createPlatformLibrary({
      actor,
      title: 'Mixed Fixture',
      publicId: `/websites/${slug}-mixed`,
      sourceType: 'website',
      location: 'https://example.test/mixed-manual',
      refreshPolicy: 'manual',
      reason: 'integration test fixture',
    });
    created.push(mixed.libraryId);
    /* A second source, written directly: the console refuses one since P1
       (agent-first-proposal.md 3.1), but the scheduler still decides per
       source, the shape libraries had before migration 0062 split them. */
    const added = { sourceId: uuidv7() };
    await db().insert(schema.source).values({
      id: added.sourceId,
      libraryId: mixed.libraryId,
      type: 'website',
      location: 'https://example.test/mixed-weekly',
      config: { indexDepth: 0 },
      refreshPolicy: { cadence: 'weekly' },
    });

    /* The library was just checked: nothing is due yet. */
    await db()
      .update(schema.library)
      .set({ lastCheckedAt: new Date() })
      .where(eq(schema.library.id, mixed.libraryId));
    const none = await scheduleDueRefreshes();
    expect(none.filter((r) => r.libraryId === mixed.libraryId)).toHaveLength(0);

    /* Eight days on, the weekly source is due and the manual one still is not. */
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const queued = await scheduleDueRefreshes(later);
    const ours = queued.filter((r) => r.libraryId === mixed.libraryId);
    expect(ours).toHaveLength(1);
    expect(ours[0]!.sourceId).toBe(added.sourceId);
  });
});
