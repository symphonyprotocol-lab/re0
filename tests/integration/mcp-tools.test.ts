/**
 * The MCP server's post and Ree tools (lib/services/mcp-posts.ts,
 * mcp-rees.ts) through the official client: a key reads and asks unless it
 * was made with "allow changes", and then every write tool does what its
 * web route does for the same account -- the same refusals for someone
 * else's posts and Rees, the same prices and holds, the same work deferred
 * past the response (`after`, collected here and run by hand).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { freezeDateAtWindowStart, pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const later: (() => unknown)[] = [];
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: (task: () => unknown) => void later.push(task) }));
/* One tool's service fails once on demand: what a client is told when re0 breaks mid-call. */
const breakage = vi.hoisted(() => ({ next: false }));
vi.mock('@/lib/services/ree-favorites', async (original) => {
  const real = await original<typeof import('@/lib/services/ree-favorites')>();
  return {
    ...real,
    listFavoriteRees: (...args: Parameters<typeof real.listFavoriteRees>) => {
      if (!breakage.next) return real.listFavoriteRees(...args);
      breakage.next = false;
      return Promise.reject(new Error('boom'));
    },
  };
});

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const posts = await import('@/lib/services/posts');
const apiKeys = await import('@/lib/services/api-keys');
const route = await import('@/app/api/mcp/route');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE: BASE, MCP_REE_CREATE_PER_DAY } = await import('@/lib/constants');
const { AI_ANSWER_FEE } = await import('@/lib/domain/post');
const privatePosts = await import('@/lib/services/private-posts');
const { hitRateBucket } = await import('@/lib/services/rate-limit');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

const URL_ = 'http://localhost:3000/api/mcp';
const QUESTION = 'When are refunds issued to the original payment method?';
const passage = (word: string) => `Ledger ${word}: refunds are issued to the original payment method within 14 days of the request.`;

/** Runs (and forgets) the work the tools deferred past their response. */
async function drain() {
  while (later.length) await later.shift()!();
}

async function person() {
  const subject = uniqueName('mcpw');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  return userId;
}

async function reeOf(ownerId: string, options: { isPublic?: boolean; queryFee?: number; answersPosts?: boolean } = {}) {
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Ree').slice(0, 40), description: 'A companion for testing.', category: 'business', isPublic: options.isPublic ?? true, queryFee: options.queryFee ?? 0, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  if (ree.isPublic) await rees.setReePublished(ownerId, ree.id, true);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: `${ree.name} notes`, content: passage(`w${Date.now().toString(36)}`) });
  await knowledge.processKnowledge(id, { profile: false });
  if (options.answersPosts !== undefined) await db().update(schema.ree).set({ answersPosts: options.answersPosts }).where(eq(schema.ree.id, ree.id));
  const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
  return row!;
}

const routeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const handler = { GET: route.GET, POST: route.POST, DELETE: route.DELETE }[request.method as 'GET' | 'POST' | 'DELETE'];
  if (!handler) return new Response(null, { status: 405 });
  return handler(request as Parameters<typeof route.POST>[0]);
};

