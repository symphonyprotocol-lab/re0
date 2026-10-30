/**
 * Phase P1 against a real database (agent-first-proposal.md 13.1, P1 row):
 *
 * - an asset outside any channel -- or in a private one -- is invisible to
 *   everyone but its owner, through every read: one-asset retrieval, routing,
 *   scope search, the public pages;
 * - moving an asset into a public channel is gated on a rights declaration
 *   and, for a website, a verified claim; leaving resets `access`;
 * - a private channel has no card and is not in the directory;
 * - anonymous A2A retrieval writes no usage event and is attributed to no
 *   workspace; an authenticated caller pays its own Call, the owner never;
 * - `SendMessage` and `GetTask` work across separate handler instances, the
 *   store being Postgres, and `SubscribeToTask` replays a finished task;
 * - a GitHub asset whose owner is a reserved name is refused.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.APP_BASE_URL ??= 'https://app.example.test';

const { buildVersion, memoryObjectStore, publishVersion } = await import('@/lib/application/ingestion');
const { createPlatformLibrary } = await import('@/lib/application/administration/manage-platform-libraries');
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { resolveLibrary } = await import('@/lib/application/retrieval/resolve-library');
const { searchScope } = await import('@/lib/application/retrieval/search-scope');
const { createWorkspaceLibrary, declareLibraryRights, publicLibraryDetail } = await import('@/lib/application/libraries');
const channels = await import('@/lib/application/channels');
const { ChannelRefused } = await import('@/lib/domain/channel');
const { changeWorkspaceHandle, HandleRefused } = await import('@/lib/application/workspaces/handle');
const { buildAgentCard } = await import('@/lib/application/a2a/card');
const { handleA2A } = await import('@/lib/application/a2a/server');
const { resolveTenant, PLATFORM_TENANT } = await import('@/lib/application/a2a/tenant');
const { serveCard } = await import('@/lib/http/a2a');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

type CallerContext = import('@/lib/application/retrieval').CallerContext;
type A2ATenant = import('@/lib/application/a2a/tenant').A2ATenant;

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const stamp = Date.now().toString(36);
const assets: string[] = [];
const workspaces: string[] = [];
const planVersions: string[] = [];
const anonymousTasks: string[] = [];
const store = memoryObjectStore();

const noModels = {
  embeddings: () => {
    throw new Error('not configured');
  },
  rerank: () => {
    throw new Error('not configured');
  },
  cache: () => ({ get: async () => null, set: async () => {}, invalidateTag: async () => {} }),
  configured: () => ({ embeddings: false, rerank: false }),
};

const FILES = [
  {
    path: 'docs/quillwort.md',
    url: 'https://example.test/quillwort',
    content:
      '# Quillwort husbandry\n\nQuillwort tanks need soft water and a gravel bed.\n\n## Lighting\n\nKeep the quillwort under twelve hours of light a day.',
  },
];

function dependencies() {
  return {
    async fetchSnapshot() {
      return {
        files: FILES,
        config: { projectTitle: null, description: null, branch: null, folders: [], excludeFolders: [], excludeFiles: [], rules: [] },
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
        return texts.map((text) => Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17));
      },
    }),
    store: () => store,
    configured: () => ({ embeddings: true, storage: true }),
  };
}

/** A workspace on its own plan version, with a handle. */
async function workspace(label: string, monthlyCalls = 100): Promise<string> {
  const database = db();
  const id = crypto.randomUUID();
  workspaces.push(id);
  await database.insert(schema.workspace).values({ id, name: `P1 ${label}`, handle: `p1-${label}-${stamp}` });
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
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  await database.insert(schema.subscription).values({
    id: uuidv7(),
    workspaceId: id,
    planVersionId,
    status: 'active',
    periodStart: new Date(Date.now() - 86_400_000),
    periodEnd: new Date(Date.now() + 86_400_000),
  });
  return id;
}

