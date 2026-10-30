/**
 * Asset builds in the call ledger, against a real database.
 * asset-build-billing.md 4 and 10:
 *
 * - a successful build writes one weighted usage event under
 *   `build:<operationId>`, in the publication transaction, and the dashboard
 *   figures split it from retrieval;
 * - a rerun of an unchanged source writes nothing and holds nothing;
 * - a build the balance cannot cover fails before embedding with
 *   `quota_exceeded`, leaves no version, no event and no held seat;
 * - shadow mode records the price at weight zero;
 * - a platform asset is nobody's bill.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { memoryObjectStore, runOperation, drainOperations } = await import('@/lib/application/ingestion');
const { BUILD_RESERVATION_TTL_MS } = await import('@/lib/application/plans/quota');
const { usageOverview } = await import('@/lib/application/plans');
const { workspaceAssetDetail } = await import('@/lib/application/assets/detail');
const { buildRequestId } = await import('@/lib/domain/build-billing');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { IngestionFailure } = await import('@/lib/domain/ingestion');

const created: string[] = [];
const workspaces: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();

/** Small enough that a fixture of a few hundred tokens costs several calls. */
const TOKENS_PER_CALL = 50;

const FILES = [
  {
    path: 'docs/guide.md',
    url: 'https://example.test/guide',
    content: `# Guide\n\n${'A sentence about the fixture. '.repeat(60)}\n\n## Details\n\nMore.`,
  },
];

let embedCalls = 0;

