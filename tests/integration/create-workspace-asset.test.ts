/**
 * A workspace creating its own asset, end to end: the wizard's use case
 * writes the rows and queues the build, the drain builds and publishes it,
 * and the owner can query their private asset -- while the plan's asset
 * limit and public-id uniqueness refuse what they should.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { inNoChannel } from '../fixtures/channels';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const {
  createWorkspaceAsset,
  prepareUploads,
  updateAssetFiles,
  assetFiles,
  workspaceAssetDetail,
  requestAssetRebuild,
  listVersionDocuments,
  documentPreview,
} = await import('@/lib/application/assets');
const { fetchPdfSnapshot } = await import('@/lib/infrastructure/connectors/pdf');
const { readFile } = await import('node:fs/promises');
const { runOperation, memoryObjectStore, purgeAbandonedUploads } = await import(
  '@/lib/application/ingestion'
);
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const assets: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();

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
    async fetchSnapshot(input: { type: string; config?: Record<string, unknown> }) {
      /* The pdf connector is the real one, against the in-memory store: the
         upload path is what this test exists to cover end to end. */
      if (input.type === 'pdf') return fetchPdfSnapshot({ config: input.config ?? {}, store });
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
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'create-lib-test' });

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

describeWithDb('workspace asset creation', () => {
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
        .delete(schema.assetClaim)
        .where(inArray(schema.assetClaim.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
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

  it('creates, queues, builds and serves a private asset to its owner', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan();

    const created = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Team handbook',
      sourceType: 'website',
      location: 'https://docs.example.test/handbook',
      indexDepth: 3,
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/handbook'),
      slug: `handbook-${stamp}`,
      description: 'Internal onboarding notes',
      language: 'en',
    });
    assets.push(created.assetId);
    expect(created.publicId).toBe(`/websites/handbook-${stamp}`);

    const [row] = await db()
      .select()
      .from(schema.asset)
      .where(eq(schema.asset.id, created.assetId));
    expect(row?.ownerWorkspaceId).toBe(workspaceId);
    /* A new asset is in no channel and its owner's alone (agent-first-proposal.md 3.3, 6.2). */
    expect(row?.kind).toBe('website');
    expect(row?.access).toBe('free');
    expect(await inNoChannel(created.assetId)).toBe(true);
    expect(row?.lifecycleStatus).toBe('draft');

    const [source] = await db()
      .select({ config: schema.source.config })
      .from(schema.source)
      .where(eq(schema.source.assetId, created.assetId));
    expect(source?.config).toMatchObject({ indexDepth: 3 });

    /* The queued operation is the whole hand-off: the drain builds it. */
    const outcome = await runOperation({
      operationId: created.operationId!,
      dependencies: dependencies(),
    });
    expect(outcome.status).toBe('succeeded');

    /* The owner's detail page: ready, with the version and the run on it. */
    const detail = await workspaceAssetDetail({ workspaceId, assetId: created.assetId });
    expect(detail?.queryable).toBe(true);
    expect(detail?.building).toBe(false);
    expect(detail?.currentVersion?.chunks).toBeGreaterThan(0);
    expect(detail?.currentVersion?.documents).toBe(1);
    expect(detail?.versions[0]?.documents).toBe(1);

    /* The documents panel and the preview behind it. */
    const listed = await listVersionDocuments({ assetId: created.assetId, versionId: detail!.versions[0]!.id });
    expect(listed.total).toBe(1);
    expect(listed.documents[0]?.title).toBe('Team Handbook');
    expect(listed.documents[0]?.chunks).toBeGreaterThan(0);
    const preview = await documentPreview({ assetId: created.assetId, documentId: listed.documents[0]!.id });
    expect(preview?.chunks[0]?.body).toContain('quartzloft');
    expect(await documentPreview({ assetId: crypto.randomUUID(), documentId: listed.documents[0]!.id })).toBeNull();
    expect(detail?.operations[0]?.status).toBe('succeeded');
    expect(await workspaceAssetDetail({ workspaceId: crypto.randomUUID(), assetId: created.assetId })).toBeNull();

    /* A rebuild queues once; a second request while it waits reuses it. */
    const rebuild = await requestAssetRebuild({ workspaceId, role: 'owner', assetId: created.assetId });
    expect(rebuild.created).toBe(true);
    const again = await requestAssetRebuild({ workspaceId, role: 'owner', assetId: created.assetId });
    expect(again).toEqual({ operationId: rebuild.operationId, created: false });
    expect((await workspaceAssetDetail({ workspaceId, assetId: created.assetId }))?.building).toBe(true);
    await expect(
      requestAssetRebuild({ workspaceId, role: 'viewer', assetId: created.assetId }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect((await runOperation({ operationId: rebuild.operationId, dependencies: dependencies() })).status).toBe('skipped');

    /* Private: no review, so the build itself published the lifecycle and
       the owner can query it straight away (requirement.md 6.2). */
    const [afterBuild] = await db()
      .select({ lifecycleStatus: schema.asset.lifecycleStatus })
      .from(schema.asset)
      .where(eq(schema.asset.id, created.assetId));
    expect(afterBuild?.lifecycleStatus).toBe('published');

    const owner = { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: false };
    const output = await queryDocs(
      owner,
      { assetId: created.publicId, query: 'quartzloft onboarding', maxTokens: 4000, format: 'json' },
      noEmbeddings,
    );
    expect(output.chunks.length).toBeGreaterThan(0);

    /* A stranger still meets a 404-shaped refusal. */
    await expect(
      queryDocs(
        { workspaceId: null, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: true },
        { assetId: created.publicId, query: 'quartzloft', maxTokens: 4000, format: 'json' },
        noEmbeddings,
      ),
    ).rejects.toMatchObject({ code: 'library_not_found' });
  });

  it('creates an asset from uploaded PDFs and builds it from the store', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan();
    const bytes = new Uint8Array(await readFile(new URL('../fixtures/handbook.pdf', import.meta.url)));

    /* The wizard's two halves: room in the bucket, then the browser's PUT. */
    const prepared = await prepareUploads({
      workspaceId,
      role: 'owner',
      files: [{ name: 'Team Handbook.pdf', size: bytes.byteLength }],
      store,
    });
    for (const file of prepared.files) {
      if (file.ticket.kind !== 'put') throw new Error('the memory store issues PUT tickets');
      await store.put(
        file.ticket.url.replace(/^memory:\/\//, '').replace(/\?upload$/, ''),
        bytes,
        'application/pdf',
      );
    }
    const manifest = {
      batchId: prepared.batchId,
      files: prepared.files.map(({ id, name, size }) => ({ id, name, size })),
    };

    /* A manifest whose sizes do not match what landed is refused. */
    await expect(
      createWorkspaceAsset({
        role: 'owner',
        workspaceId,
        title: 'Handbook PDF',
        sourceType: 'pdf',
        location: '',
        slug: `handbook-pdf-${stamp}`,
        uploads: { ...manifest, files: manifest.files.map((file) => ({ ...file, size: file.size + 1 })) },
        store,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    const created = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Handbook PDF',
      sourceType: 'pdf',
      location: '',
      slug: `handbook-pdf-${stamp}`,
      uploads: manifest,
      language: 'en',
      store,
    });
    assets.push(created.assetId);
    expect(created.publicId).toBe(`/docs/handbook-pdf-${stamp}`);

    const [source] = await db()
      .select()
      .from(schema.source)
      .where(eq(schema.source.assetId, created.assetId));
    expect(source?.type).toBe('pdf');
    expect(source?.location).toBe(`uploads/${workspaceId}/${prepared.batchId}`);
    expect((source?.config as { files: { name: string }[] }).files[0]?.name).toBe('Team Handbook.pdf');

    const outcome = await runOperation({ operationId: created.operationId!, dependencies: dependencies() });
    expect(outcome.status).toBe('succeeded');

    const owner = { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: false };
    const output = await queryDocs(
      owner,
      { assetId: created.publicId, query: 'quartzloft onboarding', maxTokens: 4000, format: 'json' },
      noEmbeddings,
    );
    expect(output.chunks.length).toBeGreaterThan(0);
    expect(output.chunks[0]?.citation.documentTitle).toBe('Team Handbook');

    /* The sweep: an upload nobody claimed goes once it is old enough; the
       one this asset lists stays however old it is. */
    const orphan = `uploads/${workspaceId}/${crypto.randomUUID()}/${crypto.randomUUID()}.pdf`;
    await store.put(orphan, bytes, 'application/pdf');
    const claimed = prepared.files[0]!;
    const claimedKey = `uploads/${workspaceId}/${prepared.batchId}/${claimed.id}.pdf`;
    const future = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const before = await purgeAbandonedUploads({ dependencies: dependencies() });
    expect(before.deleted).toBe(0);
    const after = await purgeAbandonedUploads({ now: future, dependencies: dependencies() });
    expect(after.deleted).toBe(1);
    expect(await store.head(orphan)).toBeNull();
    expect(await store.head(claimedKey)).not.toBeNull();
  });

  it('creates an empty PDF asset, then fills it in from the files page and rebuilds', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan();
    const bytes = new Uint8Array(await readFile(new URL('../fixtures/handbook.pdf', import.meta.url)));

    /* No files, no build: the asset waits. */
    const created = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Later PDFs',
      sourceType: 'pdf',
      location: '',
      slug: `later-pdfs-${stamp}`,
      store,
    });
    assets.push(created.assetId);
    expect(created.operationId).toBeNull();
    const empty = await assetFiles({ workspaceId, assetId: created.assetId });
    expect(empty?.files).toEqual([]);
    expect(empty?.building).toBe(false);
    expect(
      await db()
        .select({ id: schema.workflowOperation.id })
        .from(schema.workflowOperation)
        .where(eq(schema.workflowOperation.assetId, created.assetId)),
    ).toHaveLength(0);

    /* Another workspace's asset is nobody's business: not found, not refused. */
    const stranger = await workspaceOnPlan();
    expect(await assetFiles({ workspaceId: stranger, assetId: created.assetId })).toBeNull();
    await expect(
      updateAssetFiles({ workspaceId: stranger, role: 'owner', assetId: created.assetId, remove: [crypto.randomUUID()] }),
    ).rejects.toMatchObject({ code: 'library_not_found' });

    /* Upload one file the same way the wizard does, then save it in. */
    const upload = async (name: string) => {
      const prepared = await prepareUploads({ workspaceId, role: 'owner', files: [{ name, size: bytes.byteLength }], store });
      for (const file of prepared.files) {
        if (file.ticket.kind !== 'put') throw new Error('the memory store issues PUT tickets');
        await store.put(file.ticket.url.replace(/^memory:\/\//, '').replace(/\?upload$/, ''), bytes, 'application/pdf');
      }
      return { batchId: prepared.batchId, files: prepared.files.map(({ id, name, size }) => ({ id, name, size })) };
    };
    const first = await updateAssetFiles({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      add: await upload('Team Handbook.pdf'),
      store,
    });
    expect(first.files.map((file) => file.name)).toEqual(['Team Handbook.pdf']);
    expect(first.operationId).not.toBeNull();
    expect((await assetFiles({ workspaceId, assetId: created.assetId }))?.building).toBe(true);

    /* A second edit while the build is still pending rides the same operation. */
    const second = await updateAssetFiles({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      add: await upload('Appendix.pdf'),
      store,
    });
    expect(second.files).toHaveLength(2);
    expect(second.operationId).toBe(first.operationId);

    const outcome = await runOperation({ operationId: first.operationId!, dependencies: dependencies() });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status === 'succeeded') expect(outcome.documents).toBe(2);

    /* Removing one after the build queues a fresh rebuild; removing a file
       the source does not list is refused. */
    const appendix = second.files.find((file) => file.name === 'Appendix.pdf')!;
    await expect(
      updateAssetFiles({ workspaceId, role: 'owner', assetId: created.assetId, remove: [crypto.randomUUID()] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const third = await updateAssetFiles({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      remove: [appendix.id],
    });
    expect(third.files.map((file) => file.name)).toEqual(['Team Handbook.pdf']);
    expect(third.operationId).not.toBeNull();
    expect(third.operationId).not.toBe(first.operationId);

    /* Emptying the list saves, but queues nothing. */
    const last = third.files[0]!;
    const fourth = await updateAssetFiles({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      remove: [last.id],
    });
    expect(fourth.files).toEqual([]);
    expect(fourth.operationId).toBeNull();

    /* A developer may look, not change. */
    await expect(
      updateAssetFiles({ workspaceId, role: 'developer', assetId: created.assetId, remove: [] }),
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('enforces public-id uniqueness', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan();

    const first = await createWorkspaceAsset({
      role: 'owner',
      workspaceId,
      title: 'Only one',
      sourceType: 'website',
      location: 'https://api.example.test/reference/',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://api.example.test/reference/'),
      slug: `only-one-${stamp}`,
    });
    assets.push(first.assetId);

    const other = await workspaceOnPlan();
    await expect(
      createWorkspaceAsset({
        role: 'owner',
        workspaceId: other,
        title: 'Duplicate id',
        sourceType: 'website',
        location: 'https://api.example.test/reference/',
        domainVerificationId: await verifiedDomain(other, 'https://api.example.test/reference/'),
        slug: `only-one-${stamp}`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    await expect(
      createWorkspaceAsset({
        role: 'owner',
        workspaceId: other,
        title: 'Bad location',
        sourceType: 'github',
        location: 'not a repository',
        slug: '',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