/** A built, published website asset owned by `owner`, in no channel. */
async function ownedAsset(owner: string, slug: string): Promise<{ id: string; publicId: string }> {
  const publicId = `/websites/${slug}`;
  const { libraryId } = await createPlatformLibrary({
    actor,
    title: `Quillwort notes ${slug}`,
    publicId,
    sourceType: 'website',
    location: `https://example.test/${slug}`,
    refreshPolicy: 'manual',
    language: 'en',
    reason: 'P1 integration fixture',
  });
  assets.push(libraryId);
  const built = await buildVersion({ libraryId, operationId: uuidv7(), dependencies: dependencies() });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  await db()
    .update(schema.library)
    .set({ lifecycleStatus: 'published', isPlatformLibrary: false, ownerWorkspaceId: owner })
    .where(eq(schema.library.id, libraryId));
  /* Out of the platform channel createPlatformLibrary put it in: the owner's alone. */
  await db().delete(schema.channelAsset).where(eq(schema.channelAsset.assetId, libraryId));
  return { id: libraryId, publicId };
}

function caller(workspaceId: string | null): CallerContext {
  return { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: workspaceId === null, entrypoint: 'a2a' };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChannelRefused || error instanceof HandleRefused) return error.code;
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return 'resolved';
}

async function usageEventsFor(requestId: string) {
  return db().select().from(schema.usageEvent).where(eq(schema.usageEvent.requestId, requestId));
}

/** One JSON-RPC call through the A2A server, as the route would make it. */
async function rpc(tenant: A2ATenant, workspaceId: string | null, method: string, params: Record<string, unknown>) {
  const requestId = `req_${crypto.randomUUID()}`;
  const result = await handleA2A({
    method: 'POST',
    rest: [],
    search: new URLSearchParams(),
    body: { jsonrpc: '2.0', id: 1, method, params },
    version: '1.0',
    card: buildAgentCard({ origin: 'https://app.example.test', tenant }),
    origin: 'https://app.example.test',
    pathTenant: true,
    facts: {
      caller: { workspaceId, apiKeyId: null, requestId, anonymous: workspaceId === null, entrypoint: 'a2a' },
      tenant,
      anonymousVisitor: workspaceId ? null : `anon-${stamp}`,
    },
  });
  if (result.kind !== 'json') throw new Error(`expected JSON, got ${result.kind}`);
  return { body: result.body as { result?: Record<string, unknown>; error?: { code: number; message: string } }, requestId };
}

function sendParams(text: string, extra: Record<string, unknown> = {}) {
  return { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra } };
}

function artifactData(task: Record<string, unknown>): Record<string, unknown> {
  const artifacts = task.artifacts as { parts: { data?: Record<string, unknown>; text?: string }[] }[];
  return artifacts[0]!.parts.find((part) => part.data)!.data!;
}

