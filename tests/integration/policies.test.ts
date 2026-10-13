/**
 * The Policy Engine against a real database. architecture.md 10: PATCH mints
 * immutable versions, Library Search filters candidates at the metadata
 * stage, Context Retrieval refuses with the stable reason code before
 * reserving anything, and an anonymous caller -- who has no workspace --
 * has no policy.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, inArray, sql } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.API_KEY_HASH_SECRET ??= 'test-api-key-hash-secret-000000000000';

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { resolveLibrary } = await import('@/lib/application/retrieval/resolve-library');
const { hashApiKey } = await import('@/lib/application/auth/api-key');
const { createPlatformLibrary } = await import(
  '@/lib/application/administration/manage-platform-libraries'
);
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { GET: policiesGet, PATCH: policiesPatch } = await import('@/app/api/v1/policies/route');
const { applyWorkspacePolicy, patchPolicy, pinPolicy, policyVerdictFor, policyVerdicts, previewWorkspacePolicy } =
  await import('@/lib/application/policies');
const { OPEN_POLICY } = await import('@/lib/domain/policy');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const created: string[] = [];
const workspaces: string[] = [];
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
const noResolveEmbeddings = {
  embeddings: () => {
    throw new Error('not configured');
  },
  configured: () => ({ embeddings: false }),
};

function caller(workspaceId: string | null, requestId = `req_${crypto.randomUUID()}`) {
  return { workspaceId, apiKeyId: null, requestId, anonymous: workspaceId === null };
}

function dependencies() {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/notes.md',
            url: 'https://example.test/notes',
            content:
              '# Policy Notes\n\nThe quarterly kelpwatch report covers unusual seaweed growth patterns.',
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

async function publishedLibrary(slug: string): Promise<string> {
  const { libraryId } = await createPlatformLibrary({
    actor,
    title: `Policy fixture ${slug}`,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://example.test/${slug}`,
    refreshPolicy: 'manual',
    language: 'en',
    reason: 'integration test fixture',
  });
  created.push(libraryId);
  const built = await buildVersion({ libraryId, operationId: uuidv7(), dependencies: dependencies() });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  await db()
    .update(schema.library)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.library.id, libraryId));
  return libraryId;
}

async function workspaceWithKey(): Promise<{ workspaceId: string; key: string }> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'policy-test' });

  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 100,
    libraryLimit: 10,
    librarySizeBytesLimit: 1_000_000,
    apiKeyLimit: 5,
    shareRateBps: 2000,
    capabilities: {},
    /* Backdated so the live catalogue's newest 'pro' version stays the seeded
       one -- these fixture rows must not win currentPlanVersion() races with
       the plan-configuration suite running in a parallel worker. */
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

  const key = `mm_test_${crypto.randomUUID().replace(/-/g, '')}`;
  await database.insert(schema.apiKey).values({
    id: uuidv7(),
    workspaceId,
    name: 'policy test key',
    keyHash: await hashApiKey(key),
    keyPrefix: 'mm_test_',
    lastFour: key.slice(-4),
    scopes: ['retrieval'],
    environment: 'test',
  });
  return { workspaceId, key };
}

/** A workspace row and nothing else: the policy store needs no plan or key. */
async function bareWorkspace(): Promise<string> {
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await db().insert(schema.workspace).values({ id: workspaceId, name: 'policy-normalize' });
  return workspaceId;
}

/** The stored row, which is what the evaluator will read on the next request. */
async function storedVersion(versionId: string) {
  const [row] = await db()
    .select()
    .from(schema.policyVersion)
    .where(eq(schema.policyVersion.id, versionId));
  return row;
}

/**
 * A routable library, inserted directly: the preview count is a statement
 * about stored facts, so the fixture states them rather than building them.
 */
