/**
 * Earning events, against a real database. architecture.md 11.4 and
 * publisher-revenue-share.md 3.1/5: one earning event per attributable call,
 * written in the same transaction as the usage event, frozen at the caller's
 * plan version and share rate -- and refused for self-calls, platform
 * libraries, unclaimed libraries, anonymous callers, replays and calls past
 * the daily cap.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { DAILY_ATTRIBUTABLE_CALL_CAP, revenuePeriodId } = await import('@/lib/domain');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

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

function caller(workspaceId: string | null, requestId = `req_${crypto.randomUUID()}`) {
  return { workspaceId, apiKeyId: null, requestId, anonymous: workspaceId === null };
}

function dependencies() {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/guide.md',
            url: 'https://example.test/guide',
            content: '# Field Guide\n\nMigration corridors follow the coastline every autumn season.',
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

async function workspace(name: string): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name });
  return id;
}

async function subscribed(workspaceId: string, shareRateBps = 2_000): Promise<string> {
  const database = db();
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 100_000,
    libraryLimit: 10,
    librarySizeBytesLimit: 1_000_000,
    apiKeyLimit: 5,
    shareRateBps,
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
  return planVersionId;
}

/** A claimed, published *user* library -- the kind that earns. */
async function userLibrary(slug: string, ownerWorkspaceId: string | null): Promise<string> {
  const database = db();
  const libraryId = crypto.randomUUID();
  created.push(libraryId);
  await database.insert(schema.library).values({
    id: libraryId,
    publicId: `/websites/${slug}`,
    title: `Earning fixture ${slug}`,
    ownerWorkspaceId,
    isPlatformLibrary: false,
    visibility: 'public',
    lifecycleStatus: 'draft',
    indexStatus: 'pending',
    language: 'en',
  });
  await database.insert(schema.source).values({
    id: uuidv7(),
    libraryId,
    /* Self-owned type: rights-verified by creation (requirement.md 7.3.2). */
    type: 'openapi',
    location: `https://example.test/${slug}`,
  });
  const built = await buildVersion({ libraryId, operationId: uuidv7(), dependencies: dependencies() });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  await database
    .update(schema.library)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.library.id, libraryId));
  return libraryId;
}

const input = (slug: string) => ({
  libraryId: `/websites/${slug}`,
  query: 'migration corridors in autumn',
  maxTokens: 4000,
  format: 'json' as const,
});

