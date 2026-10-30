/**
 * Nested Asset IDs against a real database (requirement.md 6.1): a
 * workspace publishes `/websites/x` and `/websites/x/sub` as two assets,
 * each answers under its own id, and a trailing segment that is not an asset
 * still pins a version of the asset before it.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { createWorkspaceAsset } = await import('@/lib/application/assets');
const { runOperation, memoryObjectStore } = await import('@/lib/application/ingestion');
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const assets: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();

const nullCache = { get: async () => null, set: async () => {}, invalidateTag: async () => {} };
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

function dependencies(content: string) {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/page.md',
            url: 'https://docs.example.test/page',
            content,
            fetchedVia: 'firecrawl' as const,
          },
          {
            path: 'docs/index.md',
            url: 'https://docs.example.test/',
            content: `# Index\n\nSee the page. ${content.length}`,
            fetchedVia: 'direct' as const,
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
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'nested-id-test' });
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

async function publish(workspaceId: string, slug: string, content: string) {
  const created = await createWorkspaceAsset({
    role: 'owner',
    workspaceId,
    title: slug,
    sourceType: 'website',
    location: `https://docs.example.test/${slug}`,
    domainVerificationId: await verifiedDomain(workspaceId, `https://docs.example.test/${slug}`),
    slug,
  });
  assets.push(created.assetId);
  const built = await runOperation({
    operationId: created.operationId!,
    dependencies: dependencies(content),
  });
  expect(built.status).toBe('succeeded');
  await db()
    .update(schema.asset)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.asset.id, created.assetId));
  return created;
}

describeWithDb('nested asset ids', () => {
  afterAll(async () => {
    const database = db();
    if (assets.length > 0) {
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.assetId, assets));
      await database.update(schema.asset).set({ currentVersionId: null }).where(inArray(schema.asset.id, assets));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.assetId, assets));
      await database.delete(schema.assetProfileVector).where(inArray(schema.assetProfileVector.assetId, assets));
      await database.delete(schema.assetProfile).where(inArray(schema.assetProfile.assetId, assets));
      await database.delete(schema.chunk).where(inArray(schema.chunk.assetId, assets));
      await database.delete(schema.document).where(inArray(schema.document.assetId, assets));
      await database.delete(schema.assetVersion).where(inArray(schema.assetVersion.assetId, assets));
      await database.delete(schema.assetScore).where(inArray(schema.assetScore.assetId, assets));
      await database
        .delete(schema.assetClaim)
        .where(inArray(schema.assetClaim.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.requestLog).where(inArray(schema.requestLog.workspaceId, workspaces));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database.delete(schema.usageReservation).where(inArray(schema.usageReservation.workspaceId, workspaces));
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

  it('serves a parent and its nested asset under their own ids, and still pins versions', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan();
    const parentSlug = `chain-${stamp}`;

    const parent = await publish(
      workspaceId,
      parentSlug,
      '# Chain\n\nThe glimmerstone consensus overview lives in the parent asset.',
    );
    const child = await publish(
      workspaceId,
      `${parentSlug}/whitepaper`,
      '# Whitepaper\n\nThe zephyrnode whitepaper is the nested asset.',
    );
    expect(parent.publicId).toBe(`/websites/${parentSlug}`);
    expect(child.publicId).toBe(`/websites/${parentSlug}/whitepaper`);

    /* The build recorded how its pages were fetched, for the refresh queue. */
    const [operation] = await db()
      .select({ fetchSummary: schema.workflowOperation.fetchSummary })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, parent.operationId!));
    expect(operation?.fetchSummary).toEqual({ direct: 1, rendered: 1, renderer: 'firecrawl' });

    const owner = { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: false };
    const ask = (assetId: string, query: string) =>
      queryDocs(owner, { assetId, query, maxTokens: 4000, format: 'json' }, noEmbeddings);

    /* Each id answers from its own content. */
    const fromChild = await ask(child.publicId, 'zephyrnode whitepaper');
    expect(fromChild.chunks.length).toBeGreaterThan(0);
    expect(fromChild.chunks.every((chunk) => chunk.text.includes('zephyrnode'))).toBe(true);
    const fromParent = await ask(parent.publicId, 'glimmerstone consensus');
    expect(fromParent.chunks.length).toBeGreaterThan(0);
    expect(fromParent.chunks.every((chunk) => chunk.text.includes('glimmerstone'))).toBe(true);

    /* A trailing segment that is not an asset pins a version of the one before it. */
    const [version] = await db()
      .select({ label: schema.assetVersion.label })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, parent.assetId));
    const pinned = await ask(`${parent.publicId}/${version!.label}`, 'glimmerstone consensus');
    expect(pinned.chunks.length).toBeGreaterThan(0);
    expect(pinned.chunks.every((chunk) => chunk.text.includes('glimmerstone'))).toBe(true);

    /* ...and one that is neither is nothing. */
    await expect(ask(`${parent.publicId}/nothing-here`, 'glimmerstone')).rejects.toMatchObject({
      code: 'library_not_found',
    });

    /* A slug shaped like a version label is refused at creation. */
    await expect(
      createWorkspaceAsset({
        role: 'owner',
        workspaceId,
        title: 'Shadow',
        sourceType: 'website',
        location: 'https://docs.example.test/shadow',
        domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/shadow'),
        slug: `${parentSlug}/${version!.label}`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