async function plainLibrary(input: {
  publicId: string;
  visibility: 'public' | 'private';
  ownerWorkspaceId?: string | null;
  isPlatformLibrary?: boolean;
  sourceType?: string;
  location?: string;
  trustScore?: number;
  lastSuccessfulRefreshAt?: Date | null;
  indexStatus?: 'ready' | 'failed';
  currentVersion?: boolean;
}): Promise<string> {
  const database = db();
  const libraryId = crypto.randomUUID();
  created.push(libraryId);
  await database.insert(schema.library).values({
    id: libraryId,
    publicId: input.publicId,
    title: `Preview fixture ${input.publicId}`,
    ownerWorkspaceId: input.ownerWorkspaceId ?? null,
    isPlatformLibrary: input.isPlatformLibrary ?? false,
    visibility: input.visibility,
    lifecycleStatus: 'published',
    indexStatus: input.indexStatus ?? 'ready',
    lastSuccessfulRefreshAt: input.lastSuccessfulRefreshAt ?? null,
  });
  if (input.currentVersion !== false) {
    const versionId = uuidv7();
    await database.insert(schema.libraryVersion).values({
      id: versionId,
      libraryId,
      label: '20200101-aaaaaaaa',
      sourceDigest: 'digest',
      parserVersion: 'test',
      chunkerVersion: 'test',
      embeddingModel: 'test',
      indexStatus: 'ready',
    });
    await database
      .update(schema.library)
      .set({ currentVersionId: versionId })
      .where(eq(schema.library.id, libraryId));
  }
  if (input.sourceType) {
    await database.insert(schema.source).values({
      id: uuidv7(),
      libraryId,
      type: input.sourceType as 'website',
      location: input.location ?? 'https://example.test/fixture',
    });
  }
  if (input.trustScore !== undefined) {
    await database.insert(schema.libraryScore).values({
      id: uuidv7(),
      libraryId,
      algorithmVersion: 'test',
      trustScore: input.trustScore,
      benchmarkScore: 0,
    });
  }
  return libraryId;
}

/**
 * The same question `countReachableLibraries` answers, asked of the evaluator
 * itself: every routable candidate the workspace could reach, run through
 * `evaluatePolicy`. The SQL preview and this must agree exactly -- a
 * disagreement is the console showing a number retrieval will not honour.
 */
async function reachableByEvaluator(
  workspaceId: string,
  policy: Parameters<typeof policyVerdicts>[0],
): Promise<number> {
  const rows = await db()
    .select({ id: schema.library.id })
    .from(schema.library)
    .where(
      sql`${schema.library.deletedAt} is null
        and ${schema.library.lifecycleStatus} = 'published'
        and ${schema.library.indexStatus} = 'ready'
        and ${schema.library.currentVersionId} is not null
        and (${schema.library.visibility} = 'public'
          or (${schema.library.visibility} = 'private'
            and ${schema.library.ownerWorkspaceId} = ${workspaceId}))`,
    );
  const verdicts = await policyVerdicts(
    policy,
    rows.map((row) => row.id),
  );
  return [...verdicts.values()].filter((verdict) => verdict.allowed).length;
}

