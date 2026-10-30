/**
 * Deleting an asset, both halves of architecture.md 8.4 against a real
 * database: the request makes it unreachable at once, the purge removes its
 * content afterwards, and neither ever lets it be queried again.
 *
 * The properties under test are about rows nobody touched:
 *
 * - the tombstone is enough on its own -- before any purge has run, the owner
 *   cannot query the asset, it is off the dashboard list, it no longer
 *   counts against the plan, and its id can be created again;
 * - the purge removes chunks, documents, profiles and objects, and leaves the
 *   version rows and the tombstone;
 * - who may delete is a predicate of the lookup: a viewer, a stranger and a
 *   platform asset all meet the same refusals as a nonexistent id;
 * - a queued refresh is cancelled, and a build queued afterwards refuses;
 * - the console's delete records an audit entry and hides the asset.
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
  countWorkspaceAssets,
  createWorkspaceAsset,
  deleteWorkspaceAsset,
  listWorkspaceAssets,
  markAssetDeleted,
} = await import('@/lib/application/assets');
const { purgeAsset, runOperation, memoryObjectStore } = await import(
  '@/lib/application/ingestion'
);
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { createPlatformAsset, deletePlatformAsset, getPlatformAsset, listPlatformAssets } =
  await import('@/lib/application/administration/manage-platform-assets');
const { PlatformAssetRefused } = await import('@/lib/domain/asset');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const assets: string[] = [];
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

async function workspaceOnPlan(): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'delete-lib-test' });

  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'free',
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls: 1_000,
    apiKeyLimit: 5,
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
    if (error instanceof PlatformAssetRefused) return error.code;
    if (error && typeof error === 'object' && 'code' in error) return String(error.code);
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('asset deletion', () => {
  afterAll(async () => {
    const database = db();
    if (assets.length > 0) {
      await database
        .delete(schema.workflowOperation)
        .where(inArray(schema.workflowOperation.assetId, assets));
      await database
        .update(schema.asset)
        .set({ currentVersionId: null })
        .where(inArray(schema.asset.id, assets));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.assetId, assets));
      await database
        .delete(schema.assetProfileVector)
        .where(inArray(schema.assetProfileVector.assetId, assets));
      await database
        .delete(schema.assetProfile)
        .where(inArray(schema.assetProfile.assetId, assets));
      await database.delete(schema.chunk).where(inArray(schema.chunk.assetId, assets));
      await database.delete(schema.document).where(inArray(schema.document.assetId, assets));
      await database
        .delete(schema.assetVersion)
        .where(inArray(schema.assetVersion.assetId, assets));
      await database
        .delete(schema.assetScore)
        .where(inArray(schema.assetScore.assetId, assets));
      await database
        .delete(schema.assetAlias)
        .where(inArray(schema.assetAlias.assetId, assets));
      await database
        .delete(schema.assetClaim)
        .where(inArray(schema.assetClaim.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
      await database
        .delete(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetType, 'platform_library'),
            inArray(schema.auditLog.targetId, assets),
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

  it('makes the asset unreachable at once, then purges its content', async () => {
    const stamp = Date.now();
    const database = db();
    /* Re-creating the id below proves a deleted asset releases it. */
    const workspaceId = await workspaceOnPlan();
    const slug = `handbook-deleted-${stamp}`;

    const created = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Team handbook',
      sourceType: 'website',
      location: 'https://docs.example.test/handbook',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/handbook'),
      slug,
    });
    assets.push(created.assetId);

    const built = await runOperation({
      operationId: created.operationId!,
      dependencies: dependencies(),
    });
    expect(built.status).toBe('succeeded');
    await database
      .update(schema.asset)
      .set({ lifecycleStatus: 'published' })
      .where(eq(schema.asset.id, created.assetId));

    const objectsBefore = store.keys().filter((key) => key.includes(created.assetId));
    expect(objectsBefore.length).toBeGreaterThan(0);

    /* -------------------------------------------------- the request half */

    const deleted = await deleteWorkspaceAsset({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
    });
    expect(deleted.alreadyDeleted).toBe(false);
    expect(deleted.publicId).toBe(created.publicId);
    expect(deleted.operationId).not.toBeNull();

    const [tombstone] = await database
      .select()
      .from(schema.asset)
      .where(eq(schema.asset.id, created.assetId));
    expect(tombstone?.deletedAt).not.toBeNull();
    expect(tombstone?.lifecycleStatus).toBe('archived');
    expect(tombstone?.indexStatus).toBe('deleting');
    expect(tombstone?.currentVersionId).toBeNull();
    /* The id is kept on the tombstone; the partial index is what frees it. */
    expect(tombstone?.publicId).toBe(created.publicId);

    const sources = await database
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(eq(schema.source.assetId, created.assetId));
    expect(sources).toHaveLength(0);

    /* Gone from the dashboard and the quota before any purge has run. */
    const listed = await listWorkspaceAssets(workspaceId);
    expect(listed.some((row) => row.id === created.assetId)).toBe(false);
    expect(await countWorkspaceAssets(workspaceId)).toBe(0);

    /* The owner meets the same refusal as a stranger would. */
    const owner = { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: false };
    await expect(
      queryDocs(
        owner,
        { assetId: created.publicId, query: 'quartzloft', maxTokens: 4000, format: 'json' },
        noEmbeddings,
      ),
    ).rejects.toMatchObject({ code: 'asset_not_found' });

    /* Content is still there: the purge has not run. */
    const [chunksBefore] = await database
      .select({ id: schema.chunk.id })
      .from(schema.chunk)
      .where(eq(schema.chunk.assetId, created.assetId))
      .limit(1);
    expect(chunksBefore).toBeDefined();

    /* The id is free again, and so is the plan's one slot. */
    const again = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Team handbook, again',
      sourceType: 'website',
      location: 'https://docs.example.test/handbook',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/handbook'),
      slug,
    });
    assets.push(again.assetId);
    expect(again.publicId).toBe(created.publicId);
    expect(again.assetId).not.toBe(created.assetId);

    /* A second delete of the same asset changes nothing and finds the
       operation the first one queued. */
    await expect(
      deleteWorkspaceAsset({ workspaceId, role: 'owner', assetId: created.assetId }),
    ).rejects.toMatchObject({ code: 'asset_not_found' });
    const repeated = await markAssetDeleted(created.assetId);
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
      database.select({ id: schema.chunk.id }).from(schema.chunk).where(eq(schema.chunk.assetId, created.assetId)),
      database.select({ id: schema.document.id }).from(schema.document).where(eq(schema.document.assetId, created.assetId)),
      database.select({ id: schema.assetProfile.id }).from(schema.assetProfile).where(eq(schema.assetProfile.assetId, created.assetId)),
      database.select({ id: schema.assetProfileVector.id }).from(schema.assetProfileVector).where(eq(schema.assetProfileVector.assetId, created.assetId)),
    ]);
    for (const rows of remaining) expect(rows).toHaveLength(0);
    expect(store.keys().filter((key) => key.includes(created.assetId))).toHaveLength(0);

    /* Versions stay as metadata; the tombstone's size reads zero. */
    const versions = await database
      .select({ id: schema.assetVersion.id })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, created.assetId));
    expect(versions.length).toBeGreaterThan(0);
    const [after] = await database
      .select({ storageBytes: schema.asset.storageBytes, deletedAt: schema.asset.deletedAt })
      .from(schema.asset)
      .where(eq(schema.asset.id, created.assetId));
    expect(after?.storageBytes).toBe(0);
    expect(after?.deletedAt).not.toBeNull();

    const [operation] = await database
      .select({ status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, deleted.operationId!));
    expect(operation?.status).toBe('succeeded');
  });

  it('refuses a viewer, a stranger and a platform asset alike', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan();
    const stranger = await workspaceOnPlan();

    const created = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Not yours',
      sourceType: 'website',
      location: 'https://api.example.test/reference/',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://api.example.test/reference/'),
      slug: `not-yours-${stamp}`,
    });
    assets.push(created.assetId);

    await expect(
      deleteWorkspaceAsset({ workspaceId, role: 'viewer', assetId: created.assetId }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    await expect(
      deleteWorkspaceAsset({ workspaceId, role: 'developer', assetId: created.assetId }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    await expect(
      deleteWorkspaceAsset({ workspaceId: stranger, role: 'owner', assetId: created.assetId }),
    ).rejects.toMatchObject({ code: 'asset_not_found' });
    await expect(
      deleteWorkspaceAsset({ workspaceId, role: 'owner', assetId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'asset_not_found' });

    const platform = await createPlatformAsset({
      actor,
      title: 'Platform, not the workspace’s',
      publicId: `/websites/platform-owned-${stamp}`,
      sourceType: 'website',
      location: 'https://example.test/docs',
      refreshPolicy: 'manual',
      reason: 'integration test fixture',
    });
    assets.push(platform.assetId);
    await expect(
      deleteWorkspaceAsset({ workspaceId, role: 'owner', assetId: platform.assetId }),
    ).rejects.toMatchObject({ code: 'asset_not_found' });

    /* Nothing above touched the row. */
    const [row] = await db()
      .select({ deletedAt: schema.asset.deletedAt })
      .from(schema.asset)
      .where(eq(schema.asset.id, created.assetId));
    expect(row?.deletedAt).toBeNull();
  });

  it('cancels queued work and refuses to build or purge the wrong thing', async () => {
    const stamp = Date.now();
    const database = db();
    const workspaceId = await workspaceOnPlan();

    const created = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Queued',
      sourceType: 'website',
      location: 'https://docs.example.test/queued',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/queued'),
      slug: `queued-${stamp}`,
    });
    assets.push(created.assetId);

    /* A live asset is never purged, whatever asked. */
    await expect(purgeAsset({ assetId: created.assetId, dependencies: dependencies() })).rejects.toMatchObject({
      code: 'internal_error',
    });

    await deleteWorkspaceAsset({ workspaceId, role: 'owner', assetId: created.assetId });

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
      assetId: created.assetId,
      operationType: 'refresh',
      sourceDigest: null,
      status: 'pending',
    });
    const outcome = await runOperation({ operationId: stray, dependencies: dependencies() });
    expect(outcome).toMatchObject({ status: 'failed', error: 'source_unsupported' });
    const [after] = await database
      .select({ indexStatus: schema.asset.indexStatus })
      .from(schema.asset)
      .where(eq(schema.asset.id, created.assetId));
    /* ...and does not relabel the tombstone as a failed asset. */
    expect(after?.indexStatus).toBe('deleting');
  });

  it('deletes a platform asset from the console, with an audit entry', async () => {
    const stamp = Date.now();
    const database = db();
    const title = `Platform delete fixture ${stamp}`;

    const created = await createPlatformAsset({
      actor,
      title,
      publicId: `/websites/platform-delete-${stamp}`,
      sourceType: 'website',
      location: 'https://example.test/docs',
      refreshPolicy: 'daily',
      reason: 'integration test fixture',
    });
    assets.push(created.assetId);

    const deleted = await deletePlatformAsset({
      actor,
      assetId: created.assetId,
      reason: 'fixture is being deleted',
    });
    expect(deleted.publicId).toBe(created.publicId);
    expect(deleted.operationId).not.toBeNull();

    expect(await getPlatformAsset(created.assetId)).toBeNull();
    const listed = await listPlatformAssets({ query: title });
    expect(listed.rows).toHaveLength(0);

    const entries = await database
      .select({ action: schema.auditLog.action, reason: schema.auditLog.reason })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'platform_library'),
          eq(schema.auditLog.targetId, created.assetId),
        ),
      );
    expect(entries.map((entry) => entry.action)).toContain('platform_library.delete');
    expect(entries.find((entry) => entry.action === 'platform_library.delete')?.reason).toBe(
      'fixture is being deleted',
    );

    /* Every console verb now answers as for an unknown id. */
    expect(
      await refusalOf(
        deletePlatformAsset({ actor, assetId: created.assetId, reason: 'again' }),
      ),
    ).toBe('not_found');

    /* ...and a user asset is not the console's to delete. */
    const workspaceId = await workspaceOnPlan();
    const user = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'User asset',
      sourceType: 'website',
      location: 'https://api.example.test/reference/',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://api.example.test/reference/'),
      slug: `user-owned-${stamp}`,
    });
    assets.push(user.assetId);
    expect(
      await refusalOf(deletePlatformAsset({ actor, assetId: user.assetId, reason: 'no' })),
    ).toBe('not_platform_asset');
  });

  /*
   * aptos-anchoring-proposal.md 6: deleting an asset takes its proof with it.
   * The root stays on chain -- an append-only ledger has no other option -- but
   * without the leaf and its path nobody can show which version that root
   * committed to, which is the whole of what deletion can mean here and why
   * anchoring a private asset was acceptable at all.
   */
  it('takes the anchoring proof with the asset', async () => {
    const stamp = Date.now();
    const database = db();
    const workspaceId = await workspaceOnPlan();

    const created = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Anchored handbook',
      sourceType: 'website',
      location: 'https://docs.example.test/anchored',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/anchored'),
      slug: `anchored-deleted-${stamp}`,
    });
    assets.push(created.assetId);
    const built = await runOperation({ operationId: created.operationId!, dependencies: dependencies() });
    expect(built.status).toBe('succeeded');

    const [version] = await database
      .select({ id: schema.assetVersion.id })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, created.assetId));

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

    await deleteWorkspaceAsset({ workspaceId, role: 'owner', assetId: created.assetId });
    await purgeAsset({ assetId: created.assetId, dependencies: dependencies() });

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
