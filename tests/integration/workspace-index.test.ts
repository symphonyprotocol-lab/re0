/**
 * The agent workspace's second phase (docs/design/agent-workspace.md §2.2-2.4,
 * §5-§7.3): indexing on request and for Rees, two quiet minutes after a
 * change, only changed passages embedded, within the daily budget; ws_search;
 * Rees bound to folders (one embedding for two Rees), files following moves
 * and deletes; a published Ree's new files waiting for the owner and the
 * secret scan; a Ree's text moved into the workspace without any charge; and
 * the MCP tools for all of it. Embeddings come from the fake model server.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const objects = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/workspace-store', () => ({
  workspaceObjectPath: (workspaceId: string, sha: string) => `workspace/${workspaceId.toLowerCase()}/${sha}`,
  putWorkspaceObject: async (path: string, bytes: Uint8Array) => void objects.set(path, bytes),
  readWorkspaceObject: async (path: string) => objects.get(path) ?? null,
  deleteWorkspaceObjects: async (paths: readonly string[]) => paths.forEach((path) => objects.delete(path)),
}));
const later: (() => unknown)[] = [];
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: (task: () => unknown) => void later.push(task) }));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const apiKeys = await import('@/lib/services/api-keys');
const workspace = await import('@/lib/services/workspace');
const index = await import('@/lib/services/workspace-index');
const wsRees = await import('@/lib/services/workspace-rees');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const library = await import('@/lib/services/knowledge-library');
const retrieval = await import('@/lib/services/retrieval');
const route = await import('@/app/api/mcp/route');
const { db, schema } = await import('@/lib/infra/db');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { forgetRateLimitSettings } = await import('@/lib/services/rate-limit-settings');
const { addGrant } = await import('@/lib/services/credits');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

const URL_ = 'http://localhost:3000/api/mcp';
const routeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const handler = { GET: route.GET, POST: route.POST, DELETE: route.DELETE }[request.method as 'GET' | 'POST' | 'DELETE'];
  return handler ? handler(request as Parameters<typeof route.POST>[0]) : new Response(null, { status: 405 });
};

async function person(credits = 1_000) {
  const subject = uniqueName('wsi');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  if (credits) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

async function connect(userId: string, options: { kind?: 'account' | 'workspace'; workspaceAccess?: 'read' | 'write'; canWrite?: boolean; workspaceRoot?: string } = {}) {
  const { secret } = await apiKeys.createApiKey(userId, { name: 'k', canWrite: options.canWrite ?? false, kind: options.kind, workspaceAccess: options.workspaceAccess ?? 'write', workspaceRoot: options.workspaceRoot });
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: routeFetch, requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
  return client;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content: { text?: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return result.structuredContent!;
}
async function refused(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  expect(result.isError, `${name} should fail`).toBe(true);
  return result.structuredContent!;
}

const embedded = () => fake.requests.filter((request) => request.path.endsWith('/embeddings')).flatMap((request) => request.inputs ?? []);
/** Runs the index cron as if the two quiet minutes had passed. */
const indexNow = () => index.runIndexQueue(new Date(Date.now() + 3 * 60_000));

async function setCeiling(key: string, value: number | null) {
  if (value === null) await db().delete(schema.limitCeilingSetting).where(eq(schema.limitCeilingSetting.key, key));
  else await db().insert(schema.limitCeilingSetting).values({ key, value }).onConflictDoUpdate({ target: schema.limitCeilingSetting.key, set: { value } });
  forgetRateLimitSettings();
}

const reeFields = (name: string) => ({ name, description: 'Notes from the workspace.', category: 'travel' as const, tags: [], systemPrompt: '', sampleQuestions: [], queryFee: 0 });

