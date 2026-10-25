/**
 * The pricing page's Free / Pro boundaries, against the seeded plan versions:
 * monthly calls, self-built libraries, per-library size and site keys. Each
 * case fills the workspace to one under the advertised ceiling, takes the
 * last slot, and expects the next one refused.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { createWorkspaceLibrary } = await import('@/lib/application/libraries');
const { reserveCall, PLAN_VERSION_NEWEST_FIRST } = await import('@/lib/application/plans');
const { createSiteKey } = await import('@/lib/application/embed');
const { createPlatformLibrary } = await import(
  '@/lib/application/administration/manage-platform-libraries'
);
const { buildVersion, memoryObjectStore } = await import('@/lib/application/ingestion');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const store = memoryObjectStore();
const workspaces: string[] = [];
const planVersions: string[] = [];
const SITE = 'https://shop.example.test';

async function newestVersion(planId: 'free' | 'pro') {
  const [version] = await db()
    .select()
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, planId))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  if (!version) throw new Error(`no ${planId} version seeded`);
  return version;
}

/**
 * A Pro version of the test's own, older than any real one: the live Pro
 * version's figures by default. Subscribing to the live row itself would
 * count against it in the console's history (plan-configuration.test.ts).
 */
async function proVersion(overrides: { librarySizeBytesLimit?: number } = {}): Promise<string> {
  const { id: _live, createdAt: _at, ...live } = await newestVersion('pro');
  const id = uuidv7();
  planVersions.push(id);
  await db()
    .insert(schema.planVersion)
    .values({ ...live, ...overrides, id, createdAt: new Date('2000-01-01T00:00:00Z') });
  return id;
}

/** Free is the absence of a subscription; Pro is one on a copy of the live Pro version. */
async function workspaceOn(tier: 'free' | 'pro', planVersionId?: string): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: `limits-${tier}` });
  if (tier === 'pro') {
    await database.insert(schema.subscription).values({
      id: uuidv7(),
      workspaceId,
      planVersionId: planVersionId ?? (await proVersion()),
      status: 'active',
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(Date.now() + 86_400_000),
    });
  }
  return workspaceId;
}

/** `n` draft libraries owned by the workspace, written directly. */
async function fillLibraries(workspaceId: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => uuidv7());
  if (n === 0) return ids;
  await db()
    .insert(schema.library)
    .values(
      ids.map((id) => ({
        id,
        publicId: `/websites/limits-${id}`,
        title: 'Filler',
        language: 'en',
        ownerWorkspaceId: workspaceId,
        isPlatformLibrary: false,
        visibility: 'private' as const,
        lifecycleStatus: 'draft' as const,
        indexStatus: 'pending' as const,
      })),
    );
  return ids;
}

function createEmpty(workspaceId: string, slug: string) {
  return createWorkspaceLibrary({
    role: 'owner',
    workspaceId,
    title: slug,
    visibility: 'private',
    sourceType: 'markdown',
    location: '',
    slug,
    store,
  });
}

/** Consumption up to `calls`, as one weighted usage event. */
async function spend(workspaceId: string, calls: number) {
  await db().insert(schema.usageEvent).values({
    id: uuidv7(),
    workspaceId,
    requestId: `limits-${uuidv7()}`,
    operation: 'query_docs',
    entrypoint: 'rest',
    debitSource: 'plan',
    statusCode: 200,
    calls,
  });
}

/** A website library owned by the workspace, built from one file of `content`. */
async function buildOwned(workspaceId: string, content: string) {
  const slug = `limits-size-${uuidv7().slice(-12)}`;
  const { libraryId } = await createPlatformLibrary({
    actor: { administratorId: null as unknown as string, email: 'ops@example.test' },
    title: slug,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://shop.example.test/${slug}`,
    refreshPolicy: 'manual',
    language: 'en',
    reason: 'plan limits test',
  });
  await db()
    .update(schema.library)
    .set({ isPlatformLibrary: false, ownerWorkspaceId: workspaceId, visibility: 'private' })
    .where(eq(schema.library.id, libraryId));
  return buildVersion({
    libraryId,
    operationId: uuidv7(),
    dependencies: {
      async fetchSnapshot() {
        return {
          files: [{ path: 'manual.md', url: `${SITE}/manual`, content }],
          config: { projectTitle: null, description: null, branch: null, folders: [], excludeFolders: [], excludeFiles: [], rules: [] },
          revision: 'r1',
          lastModifiedAt: new Date(),
          hasLicense: true,
          stale: false,
        };
      },
      embeddings: () => ({
        model: 'fixture-embed-1',
        dimensions: EMBEDDING_COLUMN_DIMENSIONS,
        async embed(texts: string[]) {
          return texts.map(() => Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, () => 0.1));
        },
      }),
      store: () => store,
      configured: () => ({ embeddings: true, storage: true }),
    },
  });
}