function patchRequest(key: string, body: unknown): NextRequest {
  return new NextRequest('https://api.example.test/api/v1/policies', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describeWithDb('policy engine', () => {
  afterAll(async () => {
    const database = db();
    if (created.length > 0) {
      await database
        .update(schema.library)
        .set({ currentVersionId: null })
        .where(inArray(schema.library.id, created));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.libraryId, created));
      await database
        .delete(schema.libraryProfileVector)
        .where(inArray(schema.libraryProfileVector.libraryId, created));
      await database
        .delete(schema.libraryProfile)
        .where(inArray(schema.libraryProfile.libraryId, created));
      await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, created));
      await database.delete(schema.document).where(inArray(schema.document.libraryId, created));
      await database
        .delete(schema.libraryVersion)
        .where(inArray(schema.libraryVersion.libraryId, created));
      await database
        .delete(schema.libraryScore)
        .where(inArray(schema.libraryScore.libraryId, created));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, created));
      await database
        .delete(schema.libraryAlias)
        .where(inArray(schema.libraryAlias.libraryId, created));
      await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, created));
      await database.delete(schema.library).where(inArray(schema.library.id, created));
    }
    if (workspaces.length > 0) {
      const versions = await database
        .select({ id: schema.policyVersion.id })
        .from(schema.policyVersion)
        .where(inArray(schema.policyVersion.workspaceId, workspaces));
      const versionIds = versions.map((row) => row.id);
      if (versionIds.length > 0) {
        await database
          .delete(schema.policyLibraryEntry)
          .where(inArray(schema.policyLibraryEntry.policyVersionId, versionIds));
        await database
          .delete(schema.policyVersion)
          .where(inArray(schema.policyVersion.id, versionIds));
      }
      await database
        .delete(schema.requestLog)
        .where(inArray(schema.requestLog.workspaceId, workspaces));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database
        .delete(schema.usageReservation)
        .where(inArray(schema.usageReservation.workspaceId, workspaces));
      await database.delete(schema.apiKey).where(inArray(schema.apiKey.workspaceId, workspaces));
      await database
        .delete(schema.subscription)
        .where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database
        .delete(schema.planVersion)
        .where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('stores an explicit quality mode for a draft that only carried a threshold', async () => {
    const workspaceId = await bareWorkspace();

    const response = await patchPolicy(
      workspaceId,
      { quality: { minTrustScore: 40 } },
      `req_${crypto.randomUUID()}`,
    );
    expect(response.policy.mode).toBe('quality');

    /* The row, not the return value: this is what the next request reads. */
    const row = await storedVersion(response.policyVersionId!);
    expect(row?.mode).toBe('quality');
    expect(row?.qualityFilters).toMatchObject({ minTrustScore: 40 });

    /* Read back and evaluated: the threshold the screen showed now bites. */
    const pinned = await pinPolicy(workspaceId);
    expect(pinned.policy.mode).toBe('quality');
    const stamp = Date.now();
    const low = await plainLibrary({
      publicId: `/normalize-${stamp}/low`,
      visibility: 'public',
      sourceType: 'website',
      trustScore: 10,
    });
    const high = await plainLibrary({
      publicId: `/normalize-${stamp}/high`,
      visibility: 'public',
      sourceType: 'website',
      trustScore: 90,
    });
    await expect(policyVerdictFor(pinned.policy, low)).resolves.toMatchObject({
      allowed: false,
      reason: 'below_trust_threshold',
    });
    await expect(policyVerdictFor(pinned.policy, high)).resolves.toMatchObject({ allowed: true });
  });

  it('stores an explicit quality mode for an always-allow entry alone', async () => {
    const workspaceId = await bareWorkspace();
    const response = await patchPolicy(
      workspaceId,
      { excepted: { add: ['/websites/anything'] } },
      `req_${crypto.randomUUID()}`,
    );
    expect((await storedVersion(response.policyVersionId!))?.mode).toBe('quality');
  });

  it('keeps a null mode for a policy that constrains nothing', async () => {
    const workspaceId = await bareWorkspace();
    const response = await patchPolicy(
      workspaceId,
      { blocked: { add: ['/websites/nope'] } },
      `req_${crypto.randomUUID()}`,
    );
    /* A blocklist is not a quality policy: it refuses by name, in any mode. */
    expect(response.policy.mode).toBeNull();
    expect((await storedVersion(response.policyVersionId!))?.mode).toBeNull();
    expect((await pinPolicy(workspaceId)).policy.mode).toBeNull();
  });

  it('never rewrites an explicit select policy', async () => {
    const workspaceId = await bareWorkspace();
    const response = await patchPolicy(
      workspaceId,
      {
        mode: 'select',
        allowed: { add: ['/websites/only-this'] },
        /* A leftover threshold from the quality controls must not promote it. */
        quality: { minTrustScore: 70 },
        excepted: { add: ['/websites/excepted'] },
      },
      `req_${crypto.randomUUID()}`,
    );
    expect(response.policy.mode).toBe('select');
    expect((await storedVersion(response.policyVersionId!))?.mode).toBe('select');
    expect((await pinPolicy(workspaceId)).policy.mode).toBe('select');
  });

  it('heals a legacy version stored with a null mode beside its thresholds', async () => {
    const workspaceId = await bareWorkspace();
    const legacyId = uuidv7();
    await db().insert(schema.policyVersion).values({
      id: legacyId,
      workspaceId,
      mode: null,
      sourceTypes: {},
      qualityFilters: { minTrustScore: 60 },
      appliedAt: new Date(),
    });

    /* Read as what it enforces, without the row being rewritten under it. */
    const pinned = await pinPolicy(workspaceId);
    expect(pinned.versionId).toBe(legacyId);
    expect(pinned.policy.mode).toBe('quality');
    expect((await storedVersion(legacyId))?.mode).toBeNull();

    const stamp = Date.now();
    const low = await plainLibrary({
      publicId: `/legacy-${stamp}/low`,
      visibility: 'public',
      sourceType: 'website',
      trustScore: 5,
    });
    await expect(policyVerdictFor(pinned.policy, low)).resolves.toMatchObject({
      allowed: false,
      reason: 'below_trust_threshold',
    });

    /* The next patch mints a version that says so explicitly. */
    const next = await patchPolicy(workspaceId, { blocked: { add: ['/websites/x'] } }, 'req_heal');
    expect((await storedVersion(next.policyVersionId!))?.mode).toBe('quality');
    expect((await storedVersion(next.policyVersionId!))?.qualityFilters).toMatchObject({
      minTrustScore: 60,
    });
  });

  it('leaves the previous version byte for byte, and a pinned request with it', async () => {
    const workspaceId = await bareWorkspace();
    const stamp = Date.now();
    const library = await plainLibrary({
      publicId: `/immutable-${stamp}/lib`,
      visibility: 'public',
      sourceType: 'website',
      trustScore: 30,
    });

    const first = await patchPolicy(workspaceId, { quality: { minTrustScore: 10 } }, 'req_v1');
    const v1Row = await storedVersion(first.policyVersionId!);
    /* The request that started here keeps this policy for its whole life. */
    const pinnedByRequest = await pinPolicy(workspaceId);

    const second = await patchPolicy(workspaceId, { quality: { minTrustScore: 90 } }, 'req_v2');
    expect(second.policyVersionId).not.toBe(first.policyVersionId);

    /* The old row is untouched and still readable. */
    expect(await storedVersion(first.policyVersionId!)).toEqual(v1Row);
    expect(v1Row?.qualityFilters).toMatchObject({ minTrustScore: 10 });

    /* The in-flight request still resolves against what it pinned. */
    await expect(policyVerdictFor(pinnedByRequest.policy, library)).resolves.toMatchObject({
      allowed: true,
    });
    /* A request starting now pins the newer one and refuses. */
    const nowPinned = await pinPolicy(workspaceId);
    expect(nowPinned.versionId).toBe(second.policyVersionId);
    await expect(policyVerdictFor(nowPinned.policy, library)).resolves.toMatchObject({
      allowed: false,
      reason: 'below_trust_threshold',
    });
  });

  it('previews exactly the libraries the evaluator admits', async () => {
    const stamp = Date.now();
    const workspaceId = await bareWorkspace();
    const org = `Vercel${stamp}`;

    /* A mixed set: public and private, above and below the threshold,
       list-covered and not, and four different source types. */
    await plainLibrary({
      publicId: `/${org}/next.js`,
      visibility: 'public',
      sourceType: 'github',
      location: 'https://github.com/vercel/next.js',
      trustScore: 80,
    });
    await plainLibrary({
      publicId: `/preview-${stamp}/docs`,
      visibility: 'public',
      sourceType: 'website',
      location: 'https://docs.example-preview.test/guide',
      trustScore: 20,
    });
    await plainLibrary({
      publicId: `/preview-${stamp}/mine`,
      visibility: 'private',
      ownerWorkspaceId: workspaceId,
      sourceType: 'pdf',
      location: 'upload://fixture.pdf',
      trustScore: 95,
    });
    await plainLibrary({
      publicId: `/preview-${stamp}/notion`,
      visibility: 'public',
      sourceType: 'notion',
      location: 'https://notion.so/fixture',
      trustScore: 55,
    });
    await plainLibrary({
      publicId: `/preview-${stamp}/blocked`,
      visibility: 'public',
      sourceType: 'website',
      location: 'https://blocked-preview.test/x',
      trustScore: 70,
    });
    /* Not routable: neither the count nor the evaluator's candidate set. */
    await plainLibrary({
      publicId: `/preview-${stamp}/unready`,
      visibility: 'public',
      sourceType: 'website',
      trustScore: 99,
      indexStatus: 'failed',
    });
    /* Someone else's private library: invisible to this workspace either way. */
    const otherWorkspace = await bareWorkspace();
    await plainLibrary({
      publicId: `/preview-${stamp}/theirs`,
      visibility: 'private',
      ownerWorkspaceId: otherWorkspace,
      sourceType: 'website',
      trustScore: 99,
    });

    const drafts: Record<string, typeof OPEN_POLICY> = {
      open: OPEN_POLICY,
      trust: { ...OPEN_POLICY, mode: 'quality', quality: { ...OPEN_POLICY.quality, minTrustScore: 50 } },
      trustWithException: {
        ...OPEN_POLICY,
        mode: 'quality',
        quality: { ...OPEN_POLICY.quality, minTrustScore: 50 },
        exceptedLibraries: [`/preview-${stamp}/docs`],
      },
      /* Case folding: a typed `vercel` entry must reach `/Vercel/next.js`. */
      selectOrganisation: {
        ...OPEN_POLICY,
        mode: 'select',
        allowedLibraries: [`/${org.toLowerCase()}/*`],
      },
      blockedByName: {
        ...OPEN_POLICY,
        blockedLibraries: [`/preview-${stamp}/blocked`],
      },
      blockedByDomain: {
        ...OPEN_POLICY,
        blockedLibraries: ['example-preview.test'],
      },
      noNotionNoPrivate: {
        ...OPEN_POLICY,
        sourceTypes: { notion: false, private: false },
      },
      verifiedOnly: { ...OPEN_POLICY, mode: 'quality', quality: { ...OPEN_POLICY.quality, requireVerified: true } },
    };

    for (const [name, draft] of Object.entries(drafts)) {
      const previewed = await previewWorkspacePolicy({ workspaceId, draft });
      const evaluated = await reachableByEvaluator(workspaceId, draft);
      expect(`${name}: ${previewed}`).toBe(`${name}: ${evaluated}`);
    }

    /* And the case-folded allowlist really does reach the mixed-case id. */
    const selected = await previewWorkspacePolicy({
      workspaceId,
      draft: drafts.selectOrganisation,
    });
    expect(selected).toBe(1);
  });

  it('previews a freshness threshold the way the evaluator ages a library', async () => {
    const stamp = Date.now();
    const workspaceId = await bareWorkspace();
    await plainLibrary({
      publicId: `/fresh-${stamp}/yesterday`,
      visibility: 'public',
      sourceType: 'website',
      trustScore: 50,
      lastSuccessfulRefreshAt: new Date(Date.now() - 1 * 86_400_000),
    });
    await plainLibrary({
      publicId: `/fresh-${stamp}/last-month`,
      visibility: 'public',
      sourceType: 'website',
      trustScore: 50,
      lastSuccessfulRefreshAt: new Date(Date.now() - 30 * 86_400_000),
    });
    /* Never refreshed: an unknown age passes, in SQL and in the evaluator. */
    await plainLibrary({
      publicId: `/fresh-${stamp}/never`,
      visibility: 'public',
      sourceType: 'website',
      trustScore: 50,
    });

    for (const maxAgeDays of [1, 7, 365]) {
      const draft = {
        ...OPEN_POLICY,
        mode: 'quality' as const,
        quality: { ...OPEN_POLICY.quality, maxAgeDays },
      };
      const previewed = await previewWorkspacePolicy({ workspaceId, draft });
      const evaluated = await reachableByEvaluator(workspaceId, draft);
      expect(`${maxAgeDays}d: ${previewed}`).toBe(`${maxAgeDays}d: ${evaluated}`);
    }
  });

  it('applies a console draft as one patch, and refuses a role that may not', async () => {
    const workspaceId = await bareWorkspace();
    const base = { ...OPEN_POLICY };
    const draft = {
      ...OPEN_POLICY,
      /* The screen never asked for a mode; the threshold is the whole edit. */
      quality: { ...OPEN_POLICY.quality, minTrustScore: 65 },
    };

    await expect(
      applyWorkspacePolicy({ workspaceId, role: 'viewer', base, draft }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    await expect(
      applyWorkspacePolicy({ workspaceId, role: 'developer', base, draft }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(await db().select().from(schema.policyVersion).where(eq(schema.policyVersion.workspaceId, workspaceId))).toHaveLength(0);

    const applied = await applyWorkspacePolicy({ workspaceId, role: 'admin', base, draft });
    expect(applied.policy.mode).toBe('quality');
    expect((await storedVersion(applied.versionId!))?.mode).toBe('quality');

    /* An unchanged draft is not an edit: no second version is minted. */
    const again = await applyWorkspacePolicy({
      workspaceId,
      role: 'owner',
      base: applied.policy,
      draft: applied.policy,
    });
    expect(again.versionId).toBe(applied.versionId);
    const rows = await db()
      .select()
      .from(schema.policyVersion)
      .where(eq(schema.policyVersion.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
  });

  it('mints immutable versions through PATCH and reads them back', async () => {
    const { workspaceId, key } = await workspaceWithKey();

    const first = await policiesPatch(
      patchRequest(key, { blocked: { add: ['/websites/somewhere'] } }),
    );
    expect(first.status).toBe(200);
    const v1 = (await first.json()) as { policyVersionId: string; policy: { blockedLibraries: string[] } };
    expect(v1.policy.blockedLibraries).toEqual(['/websites/somewhere']);

    const second = await policiesPatch(
      patchRequest(key, { mode: 'quality', quality: { minTrustScore: 50 } }),
    );
    const v2 = (await second.json()) as {
      policyVersionId: string;
      policy: { mode: string; blockedLibraries: string[] };
    };
    expect(v2.policyVersionId).not.toBe(v1.policyVersionId);
    /* Incremental: the block list survives a patch that never mentioned it. */
    expect(v2.policy.blockedLibraries).toEqual(['/websites/somewhere']);

    const rows = await db()
      .select({ id: schema.policyVersion.id })
      .from(schema.policyVersion)
      .where(eq(schema.policyVersion.workspaceId, workspaceId));
    expect(rows).toHaveLength(2);

    const got = await policiesGet(
      new NextRequest('https://api.example.test/api/v1/policies', {
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    const current = (await got.json()) as { policyVersionId: string };
    expect(current.policyVersionId).toBe(v2.policyVersionId);
  });

  it('blocks context retrieval with the stable reason, and only for that workspace', async () => {
    const stamp = Date.now();
    await publishedLibrary(`policy-block-${stamp}`);
    const { workspaceId, key } = await workspaceWithKey();
    await policiesPatch(patchRequest(key, { blocked: { add: [`/websites/policy-block-${stamp}`] } }));

    const input = {
      libraryId: `/websites/policy-block-${stamp}`,
      query: 'kelpwatch report',
      maxTokens: 4000,
      format: 'json' as const,
    };
    await expect(queryDocs(caller(workspaceId), input, noEmbeddings)).rejects.toMatchObject({
      code: 'access_rule_blocked',
      message: 'library_blocked',
    });

    /* No seat was reserved for a policy refusal. */
    const reservations = await db()
      .select()
      .from(schema.usageReservation)
      .where(eq(schema.usageReservation.workspaceId, workspaceId));
    expect(reservations).toHaveLength(0);

    /* The block is the workspace's own preference: anonymous still reads. */
    const open = await queryDocs(caller(null), input, noEmbeddings);
    expect(open.chunks.length).toBeGreaterThan(0);
  });

  it('filters search candidates at the metadata stage', async () => {
    const stamp = Date.now();
    await publishedLibrary(`policy-search-${stamp}`);
    const { workspaceId, key } = await workspaceWithKey();

    const before = await resolveLibrary(
      caller(workspaceId),
      { query: 'kelpwatch seaweed growth' },
      noResolveEmbeddings,
    );
    expect(before.results.map((r) => r.libraryId)).toContain(`/websites/policy-search-${stamp}`);

    await policiesPatch(
      patchRequest(key, { blocked: { add: [`/websites/policy-search-${stamp}`] } }),
    );
    const after = await resolveLibrary(
      caller(workspaceId),
      { query: 'kelpwatch seaweed growth' },
      noResolveEmbeddings,
    );
    expect(after.results.map((r) => r.libraryId)).not.toContain(
      `/websites/policy-search-${stamp}`,
    );
  });

  it('select mode admits only the allowlist, and excepted bypasses quality only', async () => {
    const stamp = Date.now();
    await publishedLibrary(`policy-sel-a-${stamp}`);
    await publishedLibrary(`policy-sel-b-${stamp}`);
    const { workspaceId, key } = await workspaceWithKey();
    await policiesPatch(
      patchRequest(key, {
        mode: 'select',
        allowed: { add: [`/websites/policy-sel-a-${stamp}`] },
      }),
    );

    const query = (slug: string) =>
      queryDocs(
        caller(workspaceId),
        { libraryId: `/websites/${slug}`, query: 'kelpwatch', maxTokens: 4000, format: 'json' as const },
        noEmbeddings,
      );
    await expect(query(`policy-sel-b-${stamp}`)).rejects.toMatchObject({
      code: 'access_rule_blocked',
      message: 'not_in_allowlist',
    });
    const allowed = await query(`policy-sel-a-${stamp}`);
    expect(allowed.chunks.length).toBeGreaterThan(0);

    /* Quality mode: an impossible threshold blocks all but the excepted. */
    await policiesPatch(
      patchRequest(key, {
        mode: 'quality',
        quality: { minTrustScore: 100 },
        excepted: { add: [`/websites/policy-sel-b-${stamp}`] },
      }),
    );
    await expect(query(`policy-sel-a-${stamp}`)).rejects.toMatchObject({
      message: 'below_trust_threshold',
    });
    const excepted = await query(`policy-sel-b-${stamp}`);
    expect(excepted.chunks.length).toBeGreaterThan(0);
  });
});
