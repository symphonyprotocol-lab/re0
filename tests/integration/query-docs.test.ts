/**
 * Retrieval within one asset, against a real database. architecture.md 9.2
 * and 11.1 together, because the order is the point: visibility before
 * reservation, reservation before recall, and exactly one usage event per
 * admitted call however the request is retried.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { unshare } from '../fixtures/channels';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { usageOverview } = await import('@/lib/application/plans/usage');
const { createPlatformAsset } = await import(
  '@/lib/application/administration/manage-platform-assets'
);
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { DEFAULT_RETRIEVAL_SETTINGS } = await import('@/lib/domain/retrieval-config');

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

const FILES = [
  {
    path: 'docs/beetles.md',
    url: 'https://example.test/beetles',
    content:
      '# Rove beetles\n\nParaphrased advice on rove beetle exposure: avoid crushing the insect against skin.\n\n## Treatment\n\nRinse the area with water and consult a doctor if blisters appear.',
  },
  {
    path: 'docs/moths.md',
    url: 'https://example.test/moths',
    content: '# Moths\n\nMoths navigate by moonlight and are drawn to lamps at night.',
  },
];

function dependenciesFor(files: typeof FILES) {
  return {
    async fetchSnapshot() {
      return {
        files,
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

async function publishedAsset(slug: string, files = FILES): Promise<string> {
  const { assetId } = await createPlatformAsset({
    actor,
    title: `Query fixture ${slug}`,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://example.test/${slug}`,
    refreshPolicy: 'manual',
    language: 'en',
    reason: 'integration test fixture',
  });
  created.push(assetId);
  const built = await buildVersion({
    assetId,
    operationId: uuidv7(),
    dependencies: dependenciesFor(files),
  });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ assetId, versionId: built.versionId });
  await db()
    .update(schema.asset)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.asset.id, assetId));
  return assetId;
}

/** A workspace subscribed to a plan version with the given allowance. */
async function workspaceOnPlan(monthlyCalls: number): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'query-docs-test' });

  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'free',
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls,
    apiKeyLimit: 5,
    capabilities: {},
    /* Backdated so the live catalogue's newest 'free' version stays the seeded
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
  return workspaceId;
}

function caller(workspaceId: string | null, requestId = `req_${crypto.randomUUID()}`) {
  return { workspaceId, apiKeyId: null, requestId, anonymous: workspaceId === null };
}

describeWithDb('query-docs', () => {
  afterAll(async () => {
    const database = db();
    if (created.length > 0) {
      await database
        .update(schema.asset)
        .set({ currentVersionId: null })
        .where(inArray(schema.asset.id, created));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.assetId, created));
      await database
        .delete(schema.assetProfileVector)
        .where(inArray(schema.assetProfileVector.assetId, created));
      await database
        .delete(schema.assetProfile)
        .where(inArray(schema.assetProfile.assetId, created));
      await database.delete(schema.chunk).where(inArray(schema.chunk.assetId, created));
      await database.delete(schema.document).where(inArray(schema.document.assetId, created));
      await database
        .delete(schema.assetVersion)
        .where(inArray(schema.assetVersion.assetId, created));
      await database
        .delete(schema.assetScore)
        .where(inArray(schema.assetScore.assetId, created));
      await database.delete(schema.source).where(inArray(schema.source.assetId, created));
      await database
        .delete(schema.assetAlias)
        .where(inArray(schema.assetAlias.assetId, created));
      await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, created));
      await database.delete(schema.asset).where(inArray(schema.asset.id, created));
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
        .delete(schema.addonGrant)
        .where(inArray(schema.addonGrant.workspaceId, workspaces));
      /* `usageOverview` rebuilds the daily buckets it reads. */
      await database
        .delete(schema.usageSummary)
        .where(inArray(schema.usageSummary.workspaceId, workspaces));
      await database
        .delete(schema.subscription)
        .where(inArray(schema.subscription.workspaceId, workspaces));
      await database
        .delete(schema.workspace)
        .where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database
        .delete(schema.planVersion)
        .where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('recalls as wide as the configuration in force says, and no wider', async () => {
    /* The settings are a dependency read per request, so a narrower width
       injected here is exactly what a console save would do to the next
       call. With no embeddings only the keyword leg runs, so its width is
       the whole recall. */
    const stamp = Date.now();
    await publishedAsset(`qd-width-${stamp}`);
    const workspaceId = await workspaceOnPlan(100);
    const narrow = {
      ...noEmbeddings,
      settings: async () => ({
        ...DEFAULT_RETRIEVAL_SETTINGS,
        recallLimit: 5,
        configId: null,
        createdAt: null,
      }),
    };

    const output = await queryDocs(
      caller(workspaceId),
      { assetId: `/websites/qd-width-${stamp}`, query: 'rove beetle treatment', maxTokens: 4000, format: 'json' },
      narrow,
    );
    expect(output.chunks.length).toBeGreaterThan(0);
    expect(output.chunks.length).toBeLessThanOrEqual(5);
  });

  it('returns cited chunks and meters exactly one call', async () => {
    const stamp = Date.now();
    const assetId = await publishedAsset(`qd-basic-${stamp}`);
    const workspaceId = await workspaceOnPlan(100);
    const who = caller(workspaceId);

    const output = await queryDocs(
      who,
      { assetId: `/websites/qd-basic-${stamp}`, query: 'rove beetle treatment', maxTokens: 4000, format: 'json' },
      noEmbeddings,
    );

    expect(output.chunks.length).toBeGreaterThan(0);
    const top = output.chunks[0]!;
    expect(top.text).toContain('beetle');
    expect(top.citation.sourceUrl).toBe('https://example.test/beetles');
    expect(top.citation.documentTitle).toBe('Rove beetles');
    expect(output.version.length).toBeGreaterThan(0);
    expect(output.usage.callsUsed).toBe(1);
    expect(output.usage.planAllowanceRemaining).toBe(99);

    const events = await db()
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.requestId, who.requestId));
    expect(events).toHaveLength(1);
    expect(events[0]?.debitSource).toBe('plan');
    expect(events[0]?.assetId).toBe(assetId);
    expect(events[0]?.returnedTokens).toBeGreaterThan(0);
  });

  it('does not charge a call that returns nothing', async () => {
    const stamp = Date.now();
    await publishedAsset(`qd-empty-${stamp}`);
    const workspaceId = await workspaceOnPlan(100);
    const who = caller(workspaceId);

    // requirement.md 4.2: the seat is reserved before recall and given back
    // when recall finds nothing -- no usage event, allowance untouched.
    const output = await queryDocs(
      who,
      { assetId: `/websites/qd-empty-${stamp}`, query: 'xylophone quasar', maxTokens: 4000, format: 'json' },
      noEmbeddings,
    );

    expect(output.chunks).toEqual([]);
    expect(output.usage.callsUsed).toBe(0);
    expect(output.usage.planAllowanceRemaining).toBe(100);

    const events = await db()
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.requestId, who.requestId));
    expect(events).toHaveLength(0);
    const [reservation] = await db()
      .select({ status: schema.usageReservation.status })
      .from(schema.usageReservation)
      .where(eq(schema.usageReservation.requestId, who.requestId));
    expect(reservation?.status).toBe('released');
  });

  it('meters a retried request once', async () => {
    const stamp = Date.now();
    await publishedAsset(`qd-retry-${stamp}`);
    const workspaceId = await workspaceOnPlan(100);
    const who = caller(workspaceId, `req_retry_${stamp}`);
    const input = {
      assetId: `/websites/qd-retry-${stamp}`,
      query: 'moths at night',
      maxTokens: 4000,
      format: 'json' as const,
    };

    await queryDocs(who, input, noEmbeddings);
    await queryDocs(who, input, noEmbeddings);

    const events = await db()
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.requestId, who.requestId));
    expect(events).toHaveLength(1);
  });

  it('refuses the call after the allowance, then spends the pack', async () => {
    const stamp = Date.now();
    await publishedAsset(`qd-quota-${stamp}`);
    const workspaceId = await workspaceOnPlan(1);
    const input = {
      assetId: `/websites/qd-quota-${stamp}`,
      query: 'moths at night',
      maxTokens: 4000,
      format: 'json' as const,
    };

    await queryDocs(caller(workspaceId), input, noEmbeddings);

    await expect(queryDocs(caller(workspaceId), input, noEmbeddings)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });

    /* A pack with balance turns the same refusal into an addon debit. */
    const grantId = uuidv7();
    await db().insert(schema.addonGrant).values({
      id: grantId,
      workspaceId,
      callsGranted: 1,
      callsConsumed: 0,
      priceMinor: 500,
    });

    const spent = caller(workspaceId);
    const output = await queryDocs(spent, input, noEmbeddings);
    expect(output.usage.addonBalanceRemaining).toBe(0);

    const [event] = await db()
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.requestId, spent.requestId));
    expect(event?.debitSource).toBe('addon');
    expect(event?.addonGrantId).toBe(grantId);

    const [grant] = await db()
      .select()
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.id, grantId));
    expect(grant?.callsConsumed).toBe(1);

    /* Allowance and pack both empty: the fourth call is refused again. */
    await expect(queryDocs(caller(workspaceId), input, noEmbeddings)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });

    /* The dashboard's split of the same period: one call on the allowance, one on the pack, nothing left. */
    const overview = await usageOverview(workspaceId);
    expect(overview.callsThisPeriod).toBe(2);
    expect(overview.planCallsThisPeriod).toBe(1);
    expect(overview.addonCallsThisPeriod).toBe(1);
    expect(overview.addonGranted).toBe(1);
    expect(overview.addonBalanceRemaining).toBe(0);
  });

  it('serves anonymous callers on public assets without metering', async () => {
    const stamp = Date.now();
    await publishedAsset(`qd-anon-${stamp}`);

    const output = await queryDocs(
      caller(null),
      { assetId: `/websites/qd-anon-${stamp}`, query: 'moonlight', maxTokens: 4000, format: 'json' },
      noEmbeddings,
    );

    expect(output.chunks.length).toBeGreaterThan(0);
    expect(output.usage.planAllowanceRemaining).toBe(0);
  });

  it('keeps a private asset indistinguishable from a missing one', async () => {
    const stamp = Date.now();
    const assetId = await publishedAsset(`qd-private-${stamp}`);
    const owner = await workspaceOnPlan(100);
    await db()
      .update(schema.asset)
      .set({ ownerWorkspaceId: owner })
      .where(eq(schema.asset.id, assetId));
    /* Out of every channel: the owner's alone (agent-first-proposal.md 6.2). */
    await unshare(assetId);

    try {
      const input = {
        assetId: `/websites/qd-private-${stamp}`,
        query: 'moths',
        maxTokens: 4000,
        format: 'json' as const,
      };
      await expect(queryDocs(caller(null), input, noEmbeddings)).rejects.toMatchObject({
        code: 'asset_not_found',
      });
      const stranger = await workspaceOnPlan(100);
      await expect(queryDocs(caller(stranger), input, noEmbeddings)).rejects.toMatchObject({
        code: 'asset_not_found',
      });
      const output = await queryDocs(caller(owner), input, noEmbeddings);
      expect(output.chunks.length).toBeGreaterThan(0);
    } finally {
      await db()
        .update(schema.asset)
        .set({ ownerWorkspaceId: null })
        .where(eq(schema.asset.id, assetId));
    }
  });

  /**
   * The gap migration 0011 recorded, closed: under `simple` a Han run is one
   * token and Chinese keyword recall is silently zero. With the pre-segmented
   * CJK vector, a Chinese question recalls by keywords alone -- no embedding
   * provider in this test, so the vector path cannot be carrying it.
   */
  it('recalls Chinese content by keywords alone', async () => {
    const stamp = Date.now();
    await publishedAsset(`qd-cjk-${stamp}`, [
      {
        path: 'docs/beetles.md',
        url: 'https://example.test/beetles-zh',
        content:
          '# 常见甲虫\n\n隐翅虫的防治与危害:隐翅虫体液含隐翅虫素,接触皮肤会引起皮炎。远离灯光可以减少接触。',
      },
      {
        path: 'docs/moths.md',
        url: 'https://example.test/moths-zh',
        content: '# 蛾类\n\n蛾类依靠月光导航,夜间常被灯光吸引。',
      },
    ]);

    const output = await queryDocs(
      caller(null),
      { assetId: `/websites/qd-cjk-${stamp}`, query: '隐翅虫的防治', maxTokens: 4000, format: 'json' },
      noEmbeddings,
    );

    expect(output.chunks.length).toBeGreaterThan(0);
    expect(output.chunks[0]!.text).toContain('隐翅虫');
    expect(output.chunks[0]!.citation.sourceUrl).toBe('https://example.test/beetles-zh');
  });

  /**
   * §9.2 rerank refines the fused head; §9.3 says it sees only the limited
   * candidates. A reranker that inverts the scores must invert the order --
   * and one that throws must leave fusion order standing, not fail the call.
   */
  it('applies the reranker over the fused head, and degrades without it', async () => {
    const stamp = Date.now();
    await publishedAsset(`qd-rerank-${stamp}`);
    const input = {
      assetId: `/websites/qd-rerank-${stamp}`,
      query: 'rove beetle moths moonlight',
      maxTokens: 4000,
      format: 'json' as const,
    };

    const baseline = await queryDocs(caller(null), input, noEmbeddings);
    expect(baseline.chunks.length).toBeGreaterThan(1);

    const inverting = {
      ...noEmbeddings,
      rerank: () => ({
        async rerank(_query: string, candidates: string[]) {
          /* Later candidates score higher: fusion order must invert. */
          return candidates.map((_, at) => at + 1);
        },
      }),
      configured: () => ({ embeddings: false, rerank: true }),
    };
    const inverted = await queryDocs(caller(null), input, inverting);
    expect(inverted.chunks.map((chunk) => chunk.chunkId)).toEqual(
      [...baseline.chunks.map((chunk) => chunk.chunkId)].reverse(),
    );

    const failing = {
      ...noEmbeddings,
      rerank: () => ({
        async rerank(): Promise<number[]> {
          throw new Error('provider down');
        },
      }),
      configured: () => ({ embeddings: false, rerank: true }),
    };
    const degraded = await queryDocs(caller(null), input, failing);
    expect(degraded.chunks.map((chunk) => chunk.chunkId)).toEqual(
      baseline.chunks.map((chunk) => chunk.chunkId),
    );
  });

  /**
   * §9.4: only immutable-version results are cached, a hit short-circuits
   * recall but still meters, and the store keys by version + query + config.
   */
  it('caches public results and still meters the hit', async () => {
    const stamp = Date.now();
    const assetId = await publishedAsset(`qd-cache-${stamp}`);
    const workspaceId = await workspaceOnPlan(100);

    const store = new Map<string, string>();
    const caching = {
      ...noEmbeddings,
      cache: () => ({
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: string) => {
          store.set(key, value);
        },
        invalidateTag: async () => {},
      }),
    };
    const input = {
      assetId: `/websites/qd-cache-${stamp}`,
      query: 'moths at night',
      maxTokens: 4000,
      format: 'json' as const,
    };

    const first = await queryDocs(caller(workspaceId), input, caching);
    expect(first.chunks.length).toBeGreaterThan(0);
    expect(store.size).toBe(1);

    /* Poison the entry: if the second call returns it, the hit path ran. */
    const [key] = store.keys();
    const sentinel = {
      chunks: [
        {
          chunkId: 'cached-sentinel',
          text: 'from the cache',
          score: 1,
          tokens: 3,
          citation: {
            sourceUrl: 'https://example.test/cached',
            documentTitle: 'Cached',
            section: null,
            lines: null,
          },
        },
      ],
    };
    store.set(key!, JSON.stringify(sentinel));

    const hitCaller = caller(workspaceId);
    const second = await queryDocs(hitCaller, input, caching);
    expect(second.chunks[0]!.chunkId).toBe('cached-sentinel');
    /* The hit is still a served, metered call. */
    const events = await db()
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.requestId, hitCaller.requestId));
    expect(events).toHaveLength(1);
    expect(events[0]?.assetId).toBe(assetId);

    /* A corrupt entry is a miss, never an error. */
    store.set(key!, '{not json');
    const third = await queryDocs(caller(workspaceId), input, caching);
    expect(third.chunks[0]!.chunkId).not.toBe('cached-sentinel');
  });

  it('trims strictly to maxTokens without cutting a chunk', async () => {
    const stamp = Date.now();
    await publishedAsset(`qd-trim-${stamp}`);

    const output = await queryDocs(
      caller(null),
      { assetId: `/websites/qd-trim-${stamp}`, query: 'rove beetle treatment', maxTokens: 256, format: 'json' },
      noEmbeddings,
    );

    const total = output.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
    expect(total).toBeLessThanOrEqual(256);
  });
});
