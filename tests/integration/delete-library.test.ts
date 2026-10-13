/**
 * Deleting a library, both halves of architecture.md 8.4 against a real
 * database: the request makes it unreachable at once, the purge removes its
 * content afterwards, and neither ever lets it be queried again.
 *
 * The properties under test are about rows nobody touched:
 *
 * - the tombstone is enough on its own -- before any purge has run, the owner
 *   cannot query the library, it is off the dashboard list, it no longer
 *   counts against the plan, and its id can be created again;
 * - the purge removes chunks, documents, profiles and objects, and leaves the
 *   version rows and the tombstone;
 * - who may delete is a predicate of the lookup: a viewer, a stranger and a
 *   platform library all meet the same refusals as a nonexistent id;
 * - a queued refresh is cancelled, and a build queued afterwards refuses;
 * - the console's delete records an audit entry and hides the library.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const {
  countWorkspaceLibraries,
  createWorkspaceLibrary,
  deleteWorkspaceLibrary,
  listWorkspaceLibraries,
  markLibraryDeleted,
} = await import('@/lib/application/libraries');
const { purgeLibrary, runOperation, memoryObjectStore } = await import(
  '@/lib/application/ingestion'
);
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { createPlatformLibrary, deletePlatformLibrary, getPlatformLibrary, listPlatformLibraries } =
  await import('@/lib/application/administration/manage-platform-libraries');
const { PlatformLibraryRefused } = await import('@/lib/domain/library');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const libraries: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();

/** No administrator row is needed: `audit_log.administrator_id` is nullable. */
const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };

const nullCache = {
  get: async () => null,
  set: async () => {},
  invalidateTag: async () => {},
};
const noEmbeddings = {
  embeddings: () => {
    throw new Error('not configured');
  },
  rerank: () => {
    throw new Error('not configured');
  },
  cache: () => nullCache,
  configured: () => ({ embeddings: false, rerank: false }),
};

function dependencies() {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/handbook.md',
            url: 'https://docs.example.test/handbook',
            content: '# Team Handbook\n\nThe quartzloft onboarding checklist lives in this handbook.',
          },
        ],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          folders: [],
          excludeFolders: [],
          excludeFiles: [],
          rules: [],
        },
        revision: 'fixture-revision',
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

async function workspaceOnPlan(libraryLimit: number): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'delete-lib-test' });

  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 1_000,
    libraryLimit,
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

