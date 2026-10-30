/**
 * A user asset from build to the platform's hand, against a real database.
 *
 * What is under test is the hand-off between two flows that never see each
 * other: the build publishes the asset under either visibility
 * (2026-10-23), and the console's two verbs -- a suspension and its lifting
 * -- move it from there, each writing the review row the owner reads and the
 * audit entry requirement.md 7.4 demands.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { shareInPublicChannel } from '../fixtures/channels';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { createWorkspaceAsset, listWorkspaceAssets } = await import('@/lib/application/assets');
const { getUserAsset, reviewUserAsset, listUserAssets } = await import('@/lib/application/administration');
const { runOperation, memoryObjectStore } = await import('@/lib/application/ingestion');
const { PlatformAssetRefused } = await import('@/lib/domain/asset');
const { AdminChangeRefused } = await import('@/lib/domain/admin');
const { AppError } = await import('@/contracts/errors');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const assets: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();
const actor = { administratorId: null as unknown as string, email: 'reviewer@example.test' };

function dependencies(content: string) {
  return {
    async fetchSnapshot() {
      return {
        files: [{ path: 'docs/guide.md', url: 'https://docs.example.test/guide', content }],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          folders: [],
          excludeFolders: [],
          excludeFiles: [],
          rules: [],
        },
        revision: null,
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

async function workspace(): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'review-test' });
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

async function lifecycleOf(assetId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ lifecycleStatus: schema.asset.lifecycleStatus })
    .from(schema.asset)
    .where(eq(schema.asset.id, assetId));
  return row?.lifecycleStatus;
}

async function queueRefresh(assetId: string): Promise<string> {
  const operationId = uuidv7();
  await db().insert(schema.workflowOperation).values({
    id: operationId,
    assetId,
    operationType: 'refresh',
    sourceDigest: null,
    status: 'pending',
  });
  return operationId;
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof PlatformAssetRefused) return error.code;
    if (error instanceof AdminChangeRefused) return error.code;
    if (error instanceof AppError) return error.code;
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('user asset review', () => {
  afterAll(async () => {
    const database = db();
    if (assets.length > 0) {
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.assetId, assets));
      /* A user asset's build writes a usage event that points at its version. */
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.assetId, assets));
      await database.delete(schema.assetReview).where(inArray(schema.assetReview.assetId, assets));
      await database.update(schema.asset).set({ currentVersionId: null }).where(inArray(schema.asset.id, assets));
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
      await database
        .delete(schema.auditLog)
        .where(and(eq(schema.auditLog.targetType, 'user_library'), inArray(schema.auditLog.targetId, assets)));
    }
    if (workspaces.length > 0) {
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

  it('publishes a private asset on its first build, and a suspension outlives a rebuild', async () => {
    const workspaceId = await workspace();
    const created = await createWorkspaceAsset({
      workspaceId,
      role: 'owner',
      title: 'Private Guide',
      sourceType: 'website',
      location: 'https://docs.example.test/private',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/private'),
      slug: `private-guide-${Date.now()}`,
    });
    assets.push(created.assetId);
    expect(await lifecycleOf(created.assetId)).toBe('draft');

    const built = await runOperation({ operationId: created.operationId!, dependencies: dependencies('# Private\n\nBody one.') });
    expect(built.status).toBe('succeeded');
    expect(await lifecycleOf(created.assetId)).toBe('published');

    /* Nothing to restore on a live asset. */
    expect(await refusalOf(reviewUserAsset({ actor, assetId: created.assetId, action: 'approve', reason: 'no' }))).toBe(
      'invalid_transition',
    );
    const paused = await reviewUserAsset({ actor, assetId: created.assetId, action: 'reject', reason: 'safety pause' });
    expect(paused.status).toBe('suspended');

    /* A rebuild does not lift the pause. */
    const again = await runOperation({
      operationId: await queueRefresh(created.assetId),
      dependencies: dependencies('# Private\n\nBody two.'),
    });
    expect(again.status).toBe('succeeded');
    expect(await lifecycleOf(created.assetId)).toBe('suspended');

    const restored = await reviewUserAsset({ actor, assetId: created.assetId, action: 'approve', reason: 'pause lifted' });
    expect(restored.status).toBe('published');
  });

  it('publishes a public asset on its first build, and the console suspends and restores it', async () => {
    const workspaceId = await workspace();
    const created = await createWorkspaceAsset({
      workspaceId,
      role: 'owner',
      title: 'Public Guide',
      sourceType: 'website',
      location: 'https://docs.example.test/public',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/public'),
      slug: `public-guide-${Date.now()}`,
      rights: { origin: 'own', license: 'open_source', generation: 'human' },
    });
    assets.push(created.assetId);
    /* Public means listed in a public channel now (agent-first-proposal.md 6.2). */
    await shareInPublicChannel(created.assetId);

    /* Nothing to decide before the first version exists. */
    expect(await refusalOf(reviewUserAsset({ actor, assetId: created.assetId, action: 'reject', reason: 'early' }))).toBe(
      'invalid_transition',
    );

    /* The build publishes it: no submission, no queue (2026-10-23). */
    const built = await runOperation({ operationId: created.operationId!, dependencies: dependencies('# Public\n\nVersion one.') });
    expect(built.status).toBe('succeeded');
    expect(await lifecycleOf(created.assetId)).toBe('published');
    const live = await listUserAssets({ review: 'approved' });
    expect(live.rows.find((row) => row.id === created.assetId)?.hasReadyVersion).toBe(true);

    /* Suspended: the owner reads the reason, and a rebuild does not undo it. */
    const suspended = await reviewUserAsset({ actor, assetId: created.assetId, action: 'reject', reason: 'rights unclear' });
    expect(suspended.status).toBe('suspended');
    const mine = await listWorkspaceAssets(workspaceId);
    expect(mine.find((row) => row.id === created.assetId)?.reviewNote).toBe('rights unclear');
    expect(await refusalOf(reviewUserAsset({ actor, assetId: created.assetId, action: 'reject', reason: 'twice' }))).toBe(
      'invalid_transition',
    );
    const rebuilt = await runOperation({
      operationId: await queueRefresh(created.assetId),
      dependencies: dependencies('# Public\n\nVersion two, with a licence.'),
    });
    expect(rebuilt.status).toBe('succeeded');
    expect(await lifecycleOf(created.assetId)).toBe('suspended');
    const stopped = await listUserAssets({ review: 'rejected' });
    expect(stopped.rows.some((row) => row.id === created.assetId)).toBe(true);

    const restored = await reviewUserAsset({ actor, assetId: created.assetId, action: 'approve', reason: 'rights confirmed' });
    expect(restored.status).toBe('published');
    expect(await refusalOf(reviewUserAsset({ actor, assetId: created.assetId, action: 'approve', reason: 'again' }))).toBe(
      'invalid_transition',
    );

    /* Every decision left a review row and an audit entry; nothing else wrote one. */
    const detail = await getUserAsset(created.assetId);
    expect(detail?.lifecycleStatus).toBe('published');
    expect(detail?.reviews.map((review) => review.outcome)).toEqual(['approve', 'reject']);
    expect(detail?.reviews.every((review) => review.stage === 'manual' && review.decidedAt !== null)).toBe(true);
    expect(detail?.reviews.find((review) => review.outcome === 'reject')?.feedback).toEqual(['rights unclear']);
    expect(detail?.materials.rights?.origin).toBe('own');
    expect(detail?.versions).toHaveLength(2);
    const audit = await db()
      .select({ action: schema.auditLog.action, reason: schema.auditLog.reason })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'user_library'), eq(schema.auditLog.targetId, created.assetId)));
    expect(audit.map((entry) => entry.action).sort()).toEqual(['user_library.approve', 'user_library.reject']);
  });

  it('requires a reason and refuses an unknown asset', async () => {
    expect(await refusalOf(reviewUserAsset({ actor, assetId: assets[0]!, action: 'reject', reason: '   ' }))).toBe(
      'reason_required',
    );
    expect(await refusalOf(reviewUserAsset({ actor, assetId: crypto.randomUUID(), action: 'approve', reason: 'x' }))).toBe(
      'not_found',
    );
    expect(await refusalOf(reviewUserAsset({ actor, assetId: 'junk', action: 'approve', reason: 'x' }))).toBe('not_found');
    expect(await getUserAsset('junk')).toBeNull();
  });
});