async function connect(userId: string, canWrite = true) {
  const { secret, key } = await apiKeys.createApiKey(userId, { name: 'k', canWrite });
  const client = new Client({ name: 're0-tests', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: routeFetch, requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
  return { client, keyId: key.id };
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** A tool call that must succeed; its structured result. */
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return result.structuredContent as Record<string, any>;
}

const errorOf = (result: ToolResult) => (result.isError ? (result.structuredContent as { error: string; reason?: string }) : null);

const WRITE_TOOLS = [
  'create_post',
  'add_followup',
  'delete_followup',
  'publish_post',
  'update_post',
  'trash_post',
  'save_post',
  'mark_helpful',
  'respond_paid_request',
  'create_ree',
  'update_ree',
  'publish_ree',
  'delete_ree',
  'add_knowledge',
  'delete_knowledge',
  'add_ree_comment',
  'delete_ree_comment',
  'favorite_ree',
];

describeWithDb('MCP tools: permissions', () => {
  it('lists every tool; destructive ones say so; spending ones say they spend credits', async () => {
    const { client } = await connect(await person(), false);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [...WRITE_TOOLS, 'search_rees', 'get_ree', 'list_my_rees', 'ask_ree', 'list_posts', 'get_post', 'list_knowledge', 'list_ree_comments', 'list_favorite_rees', 'get_share_link', 'ree_statistics']) expect(names).toContain(name);
    const destructive = tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name).sort();
    expect(destructive).toEqual(['delete_followup', 'delete_knowledge', 'delete_ree', 'delete_ree_comment', 'trash_post']);
    for (const name of ['ask_ree', 'create_post', 'add_followup', 'add_knowledge', 'respond_paid_request']) expect(tools.find((tool) => tool.name === name)!.description).toContain('SPENDS CREDITS');
    for (const tool of tools.filter((entry) => entry.annotations?.readOnlyHint)) expect(WRITE_TOOLS).not.toContain(tool.name);
    await client.close();
  });

  it('keys read and ask by default; only "allow changes" keys write, and existing keys stay read-only', async () => {
    const userId = await person();
    const plain = await apiKeys.createApiKey(userId, { name: 'plain' });
    const writer = await apiKeys.createApiKey(userId, { name: 'writer', canWrite: true });
    const notQuite = await apiKeys.createApiKey(userId, { name: 'not quite', canWrite: 'true' });
    expect([plain.key.canWrite, writer.key.canWrite, notQuite.key.canWrite]).toEqual([false, true, false]);
    expect((await apiKeys.listApiKeys(userId)).find((key) => key.id === writer.key.id)).toMatchObject({ canWrite: true });

    const ree = await reeOf(userId, { isPublic: false });
    const { client } = await connect(userId, false);
    const args: Record<string, Record<string, unknown>> = {
      create_post: { visibility: 'public', question: QUESTION },
      add_followup: { post: ree.id, question: 'And then?' },
      delete_followup: { followup: ree.id },
      publish_post: { post: ree.id },
      update_post: { post: ree.id, pinned: true },
      trash_post: { post: ree.id },
      save_post: { post: ree.id },
      mark_helpful: { post: ree.id },
      respond_paid_request: { request: ree.id, action: 'decline' },
      create_ree: { name: 'Nope', category: 'business' },
      update_ree: { ree: ree.id, name: 'Renamed' },
      publish_ree: { ree: ree.id },
      delete_ree: { ree: ree.id },
      add_knowledge: { ree: ree.id, kind: 'text', title: 't', content: 'c' },
      delete_knowledge: { ree: ree.id, knowledge: ree.id },
      add_ree_comment: { ree: ree.id, content: 'hi' },
      delete_ree_comment: { ree: ree.id, comment: ree.id },
      favorite_ree: { ree: ree.id },
    };
    for (const name of WRITE_TOOLS) expect(errorOf(await call(client, name, args[name]!)), name).toMatchObject({ error: 'write_not_allowed' });
    const [after] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
    expect(after).toMatchObject({ name: ree.name, deletedAt: null });
    expect(await db().select().from(schema.post).where(eq(schema.post.userId, userId))).toHaveLength(0);
    /* Reading and asking still work. */
    expect((await call(client, 'list_my_rees')).isError).toBeFalsy();
    expect((await call(client, 'list_posts', { feed: 'mine' })).isError).toBeFalsy();
    await client.close();
  });
});