describeWithDb('earning events', () => {
  afterAll(async () => {
    const database = db();
    if (created.length > 0) {
      await database
        .delete(schema.libraryClaim)
        .where(inArray(schema.libraryClaim.libraryId, created));
      await database
        .delete(schema.earningEvent)
        .where(inArray(schema.earningEvent.libraryId, created));
      await database
        .update(schema.library)
        .set({ currentVersionId: null, ownerWorkspaceId: null })
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
      await database.delete(schema.library).where(inArray(schema.library.id, created));
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
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database
        .delete(schema.planVersion)
        .where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('writes one earning event with the frozen plan version and rate', async () => {
    const stamp = Date.now();
    const owner = await workspace('earning-owner');
    const libraryId = await userLibrary(`earn-basic-${stamp}`, owner);
    const reader = await workspace('earning-reader');
    const planVersionId = await subscribed(reader, 2_500);

    const who = caller(reader);
    await queryDocs(who, input(`earn-basic-${stamp}`), noEmbeddings);

    const [event] = await db()
      .select()
      .from(schema.earningEvent)
      .where(eq(schema.earningEvent.requestId, who.requestId));
    expect(event).toBeDefined();
    expect(event!.libraryId).toBe(libraryId);
    expect(event!.ownerWorkspaceId).toBe(owner);
    expect(event!.planVersionId).toBe(planVersionId);
    expect(event!.shareRateBps).toBe(2_500);
    expect(event!.periodId).toBe(revenuePeriodId(new Date()));

    /* A retried request keeps exactly one earning event, like its usage event. */
    await queryDocs(who, input(`earn-basic-${stamp}`), noEmbeddings);
    const events = await db()
      .select()
      .from(schema.earningEvent)
      .where(eq(schema.earningEvent.requestId, who.requestId));
    expect(events).toHaveLength(1);
  });

  it('refuses self-calls, unclaimed libraries and anonymous callers', async () => {
    const stamp = Date.now();
    const owner = await workspace('earning-self');
    await subscribed(owner);
    const ownLibrary = await userLibrary(`earn-self-${stamp}`, owner);

    const selfCall = caller(owner);
    await queryDocs(selfCall, input(`earn-self-${stamp}`), noEmbeddings);
    expect(
      await db()
        .select()
        .from(schema.earningEvent)
        .where(eq(schema.earningEvent.requestId, selfCall.requestId)),
    ).toHaveLength(0);

    const unclaimed = await userLibrary(`earn-unclaimed-${stamp}`, null);
    const reader = await workspace('earning-reader-2');
    await subscribed(reader);
    const toUnclaimed = caller(reader);
    await queryDocs(toUnclaimed, input(`earn-unclaimed-${stamp}`), noEmbeddings);
    expect(
      await db()
        .select()
        .from(schema.earningEvent)
        .where(eq(schema.earningEvent.requestId, toUnclaimed.requestId)),
    ).toHaveLength(0);

    /* Anonymous is never metered, so it can never earn either. */
    await queryDocs(caller(null), input(`earn-self-${stamp}`), noEmbeddings);
    expect(
      await db()
        .select()
        .from(schema.earningEvent)
        .where(eq(schema.earningEvent.libraryId, ownLibrary)),
    ).toHaveLength(0);
    void unclaimed;
  });

  /**
   * requirement.md 7.3: owner_workspace_id proves access, not rights. A
   * claim-gated source (website) earns nothing until a claim verifies --
   * otherwise a workspace could mint a library over someone else's site and
   * collect its share without ever passing the claim.
   */
  it('refuses claim-gated sources until a claim verifies', async () => {
    const stamp = Date.now();
    const owner = await workspace('earning-rights-owner');
    const libraryId = await userLibrary(`earn-rights-${stamp}`, owner);
    await db()
      .update(schema.source)
      .set({ type: 'website' })
      .where(eq(schema.source.libraryId, libraryId));
    const reader = await workspace('earning-rights-reader');
    await subscribed(reader);

    const unverified = caller(reader);
    await queryDocs(unverified, input(`earn-rights-${stamp}`), noEmbeddings);
    expect(
      await db()
        .select()
        .from(schema.earningEvent)
        .where(eq(schema.earningEvent.requestId, unverified.requestId)),
    ).toHaveLength(0);

    await db().insert(schema.libraryClaim).values({
      id: uuidv7(),
      libraryId,
      claimantWorkspaceId: owner,
      method: 'dns_txt',
      challengeTokenHash: 'fixture-hash',
      status: 'verified',
      expiresAt: new Date(Date.now() + 86_400_000),
      verifiedAt: new Date(),
    });

    const verified = caller(reader);
    await queryDocs(verified, input(`earn-rights-${stamp}`), noEmbeddings);
    expect(
      await db()
        .select()
        .from(schema.earningEvent)
        .where(eq(schema.earningEvent.requestId, verified.requestId)),
    ).toHaveLength(1);
  });

  it('stops earning at the daily cap while billing continues', async () => {
    const stamp = Date.now();
    /*
     * The cap counter derives its UTC day start from the JS clock
     * (lib/application/plans/quota.ts), so pin that clock to mid-day and seed
     * the prior events with explicit createdAt values from it -- otherwise a
     * run crossing UTC midnight between seeding and the capped call would put
     * the seeded rows in yesterday's window and the cap would not bind.
     * Date-only faking keeps database I/O and timeouts on real timers.
     */
    const seededAt = new Date();
    seededAt.setUTCHours(12, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(seededAt);
    try {
      const owner = await workspace('earning-cap-owner');
      const libraryId = await userLibrary(`earn-cap-${stamp}`, owner);
      const reader = await workspace('earning-cap-reader');
      const planVersionId = await subscribed(reader);

      /* The reader has already earned the library its daily cap, synthetically. */
      const database = db();
      const versionRow = await database
        .select({ id: schema.libraryVersion.id })
        .from(schema.libraryVersion)
        .where(eq(schema.libraryVersion.libraryId, libraryId));
      const priorIds = Array.from({ length: DAILY_ATTRIBUTABLE_CALL_CAP }, () => `req_cap_${uuidv7()}`);
      await database.insert(schema.usageEvent).values(
        priorIds.map((requestId) => ({
          id: uuidv7(),
          workspaceId: reader,
          requestId,
          libraryId,
          versionId: versionRow[0]!.id,
          operation: 'context',
          entrypoint: 'rest',
          debitSource: 'plan',
          statusCode: 200,
          createdAt: seededAt,
        })),
      );
      await database.insert(schema.earningEvent).values(
        priorIds.map((requestId) => ({
          id: uuidv7(),
          requestId,
          libraryId,
          versionId: versionRow[0]!.id,
          ownerWorkspaceId: owner,
          planVersionId,
          shareRateBps: 2_000,
          periodId: revenuePeriodId(new Date()),
          createdAt: seededAt,
        })),
      );

      const capped = caller(reader);
      const output = await queryDocs(capped, input(`earn-cap-${stamp}`), noEmbeddings);
      expect(output.chunks.length).toBeGreaterThan(0); // billed and served as normal

      const [usage] = await database
        .select()
        .from(schema.usageEvent)
        .where(eq(schema.usageEvent.requestId, capped.requestId));
      expect(usage).toBeDefined(); // the call was metered...
      expect(
        await database
          .select()
          .from(schema.earningEvent)
          .where(eq(schema.earningEvent.requestId, capped.requestId)),
      ).toHaveLength(0); // ...but past the cap it earns nothing
    } finally {
      vi.useRealTimers();
    }
  });
});