describeWithDb('pricing page boundaries', () => {
  /* The subscriptions go so the versions can; the rest is disposable fixture data. */
  afterAll(async () => {
    const database = db();
    if (workspaces.length > 0) {
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('seeds the figures the pricing page prints', async () => {
    const free = await newestVersion('free');
    const pro = await newestVersion('pro');
    expect([free.monthlyCalls, free.libraryLimit, free.librarySizeBytesLimit]).toEqual([1_000, 5, 20 * 1024 * 1024]);
    expect([pro.monthlyCalls, pro.libraryLimit, pro.librarySizeBytesLimit]).toEqual([5_000, 25, 100 * 1024 * 1024]);
  });

  for (const [tier, allowance] of [
    ['free', 1_000],
    ['pro', 5_000],
  ] as const) {
    it(`${tier}: admits call ${allowance} and refuses call ${allowance + 1}`, async () => {
      const workspaceId = await workspaceOn(tier);
      await spend(workspaceId, allowance - 1);
      const last = await reserveCall({ workspaceId, requestId: `limits-${uuidv7()}` });
      expect(last).toMatchObject({ debitSource: 'plan', planAllowanceRemaining: 0 });
      await expect(reserveCall({ workspaceId, requestId: `limits-${uuidv7()}` })).rejects.toMatchObject({
        code: 'quota_exceeded',
      });
    });
  }

  for (const [tier, limit] of [
    ['free', 5],
    ['pro', 25],
  ] as const) {
    it(`${tier}: creates library ${limit} and refuses library ${limit + 1}`, async () => {
      const workspaceId = await workspaceOn(tier);
      await fillLibraries(workspaceId, limit - 1);
      const stamp = uuidv7().slice(-12);
      await expect(createEmpty(workspaceId, `last-${stamp}`)).resolves.toMatchObject({
        libraryId: expect.any(String),
      });
      await expect(createEmpty(workspaceId, `over-${stamp}`)).rejects.toMatchObject({
        code: 'library_limit_exceeded',
      });
    });
  }

  it('free: one site key across the workspace', async () => {
    const workspaceId = await workspaceOn('free');
    const [a, b] = await fillLibraries(workspaceId, 2);
    await createSiteKey({ workspaceId, role: 'owner', libraryId: a!, name: 'One', origins: SITE });
    await expect(
      createSiteKey({ workspaceId, role: 'owner', libraryId: b!, name: 'Two', origins: SITE }),
    ).rejects.toMatchObject({ code: 'api_key_limit_exceeded', ceiling: 'plan' });
  });

  it('pro: no workspace cap on site keys, only the per-library ceiling', async () => {
    const workspaceId = await workspaceOn('pro');
    const [a, b, c] = await fillLibraries(workspaceId, 3);
    for (const libraryId of [a!, b!]) {
      for (let i = 0; i < 5; i += 1) {
        await createSiteKey({ workspaceId, role: 'owner', libraryId, name: `k${i}`, origins: SITE });
      }
    }
    await expect(
      createSiteKey({ workspaceId, role: 'owner', libraryId: c!, name: 'eleventh', origins: SITE }),
    ).resolves.toMatchObject({ name: 'eleventh' });
    await expect(
      createSiteKey({ workspaceId, role: 'owner', libraryId: a!, name: 'sixth', origins: SITE }),
    ).rejects.toMatchObject({ code: 'api_key_limit_exceeded', ceiling: 'library' });
  });

  it('builds content at the plan’s per-library size and refuses a byte over', async () => {
    /* A 1 KB ceiling stands in for 20 MB: the same column, the same code path. */
    const ceiling = 1024;
    const workspaceId = await workspaceOn('pro', await proVersion({ librarySizeBytesLimit: ceiling }));

    const header = '# Manual\n\n';
    const at = header + 'q'.repeat(ceiling - header.length);
    const over = at + 'q';
    expect(Buffer.byteLength(at)).toBe(ceiling);

    await expect(buildOwned(workspaceId, at)).resolves.toMatchObject({ changed: true });
    await expect(buildOwned(workspaceId, over)).rejects.toMatchObject({
      code: 'library_too_large',
      stage: 'fetch-snapshot',
    });

    /* Multi-byte text counts as UTF-8 bytes, not characters. */
    const han = header + '知'.repeat(Math.ceil((ceiling - header.length) / 3) + 1);
    expect(han.length).toBeLessThan(ceiling);
    await expect(buildOwned(workspaceId, han)).rejects.toMatchObject({ code: 'library_too_large' });
  });
});