describeWithDb('MCP tools: Rees', () => {
  it('creates, reads, changes, publishes, shares and deletes a Ree, without touching the web draft', async () => {
    const owner = await person();
    await rees.saveDraft(owner, { ...newReeDraft(), name: 'Half-typed on the web' });
    const { client } = await connect(owner);

    expect(errorOf(await call(client, 'create_ree', { name: 'Bad', category: 'business', tags: ['a', 'b', 'c', 'd'] }))).toMatchObject({ error: 'invalid_input', reason: 'limit' });
    const created = await ok(client, 'create_ree', { name: 'Refund desk', intro: 'Refund rules.', category: 'business', tags: ['Refunds'], sample_questions: ['When are refunds paid?'], query_fee: 5 });
    expect(created).toMatchObject({ name: 'Refund desk', is_public: false, is_published: false, query_fee: 5, tags: ['Refunds'] });
    expect((await rees.getDraft(owner))?.name).toBe('Half-typed on the web');

    /* Only the fields passed change. */
    const updated = await ok(client, 'update_ree', { ree: created.slug, system_prompt: 'Answer briefly.' });
    expect(updated).toMatchObject({ name: 'Refund desk', intro: 'Refund rules.', tags: ['Refunds'], query_fee: 5, system_prompt: 'Answer briefly.' });
    expect(errorOf(await call(client, 'update_ree', { ree: created.id, query_fee: 10_001 }))).toMatchObject({ error: 'invalid_input', reason: 'fee' });

    expect(errorOf(await call(client, 'publish_ree', { ree: created.id }))).toMatchObject({ error: 'invalid_input', reason: 'not_public' });
    await ok(client, 'update_ree', { ree: created.id, is_public: true });
    const published = await ok(client, 'publish_ree', { ree: created.id });
    expect(published).toMatchObject({ is_public: true, is_published: true });
    expect(published.url).toContain(`/r/${created.slug}`);

    const own = await ok(client, 'get_ree', { ree: created.id });
    expect(own.settings).toMatchObject({ is_published: true, query_fee: 5, system_prompt: 'Answer briefly.' });
    expect(own.settings.share_url).toContain(`/s/${created.slug}`);
    const listed = await ok(client, 'list_my_rees');
    expect(listed.rees.find((ree: { id: string }) => ree.id === created.id)).toMatchObject({ is_public: true, is_published: true });

    const share = await ok(client, 'get_share_link', { ree: created.slug });
    expect(share).toMatchObject({ shareable: true, statistics: { visits: 0, conversions: 0 } });
    expect(share.share_url).toContain(`/s/${created.slug}`);
    const stats = await ok(client, 'ree_statistics', { ree: created.id, period: 'month' });
    expect(stats).toMatchObject({ answers: 0, share: { visits: 0 } });

    /* Unpublishing keeps it public in its settings; making it private hides its share page. */
    expect(await ok(client, 'publish_ree', { ree: created.id, published: false })).toMatchObject({ is_public: true, is_published: false });
    expect(await ok(client, 'get_share_link', { ree: created.id })).toMatchObject({ shareable: false, share_url: null });

    expect(await ok(client, 'delete_ree', { ree: created.id })).toMatchObject({ deleted: true });
    expect(errorOf(await call(client, 'get_ree', { ree: created.id }))).toMatchObject({ error: 'not_found' });
    await drain();
    await client.close();
  });

  it('adds knowledge (holding credits, processed after the call), lists it and trashes it', async () => {
    const owner = await person();
    const ree = await reeOf(owner, { isPublic: false });
    const { client } = await connect(owner);
    const before = await balanceOf(db(), owner);

    expect(errorOf(await call(client, 'add_knowledge', { ree: ree.id, kind: 'page', url: 'not a url' }))).toMatchObject({ error: 'invalid_input', reason: 'invalid_url' });
    const added = await ok(client, 'add_knowledge', { ree: ree.slug, kind: 'text', title: 'Store credit', content: 'Store credit is forced only for sale items bought with a gift card.' });
    expect(added).toMatchObject({ status: 'pending' });
    expect(await balanceOf(db(), owner)).toBeLessThan(before);
    expect(later).toHaveLength(1);
    await drain();

    const library = await ok(client, 'list_knowledge', { ree: ree.id });
    expect(library.sources.find((source: { id: string }) => source.id === added.id)).toMatchObject({ title: 'Store credit', kind: 'text', status: 'ready' });
    expect(library.counts.ready).toBe(2);

    expect(await ok(client, 'delete_knowledge', { ree: ree.id, knowledge: added.id })).toMatchObject({ trashed: true });
    expect((await ok(client, 'list_knowledge', { ree: ree.id, trash: true })).sources.map((source: { id: string }) => source.id)).toEqual([added.id]);
    expect(errorOf(await call(client, 'delete_knowledge', { ree: ree.id, knowledge: added.id }))).toMatchObject({ error: 'not_found' });
    await drain();
    await client.close();
  });

  it('refuses every owner tool on someone else’s Ree as not found', async () => {
    const owner = await person();
    const ree = await reeOf(owner);
    const [source] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, ree.id));
    const { client } = await connect(await person());
    for (const [name, args] of [
      ['update_ree', { ree: ree.id, name: 'Mine now' }],
      ['publish_ree', { ree: ree.slug, published: false }],
      ['delete_ree', { ree: ree.id }],
      ['add_knowledge', { ree: ree.id, kind: 'text', title: 't', content: 'c' }],
      ['delete_knowledge', { ree: ree.id, knowledge: source!.id }],
      ['list_knowledge', { ree: ree.id }],
      ['ree_statistics', { ree: ree.id }],
    ] as const) {
      expect(errorOf(await call(client, name, args)), name).toMatchObject({ error: 'not_found' });
    }
    const [unchanged] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
    expect(unchanged).toMatchObject({ name: ree.name, isPublished: true, deletedAt: null });
    /* Its share link is public; its statistics are not. */
    const share = await ok(client, 'get_share_link', { ree: ree.slug });
    expect(share.shareable).toBe(true);
    expect(share).not.toHaveProperty('statistics');
    const seen = await ok(client, 'get_ree', { ree: ree.id });
    expect(seen).not.toHaveProperty('settings');
    expect(later).toHaveLength(0);
    await client.close();
  });

  it('comments, favorites and browses public Rees', async () => {
    const owner = await person();
    const ree = await reeOf(owner);
    const reader = await person();
    const { client } = await connect(reader);

    const comment = await ok(client, 'add_ree_comment', { ree: ree.slug, content: 'Helpful desk.' });
    const page = await ok(client, 'list_ree_comments', { ree: ree.id });
    expect(page.comments[0]).toMatchObject({ id: comment.id, content: 'Helpful desk.', can_delete: true });

    const { client: stranger } = await connect(await person());
    expect(errorOf(await call(stranger, 'delete_ree_comment', { ree: ree.id, comment: comment.id }))).toMatchObject({ error: 'not_found' });
    expect(await ok(client, 'delete_ree_comment', { ree: ree.id, comment: comment.id })).toMatchObject({ deleted: true });
    const privateRee = await reeOf(owner, { isPublic: false });
    expect(errorOf(await call(client, 'add_ree_comment', { ree: privateRee.id, content: 'hi' }))).toMatchObject({ error: 'not_found' });

    expect(await ok(client, 'favorite_ree', { ree: ree.slug })).toMatchObject({ favorite: true });
    expect((await ok(client, 'list_favorite_rees')).rees.map((entry: { id: string }) => entry.id)).toContain(ree.id);
    expect((await ok(client, 'get_ree', { ree: ree.id })).favorite).toBe(true);
    expect(await ok(client, 'favorite_ree', { ree: ree.id, favorite: false })).toMatchObject({ favorite: false });
    /* One's own Ree is never a favorite. */
    const { client: ownerClient } = await connect(owner);
    expect(errorOf(await call(ownerClient, 'favorite_ree', { ree: ree.id }))).toMatchObject({ error: 'not_found' });

    const browsed = await ok(client, 'search_rees', { category: 'business', limit: 2 });
    expect(browsed.query).toBeNull();
    expect(browsed.rees.length).toBeGreaterThan(0);
    expect(browsed.rees.every((entry: { category: string }) => entry.category === 'business')).toBe(true);
    if (browsed.total > 2) {
      const next = await ok(client, 'search_rees', { category: 'business', limit: 2, cursor: browsed.next_cursor });
      expect(next.rees.map((entry: { id: string }) => entry.id)).not.toContain(browsed.rees[0].id);
    }
    expect(errorOf(await call(client, 'search_rees', { cursor: 'garbage' }))).toMatchObject({ error: 'invalid_input', reason: 'invalid_cursor' });
    await client.close();
    await stranger.close();
    await ownerClient.close();
  });
});