function dependencies(options: { failFetch?: () => boolean } = {}) {
  return {
    async fetchSnapshot() {
      if (options.failFetch?.()) {
        throw new IngestionFailure('source_unreachable', 'fetch-snapshot', 'fixture failure');
      }
      return {
        files: FILES,
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
        embedCalls += 1;
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

async function subscribed(workspaceId: string, monthlyCalls: number): Promise<string> {
  const database = db();
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'free',
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls,
    apiKeyLimit: 5,
    buildBaseCalls: 1,
    buildTokensPerCall: TOKENS_PER_CALL,
    buildPagesPerCall: 5,
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
  return planVersionId;
}

async function asset(slug: string, ownerWorkspaceId: string | null): Promise<string> {
  const database = db();
  const assetId = crypto.randomUUID();
  created.push(assetId);
  await database.insert(schema.asset).values({
    id: assetId,
    publicId: `/websites/${slug}`,
    title: `Build billing fixture ${slug}`,
    ownerWorkspaceId,
    isPlatformAsset: ownerWorkspaceId === null,
    kind: 'website',
    lifecycleStatus: 'draft',
    indexStatus: 'pending',
    language: 'en',
  });
  await database.insert(schema.source).values({
    id: uuidv7(),
    assetId,
    type: 'website',
    location: `https://example.test/${slug}`,
  });
  return assetId;
}

async function queue(assetId: string, trigger = 'manual'): Promise<string> {
  const operationId = uuidv7();
  await db().insert(schema.workflowOperation).values({
    id: operationId,
    assetId,
    operationType: 'ingest',
    sourceDigest: null,
    status: 'pending',
    trigger,
  });
  return operationId;
}

async function buildEvent(operationId: string) {
  const [event] = await db()
    .select()
    .from(schema.usageEvent)
    .where(eq(schema.usageEvent.requestId, buildRequestId(operationId)));
  return event ?? null;
}

async function operation(operationId: string) {
  const [row] = await db()
    .select()
    .from(schema.workflowOperation)
    .where(eq(schema.workflowOperation.id, operationId));
  return row!;
}

async function pendingSeats(workspaceId: string): Promise<number> {
  const rows = await db()
    .select({ id: schema.usageReservation.id })
    .from(schema.usageReservation)
    .where(
      and(
        eq(schema.usageReservation.workspaceId, workspaceId),
        eq(schema.usageReservation.status, 'pending'),
      ),
    );
  return rows.length;
}

describeWithDb('asset build billing', () => {
  const previousMode = process.env.BUILD_BILLING_MODE;
  beforeEach(() => {
    process.env.BUILD_BILLING_MODE = 'enforce';
    embedCalls = 0;
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.BUILD_BILLING_MODE;
    else process.env.BUILD_BILLING_MODE = previousMode;
  });

  afterAll(async () => {
    const database = db();
    if (created.length > 0) {
      await database
        .update(schema.asset)
        .set({ currentVersionId: null })
        .where(inArray(schema.asset.id, created));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.assetId, created));
      await database
        .update(schema.workflowOperation)
        .set({ reservationId: null })
        .where(inArray(schema.workflowOperation.assetId, created));
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
      await database
        .delete(schema.workflowOperation)
        .where(inArray(schema.workflowOperation.assetId, created));
      await database.delete(schema.source).where(inArray(schema.source.assetId, created));
      await database.delete(schema.asset).where(inArray(schema.asset.id, created));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.usageReservation)
        .where(inArray(schema.usageReservation.workspaceId, workspaces));
      await database
        .delete(schema.usageSummary)
        .where(inArray(schema.usageSummary.workspaceId, workspaces));
      await database.delete(schema.addonGrant).where(inArray(schema.addonGrant.workspaceId, workspaces));
      await database
        .delete(schema.subscription)
        .where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('bills a published build once, weighted by what it added, and reports it apart', async () => {
    const owner = await workspace('build-billing owner');
    await subscribed(owner, 1_000);
    const assetId = await asset('billed', owner);
    const operationId = await queue(assetId);

    const outcome = await runOperation({ operationId, dependencies: dependencies() });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;

    const [version] = await db()
      .select({ totalTokens: schema.assetVersion.totalTokens })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.id, outcome.versionId));
    const expected = 1 + Math.ceil(version!.totalTokens / TOKENS_PER_CALL);
    expect(expected).toBeGreaterThan(1);

    const event = await buildEvent(operationId);
    expect(event).not.toBeNull();
    expect(event!.entrypoint).toBe('build');
    expect(event!.operation).toBe('index');
    expect(event!.calls).toBe(expected);
    expect(event!.versionId).toBe(outcome.versionId);
    expect(event!.debitSource).toBe('plan');
    expect((event!.buildDetail as { freshTokens: number }).freshTokens).toBe(version!.totalTokens);

    const row = await operation(operationId);
    expect(row.chargedCalls).toBe(expected);
    expect(row.quotedCalls).toBeGreaterThanOrEqual(expected);
    expect(await pendingSeats(owner)).toBe(0);

    /* The asset page reads the same figure back by version. */
    const detail = await workspaceAssetDetail({ workspaceId: owner, assetId });
    expect(detail?.versions.find((version) => version.id === outcome.versionId)?.buildCalls).toBe(expected);

    const overview = await usageOverview(owner);
    expect(overview.buildCallsThisPeriod).toBe(expected);
    expect(overview.retrievalCallsThisPeriod).toBe(0);
    expect(overview.callsThisPeriod).toBe(expected);

    /* A rerun of an unchanged source: no version, no event, no seat. */
    const again = await queue(assetId);
    const rerun = await runOperation({ operationId: again, dependencies: dependencies() });
    expect(rerun.status).toBe('skipped');
    expect(await buildEvent(again)).toBeNull();
    expect(await pendingSeats(owner)).toBe(0);
    expect((await usageOverview(owner)).buildCallsThisPeriod).toBe(expected);
  });

  it('splits a build across the allowance and a call pack once the allowance runs short', async () => {
    const owner = await workspace('build-billing split');
    await subscribed(owner, 2);
    const grantId = uuidv7();
    await db().insert(schema.addonGrant).values({ id: grantId, workspaceId: owner, callsGranted: 1_000, callsConsumed: 0, priceMinor: 500 });
    const assetId = await asset('split', owner);
    const operationId = await queue(assetId);

    const outcome = await runOperation({ operationId, dependencies: dependencies() });
    expect(outcome.status).toBe('succeeded');
    const event = await buildEvent(operationId);
    const calls = event!.calls;
    expect(calls).toBeGreaterThan(2);

    /* The allowance pays first, the pack the rest -- one event, both shares recorded. */
    expect(event!.debitSource).toBe('split');
    expect(event!.addonGrantId).toBe(grantId);
    const detail = event!.buildDetail as { planCalls: number; addonCalls: number };
    expect(detail.planCalls).toBe(2);
    expect(detail.addonCalls).toBe(calls - 2);
    const [grant] = await db().select().from(schema.addonGrant).where(eq(schema.addonGrant.id, grantId));
    expect(grant!.callsConsumed).toBe(calls - 2);

    /* What the dashboard prints: the allowance full, the excess on the pack, the pack's balance. */
    const overview = await usageOverview(owner);
    expect(overview.callsThisPeriod).toBe(calls);
    expect(overview.planCallsThisPeriod).toBe(2);
    expect(overview.addonCallsThisPeriod).toBe(calls - 2);
    expect(overview.addonGranted).toBe(1_000);
    expect(overview.addonBalanceRemaining).toBe(1_000 - (calls - 2));
  });

  it('stops before embedding, unbilled, when the price exceeds the balance', async () => {
    const owner = await workspace('build-billing poor');
    /* Enough for the base fee, so the build is admitted, but not for the tokens. */
    await subscribed(owner, 1);
    const assetId = await asset('refused', owner);
    const operationId = await queue(assetId);

    const outcome = await runOperation({ operationId, dependencies: dependencies() });
    expect(outcome).toEqual({ status: 'failed', error: 'quota_exceeded' });
    expect(embedCalls).toBe(0);

    const row = await operation(operationId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('quota_exceeded');
    expect(await buildEvent(operationId)).toBeNull();
    expect(await pendingSeats(owner)).toBe(0);
    const versions = await db()
      .select({ id: schema.assetVersion.id })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, assetId));
    expect(versions).toHaveLength(0);
    const [lib] = await db()
      .select({ indexStatus: schema.asset.indexStatus })
      .from(schema.asset)
      .where(eq(schema.asset.id, assetId));
    expect(lib!.indexStatus).toBe('failed');
  });

  it('refuses to admit a build when the balance cannot cover the base fee', async () => {
    const owner = await workspace('build-billing empty');
    await subscribed(owner, 1);
    /* Spend the one call on an earlier build's event. */
    const spent = await asset('spent', owner);
    await db().insert(schema.usageEvent).values({
      id: uuidv7(),
      workspaceId: owner,
      requestId: `req_${crypto.randomUUID()}`,
      assetId: spent,
      operation: 'query-docs',
      entrypoint: 'rest',
      debitSource: 'plan',
      statusCode: 200,
    });
    const operationId = await queue(spent);
    const outcome = await runOperation({ operationId, dependencies: dependencies() });
    expect(outcome).toEqual({ status: 'failed', error: 'quota_exceeded' });
    expect(await pendingSeats(owner)).toBe(0);
  });

  it('records the price at weight zero in shadow mode', async () => {
    process.env.BUILD_BILLING_MODE = 'shadow';
    const owner = await workspace('build-billing shadow');
    await subscribed(owner, 1);
    const assetId = await asset('shadow', owner);
    const operationId = await queue(assetId);

    const outcome = await runOperation({ operationId, dependencies: dependencies() });
    expect(outcome.status).toBe('succeeded');
    const event = await buildEvent(operationId);
    expect(event).not.toBeNull();
    expect(event!.calls).toBe(0);
    const detail = event!.buildDetail as { billedCalls: number; mode: string };
    expect(detail.mode).toBe('shadow');
    expect(detail.billedCalls).toBeGreaterThan(1);
    expect((await usageOverview(owner)).callsThisPeriod).toBe(0);
    expect(await pendingSeats(owner)).toBe(0);
  });

  it('takes its seat back on a retry after a released attempt', async () => {
    const owner = await workspace('build-billing retry');
    await subscribed(owner, 1_000);
    const assetId = await asset('retry', owner);
    const operationId = await queue(assetId);

    let failures = 0;
    const deps = dependencies({ failFetch: () => failures++ === 0 });
    const first = await runOperation({ operationId, dependencies: deps });
    expect(first).toEqual({ status: 'failed', error: 'source_unreachable' });
    expect((await operation(operationId)).status).toBe('pending');
    expect(await pendingSeats(owner)).toBe(0);

    /* The retry re-holds the same seat (same request id) before fetching. */
    const second = await runOperation({ operationId, dependencies: deps });
    expect(second.status).toBe('succeeded');
    const event = await buildEvent(operationId);
    expect(event).not.toBeNull();
    const [seat] = await db()
      .select({ status: schema.usageReservation.status, calls: schema.usageReservation.calls })
      .from(schema.usageReservation)
      .where(eq(schema.usageReservation.requestId, buildRequestId(operationId)));
    expect(seat!.status).toBe('committed');
    expect(seat!.calls).toBe(event!.calls);
    expect(await pendingSeats(owner)).toBe(0);
  });

  it('reaps a build whose worker died, and frees the seat it held', async () => {
    const owner = await workspace('build-billing dead worker');
    await subscribed(owner, 1_000);
    const assetId = await asset('dead-worker', owner);
    const operationId = await queue(assetId);
    const stale = new Date(Date.now() - BUILD_RESERVATION_TTL_MS - 60_000);

    /* A claimed operation and its seat, both older than a build can be. */
    const reservationId = uuidv7();
    await db().insert(schema.usageReservation).values({
      id: reservationId,
      workspaceId: owner,
      requestId: buildRequestId(operationId),
      status: 'pending',
      kind: 'build',
      calls: 900,
      createdAt: stale,
    });
    await db()
      .update(schema.workflowOperation)
      .set({ status: 'running', reservationId, updatedAt: stale })
      .where(eq(schema.workflowOperation.id, operationId));

    expect(await pendingSeats(owner)).toBe(1);
    await drainOperations({ limit: 1, dependencies: dependencies() });
    const row = await operation(operationId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('internal_error');
    expect(await pendingSeats(owner)).toBe(0);
    /* And the retrieval-side sweep frees it on its own if the drain never runs. */
    expect((await usageOverview(owner)).planAllowance).toBe(1_000);
  });

  it('does not bill the first refresh of a version built before per-source digests', async () => {
    const owner = await workspace('build-billing legacy');
    await subscribed(owner, 1_000);
    const assetId = await asset('legacy', owner);
    const initial = await queue(assetId);
    const first = await runOperation({ operationId: initial, dependencies: dependencies() });
    expect(first.status).toBe('succeeded');
    if (first.status !== 'succeeded') return;
    const charged = (await buildEvent(initial))!.calls;
    expect(charged).toBeGreaterThan(1);

    /* A pre-0026 version: no digests to carry forward from. */
    await db()
      .update(schema.assetVersion)
      .set({ sourceDigests: null })
      .where(eq(schema.assetVersion.id, first.versionId));

    const refresh = await queue(assetId);
    const outcome = await runOperation({ operationId: refresh, dependencies: dependencies() });
    expect(outcome.status).toBe('succeeded');
    const event = await buildEvent(refresh);
    expect(event).not.toBeNull();
    expect(event!.calls).toBe(0);
    expect((event!.buildDetail as { platformRebuild: boolean }).platformRebuild).toBe(true);
    expect((await usageOverview(owner)).buildCallsThisPeriod).toBe(charged);
  });

  it('bills nobody for a platform asset or a platform-triggered build', async () => {
    const platform = await asset('platform', null);
    const operationId = await queue(platform);
    expect((await runOperation({ operationId, dependencies: dependencies() })).status).toBe('succeeded');
    expect(await buildEvent(operationId)).toBeNull();

    const owner = await workspace('build-billing platform-trigger');
    await subscribed(owner, 1);
    const owned = await asset('platform-trigger', owner);
    const forced = await queue(owned, 'platform');
    expect((await runOperation({ operationId: forced, dependencies: dependencies() })).status).toBe('succeeded');
    expect(await buildEvent(forced)).toBeNull();
    expect(await pendingSeats(owner)).toBe(0);
  });
});
