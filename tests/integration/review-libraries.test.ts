/**
 * A user library from build to review, against a real database.
 *
 * What is under test is the hand-off between two flows that never see each
 * other: the build advances the lifecycle (private publishes, public waits),
 * and the reviewer's verbs move it from there -- each one writing the review
 * row the owner reads and the audit entry requirement.md 7.4 demands.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { createWorkspaceLibrary, listWorkspaceLibraries } = await import('@/lib/application/libraries');
const { getUserLibrary, reviewUserLibrary, listUserLibraries } = await import(
  '@/lib/application/administration'
);
const { runOperation, memoryObjectStore } = await import('@/lib/application/ingestion');
const { PlatformLibraryRefused } = await import('@/lib/domain/library');
const { AdminChangeRefused } = await import('@/lib/domain/admin');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const libraries: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();
const actor = { administratorId: null as unknown as string, email: 'reviewer@example.test' };

function dependencies(content: string) {
  return {
    async fetchSnapshot() {
      return {
        files: [{ path: 'docs/guide.md', url: 'https://docs.example.test/guide', content }],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          folders: [],
          excludeFolders: [],
          excludeFiles: [],
          rules: [],
        },
        revision: null,
        lastModifiedAt: new Date(),
        hasLicense: true,
        stale: false,
      };
    },
    embeddings: () => ({
      model: 'fixture-embed-1',
      dimensions: EMBEDDING_COLUMN_DIMENSIONS,
      async embed(texts: string[]) {
        return texts.map((text) =>
          Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17),
        );
      },
    }),
    store: () => store,
    configured: () => ({ embeddings: true, storage: true }),
  };
}

async function workspace(): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'review-test' });
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 1_000,
    libraryLimit: 10,
    librarySizeBytesLimit: 1_000_000,
    apiKeyLimit: 5,
    shareRateBps: 2000,
    capabilities: {},
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  await database.insert(schema.subscription).values({
    id: uuidv7(),
    workspaceId,
    planVersionId,
    status: 'active',
    periodStart: new Date(Date.now() - 86_400_000),
    periodEnd: new Date(Date.now() + 86_400_000),
  });
  return workspaceId;
}

async function lifecycleOf(libraryId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ lifecycleStatus: schema.library.lifecycleStatus })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId));
  return row?.lifecycleStatus;
}

async function queueRefresh(libraryId: string): Promise<string> {
  const operationId = uuidv7();
  await db().insert(schema.workflowOperation).values({
    id: operationId,
    libraryId,
    operationType: 'refresh',
    sourceDigest: null,
    status: 'pending',
  });
  return operationId;
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof PlatformLibraryRefused) return error.code;
    if (error instanceof AdminChangeRefused) return error.code;
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('user library review', () => {
  afterAll(async () => {
    const database = db();
    if (libraries.length > 0) {
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.libraryId, libraries));
      /* A user library's build writes a usage event that points at its version. */
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.libraryId, libraries));
      await database.delete(schema.libraryReview).where(inArray(schema.libraryReview.libraryId, libraries));
      await database.update(schema.library).set({ currentVersionId: null }).where(inArray(schema.library.id, libraries));
      await database.delete(schema.libraryProfileVector).where(inArray(schema.libraryProfileVector.libraryId, libraries));
      await database.delete(schema.libraryProfile).where(inArray(schema.libraryProfile.libraryId, libraries));
      await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, libraries));
      await database.delete(schema.document).where(inArray(schema.document.libraryId, libraries));
      await database.delete(schema.libraryVersion).where(inArray(schema.libraryVersion.libraryId, libraries));
      await database.delete(schema.libraryScore).where(inArray(schema.libraryScore.libraryId, libraries));
      await database
        .delete(schema.libraryClaim)
        .where(inArray(schema.libraryClaim.libraryId, libraries));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, libraries));
      await database.delete(schema.library).where(inArray(schema.library.id, libraries));
      await database
        .delete(schema.auditLog)
        .where(and(eq(schema.auditLog.targetType, 'user_library'), inArray(schema.auditLog.targetId, libraries)));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
      await database
        .delete(schema.domainVerification)
        .where(inArray(schema.domainVerification.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('publishes a private library on its first build and offers only a pause', async () => {
    const workspaceId = await workspace();
    const created = await createWorkspaceLibrary({
      workspaceId,
      role: 'owner',
      title: 'Private Guide',
      visibility: 'private',
      sourceType: 'website',
      location: 'https://docs.example.test/private',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/private'),
      slug: `private-guide-${Date.now()}`,
    });
    libraries.push(created.libraryId);
    expect(await lifecycleOf(created.libraryId)).toBe('draft');

    const built = await runOperation({ operationId: created.operationId!, dependencies: dependencies('# Private\n\nBody one.') });
    expect(built.status).toBe('succeeded');
    expect(await lifecycleOf(created.libraryId)).toBe('published');

    expect(
      await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'request_changes', reason: 'no' })),
    ).toBe('invalid_transition');
    const paused = await reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'reject', reason: 'safety pause' });
    expect(paused.status).toBe('suspended');

    /* A rebuild does not lift the pause. */
    const again = await runOperation({
      operationId: await queueRefresh(created.libraryId),
      dependencies: dependencies('# Private\n\nBody two.'),
    });
    expect(again.status).toBe('succeeded');
    expect(await lifecycleOf(created.libraryId)).toBe('suspended');

    const restored = await reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'approve', reason: 'pause lifted' });
    expect(restored.status).toBe('published');
  });

  it('queues a public library for review and walks it through the three verbs', async () => {
    const workspaceId = await workspace();
    const created = await createWorkspaceLibrary({
      workspaceId,
      role: 'owner',
      title: 'Public Guide',
      visibility: 'public',
      sourceType: 'website',
      location: 'https://docs.example.test/public',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/public'),
      slug: `public-guide-${Date.now()}`,
    });
    libraries.push(created.libraryId);

    /* Nothing to decide before the first version exists. */
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'approve', reason: 'early' }))).toBe(
      'invalid_transition',
    );

    const built = await runOperation({ operationId: created.operationId!, dependencies: dependencies('# Public\n\nVersion one.') });
    expect(built.status).toBe('succeeded');
    expect(await lifecycleOf(created.libraryId)).toBe('submitted');

    const queue = await listUserLibraries({ review: 'pending' });
    const queued = queue.rows.find((row) => row.id === created.libraryId);
    expect(queued?.hasReadyVersion).toBe(true);

    /* Sent back: the owner sees the note, a rebuild resubmits. */
    const sentBack = await reviewUserLibrary({
      actor,
      libraryId: created.libraryId,
      action: 'request_changes',
      reason: 'add a licence statement',
    });
    expect(sentBack.status).toBe('changes_requested');
    const mine = await listWorkspaceLibraries(workspaceId);
    expect(mine.find((row) => row.id === created.libraryId)?.reviewNote).toBe('add a licence statement');

    const rebuilt = await runOperation({
      operationId: await queueRefresh(created.libraryId),
      dependencies: dependencies('# Public\n\nVersion two, with a licence.'),
    });
    expect(rebuilt.status).toBe('succeeded');
    expect(await lifecycleOf(created.libraryId)).toBe('submitted');

    const rejected = await reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'reject', reason: 'rights unclear' });
    expect(rejected.status).toBe('suspended');
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'reject', reason: 'twice' }))).toBe(
      'invalid_transition',
    );

    const approved = await reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'approve', reason: 'rights confirmed' });
    expect(approved.status).toBe('published');
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'approve', reason: 'again' }))).toBe(
      'invalid_transition',
    );

    /* Every decision left a review row and an audit entry. */
    const detail = await getUserLibrary(created.libraryId);
    expect(detail?.lifecycleStatus).toBe('published');
    expect(detail?.reviews.map((review) => review.outcome)).toEqual(['approve', 'reject', 'request_changes']);
    expect(detail?.reviews[2]?.feedback).toEqual(['add a licence statement']);
    expect(detail?.versions).toHaveLength(2);
    const audit = await db()
      .select({ action: schema.auditLog.action, reason: schema.auditLog.reason })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'user_library'), eq(schema.auditLog.targetId, created.libraryId)));
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'user_library.approve',
      'user_library.reject',
      'user_library.request_changes',
    ]);
  });

  it('requires a reason and refuses an unknown library', async () => {
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: libraries[0]!, action: 'reject', reason: '   ' }))).toBe(
      'reason_required',
    );
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: crypto.randomUUID(), action: 'approve', reason: 'x' }))).toBe(
      'not_found',
    );
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: 'junk', action: 'approve', reason: 'x' }))).toBe('not_found');
    expect(await getUserLibrary('junk')).toBeNull();
  });
});