const approve = async () => ({ publish: true });

describeWithDb('MCP tools: posts', () => {
  it('asks privately, follows up, renames, publishes a copy, and trashes -- charging as the web does', async () => {
    const ree = await reeOf(await person(), { queryFee: 30 });
    const asker = await person();
    const { client, keyId } = await connect(asker);
    const before = await balanceOf(db(), asker);

    expect(errorOf(await call(client, 'create_post', { visibility: 'private', question: QUESTION, rees: [ree.slug], max_cost: 49 }))).toMatchObject({ error: 'max_cost_exceeded' });
    expect(errorOf(await call(client, 'create_post', { visibility: 'private', question: QUESTION }))).toMatchObject({ error: 'invalid_input', reason: 'no_rees' });
    expect(await db().select().from(schema.post).where(eq(schema.post.userId, asker))).toHaveLength(0);

    const created = await ok(client, 'create_post', { visibility: 'private', question: QUESTION, rees: [ree.slug], max_cost: 50 });
    expect(created).toMatchObject({ visibility: 'private', possible_cost: 50, duplicate: false });
    expect(await balanceOf(db(), asker)).toBe(before - 50);
    const [row] = await db().select().from(schema.post).where(eq(schema.post.id, created.id));
    expect(row).toMatchObject({ source: 'post', visibility: 'private', apiKeyId: keyId });
    await drain();

    const read = await ok(client, 'get_post', { post: created.id });
    expect(read).toMatchObject({ visibility: 'private', answered: 1, spent: 50 });
    expect(read.answers[0]).toMatchObject({ state: 'answered', ree: { id: ree.id }, cost: 50 });
    expect(read.answers[0].citations[0]).toMatchObject({ index: 1 });

    const followup = await ok(client, 'add_followup', { post: created.id, question: 'And when is store credit forced?', mention_rees: [ree.id] });
    await drain();
    const thread = await ok(client, 'get_post', { post: created.id });
    expect(thread.followups.map((entry: { id: string }) => entry.id)).toEqual([followup.id]);

    expect(await ok(client, 'update_post', { post: created.id, pinned: true, title: 'Refunds' })).toMatchObject({ pinned: true, title: 'Refunds' });
    const mine = await ok(client, 'list_posts', { feed: 'mine', view: 'private', pinned: true });
    expect(mine.posts.map((post: { id: string }) => post.id)).toEqual([created.id]);

    const copy = await ok(client, 'publish_post', { post: created.id, anonymous: true });
    expect(copy).toMatchObject({ status: 'pending' });
    expect(errorOf(await call(client, 'publish_post', { post: created.id }))).toMatchObject({ error: 'conflict' });
    expect(later).toHaveLength(1);
    later.length = 0;

    /* Nobody else reads, renames, follows up or deletes it. */
    const { client: stranger } = await connect(await person());
    expect(errorOf(await call(stranger, 'get_post', { post: created.id }))).toMatchObject({ error: 'not_found' });
    expect(errorOf(await call(stranger, 'update_post', { post: created.id, title: 'x' }))).toMatchObject({ error: 'not_found' });
    expect(errorOf(await call(stranger, 'add_followup', { post: created.id, question: 'Mine?' }))).toMatchObject({ error: 'not_found' });
    expect(errorOf(await call(stranger, 'delete_followup', { followup: followup.id }))).toMatchObject({ error: 'not_found' });
    expect(errorOf(await call(stranger, 'trash_post', { post: created.id }))).toMatchObject({ error: 'not_found' });

    expect(await ok(client, 'delete_followup', { followup: followup.id })).toMatchObject({ deleted: true });
    expect(await ok(client, 'trash_post', { post: created.id })).toMatchObject({ trashed: true });
    expect((await ok(client, 'list_posts', { feed: 'mine', view: 'trash' })).posts.map((post: { id: string }) => post.id)).toContain(created.id);
    await client.close();
    await stranger.close();
  });

  it('posts publicly, and readers save, vote and follow up on it', async () => {
    const ree = await reeOf(await person());
    const author = await person();
    const { client } = await connect(author);
    expect(errorOf(await call(client, 'create_post', { visibility: 'public', question: QUESTION, max_cost: BASE }))).toMatchObject({ error: 'max_cost_exceeded' });
    const created = await ok(client, 'create_post', { visibility: 'public', question: `${QUESTION} ${uniqueName('q')}`, mention_ree: ree.slug, client_token: crypto.randomUUID() });
    expect(created).toMatchObject({ visibility: 'public', duplicate: false });
    expect(later).toHaveLength(1);
    later.length = 0;
    const [row] = await db().select().from(schema.post).where(eq(schema.post.id, created.id));
    expect(row).toMatchObject({ visibility: 'public', status: 'pending', mentionReeId: ree.id });
    /* The review and answers, as the deferred `processPost` runs them, with the model steps stubbed. */
    await posts.processPost(created.id, {
      judge: approve,
      match: async () => ({ answerers: [{ reeId: ree.id, similarity: 0.9, mentioned: true }], candidates: 1, skipped: 0, vector: null }),
      answerOne: async () => ({ state: 'answered', text: 'Within 14 days [1].', citations: [], model: 'stub' }),
    });

    const reader = await person();
    const { client: readerClient } = await connect(reader);
    const latest = await ok(readerClient, 'list_posts', { feed: 'latest', query: row!.question });
    expect(latest.posts.map((post: { id: string }) => post.id)).toContain(created.id);
    const seen = await ok(readerClient, 'get_post', { post: created.id });
    expect(seen).toMatchObject({ visibility: 'public', status: 'published', answered: 1, spent: null });
    expect(seen.followup_candidates.map((candidate: { ree_id: string }) => candidate.ree_id)).toEqual([ree.id]);

    expect(await ok(readerClient, 'save_post', { post: created.id })).toMatchObject({ saved: true });
    expect((await ok(readerClient, 'list_posts', { feed: 'saved' })).posts.map((post: { id: string }) => post.id)).toEqual([created.id]);
    expect(await ok(readerClient, 'mark_helpful', { answer: seen.answers[0].id })).toMatchObject({ voted_helpful: true, helpful: 1 });
    expect(errorOf(await call(readerClient, 'mark_helpful', { post: created.id, answer: seen.answers[0].id }))).toMatchObject({ error: 'invalid_input' });

    const asked = await ok(readerClient, 'add_followup', { post: created.id, question: 'Does it hold for sale items?', mention_rees: [ree.slug] });
    const [followup] = await db().select().from(schema.postFollowup).where(eq(schema.postFollowup.id, asked.id));
    expect(followup).toMatchObject({ userId: reader, status: 'pending', mentionReeIds: [ree.id] });
    expect(errorOf(await call(readerClient, 'add_followup', { post: created.id, question: 'More?', add_rees: [ree.id] }))).toMatchObject({ error: 'invalid_input', reason: 'add_rees_private_only' });
    later.length = 0;

    /* The author trashes it: gone for the reader. */
    expect(await ok(client, 'trash_post', { post: created.id })).toMatchObject({ trashed: true });
    expect(errorOf(await call(readerClient, 'get_post', { post: created.id }))).toMatchObject({ error: 'not_found' });
    expect(await ok(client, 'trash_post', { post: created.id, trashed: false })).toMatchObject({ trashed: false });
    await client.close();
    await readerClient.close();
  });

  it('agrees to a paid Ree’s request only up to max_cost, and declines one', async () => {
    const paid = await reeOf(await person(), { queryFee: 15, answersPosts: true });
    const author = await person();
    const posted = await posts.publishPost(author, { question: `${QUESTION} ${uniqueName('paid')}`, lang: 'en' });
    if (!posted.ok) throw new Error(posted.error);
    await posts.processPost(posted.id, {
      judge: approve,
      match: async () => ({ answerers: [{ reeId: paid.id, similarity: 0.9, mentioned: false }], candidates: 1, skipped: 0, vector: null }),
      answerOne: async () => ({ state: 'answered', text: 'Paid answer.', citations: [], model: 'stub' }),
    });
    const { client } = await connect(author);
    const view = await ok(client, 'get_post', { post: posted.id });
    const request = view.paid_requests.find((entry: { ree: { id: string } }) => entry.ree.id === paid.id);
    expect(request).toMatchObject({ price: BASE + 15, state: 'awaiting' });

    const { client: stranger } = await connect(await person());
    expect(errorOf(await call(stranger, 'respond_paid_request', { request: request.request_id, action: 'agree', max_cost: 1000 }))).toMatchObject({ error: 'not_found' });
    expect(errorOf(await call(client, 'respond_paid_request', { request: request.request_id, action: 'agree' }))).toMatchObject({ error: 'invalid_input', reason: 'max_cost_required' });
    expect(errorOf(await call(client, 'respond_paid_request', { request: request.request_id, action: 'agree', max_cost: BASE + 14 }))).toMatchObject({ error: 'max_cost_exceeded' });
    const balance = await balanceOf(db(), author);
    expect(await ok(client, 'respond_paid_request', { request: request.request_id, action: 'agree', max_cost: BASE + 15 })).toMatchObject({ agreed: true });
    expect(await balanceOf(db(), author)).toBe(balance - BASE - 15);
    expect(later).toHaveLength(1);
    later.length = 0;
    expect(errorOf(await call(client, 'respond_paid_request', { request: request.request_id, action: 'decline' }))).toMatchObject({ error: 'not_found' });
    const [held] = await db().select().from(schema.postAnswer).where(and(eq(schema.postAnswer.id, request.request_id)));
    expect(held!.baseHoldId).not.toBeNull();
    await client.close();
    await stranger.close();
  });
});

