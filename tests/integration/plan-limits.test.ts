/**
 * The pricing page's boundaries, against the seeded plan version and the two
 * storage tiers: monthly calls, the workspace's total storage, and site keys.
 * Each case fills the workspace to one under the advertised ceiling, takes the
 * last slot, and expects the next one refused.
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

const { reserveCall, PLAN_VERSION_NEWEST_FIRST } = await import('@/lib/application/plans');
const { workspaceStorage } = await import('@/lib/application/plans/storage');
const { createSiteKey } = await import('@/lib/application/embed');
const { createPlatformAsset } = await import(
  '@/lib/application/administration/manage-platform-assets'
);
const { buildVersion, memoryObjectStore } = await import('@/lib/application/ingestion');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { storageCapacityBytes } = await import('@/lib/domain/plans');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const store = memoryObjectStore();
const workspaces: string[] = [];
const users: string[] = [];
const SITE = 'https://shop.example.test';

async function newestFreeVersion() {
  const [version] = await db()
    .select()
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'free'))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  if (!version) throw new Error('no free version seeded');
  return version;
}

/**
 * A workspace on Free -- the absence of a subscription -- owned by a user on
 * the given storage tier. The tier is the owner's (agent-first-proposal.md
 * 8.1), so the capacity test needs the member row; the others do not care.
 */
async function workspaceOn(tier: 'base' | 'extended'): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  const userId = uuidv7();
  workspaces.push(workspaceId);
  users.push(userId);
  await database.insert(schema.user).values({
    id: userId,
    email: `limits-${userId}@example.test`,
    displayName: 'Limits Owner',
    status: 'active',
    storageTier: tier,
  });
  await database.insert(schema.workspace).values({ id: workspaceId, name: `limits-${tier}` });
  await database.insert(schema.workspaceMember).values({ workspaceId, userId, role: 'owner' });
  return workspaceId;
}

/** `n` draft assets owned by the workspace, written directly, each holding `storageBytes`. */
async function fillAssets(workspaceId: string, n: number, storageBytes = 0): Promise<string[]> {
  const ids = Array.from({ length: n }, () => uuidv7());
  if (n === 0) return ids;
  await db()
    .insert(schema.asset)
    .values(
      ids.map((id) => ({
        id,
        publicId: `/websites/limits-${id}`,
        title: 'Filler',
        language: 'en',
        ownerWorkspaceId: workspaceId,
        isPlatformAsset: false,
        kind: 'website' as const,
        lifecycleStatus: 'draft' as const,
        indexStatus: 'pending' as const,
        storageBytes,
      })),
    );
  return ids;
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

/** A website asset owned by the workspace, built from one file of `content`. */
async function buildOwned(workspaceId: string, content: string) {
  const slug = `limits-size-${uuidv7().slice(-12)}`;
  const { assetId } = await createPlatformAsset({
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
    .update(schema.asset)
    .set({ isPlatformAsset: false, ownerWorkspaceId: workspaceId })
    .where(eq(schema.asset.id, assetId));
  await unshare(assetId);
  return buildVersion({
    assetId,
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
  afterAll(async () => {
    const database = db();
    if (workspaces.length > 0) {
      await database
        .delete(schema.workspaceMember)
        .where(inArray(schema.workspaceMember.workspaceId, workspaces));
    }
    if (users.length > 0) {
      await database.delete(schema.user).where(inArray(schema.user.id, users));
    }
  });

  it('seeds the figures the pricing page prints', async () => {
    const free = await newestFreeVersion();
    expect([free.monthlyCalls, free.apiKeyLimit]).toEqual([1_000, 20]);
    expect(storageCapacityBytes('base')).toBe(500 * 1024 * 1024);
    expect(storageCapacityBytes('extended')).toBe(2 * 1024 * 1024 * 1024);
  });

  it('admits call 1,000 and refuses call 1,001', async () => {
    const workspaceId = await workspaceOn('base');
    await spend(workspaceId, 999);
    const last = await reserveCall({ workspaceId, requestId: `limits-${uuidv7()}` });
    expect(last).toMatchObject({ debitSource: 'plan', planAllowanceRemaining: 0 });
    await expect(reserveCall({ workspaceId, requestId: `limits-${uuidv7()}` })).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
  });

  it('one site key across the workspace', async () => {
    const workspaceId = await workspaceOn('base');
    const [a, b] = await fillAssets(workspaceId, 2);
    await createSiteKey({ workspaceId, role: 'owner', assetId: a!, name: 'One', origins: SITE });
    await expect(
      createSiteKey({ workspaceId, role: 'owner', assetId: b!, name: 'Two', origins: SITE }),
    ).rejects.toMatchObject({ code: 'api_key_limit_exceeded', ceiling: 'plan' });
  });

  it('builds content up to the workspace’s total capacity and refuses a byte over', async () => {
    /*
     * The ceiling is the workspace's, not the asset's: a filler asset
     * already holding all but 1 KB of the base tier leaves this build 1 KB.
     */
    const room = 1024;
    const workspaceId = await workspaceOn('base');
    await fillAssets(workspaceId, 1, storageCapacityBytes('base') - room);
    expect((await workspaceStorage(workspaceId)).remainingBytes).toBe(room);

    const header = '# Manual\n\n';
    const at = header + 'q'.repeat(room - header.length);
    const over = at + 'q';
    expect(Buffer.byteLength(at)).toBe(room);

    await expect(buildOwned(workspaceId, at)).resolves.toMatchObject({ changed: true });
    expect((await workspaceStorage(workspaceId)).remainingBytes).toBe(0);
    await expect(buildOwned(workspaceId, over)).rejects.toMatchObject({
      code: 'asset_too_large',
      stage: 'fetch-snapshot',
    });

    /* Multi-byte text counts as UTF-8 bytes, not characters. */
    const han = header + '知'.repeat(Math.ceil((room - header.length) / 3) + 1);
    expect(han.length).toBeLessThan(room);
    await expect(buildOwned(workspaceId, han)).rejects.toMatchObject({ code: 'asset_too_large' });
  });

  it('gives an owner who has bought a pack the extended capacity', async () => {
    const workspaceId = await workspaceOn('extended');
    await fillAssets(workspaceId, 1, storageCapacityBytes('base'));
    const storage = await workspaceStorage(workspaceId);
    expect(storage.tier).toBe('extended');
    expect(storage.remainingBytes).toBe(storageCapacityBytes('extended') - storageCapacityBytes('base'));

    /* Over the base tier already, and still room to build. */
    await expect(buildOwned(workspaceId, '# Manual\n\nroom to spare')).resolves.toMatchObject({ changed: true });
  });
});
