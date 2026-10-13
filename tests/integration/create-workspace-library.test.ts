/**
 * A workspace creating its own library, end to end: the wizard's use case
 * writes the rows and queues the build, the drain builds and publishes it,
 * and the owner can query their private library -- while the plan's library
 * limit and public-id uniqueness refuse what they should.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const {
  createWorkspaceLibrary,
  prepareUploads,
  updateLibraryFiles,
  libraryFiles,
  workspaceLibraryDetail,
  requestLibraryRebuild,
  listVersionDocuments,
  documentPreview,
} = await import('@/lib/application/libraries');
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
const libraries: string[] = [];
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

async function workspaceOnPlan(libraryLimit: number): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'create-lib-test' });

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

describeWithDb('workspace library creation', () => {
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
        .delete(schema.libraryClaim)
        .where(inArray(schema.libraryClaim.libraryId, libraries));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, libraries));
      await database.delete(schema.library).where(inArray(schema.library.id, libraries));
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

  it('creates, queues, builds and serves a private library to its owner', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan(5);

    const created = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Team handbook',
      visibility: 'private',
      sourceType: 'website',
      location: 'https://docs.example.test/handbook',
      indexDepth: 3,
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/handbook'),
      slug: `handbook-${stamp}`,
      description: 'Internal onboarding notes',
      language: 'en',
    });
    libraries.push(created.libraryId);
    expect(created.publicId).toBe(`/websites/handbook-${stamp}`);

    const [row] = await db()
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, created.libraryId));
    expect(row?.ownerWorkspaceId).toBe(workspaceId);
    expect(row?.visibility).toBe('private');
    expect(row?.lifecycleStatus).toBe('draft');

    const [source] = await db()
      .select({ config: schema.source.config })
      .from(schema.source)
      .where(eq(schema.source.libraryId, created.libraryId));
    expect(source?.config).toMatchObject({ indexDepth: 3 });

    /* The queued operation is the whole hand-off: the drain builds it. */
    const outcome = await runOperation({
      operationId: created.operationId!,
      dependencies: dependencies(),
    });
    expect(outcome.status).toBe('succeeded');

    /* The owner's detail page: ready, with the version and the run on it. */
    const detail = await workspaceLibraryDetail({ workspaceId, libraryId: created.libraryId });
    expect(detail?.queryable).toBe(true);
    expect(detail?.building).toBe(false);
    expect(detail?.currentVersion?.chunks).toBeGreaterThan(0);
    expect(detail?.currentVersion?.documents).toBe(1);
    expect(detail?.versions[0]?.documents).toBe(1);

    /* The documents panel and the preview behind it. */
    const listed = await listVersionDocuments({ libraryId: created.libraryId, versionId: detail!.versions[0]!.id });
    expect(listed.total).toBe(1);
    expect(listed.documents[0]?.title).toBe('Team Handbook');
    expect(listed.documents[0]?.chunks).toBeGreaterThan(0);
    const preview = await documentPreview({ libraryId: created.libraryId, documentId: listed.documents[0]!.id });
    expect(preview?.chunks[0]?.body).toContain('quartzloft');
    expect(await documentPreview({ libraryId: crypto.randomUUID(), documentId: listed.documents[0]!.id })).toBeNull();
    expect(detail?.operations[0]?.status).toBe('succeeded');
    expect(await workspaceLibraryDetail({ workspaceId: crypto.randomUUID(), libraryId: created.libraryId })).toBeNull();

    /* A rebuild queues once; a second request while it waits reuses it. */
    const rebuild = await requestLibraryRebuild({ workspaceId, role: 'owner', libraryId: created.libraryId });
    expect(rebuild.created).toBe(true);
    const again = await requestLibraryRebuild({ workspaceId, role: 'owner', libraryId: created.libraryId });
    expect(again).toEqual({ operationId: rebuild.operationId, created: false });
    expect((await workspaceLibraryDetail({ workspaceId, libraryId: created.libraryId }))?.building).toBe(true);
    await expect(
      requestLibraryRebuild({ workspaceId, role: 'viewer', libraryId: created.libraryId }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect((await runOperation({ operationId: rebuild.operationId, dependencies: dependencies() })).status).toBe('skipped');

    /* Private: no review, so the build itself published the lifecycle and
       the owner can query it straight away (requirement.md 6.2). */
    const [afterBuild] = await db()
      .select({ lifecycleStatus: schema.library.lifecycleStatus })
      .from(schema.library)
      .where(eq(schema.library.id, created.libraryId));
    expect(afterBuild?.lifecycleStatus).toBe('published');

    const owner = { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: false };
    const output = await queryDocs(
      owner,
      { libraryId: created.publicId, query: 'quartzloft onboarding', maxTokens: 4000, format: 'json' },
      noEmbeddings,
    );
    expect(output.chunks.length).toBeGreaterThan(0);

    /* A stranger still meets a 404-shaped refusal. */
    await expect(
      queryDocs(
        { workspaceId: null, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: true },
        { libraryId: created.publicId, query: 'quartzloft', maxTokens: 4000, format: 'json' },
        noEmbeddings,
      ),
    ).rejects.toMatchObject({ code: 'library_not_found' });
  });

  it('creates a library from uploaded PDFs and builds it from the store', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan(5);
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
      createWorkspaceLibrary({
        role: 'owner',
        workspaceId,
        title: 'Handbook PDF',
        visibility: 'private',
        sourceType: 'pdf',
        location: '',
        slug: `handbook-pdf-${stamp}`,
        uploads: { ...manifest, files: manifest.files.map((file) => ({ ...file, size: file.size + 1 })) },
        store,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    const created = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Handbook PDF',
      visibility: 'private',
      sourceType: 'pdf',
      location: '',
      slug: `handbook-pdf-${stamp}`,
      uploads: manifest,
      language: 'en',
      store,
    });
    libraries.push(created.libraryId);
    expect(created.publicId).toBe(`/docs/handbook-pdf-${stamp}`);

    const [source] = await db()
      .select()
      .from(schema.source)
      .where(eq(schema.source.libraryId, created.libraryId));
    expect(source?.type).toBe('pdf');
    expect(source?.location).toBe(`uploads/${workspaceId}/${prepared.batchId}`);
    expect((source?.config as { files: { name: string }[] }).files[0]?.name).toBe('Team Handbook.pdf');

    const outcome = await runOperation({ operationId: created.operationId!, dependencies: dependencies() });
    expect(outcome.status).toBe('succeeded');

    const owner = { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: false };
    const output = await queryDocs(
      owner,
      { libraryId: created.publicId, query: 'quartzloft onboarding', maxTokens: 4000, format: 'json' },
      noEmbeddings,
    );
    expect(output.chunks.length).toBeGreaterThan(0);
    expect(output.chunks[0]?.citation.documentTitle).toBe('Team Handbook');

    /* The sweep: an upload nobody claimed goes once it is old enough; the
       one this library lists stays however old it is. */
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

  it('creates an empty PDF library, then fills it in from the files page and rebuilds', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan(5);
    const bytes = new Uint8Array(await readFile(new URL('../fixtures/handbook.pdf', import.meta.url)));

    /* No files, no build: the library waits. */
    const created = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Later PDFs',
      visibility: 'private',
      sourceType: 'pdf',
      location: '',
      slug: `later-pdfs-${stamp}`,
      store,
    });
    libraries.push(created.libraryId);
    expect(created.operationId).toBeNull();
    const empty = await libraryFiles({ workspaceId, libraryId: created.libraryId });
    expect(empty?.files).toEqual([]);
    expect(empty?.building).toBe(false);
    expect(
      await db()
        .select({ id: schema.workflowOperation.id })
        .from(schema.workflowOperation)
        .where(eq(schema.workflowOperation.libraryId, created.libraryId)),
    ).toHaveLength(0);

    /* Another workspace's library is nobody's business: not found, not refused. */
    const stranger = await workspaceOnPlan(5);
    expect(await libraryFiles({ workspaceId: stranger, libraryId: created.libraryId })).toBeNull();
    await expect(
      updateLibraryFiles({ workspaceId: stranger, role: 'owner', libraryId: created.libraryId, remove: [crypto.randomUUID()] }),
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
    const first = await updateLibraryFiles({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      add: await upload('Team Handbook.pdf'),
      store,
    });
    expect(first.files.map((file) => file.name)).toEqual(['Team Handbook.pdf']);
    expect(first.operationId).not.toBeNull();
    expect((await libraryFiles({ workspaceId, libraryId: created.libraryId }))?.building).toBe(true);

    /* A second edit while the build is still pending rides the same operation. */
    const second = await updateLibraryFiles({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
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
      updateLibraryFiles({ workspaceId, role: 'owner', libraryId: created.libraryId, remove: [crypto.randomUUID()] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const third = await updateLibraryFiles({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      remove: [appendix.id],
    });
    expect(third.files.map((file) => file.name)).toEqual(['Team Handbook.pdf']);
    expect(third.operationId).not.toBeNull();
    expect(third.operationId).not.toBe(first.operationId);

    /* Emptying the list saves, but queues nothing. */
    const last = third.files[0]!;
    const fourth = await updateLibraryFiles({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      remove: [last.id],
    });
    expect(fourth.files).toEqual([]);
    expect(fourth.operationId).toBeNull();

    /* A developer may look, not change. */
    await expect(
      updateLibraryFiles({ workspaceId, role: 'developer', libraryId: created.libraryId, remove: [] }),
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('enforces the plan limit and public-id uniqueness', async () => {
    const stamp = Date.now();
    const workspaceId = await workspaceOnPlan(1);

    const first = await createWorkspaceLibrary({
      role: 'owner',
      workspaceId,
      title: 'Only one',
      visibility: 'private',
      sourceType: 'openapi',
      location: 'https://api.example.test/openapi.json',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://api.example.test/openapi.json'),
      slug: `only-one-${stamp}`,
    });
    libraries.push(first.libraryId);

    await expect(
      createWorkspaceLibrary({
        role: 'owner',
        workspaceId,
        title: 'Second',
        visibility: 'private',
        sourceType: 'openapi',
        location: 'https://api.example.test/openapi.json',
        domainVerificationId: await verifiedDomain(workspaceId, 'https://api.example.test/openapi.json'),
        slug: `second-${stamp}`,
      }),
    ).rejects.toMatchObject({ code: 'library_limit_exceeded' });

    const other = await workspaceOnPlan(5);
    await expect(
      createWorkspaceLibrary({
        role: 'owner',
      workspaceId: other,
        title: 'Duplicate id',
        visibility: 'private',
        sourceType: 'openapi',
        location: 'https://api.example.test/openapi.json',
        domainVerificationId: await verifiedDomain(other, 'https://api.example.test/openapi.json'),
        slug: `only-one-${stamp}`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    await expect(
      createWorkspaceLibrary({
        role: 'owner',
      workspaceId: other,
        title: 'Bad location',
        visibility: 'private',
        sourceType: 'github',
        location: 'not a repository',
        slug: '',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