describeWithDb('MCP tools: review fixes', () => {
  it('asks privately as the web does: replayed text is one post, the daily limit holds, the AI answers when no Ree can, and the key counts it', async () => {
    const empty = await reeOf(await person());
    /* A Ree with nothing ready: it cannot answer, so the AI does. */
    await db().delete(schema.knowledge).where(eq(schema.knowledge.reeId, empty.id));
    const asker = await person();
    const { client, keyId } = await connect(asker);
    const question = `${QUESTION} ${uniqueName('ai')}`;
    const before = await balanceOf(db(), asker);

    const first = await ok(client, 'create_post', { visibility: 'private', question, rees: [empty.id] });
    expect(first.possible_cost).toBe(Math.max(BASE, AI_ANSWER_FEE));
    const [row] = await db().select().from(schema.post).where(eq(schema.post.id, first.id));
    expect(row).toMatchObject({ source: 'post', visibility: 'private', apiKeyId: keyId });
    /* A retry without a client_token (a timed-out call) is the same post, held once. */
    const again = await ok(client, 'create_post', { visibility: 'private', question, rees: [empty.id] });
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    await drain();
    const read = await ok(client, 'get_post', { post: first.id });
    expect(read.ai_answer).toMatchObject({ state: 'answered', cost: AI_ANSWER_FEE });
    expect(await balanceOf(db(), asker)).toBe(before - AI_ANSWER_FEE);
    const [usage] = (await apiKeys.listApiKeys(asker)).filter((key) => key.id === keyId);
    expect(usage).toMatchObject({ questions: 1, spent: AI_ANSWER_FEE });

    /* The daily limit counts its posts with the web's. */
    const today = Array.from({ length: 30 }, (_, at) => ({ userId: asker, source: 'post' as const, visibility: 'public' as const, question: `q${at}`, lang: 'en' as const }));
    await db().insert(schema.post).values(today);
    expect(errorOf(await call(client, 'create_post', { visibility: 'private', question: 'One more?', rees: [empty.id] }))).toMatchObject({ error: 'limit_reached', reason: 'daily_limit' });
    await client.close();
  });

  it('refuses a follow-up on someone else’s private post as not found, whatever its max_cost', async () => {
    const ree = await reeOf(await person(), { queryFee: 30 });
    const owner = await person();
    const asked = await privatePosts.publishPrivatePost(owner, { question: QUESTION, reeIds: [ree.id], fees: { [ree.id]: BASE + 30 }, lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    later.length = 0;
    const { client: stranger } = await connect(await person());
    const refused = await call(stranger, 'add_followup', { post: asked.id, question: 'And then?', max_cost: 0 });
    expect(errorOf(refused)).toMatchObject({ error: 'not_found' });
    expect(refused.structuredContent).not.toHaveProperty('possible_cost');
    await stranger.close();
  });

  it('counts the AI’s fee in a private follow-up’s possible cost', async () => {
    const asker = await person();
    const aiOnly = await privatePosts.publishPrivatePost(asker, { question: `${QUESTION} ${uniqueName('only')}`, reeIds: [], aiOnly: true, lang: 'en' });
    if (!aiOnly.ok) throw new Error(aiOnly.error);
    const { client } = await connect(asker);
    expect(errorOf(await call(client, 'add_followup', { post: aiOnly.id, question: 'And then?', max_cost: 0 }))).toMatchObject({ error: 'max_cost_exceeded' });
    const capped = await call(client, 'add_followup', { post: aiOnly.id, question: 'And then?', max_cost: AI_ANSWER_FEE - 1 });
    expect(capped.structuredContent).toMatchObject({ error: 'max_cost_exceeded', possible_cost: AI_ANSWER_FEE });
    later.length = 0;
    await client.close();
  });

  it('tells the client an internal error may have done the work, and how to retry safely', async () => {
    const { client } = await connect(await person());
    breakage.next = true;
    const failed = await call(client, 'list_favorite_rees');
    expect(errorOf(failed)).toMatchObject({ error: 'internal_error' });
    expect(String(failed.structuredContent!.message)).toContain('may or may not have happened');
    expect(String(failed.structuredContent!.message)).toContain('client_token');
    expect(String(failed.structuredContent!.message)).not.toContain('given back');
    await client.close();
  });

  it('gives the server the knowledge routes’ time, and marks add_knowledge as reaching the open web', async () => {
    expect(route.maxDuration).toBe(800);
    const { client } = await connect(await person());
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'add_knowledge')!.annotations).toMatchObject({ openWorldHint: true });
    expect(tools.filter((tool) => tool.annotations?.openWorldHint).map((tool) => tool.name)).toEqual(['add_knowledge']);
    await client.close();
  });

  it('caps add_knowledge at max_cost: refused before holding, and stopped before a step past it', async () => {
    const owner = await person();
    const ree = await reeOf(owner, { isPublic: false });
    const { client } = await connect(owner);
    const before = await balanceOf(db(), owner);
    expect(errorOf(await call(client, 'add_knowledge', { ree: ree.id, kind: 'text', title: 't', content: 'c', max_cost: 0 }))).toMatchObject({ error: 'max_cost_exceeded' });
    expect(await balanceOf(db(), owner)).toBe(before);

    const added = await ok(client, 'add_knowledge', { ree: ree.id, kind: 'text', title: 'Capped', content: 'Store credit is forced only for sale items.', max_cost: 2 });
    later.length = 0;
    /* What an earlier, interrupted run already spent counts against the cap. */
    const [row] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, added.id));
    expect(row!.activity[0]).toMatchObject({ code: 'added', detail: { maxCredits: 2 } });
    const spent = { id: 'earlier', runId: 'earlier-run', at: new Date().toISOString(), service: 'embedding', usage: {}, costUsd: '5', basis: 'configured_rate' };
    await db().update(schema.knowledge).set({ activity: [...row!.activity, { at: new Date().toISOString(), code: 'provider_usage', detail: { runId: 'earlier-run', charge: JSON.stringify(spent) } }] }).where(eq(schema.knowledge.id, added.id));
    await knowledge.processKnowledge(added.id, { profile: false });
    const [stopped] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, added.id));
    expect(stopped).toMatchObject({ status: 'failed', error: 'max_cost' });
    /* Nothing held stays held. */
    expect(await db().select().from(schema.creditHold).where(and(eq(schema.creditHold.userId, owner), eq(schema.creditHold.status, 'held')))).toHaveLength(0);
    await client.close();
  });

  it('limits Rees created through MCP per day, counting only valid ones', async () => {
    freezeDateAtWindowStart(86_400);
    try {
      const owner = await person();
      const { client } = await connect(owner);
      for (let at = 1; at < MCP_REE_CREATE_PER_DAY; at += 1) await hitRateBucket(`mcp:ree-create:${owner}`, MCP_REE_CREATE_PER_DAY, 86_400);
      expect(errorOf(await call(client, 'create_ree', { name: 'Bad', category: 'business', tags: ['a', 'b', 'c', 'd'] }))).toMatchObject({ error: 'invalid_input', reason: 'limit' });
      await ok(client, 'create_ree', { name: 'Last of the day', category: 'business' });
      expect(errorOf(await call(client, 'create_ree', { name: 'One too many', category: 'business' }))).toMatchObject({ error: 'limit_reached', reason: 'ree_daily_limit' });
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a source whose run never started when the library is read', async () => {
    const owner = await person();
    const ree = await reeOf(owner, { isPublic: false });
    const id = await knowledge.addKnowledge(owner, ree, { kind: 'text', title: 'Waiting', content: 'Refunds take 14 days.' });
    await db().update(schema.knowledge).set({ updatedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(schema.knowledge.id, id));
    const { client } = await connect(owner);
    await ok(client, 'list_knowledge', { ree: ree.id });
    expect(later.length).toBeGreaterThan(0);
    await drain();
    const [row] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, id));
    expect(row!.status).toBe('ready');
    await client.close();
  });
});