/** The refusal code, so a case asserts which guard fired rather than that one did. */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof PlatformLibraryRefused) return error.code;
    if (error && typeof error === 'object' && 'code' in error) return String(error.code);
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('library deletion', () => {
  afterAll(async () => {
    const database = db();
    if (libraries.length > 0) {
      await database
        .delete(schema.workflowOperation)
        .where(inArray(schema.workflowOperation.libraryId, libraries));
      await database
        .update(schema.library)
        .set({ currentVersionId: null })
        .where(inArray(schema.library.id, libraries));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.libraryId, libraries));
      await database
        .delete(schema.libraryProfileVector)
        .where(inArray(schema.libraryProfileVector.libraryId, libraries));
      await database
        .delete(schema.libraryProfile)
        .where(inArray(schema.libraryProfile.libraryId, libraries));
      await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, libraries));
      await database.delete(schema.document).where(inArray(schema.document.libraryId, libraries));
      await database
        .delete(schema.libraryVersion)
        .where(inArray(schema.libraryVersion.libraryId, libraries));
      await database
        .delete(schema.libraryScore)
        .where(inArray(schema.libraryScore.libraryId, libraries));
      await database
        .delete(schema.libraryAlias)
        .where(inArray(schema.libraryAlias.libraryId, libraries));
      await database
        .delete(schema.libraryClaim)
        .where(inArray(schema.libraryClaim.libraryId, libraries));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, libraries));
      await database.delete(schema.library).where(inArray(schema.library.id, libraries));
      await database
        .delete(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetType, 'platform_library'),
            inArray(schema.auditLog.targetId, libraries),
          ),
        );
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.requestLog)
        .where(inArray(schema.requestLog.workspaceId, workspaces));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database
        .delete(schema.usageReservation)
        .where(inArray(schema.usageReservation.workspaceId, workspaces));
      await database
        .delete(schema.subscription)
        .where(inArray(schema.subscription.workspaceId, workspaces));
      await database
        .delete(schema.domainVerification)
        .where(inArray(schema.domainVerification.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database
        .delete(schema.planVersion)
        .where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('makes the library unreachable at once, then purges its content', async () => {
    const stamp = Date.now();
    const database = db();
    /* A one-library plan: re-creating the id below proves the slot came back. */
    const workspaceId = await workspaceOnPlan(1);
    const slug = `handbook-deleted-${stamp}`;

    const created = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Team handbook',
      visibility: 'private',
      sourceType: 'website',
      location: 'https://docs.example.test/handbook',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/handbook'),
      slug,
    });
    libraries.push(created.libraryId);

    const built = await runOperation({
      operationId: created.operationId!,
      dependencies: dependencies(),
    });
    expect(built.status).toBe('succeeded');
    await database
      .update(schema.library)
      .set({ lifecycleStatus: 'published' })
      .where(eq(schema.library.id, created.libraryId));

    const objectsBefore = store.keys().filter((key) => key.includes(created.libraryId));
    expect(objectsBefore.length).toBeGreaterThan(0);

    /* -------------------------------------------------- the request half */

    const deleted = await deleteWorkspaceLibrary({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
    });
    expect(deleted.alreadyDeleted).toBe(false);
    expect(deleted.publicId).toBe(created.publicId);
    expect(deleted.operationId).not.toBeNull();

    const [tombstone] = await database
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, created.libraryId));
    expect(tombstone?.deletedAt).not.toBeNull();
    expect(tombstone?.lifecycleStatus).toBe('archived');
    expect(tombstone?.indexStatus).toBe('deleting');
    expect(tombstone?.currentVersionId).toBeNull();
    /* The id is kept on the tombstone; the partial index is what frees it. */
    expect(tombstone?.publicId).toBe(created.publicId);

    const sources = await database
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(eq(schema.source.libraryId, created.libraryId));
    expect(sources).toHaveLength(0);

    /* Gone from the dashboard and the quota before any purge has run. */
    const listed = await listWorkspaceLibraries(workspaceId);
    expect(listed.some((row) => row.id === created.libraryId)).toBe(false);
    expect(await countWorkspaceLibraries(workspaceId)).toBe(0);

    /* The owner meets the same refusal as a stranger would. */
    const owner = { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: false };
    await expect(
      queryDocs(
        owner,
        { libraryId: created.publicId, query: 'quartzloft', maxTokens: 4000, format: 'json' },
        noEmbeddings,
      ),
    ).rejects.toMatchObject({ code: 'library_not_found' });

    /* Content is still there: the purge has not run. */
    const [chunksBefore] = await database
      .select({ id: schema.chunk.id })
      .from(schema.chunk)
      .where(eq(schema.chunk.libraryId, created.libraryId))
      .limit(1);
    expect(chunksBefore).toBeDefined();

    /* The id is free again, and so is the plan's one slot. */
    const again = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Team handbook, again',
      visibility: 'private',
      sourceType: 'website',
      location: 'https://docs.example.test/handbook',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/handbook'),
      slug,
    });
    libraries.push(again.libraryId);
    expect(again.publicId).toBe(created.publicId);
    expect(again.libraryId).not.toBe(created.libraryId);

    /* A second delete of the same library changes nothing and finds the
       operation the first one queued. */
    await expect(
      deleteWorkspaceLibrary({ workspaceId, role: 'owner', libraryId: created.libraryId }),
    ).rejects.toMatchObject({ code: 'library_not_found' });
    const repeated = await markLibraryDeleted(created.libraryId);
    expect(repeated.alreadyDeleted).toBe(true);
    expect(repeated.operationId).toBe(deleted.operationId);

    /* ---------------------------------------------------- the purge half */

    const purged = await runOperation({
      operationId: deleted.operationId!,
      dependencies: dependencies(),
    });
    expect(purged.status).toBe('purged');
    if (purged.status === 'purged') {
      expect(purged.chunks).toBeGreaterThan(0);
      expect(purged.documents).toBeGreaterThan(0);
      expect(purged.objects).toBeGreaterThanOrEqual(objectsBefore.length);
    }

    const remaining = await Promise.all([
      database.select({ id: schema.chunk.id }).from(schema.chunk).where(eq(schema.chunk.libraryId, created.libraryId)),
      database.select({ id: schema.document.id }).from(schema.document).where(eq(schema.document.libraryId, created.libraryId)),
      database.select({ id: schema.libraryProfile.id }).from(schema.libraryProfile).where(eq(schema.libraryProfile.libraryId, created.libraryId)),
      database.select({ id: schema.libraryProfileVector.id }).from(schema.libraryProfileVector).where(eq(schema.libraryProfileVector.libraryId, created.libraryId)),
    ]);
    for (const rows of remaining) expect(rows).toHaveLength(0);
    expect(store.keys().filter((key) => key.includes(created.libraryId))).toHaveLength(0);

    /* Versions stay as metadata; the tombstone's size reads zero. */
    const versions = await database
      .select({ id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, created.libraryId));
    expect(versions.length).toBeGreaterThan(0);
    const [after] = await database
      .select({ storageBytes: schema.library.storageBytes, deletedAt: schema.library.deletedAt })
      .from(schema.library)
      .where(eq(schema.library.id, created.libraryId));
    expect(after?.storageBytes).toBe(0);
    expect(after?.deletedAt).not.toBeNull();

    const [operation] = await database
      .select({ status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, deleted.operationId!));
    expect(operation?.status).toBe('succeeded');
  });

  it('refuses a viewer, a stranger and a platform library alike', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan(5);
    const stranger = await workspaceOnPlan(5);

    const created = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Not yours',
      visibility: 'private',
      sourceType: 'openapi',
      location: 'https://api.example.test/openapi.json',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://api.example.test/openapi.json'),
      slug: `not-yours-${stamp}`,
    });
    libraries.push(created.libraryId);

    await expect(
      deleteWorkspaceLibrary({ workspaceId, role: 'viewer', libraryId: created.libraryId }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    await expect(
      deleteWorkspaceLibrary({ workspaceId, role: 'developer', libraryId: created.libraryId }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    await expect(
      deleteWorkspaceLibrary({ workspaceId: stranger, role: 'owner', libraryId: created.libraryId }),
    ).rejects.toMatchObject({ code: 'library_not_found' });
    await expect(
      deleteWorkspaceLibrary({ workspaceId, role: 'owner', libraryId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'library_not_found' });

    const platform = await createPlatformLibrary({
      actor,
      title: 'Platform, not the workspace’s',
      publicId: `/websites/platform-owned-${stamp}`,
      sourceType: 'website',
      location: 'https://example.test/docs',
      refreshPolicy: 'manual',
      reason: 'integration test fixture',
    });
    libraries.push(platform.libraryId);
    await expect(
      deleteWorkspaceLibrary({ workspaceId, role: 'owner', libraryId: platform.libraryId }),
    ).rejects.toMatchObject({ code: 'library_not_found' });

    /* Nothing above touched the row. */
    const [row] = await db()
      .select({ deletedAt: schema.library.deletedAt })
      .from(schema.library)
      .where(eq(schema.library.id, created.libraryId));
    expect(row?.deletedAt).toBeNull();
  });

  it('cancels queued work and refuses to build or purge the wrong thing', async () => {
    const stamp = Date.now();
    const database = db();
    const workspaceId = await workspaceOnPlan(5);

    const created = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Queued',
      visibility: 'private',
      sourceType: 'website',
      location: 'https://docs.example.test/queued',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/queued'),
      slug: `queued-${stamp}`,
    });
    libraries.push(created.libraryId);

    /* A live library is never purged, whatever asked. */
    await expect(purgeLibrary({ libraryId: created.libraryId, dependencies: dependencies() })).rejects.toMatchObject({
      code: 'internal_error',
    });

    await deleteWorkspaceLibrary({ workspaceId, role: 'owner', libraryId: created.libraryId });

    /* The ingest queued at creation is withdrawn, and a drain skips it. */
    const [ingest] = await database
      .select({ status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, created.operationId!));
    expect(ingest?.status).toBe('cancelled');
    expect(
      (await runOperation({ operationId: created.operationId!, dependencies: dependencies() }))
        .status,
    ).toBe('lost');

    /* A build queued behind the tombstone fails at its first guard. */
    const stray = uuidv7();
    await database.insert(schema.workflowOperation).values({
      id: stray,
      libraryId: created.libraryId,
      operationType: 'refresh',
      sourceDigest: null,
      status: 'pending',
    });
    const outcome = await runOperation({ operationId: stray, dependencies: dependencies() });
    expect(outcome).toMatchObject({ status: 'failed', error: 'source_unsupported' });
    const [after] = await database
      .select({ indexStatus: schema.library.indexStatus })
      .from(schema.library)
      .where(eq(schema.library.id, created.libraryId));
    /* ...and does not relabel the tombstone as a failed library. */
    expect(after?.indexStatus).toBe('deleting');
  });

  it('deletes a platform library from the console, with an audit entry', async () => {
    const stamp = Date.now();
    const database = db();
    const title = `Platform delete fixture ${stamp}`;

    const created = await createPlatformLibrary({
      actor,
      title,
      publicId: `/websites/platform-delete-${stamp}`,
      sourceType: 'website',
      location: 'https://example.test/docs',
      refreshPolicy: 'daily',
      reason: 'integration test fixture',
    });
    libraries.push(created.libraryId);

    const deleted = await deletePlatformLibrary({
      actor,
      libraryId: created.libraryId,
      reason: 'fixture is being deleted',
    });
    expect(deleted.publicId).toBe(created.publicId);
    expect(deleted.operationId).not.toBeNull();

    expect(await getPlatformLibrary(created.libraryId)).toBeNull();
    const listed = await listPlatformLibraries({ query: title });
    expect(listed.rows).toHaveLength(0);

    const entries = await database
      .select({ action: schema.auditLog.action, reason: schema.auditLog.reason })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'platform_library'),
          eq(schema.auditLog.targetId, created.libraryId),
        ),
      );
    expect(entries.map((entry) => entry.action)).toContain('platform_library.delete');
    expect(entries.find((entry) => entry.action === 'platform_library.delete')?.reason).toBe(
      'fixture is being deleted',
    );

    /* Every console verb now answers as for an unknown id. */
    expect(
      await refusalOf(
        deletePlatformLibrary({ actor, libraryId: created.libraryId, reason: 'again' }),
      ),
    ).toBe('not_found');

    /* ...and a user library is not the console's to delete. */
    const workspaceId = await workspaceOnPlan(5);
    const user = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'User library',
      visibility: 'private',
      sourceType: 'openapi',
      location: 'https://api.example.test/openapi.json',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://api.example.test/openapi.json'),
      slug: `user-owned-${stamp}`,
    });
    libraries.push(user.libraryId);
    expect(
      await refusalOf(deletePlatformLibrary({ actor, libraryId: user.libraryId, reason: 'no' })),
    ).toBe('not_platform_library');
  });

  /*
   * aptos-anchoring-proposal.md 6: deleting a library takes its proof with it.
   * The root stays on chain -- an append-only ledger has no other option -- but
   * without the leaf and its path nobody can show which version that root
   * committed to, which is the whole of what deletion can mean here and why
   * anchoring a private library was acceptable at all.
   */
  it('takes the anchoring proof with the library', async () => {
    const stamp = Date.now();
    const database = db();
    const workspaceId = await workspaceOnPlan(1);

    const created = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Anchored handbook',
      visibility: 'private',
      sourceType: 'website',
      location: 'https://docs.example.test/anchored',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/anchored'),
      slug: `anchored-deleted-${stamp}`,
    });
    libraries.push(created.libraryId);
    const built = await runOperation({ operationId: created.operationId!, dependencies: dependencies() });
    expect(built.status).toBe('succeeded');

    const [version] = await database
      .select({ id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, created.libraryId));

    /* A confirmed batch, as the workflow would have left one. */
    const batchId = crypto.randomUUID();
    const at = new Date('2026-02-01T00:00:00Z');
    await database.insert(schema.anchorBatch).values({
      id: batchId,
      subjectType: 'version',
      leafSchemaVersion: 1,
      merkleRoot: 'a'.repeat(64),
      leafCount: 4,
      windowStart: at,
      windowEnd: at,
      network: 'testnet',
      txHash: `0x${batchId.replace(/-/g, '')}`,
      status: 'confirmed',
      confirmedAt: at,
    });
    await database.insert(schema.anchorLeaf).values({
      id: crypto.randomUUID(),
      batchId,
      leafHash: 'b'.repeat(64),
      leafSchemaVersion: 1,
      subjectType: 'version',
      subjectId: version!.id,
      leafIndex: 1,
      merkleProof: [`r:${'c'.repeat(64)}`],
    });

    await deleteWorkspaceLibrary({ workspaceId, role: 'owner', libraryId: created.libraryId });
    await purgeLibrary({ libraryId: created.libraryId, dependencies: dependencies() });

    const leaves = await database
      .select({ id: schema.anchorLeaf.id })
      .from(schema.anchorLeaf)
      .where(eq(schema.anchorLeaf.subjectId, version!.id));
    expect(leaves).toHaveLength(0);

    /*
     * The batch survives untouched, count included. It describes a root that is
     * on chain committing to four leaves, and lowering the number to match what
     * this database still holds would make the row disagree with the ledger.
     */
    const [batch] = await database
      .select({ status: schema.anchorBatch.status, leafCount: schema.anchorBatch.leafCount })
      .from(schema.anchorBatch)
      .where(eq(schema.anchorBatch.id, batchId));
    expect(batch).toMatchObject({ status: 'confirmed', leafCount: 4 });

    await database.delete(schema.anchorBatch).where(eq(schema.anchorBatch.id, batchId));
  });
});