describeWithDb('P1: channels, visibility and A2A', () => {
  afterAll(async () => {
    const database = db();
    if (anonymousTasks.length > 0) await database.delete(schema.a2aTask).where(inArray(schema.a2aTask.id, anonymousTasks));
    if (assets.length > 0) {
      await database.update(schema.library).set({ currentVersionId: null }).where(inArray(schema.library.id, assets));
      await database.delete(schema.channelAsset).where(inArray(schema.channelAsset.assetId, assets));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.libraryId, assets));
      await database.delete(schema.libraryClaim).where(inArray(schema.libraryClaim.libraryId, assets));
      await database.delete(schema.libraryProfileVector).where(inArray(schema.libraryProfileVector.libraryId, assets));
      await database.delete(schema.libraryProfile).where(inArray(schema.libraryProfile.libraryId, assets));
      await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, assets));
      await database.delete(schema.document).where(inArray(schema.document.libraryId, assets));
      await database.delete(schema.libraryVersion).where(inArray(schema.libraryVersion.libraryId, assets));
      await database.delete(schema.libraryScore).where(inArray(schema.libraryScore.libraryId, assets));
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.libraryId, assets));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, assets));
      await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, assets));
      await database.delete(schema.library).where(inArray(schema.library.id, assets));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.requestLog).where(inArray(schema.requestLog.workspaceId, workspaces));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database.delete(schema.usageReservation).where(inArray(schema.usageReservation.workspaceId, workspaces));
      await database.delete(schema.usageSummary).where(inArray(schema.usageSummary.workspaceId, workspaces));
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
      /* Channels, their visits and the workspace's tasks cascade with it. */
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
  });

  it('keeps an asset outside any channel, or in a private one, invisible to everyone but its owner', async () => {
    const owner = await workspace('own');
    const stranger = await workspace('str');
    const asset = await ownedAsset(owner, `p1-hidden-${stamp}`);
    const input = { libraryId: asset.publicId, query: 'quillwort lighting', maxTokens: 4000, format: 'json' as const };

    /* In no channel. */
    expect((await queryDocs(caller(owner), input, noModels)).chunks.length).toBeGreaterThan(0);
    for (const who of [stranger, null]) {
      expect(await refusal(queryDocs(caller(who), input, noModels))).toBe('library_not_found');
      const routed = await resolveLibrary(caller(who), { query: 'quillwort husbandry' }, noModels);
      expect(routed.results.map((result) => result.libraryId)).not.toContain(asset.publicId);
      const scoped = await searchScope(caller(who), { scope: { kind: 'workspace', workspaceId: owner }, query: 'quillwort', maxTokens: 4000 }, noModels);
      expect(scoped.searchedAssets).toBe(0);
      expect(scoped.chunks).toHaveLength(0);
    }
    expect(await publicLibraryDetail(asset.publicId)).toBeNull();

    /* In a private channel: still the owner's alone. */
    const hidden = await channels.createChannel({ workspaceId: owner, role: 'owner', slug: `p1-private-${stamp}`, title: 'Private shelf', visibility: 'private' });
    await channels.moveAsset({ workspaceId: owner, role: 'owner', assetId: asset.id, channelId: hidden.id });
    expect(await refusal(queryDocs(caller(stranger), input, noModels))).toBe('library_not_found');
    expect(await refusal(queryDocs(caller(null), input, noModels))).toBe('library_not_found');
    expect((await queryDocs(caller(owner), input, noModels)).chunks.length).toBeGreaterThan(0);
  });

  it('gates a move into a public channel on rights and a claim, and resets access on the way out', async () => {
    const owner = await workspace('gate');
    const stranger = await workspace('gstr');
    const asset = await ownedAsset(owner, `p1-gate-${stamp}`);
    const open = await channels.createChannel({ workspaceId: owner, role: 'owner', slug: `p1-open-${stamp}`, title: 'Quillwort club' });
    const move = (channelId: string | null) => channels.moveAsset({ workspaceId: owner, role: 'owner', assetId: asset.id, channelId });

    expect(await refusal(move(open.id))).toBe('rights_required');
    await declareLibraryRights({ workspaceId: owner, role: 'owner', libraryId: asset.id, userId: null, rights: { origin: 'own', license: 'open_source', generation: 'human' } });
    expect(await refusal(move(open.id))).toBe('claim_required');
    await db().insert(schema.libraryClaim).values({
      id: uuidv7(),
      libraryId: asset.id,
      claimantWorkspaceId: owner,
      method: 'dns_txt',
      challengeTokenHash: 'fixture',
      status: 'verified',
      expiresAt: new Date(Date.now() + 86_400_000),
      verifiedAt: new Date(),
    });
    /* Someone else's workspace cannot move it, and cannot move it into their own channel. */
    expect(await refusal(channels.moveAsset({ workspaceId: stranger, role: 'owner', assetId: asset.id, channelId: open.id }))).toBe('asset_not_found');

    expect(await move(open.id)).toMatchObject({ to: open.id, madePublic: true });
    const input = { libraryId: asset.publicId, query: 'quillwort lighting', maxTokens: 4000, format: 'json' as const };
    expect((await queryDocs(caller(stranger), input, noModels)).chunks.length).toBeGreaterThan(0);
    expect((await queryDocs(caller(null), input, noModels)).chunks.length).toBeGreaterThan(0);
    expect((await publicLibraryDetail(asset.publicId))?.channel?.slug).toBe(`p1-open-${stamp}`);

    /* An asset is in at most one channel: a second move replaces the first. */
    const other = await channels.createChannel({ workspaceId: owner, role: 'owner', slug: `p1-other-${stamp}`, title: 'Other', visibility: 'private' });
    await db().update(schema.library).set({ access: 'paid' }).where(eq(schema.library.id, asset.id));
    expect(await move(other.id)).toMatchObject({ from: open.id, to: other.id, madePublic: false });
    const memberships = await db().select().from(schema.channelAsset).where(eq(schema.channelAsset.assetId, asset.id));
    expect(memberships.map((row) => row.channelId)).toEqual([other.id]);
    /* Access describes the asset inside one channel and is not carried to the next. */
    const [afterMove] = await db().select({ access: schema.library.access }).from(schema.library).where(eq(schema.library.id, asset.id));
    expect(afterMove?.access).toBe('free');

    await db().update(schema.library).set({ access: 'paid' }).where(eq(schema.library.id, asset.id));
    expect(await move(null)).toMatchObject({ from: other.id, to: null });
    const [afterOut] = await db().select({ access: schema.library.access }).from(schema.library).where(eq(schema.library.id, asset.id));
    expect(afterOut?.access).toBe('free');
    expect(await refusal(queryDocs(caller(stranger), input, noModels))).toBe('library_not_found');
  });

  it('gives a private channel no card and keeps it, and empty channels, out of the directory', async () => {
    const owner = await workspace('card');
    const asset = await ownedAsset(owner, `p1-card-${stamp}`);
    await declareLibraryRights({ workspaceId: owner, role: 'owner', libraryId: asset.id, userId: null, rights: { origin: 'own', license: 'open_source', generation: 'human' } });
    await db().insert(schema.libraryClaim).values({
      id: uuidv7(), libraryId: asset.id, claimantWorkspaceId: owner, method: 'dns_txt', challengeTokenHash: 'fixture',
      status: 'verified', expiresAt: new Date(Date.now() + 86_400_000), verifiedAt: new Date(),
    });
    const publicSlug = `p1-pub-${stamp}`;
    const privateSlug = `p1-priv-${stamp}`;
    const emptySlug = `p1-empty-${stamp}`;
    const pub = await channels.createChannel({ workspaceId: owner, role: 'owner', slug: publicSlug, title: 'Quillwort public' });
    await channels.createChannel({ workspaceId: owner, role: 'owner', slug: privateSlug, title: 'Quillwort private', visibility: 'private' });
    await channels.createChannel({ workspaceId: owner, role: 'owner', slug: emptySlug, title: 'Nothing yet' });
    await channels.moveAsset({ workspaceId: owner, role: 'owner', assetId: asset.id, channelId: pub.id });

    expect(await resolveTenant(`channels/${privateSlug}`)).toBeNull();
    expect(await resolveTenant(`channels/${publicSlug}`)).toMatchObject({ level: 'channel', slug: publicSlug });
    const privateCard = await serveCard(new NextRequest(`https://app.example.test/a2a/channels/${privateSlug}/agent-card.json`), `channels/${privateSlug}`);
    expect(privateCard.status).toBe(404);
    const publicCard = await serveCard(
      new NextRequest(`https://app.example.test/a2a/channels/${publicSlug}/agent-card.json`, { headers: { 'a2a-version': '1.0' } }),
      `channels/${publicSlug}`,
    );
    expect(publicCard.status).toBe(200);
    const card = (await publicCard.json()) as { supportedInterfaces: { tenant?: string }[]; skills: { id: string }[] };
    expect(card.supportedInterfaces[0]?.tenant).toBe(`channels/${publicSlug}`);
    expect(card.skills.map((skill) => skill.id)).toEqual(['search_context']);
    /* Without A2A-Version the caller speaks 0.3: the legacy shape, with the 1.0 interfaces embedded. */
    const legacy = (await (await serveCard(new NextRequest('https://app.example.test/x'), `channels/${publicSlug}`)).json()) as {
      url: string;
      protocolVersion: string;
      supportedInterfaces: unknown[];
    };
    expect(legacy.url).toBe(`https://app.example.test/a2a/channels/${publicSlug}`);
    expect(legacy.protocolVersion).toBe('0.3');
    expect(legacy.supportedInterfaces.length).toBe(4);

    const { entries } = await channels.listChannelDirectory({ sort: 'recent', limit: 100 });
    const slugs = entries.map((entry) => entry.slug);
    expect(slugs).toContain(publicSlug);
    expect(slugs).not.toContain(privateSlug);
    expect(slugs).not.toContain(emptySlug);
    const hot = await channels.listChannelDirectory({ sort: 'hot', limit: 100 });
    expect(hot.entries.map((entry) => entry.slug)).toContain(publicSlug);

    /* The user page lists the public channel; the user card exists. */
    const page = await channels.userByHandle(`p1-card-${stamp}`);
    expect(page?.channels.map((entry) => entry.slug)).toEqual([publicSlug]);
    expect(await resolveTenant(`users/p1-card-${stamp}`)).toMatchObject({ level: 'user' });
  });

  it('meters A2A search: anonymous writes nothing, a signed caller pays itself, the owner never', async () => {
    const owner = await workspace('meter');
    const visitor = await workspace('mvis');
    const asset = await ownedAsset(owner, `p1-meter-${stamp}`);
    await declareLibraryRights({ workspaceId: owner, role: 'owner', libraryId: asset.id, userId: null, rights: { origin: 'own', license: 'open_source', generation: 'human' } });
    await db().insert(schema.libraryClaim).values({
      id: uuidv7(), libraryId: asset.id, claimantWorkspaceId: owner, method: 'dns_txt', challengeTokenHash: 'fixture',
      status: 'verified', expiresAt: new Date(Date.now() + 86_400_000), verifiedAt: new Date(),
    });
    const slug = `p1-meter-${stamp}`;
    const channel = await channels.createChannel({ workspaceId: owner, role: 'owner', slug, title: 'Quillwort meter' });
    await channels.moveAsset({ workspaceId: owner, role: 'owner', assetId: asset.id, channelId: channel.id });
    const tenant = (await resolveTenant(`channels/${slug}`))!;

    /* Anonymous: results, and no usage event at all. */
    const anonymous = await rpc(tenant, null, 'SendMessage', sendParams('quillwort lighting'));
    const anonymousTask = anonymous.body.result!.task as Record<string, unknown>;
    anonymousTasks.push(anonymousTask.id as string);
    expect((anonymousTask.status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    const evidence = artifactData(anonymousTask) as { results: { assetId: string; version: string; chunkId: string; sourceUrl: string; anchor: { status: string; verifyUrl: string } }[]; usage: { callsUsed: number } };
    expect(evidence.results.length).toBeGreaterThan(0);
    expect(evidence.results[0]).toMatchObject({ assetId: asset.publicId, sourceUrl: 'https://example.test/quillwort' });
    expect(evidence.results[0]!.anchor.verifyUrl).toContain('/api/v1/anchors?version=');
    expect(evidence.usage.callsUsed).toBe(0);
    expect(await usageEventsFor(anonymous.requestId)).toHaveLength(0);
    const [stored] = await db().select().from(schema.a2aTask).where(eq(schema.a2aTask.id, anonymousTask.id as string));
    expect(stored?.workspaceId).toBeNull();

    /* Authenticated: one Call on the caller's own workspace, entrypoint a2a. */
    const signed = await rpc(tenant, visitor, 'SendMessage', sendParams('quillwort lighting'));
    expect(((signed.body.result!.task as Record<string, unknown>).status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    const charged = await usageEventsFor(signed.requestId);
    expect(charged).toHaveLength(1);
    expect(charged[0]).toMatchObject({ workspaceId: visitor, entrypoint: 'a2a', operation: 'search_context', calls: 1, libraryId: asset.id });

    /* Nothing found, nothing charged. */
    const empty = await rpc(tenant, visitor, 'SendMessage', sendParams('zzzqqqxxx nonexistentword'));
    expect(artifactData(empty.body.result!.task as Record<string, unknown>)).toMatchObject({ results: [], usage: { callsUsed: 0 } });
    expect(await usageEventsFor(empty.requestId)).toHaveLength(0);

    /* The owner paid for none of it. */
    const ownerEvents = await db().select().from(schema.usageEvent).where(and(eq(schema.usageEvent.workspaceId, owner), eq(schema.usageEvent.entrypoint, 'a2a')));
    expect(ownerEvents).toHaveLength(0);

    /* Both callers counted once each toward the directory's activity, the owner not at all. */
    const visits = await db().select().from(schema.channelVisit).where(eq(schema.channelVisit.channelId, channel.id));
    expect(visits.map((visit) => visit.visitorKind).sort()).toEqual(['anonymous', 'workspace']);
  });

  it('serves SendMessage, GetTask, ListTasks and SubscribeToTask from the shared store', async () => {
    const owner = await workspace('task');
    const caller2 = await workspace('tcall');
    const asset = await ownedAsset(owner, `p1-task-${stamp}`);
    await declareLibraryRights({ workspaceId: owner, role: 'owner', libraryId: asset.id, userId: null, rights: { origin: 'own', license: 'open_source', generation: 'human' } });
    await db().insert(schema.libraryClaim).values({
      id: uuidv7(), libraryId: asset.id, claimantWorkspaceId: owner, method: 'dns_txt', challengeTokenHash: 'fixture',
      status: 'verified', expiresAt: new Date(Date.now() + 86_400_000), verifiedAt: new Date(),
    });
    const slug = `p1-task-${stamp}`;
    const channel = await channels.createChannel({ workspaceId: owner, role: 'owner', slug, title: 'Quillwort tasks' });
    await channels.moveAsset({ workspaceId: owner, role: 'owner', assetId: asset.id, channelId: channel.id });
    const tenant = (await resolveTenant(`channels/${slug}`))!;

    const sent = await rpc(tenant, caller2, 'SendMessage', sendParams('quillwort water'));
    const taskId = (sent.body.result!.task as { id: string }).id;

    /* A different handler instance -- another function, as far as the store knows. */
    const got = await rpc(tenant, caller2, 'GetTask', { id: taskId });
    expect((got.body.result as { id: string; status: { state: string } }).status.state).toBe('TASK_STATE_COMPLETED');
    expect((got.body.result as { artifacts: unknown[] }).artifacts).toHaveLength(1);

    /* Another workspace, or nobody, cannot read it; the wrong tenant cannot either. */
    expect((await rpc(tenant, owner, 'GetTask', { id: taskId })).body.error?.code).toBe(-32001);
    expect((await rpc(tenant, null, 'GetTask', { id: taskId })).body.error?.code).toBe(-32001);
    expect((await rpc(PLATFORM_TENANT, caller2, 'GetTask', { id: taskId })).body.error?.code).toBe(-32001);

    const listed = await rpc(tenant, caller2, 'ListTasks', {});
    expect((listed.body.result as { tasks: { id: string }[] }).tasks.map((task) => task.id)).toContain(taskId);
    expect((await rpc(tenant, null, 'ListTasks', {})).body.result).toMatchObject({ tasks: [] });

    /* HTTP+JSON: the same task by path, and a subscription that replays it and ends. */
    const rest = await handleA2A({
      method: 'GET',
      rest: ['tasks', taskId],
      search: new URLSearchParams(),
      body: undefined,
      version: '1.0',
      card: buildAgentCard({ origin: 'https://app.example.test', tenant }),
      origin: 'https://app.example.test',
      pathTenant: true,
      facts: { caller: { ...caller(caller2), entrypoint: 'a2a' }, tenant, anonymousVisitor: null },
    });
    expect(rest).toMatchObject({ kind: 'json', status: 200 });
    const subscribed = await handleA2A({
      method: 'GET',
      rest: ['tasks', `${taskId}:subscribe`],
      search: new URLSearchParams(),
      body: undefined,
      version: '1.0',
      card: buildAgentCard({ origin: 'https://app.example.test', tenant }),
      origin: 'https://app.example.test',
      pathTenant: true,
      streamWindowMs: 2_000,
      facts: { caller: { ...caller(caller2), entrypoint: 'a2a' }, tenant, anonymousVisitor: null },
    });
    if (subscribed.kind !== 'sse') throw new Error('expected a stream');
    const events: unknown[] = [];
    for await (const event of subscribed.events) events.push(event);
    expect(events).toHaveLength(1);
    expect((events[0] as { task: { id: string; status: { state: string } } }).task.status.state).toBe('TASK_STATE_COMPLETED');

    /* find_channels on the platform card finds the channel and its card. */
    const found = await rpc(PLATFORM_TENANT, null, 'SendMessage', sendParams('quillwort', { metadata: { skill: 'find_channels' } }));
    const foundTask = found.body.result!.task as Record<string, unknown>;
    anonymousTasks.push(foundTask.id as string);
    const listedChannels = (artifactData(foundTask) as { channels: { slug: string; agentCardUrl: string }[] }).channels;
    expect(listedChannels.map((entry) => entry.slug)).toContain(slug);
    expect(listedChannels.find((entry) => entry.slug === slug)?.agentCardUrl).toBe(`https://app.example.test/a2a/channels/${slug}/agent-card.json`);

    /* A skill the card does not offer is rejected, not run. */
    const rejected = await rpc(tenant, caller2, 'SendMessage', sendParams('x', { metadata: { skill: 'find_channels' } }));
    expect(((rejected.body.result!.task as Record<string, unknown>).status as { state: string }).state).toBe('TASK_STATE_REJECTED');
  });

  it('refuses a GitHub asset whose owner is a reserved name, before asking GitHub', async () => {
    const owner = await workspace('gh');
    let asked = false;
    const attempt = await refusal(
      createWorkspaceLibrary({
        role: 'owner',
        workspaceId: owner,
        userId: crypto.randomUUID(),
        title: 'Shadowing a namespace',
        sourceType: 'github',
        location: 'https://github.com/channels/handbook',
        slug: '',
        checkRepository: async () => {
          asked = true;
          return { location: 'channels/handbook', repositoryId: 1 };
        },
      }),
    );
    expect(attempt).toBe('invalid_request');
    expect(asked).toBe(false);
    const rows = await db().select().from(schema.library).where(eq(schema.library.publicId, '/channels/handbook'));
    expect(rows).toHaveLength(0);
  });

  it('keeps handles unique and off the reserved list', async () => {
    const first = await workspace('h1');
    const second = await workspace('h2');
    expect(await refusal(changeWorkspaceHandle({ workspaceId: first, role: 'owner', handle: 'dashboard' }))).toBe('reserved');
    expect(await refusal(changeWorkspaceHandle({ workspaceId: first, role: 'owner', handle: 'x' }))).toBe('invalid');
    expect(await refusal(changeWorkspaceHandle({ workspaceId: first, role: 'member', handle: `p1-new-${stamp}` }))).toBe('access_denied');
    expect(await changeWorkspaceHandle({ workspaceId: first, role: 'owner', handle: `P1-New-${stamp}` })).toBe(`p1-new-${stamp}`);
    expect(await refusal(changeWorkspaceHandle({ workspaceId: second, role: 'owner', handle: `p1-new-${stamp}` }))).toBe('taken');
  });
});