describeWithDb('workspace index', () => {
  it('quotes before turning on, indexes after the quiet minutes, and searches what it indexed', async () => {
    const userId = await person();
    const client = await connect(userId);
    await ok(client, 'ws_write', { path: '/docs/visa.md', content: '# Visa\n\nCitizens of most countries enter Paraguay visa-free for 90 days.\n' });
    await ok(client, 'ws_write', { path: '/docs/transport.md', content: '# Buses\n\nThe bus from Asunción to Encarnación takes five and a half hours.\n' });
    expect((await refused(client, 'ws_index', { path: '/docs', mode: 'on', max_cost: 0 })).error).toBe('max_cost_exceeded');
    expect((await ok(client, 'ws_search', { query: 'bus to Encarnación' })).passages).toEqual([]);
    const on = await ok(client, 'ws_index', { path: '/docs', mode: 'on', max_cost: 100 });
    expect(on).toMatchObject({ mode: 'on', queued: 2 });
    expect(on.estimate.files).toBe(2);
    const counts = await index.runIndexQueue(new Date());
    expect(counts.indexed).toBe(2);
    const found = await ok(client, 'ws_search', { query: 'how long is the bus to Encarnación' });
    expect(found.passages[0]).toMatchObject({ path: '/docs/transport.md', lines: [1, 3] });
    const [run] = await db().select().from(schema.knowledgeCostRun).where(and(eq(schema.knowledgeCostRun.userId, userId), eq(schema.knowledgeCostRun.kind, 'workspace_index')));
    expect(run).toMatchObject({ status: 'ready' });
    expect((await index.indexBudget(userId)).spent).toBeGreaterThanOrEqual(0);
    /* Files outside an indexed folder are not indexed: they stay greppable. */
    await ok(client, 'ws_write', { path: '/scratch/todo.md', content: 'buy tickets' });
    await indexNow();
    expect((await db().select().from(schema.workspacePassage).where(eq(schema.workspacePassage.workspaceId, await workspace.defaultWorkspace(userId)))).length).toBe(2);
  });

  it('indexes a burst of saves once, and re-embeds only what an edit changed', async () => {
    const userId = await person();
    const client = await connect(userId);
    await ok(client, 'ws_mkdir', { path: '/book' });
    await ok(client, 'ws_index', { path: '/book', mode: 'on' });
    const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}: ${'the quick brown fox jumps over the lazy dog '.repeat(2)}${i}`);
    for (let i = 0; i < 10; i += 1) await ok(client, 'ws_write', { path: '/book/long.md', content: `${lines.join('\n')}\n${i}` });
    const before = embedded().length;
    /* Not due yet: the last save was just now. */
    expect((await index.runIndexQueue(new Date())).indexed).toBe(0);
    expect((await indexNow()).indexed).toBe(1);
    const first = embedded().length - before;
    expect(first).toBeGreaterThan(10);
    const edited = [...lines];
    edited[500] = 'Line 501: changed.';
    await ok(client, 'ws_write', { path: '/book/long.md', content: `${edited.join('\n')}\n9` });
    const mid = embedded().length;
    expect((await indexNow()).indexed).toBe(1);
    /* The edited passage, what it split into, and at most a neighbour whose start moved: not the rest of the file. */
    expect(embedded().length - mid).toBeLessThanOrEqual(3);
    expect(embedded().length - mid).toBeLessThan(first / 5);
  });

  it('stops at the daily budget and lets the file wait for the next day', async () => {
    const userId = await person();
    const client = await connect(userId);
    await ok(client, 'ws_mkdir', { path: '/b' });
    await ok(client, 'ws_index', { path: '/b', mode: 'on' });
    await ok(client, 'ws_write', { path: '/b/a.md', content: 'something worth indexing' });
    await setCeiling('workspaceIndexBudget', 1);
    try {
      await db().insert(schema.workspaceUsage).values({ userId }).onConflictDoNothing();
      await db().update(schema.workspaceUsage).set({ indexSpentDay: new Date().toISOString().slice(0, 10), indexSpent: 1 }).where(eq(schema.workspaceUsage.userId, userId));
      expect((await indexNow()).budget).toBeGreaterThanOrEqual(1);
      const [entry] = await db().select().from(schema.workspaceEntry).where(and(eq(schema.workspaceEntry.workspaceId, await workspace.defaultWorkspace(userId)), eq(schema.workspaceEntry.path, '/b/a.md')));
      expect(entry).toMatchObject({ indexError: 'budget', indexedRevisionId: null });
      expect(entry!.indexDueAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
      expect((await ok(client, 'ws_grep', { pattern: 'worth' })).matches).toHaveLength(1);
    } finally {
      await setCeiling('workspaceIndexBudget', null);
    }
  });
});

describeWithDb('Rees on workspace folders', () => {
  it('creates a private Ree from a folder, answers from it, and shares one embedding with a second Ree', async () => {
    const userId = await person();
    const client = await connect(userId, { canWrite: true });
    await ok(client, 'ws_write', { path: '/guide/itinerary.md', content: '# Day 4\n\nTake the bus to Encarnación and visit the Jesuit ruins at Trinidad.\n' });
    await ok(client, 'ws_write', { path: '/guide/drafts/wip.md', content: 'not ready' });
    expect((await refused(client, 'create_ree_from_folder', { path: '/guide', name: uniqueName('Guide').slice(0, 40), category: 'travel', max_cost: 0 })).error).toBe('max_cost_exceeded');
    const made = await ok(client, 'create_ree_from_folder', { path: '/guide', name: uniqueName('Guide').slice(0, 40), category: 'travel', exclude: ['drafts/**'], max_cost: 100 });
    expect(made.ree.is_public).toBe(false);
    expect(made.bindings[0]).toMatchObject({ path: '/guide', exclude: ['drafts/**'] });
    await indexNow();
    const sources = await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, made.ree.id));
    expect(sources.map((source) => source.title)).toEqual(['itinerary.md']);
    expect(sources[0]).toMatchObject({ kind: 'file', status: 'ready', enabled: true, awaitingConfirmation: false });
    const found = await retrieval.retrieve(made.ree.id, 'How do I get to the Jesuit ruins at Trinidad?');
    expect(found.passages[0]?.title).toBe('itinerary.md');
    expect(found.passages[0]?.locator.path).toBe('itinerary.md');

    /* The same folder bound to another Ree: no new embedding. */
    const before = embedded().length;
    const { ree: second } = await rees.createRee(userId, { ...reeFields(uniqueName('Second').slice(0, 40)), isPublic: false, color: 'default' });
    await ok(client, 'bind_ree_paths', { ree: second.id, add: ['/guide/itinerary.md'] });
    await indexNow();
    expect(embedded().length).toBe(before);
    expect((await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, second.id))).map((source) => source.title)).toEqual(['itinerary.md']);
  });

  it('follows moves and deletes: a file leaving the folder leaves the Ree for its trash, and comes back', async () => {
    const userId = await person();
    const client = await connect(userId, { canWrite: true });
    await ok(client, 'ws_write', { path: '/kb/a.md', content: 'Alpha facts about Asunción.' });
    const made = await ok(client, 'create_ree_from_folder', { path: '/kb', name: uniqueName('Kb').slice(0, 40), category: 'travel' });
    await indexNow();
    const live = async () => (await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, made.ree.id))).filter((row) => !row.deletedAt).map((row) => row.title);
    expect(await live()).toEqual(['a.md']);
    await ok(client, 'ws_move', { from: '/kb/a.md', to: '/elsewhere/a.md' });
    expect(await live()).toEqual([]);
    await ok(client, 'ws_move', { from: '/elsewhere/a.md', to: '/kb/a.md' });
    await indexNow();
    expect(await live()).toEqual(['a.md']);
    await ok(client, 'ws_delete', { path: '/kb/a.md' });
    expect(await live()).toEqual([]);
    /* The binding names the folder, not its path: renaming it keeps the Ree's knowledge. */
    await ok(client, 'ws_write', { path: '/kb/b.md', content: 'Beta facts.' });
    await indexNow();
    await ok(client, 'ws_move', { from: '/kb', to: '/knowledge-base' });
    await indexNow();
    expect(await live()).toEqual(['b.md']);
  });

  it("holds a published Ree's new files for confirmation, and never enables one with a secret", async () => {
    const userId = await person();
    const client = await connect(userId, { canWrite: true });
    await ok(client, 'ws_write', { path: '/pub/one.md', content: 'Published knowledge about Ciudad del Este.' });
    const made = await ok(client, 'create_ree_from_folder', { path: '/pub', name: uniqueName('Pub').slice(0, 40), category: 'travel' });
    await indexNow();
    await rees.setReesVisibility(userId, [made.ree.id], true);
    await rees.setReePublished(userId, made.ree.id, true);
    await ok(client, 'ws_write', { path: '/pub/new.md', content: 'Fresh notes about Ciudad del Este markets.' });
    await ok(client, 'ws_write', { path: '/pub/keys.md', content: `deploy with sk-${'a'.repeat(40)}` });
    await indexNow();
    const waiting = await wsRees.awaitingFiles(userId, made.ree.id);
    expect(waiting.map((row) => [row.title, row.secretFound]).sort()).toEqual([['keys.md', 'openai_key'], ['new.md', null]]);
    const passages = await retrieval.retrieve(made.ree.id, 'markets in Ciudad del Este');
    expect(passages.passages.map((passage) => passage.title)).not.toContain('new.md');
    expect(await wsRees.decideAwaiting(userId, made.ree.id, waiting.map((row) => row.id), 'confirm')).toEqual({ changed: 1, refused: 1 });
    const keys = waiting.find((row) => row.title === 'keys.md')!;
    await expect(library.runBatch(userId, made.ree.id, { action: 'resume', ids: [keys.id] })).rejects.toMatchObject({ code: 'secret_found' });
    expect((await retrieval.retrieve(made.ree.id, 'markets in Ciudad del Este')).passages.map((passage) => passage.title)).toContain('new.md');
  });

  it('quarantines a flagged file when its private Ree is published', async () => {
    const userId = await person();
    const client = await connect(userId, { canWrite: true });
    await ok(client, 'ws_write', { path: '/priv/creds.md', content: `aws key AKIA${'ABCDEFGHIJKLMNOP'}` });
    const made = await ok(client, 'create_ree_from_folder', { path: '/priv', name: uniqueName('Priv').slice(0, 40), category: 'travel' });
    await indexNow();
    const [before] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, made.ree.id));
    expect(before).toMatchObject({ enabled: true, secretFound: 'aws_access_key' });
    await rees.setReesVisibility(userId, [made.ree.id], true);
    await rees.setReePublished(userId, made.ree.id, true);
    const [after] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, made.ree.id));
    expect(after).toMatchObject({ enabled: false, awaitingConfirmation: true });
  });

  it("moves a Ree's pasted text into the workspace without embedding or charging anything", async () => {
    const userId = await person();
    const { ree } = await rees.createRee(userId, { ...reeFields(uniqueName('Old').slice(0, 40)), isPublic: false, color: 'default' });
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Packing list', content: 'Bring sunscreen and a hat for the Chaco.' });
    await knowledge.processKnowledge(id, { profile: false });
    const chunksBefore = await db().select({ id: schema.chunk.id }).from(schema.chunk).where(eq(schema.chunk.knowledgeId, id));
    const before = embedded().length;
    const result = await wsRees.moveReeToWorkspace(userId, ree.id);
    expect(result).toMatchObject({ moved: 1, folder: `/Rees/${ree.slug}` });
    await indexNow();
    expect(embedded().length).toBe(before);
    const [source] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, id));
    expect(source).toMatchObject({ kind: 'file', status: 'ready', enabled: true });
    expect((await db().select({ id: schema.chunk.id }).from(schema.chunk).where(eq(schema.chunk.knowledgeId, id))).length).toBe(chunksBefore.length);
    const file = await workspace.fileText(await workspace.webScope(userId), `/Rees/${ree.slug}/Packing list.md`);
    expect(file.text).toBe('Bring sunscreen and a hat for the Chaco.');
    expect((await db().select().from(schema.knowledgeCostRun).where(and(eq(schema.knowledgeCostRun.userId, userId), eq(schema.knowledgeCostRun.kind, 'workspace_index')))).length).toBe(0);
  });

  it('lists the Ree tools only to account keys with workspace access, and asks for "Allow changes"', async () => {
    const userId = await person();
    const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name);
    const scoped = await connect(userId, { kind: 'workspace', workspaceAccess: 'write' });
    expect(await names(scoped)).toEqual(expect.arrayContaining(['ws_index', 'ws_search']));
    expect(await names(scoped)).not.toContain('create_ree_from_folder');
    const readOnly = await connect(userId, { canWrite: false });
    expect(await names(readOnly)).toContain('create_ree_from_folder');
    await ok(readOnly, 'ws_write', { path: '/x/a.md', content: 'a' });
    expect((await refused(readOnly, 'create_ree_from_folder', { path: '/x', name: 'Nope nope', category: 'travel' })).error).toBe('write_not_allowed');
    const reader = await connect(userId, { kind: 'workspace', workspaceAccess: 'read' });
    expect((await refused(reader, 'ws_index', { path: '/x', mode: 'on' })).error).toBe('workspace_not_allowed');
    const other = await connect(await person(), { canWrite: true });
    expect((await refused(other, 'bind_ree_paths', { ree: (await rees.createRee(userId, { ...reeFields(uniqueName('Mine').slice(0, 40)), isPublic: false, color: 'default' })).ree.id, add: ['/'] })).error).toBe('not_found');
  });
});

