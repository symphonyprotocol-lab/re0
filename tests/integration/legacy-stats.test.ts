/**
 * Private posts replace private conversations (PR A); migration 0070 (PR B)
 * drops the conversation tables. Every figure that counted them now reads
 * the frozen conversation counters (migrations 0066 / 0067) plus the same
 * figure from posts, so dropping the conversations changes nothing. And the
 * owner's 试问 (private posts of source `test`) is billed like the test
 * conversation was and counted nowhere. The conversation tables are put
 * back for these tests only (`restoreConversationTables`), and 0070 itself
 * drops them again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { dropConversationTables, pointModelsAt, restoreConversationTables, runBackfill, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { AnswerOne } from '@/lib/services/posts';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let token: string | undefined;
const later: (() => unknown)[] = [];
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 're0_session' && token ? { value: token } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: (task: () => unknown) => void later.push(task) }));

const { createSession, sessionTokenHash } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const posts = await import('@/lib/services/posts');
const privatePosts = await import('@/lib/services/private-posts');
const reeTry = await import('@/lib/services/ree-try');
const { answersByOthers, reeCards } = await import('@/lib/services/explore');
const { votesByOthers } = await import('@/lib/services/ree-feedback');
const { publicReeBySlug } = await import('@/lib/services/public-rees');
const { computeRanks } = await import('@/lib/services/rank');
const { roleMetrics } = await import('@/lib/services/roles');
const { savedCounts, answerCounts } = await import('@/lib/services/statistics');
const { adminOverview } = await import('@/lib/services/admin-overview');
const apiKeys = await import('@/lib/services/api-keys');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { consoleAdministrator } = await import('../fixtures/console-administrator');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE: BASE } = await import('@/lib/constants');
const tryRoute = await import('@/app/api/rees/[id]/try/route');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await dropConversationTables();
  await fake?.close();
});

async function user(prefix: string, credits = 0) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

/** A public free Ree with ready knowledge, owned by a new user. */
async function makeRee() {
  const ownerId = await user('ls-owner', 1_000);
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refund policy', content: 'Refunds are issued to the original payment method within 14 days of the request.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true }).where(eq(schema.ree.id, ree.id));
  const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
  return { ownerId, reeId: ree.id, slug: row!.slug };
}

const answered: AnswerOne = async ({ reeId }) => ({ state: 'answered', text: `Answer from ${reeId}.`, citations: [], model: 'stub' });
const unanswered: AnswerOne = async () => ({ state: 'no_answer', model: 'stub' });

/** A private post of `userId` to the Ree, answered. */
async function privateAsk(userId: string, reeId: string, options: { source?: 'post' | 'api'; apiKeyId?: string } = {}) {
  const made = await privatePosts.publishPrivatePost(userId, { question: `When are refunds issued? ${crypto.randomUUID()}`, reeIds: [reeId], fees: { [reeId]: BASE }, lang: 'en' }, options);
  if (!made.ok) throw new Error(made.error);
  await privatePosts.processPrivatePost(made.id, { answerOne: answered });
  return made.id;
}

/** One exchange in a new conversation, as the chat wrote them (raw SQL: the schema no longer has the tables); answers the reply's id. */
async function exchange(userId: string, reeId: string, options: { noAnswer?: boolean; copied?: boolean; kind?: 'normal' | 'mcp'; apiKeyId?: string; cost?: number } = {}) {
  const conversationId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const replyId = crypto.randomUUID();
  const copied = options.copied ?? false;
  await db().execute(sql`insert into conversation (id, user_id, kind) values (${conversationId}, ${userId}, ${options.kind ?? 'normal'})`);
  await db().execute(sql`insert into message (id, conversation_id, role, content, request_id, copied_from_post, api_key_id) values (${requestId}, ${conversationId}, 'user', 'Q?', ${requestId}, ${copied}, ${options.apiKeyId ?? null})`);
  await db().execute(sql`insert into message (id, conversation_id, role, ree_id, content, no_answer, request_id, copied_from_post, cost_credits)
    values (${replyId}, ${conversationId}, 'ree', ${reeId}, ${options.noAnswer ? '' : 'A.'}, ${options.noAnswer ?? false}, ${requestId}, ${copied}, ${options.cost ?? 0})`);
  return { conversationId, replyId };
}

async function vote(messageId: string, userId: string, value: 'up' | 'down') {
  await db().execute(sql`insert into ree_feedback (message_id, user_id, vote) values (${messageId}, ${userId}, ${value})`);
}

/** What the readers counted from conversations before private posts (the queries as they were). */
async function conversationFigures(reeId: string, ownerId: string) {
  const result = await db().execute<{ answers: number; asked: number; up: number; down: number }>(sql`select
    (select count(*)::int from message m join conversation c on c.id = m.conversation_id where m.ree_id = ${reeId} and m.role = 'ree' and not m.no_answer and c.user_id <> ${ownerId} and not m.copied_from_post) as answers,
    (select count(*)::int from message m join conversation c on c.id = m.conversation_id where m.role = 'ree' and not m.copied_from_post and m.ree_id = ${reeId} and c.user_id <> ${ownerId}) as asked,
    (select count(*)::int from ree_feedback f join message m on m.id = f.message_id where m.ree_id = ${reeId} and f.vote = 'up' and f.user_id <> ${ownerId}) as up,
    (select count(*)::int from ree_feedback f join message m on m.id = f.message_id where m.ree_id = ${reeId} and f.vote = 'down' and f.user_id <> ${ownerId}) as down`);
  return result.rows[0]!;
}

/** Every reader that counted conversations, as it reads now. */
async function figures(ree: { ownerId: string; reeId: string; slug: string }, keyOwner: string, keyId: string) {
  await computeRanks();
  const [row] = await db().select({ answers: answersByOthers, up: votesByOthers('up'), down: votesByOthers('down'), rank: schema.ree.rank }).from(schema.ree).where(eq(schema.ree.id, ree.reeId));
  const page = (await publicReeBySlug(ree.slug))!;
  const [card] = await reeCards([ree.reeId], new Map(), { includeIntros: false });
  const metrics = await roleMetrics(db(), ree.ownerId);
  const [usage] = (await apiKeys.listApiKeys(keyOwner)).filter((item) => item.id === keyId);
  const rank = row!.rank!;
  return {
    answers: row!.answers,
    up: row!.up,
    down: row!.down,
    page: { answers: page.answers, positiveRate: page.positiveRate },
    card: { answers: card!.answers, positiveRate: card!.positiveRate },
    roles: { externalQuestions: metrics.externalQuestions, helpful: metrics.helpful, unhelpful: metrics.unhelpful },
    rank: { answersAll: rank.answersAll, asked30: rank.asked30, answered30: rank.answered30, up30: rank.up30, down30: rank.down30, pulls30: rank.pulls30, asked7: rank.asked7 },
    usage: { questions: usage!.questions, spent: usage!.spent },
    saved: (await savedCounts([ree.reeId], null)).get(ree.reeId) ?? 0,
    questions30: (await adminOverview(await consoleAdministrator())).questions30,
  };
}

describeWithDb('legacy counters: the same figures before and after the conversations go', () => {
  it('reads every figure as the frozen conversations plus the posts, and keeps it when the conversations are deleted', async () => {
    await restoreConversationTables();
    const ree = await makeRee();
    const a = await user('ls-a', 1_000);
    const b = await user('ls-b', 1_000);
    const { key } = await apiKeys.createApiKey(a, { name: 'k' });

    /* The conversations: two answers to others, one not answered, one copied 继续问 exchange, one MCP answer, the owner's own; three votes. */
    const first = await exchange(a, ree.reeId);
    const second = await exchange(b, ree.reeId);
    await exchange(a, ree.reeId, { noAnswer: true });
    await exchange(b, ree.reeId, { copied: true });
    await exchange(a, ree.reeId, { kind: 'mcp', apiKeyId: key.id, cost: BASE });
    const own = await exchange(ree.ownerId, ree.reeId);
    await vote(first.replyId, a, 'up');
    await vote(second.replyId, b, 'down');
    await vote(own.replyId, ree.ownerId, 'up');
    const old = await conversationFigures(ree.reeId, ree.ownerId);
    expect(old).toEqual({ answers: 3, asked: 4, up: 1, down: 1 });

    /* The posts: a's private post and a follow-up on it, an MCP ask, with 有帮助 and 没帮助; the owner's own question and 试问 count nowhere. */
    const postId = await privateAsk(a, ree.reeId);
    const followed = await privatePosts.askPrivateFollowup(a, postId, { question: 'And to which card?', mentionReeIds: [ree.reeId], fees: { [ree.reeId]: BASE }, lang: 'en' });
    if (!followed.ok) throw new Error(followed.error);
    await privatePosts.processPrivateFollowup(followed.id, { answerOne: answered });
    await privateAsk(a, ree.reeId, { source: 'api', apiKeyId: key.id });
    const rows = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, postId));
    expect(await posts.setAnswerHelpful(a, rows.find((row) => row.followupId === null)!.id, true)).toMatchObject({ voted: true });
    expect(await privatePosts.setAnswerUnhelpful(a, rows.find((row) => row.followupId !== null)!.id, true)).toMatchObject({ unvoted: true });
    await privateAsk(ree.ownerId, ree.reeId);
    const tried = await reeTry.askReeTry(ree.ownerId, ree.reeId, { question: 'Does it know refunds?', lang: 'en' });
    if (!tried?.ok) throw new Error('试问 refused');
    await privatePosts.processPrivatePost(tried.id, { answerOne: answered });

    await runBackfill('legacy-stats');
    await runBackfill('api-key-usage');
    const before = await figures(ree, a, key.id);
    /* Conversations' figure + the posts' (three answers by a, one 有帮助, one 没帮助). */
    expect(before).toMatchObject({
      answers: old.answers + 3,
      up: old.up + 1,
      down: old.down + 1,
      page: { answers: old.answers + 3, positiveRate: 50 },
      card: { answers: old.answers + 3, positiveRate: 50 },
      roles: { externalQuestions: old.asked + 3, helpful: old.up + 1, unhelpful: old.down + 1 },
      /* The windows are posts only: the conversations rolled out of them. Two private posts pulled the Ree in. */
      rank: { answersAll: old.answers + 3, asked30: 3, answered30: 3, up30: 1, down30: 1, pulls30: 2, asked7: 3 },
      usage: { questions: 2, spent: 2 * BASE },
      /* On file: a's three answers and the owner's own question; never the 试问. */
      saved: 4,
    });

    /* PR B: migration 0070 drops the conversation tables. */
    await dropConversationTables();
    const gone = await db().execute<{ present: boolean }>(sql`select to_regclass('public.message') is not null as present`);
    expect(gone.rows[0]!.present).toBe(false);
    expect(await figures(ree, a, key.id)).toEqual(before);
  });

  it('tells everyone with a conversation that has something in it, once, that the conversations go', async () => {
    await restoreConversationTables();
    const talker = await user('ls-talker');
    const empty = await user('ls-empty');
    const trashed = await user('ls-trashed');
    const ree = await makeRee();
    await exchange(talker, ree.reeId);
    await exchange(talker, ree.reeId);
    await db().execute(sql`insert into conversation (user_id) values (${empty})`);
    const gone = await exchange(trashed, ree.reeId);
    await db().execute(sql`update conversation set deleted_at = now() where id = ${gone.conversationId}`);
    await runBackfill('chats-removal-notice');
    await runBackfill('chats-removal-notice');
    const told = await db().select().from(schema.notice).where(and(inArray(schema.notice.userId, [talker, empty, trashed]), eq(schema.notice.kind, 'chats_removal')));
    expect(told.map((row) => ({ userId: row.userId, params: row.params, refId: row.refId, readAt: row.readAt }))).toEqual([{ userId: talker, params: {}, refId: null, readAt: null }]);
  });

  it('runs 试问 as a private post of the owner\'s own Ree: base fee once answered, listed and cleared on its page, counted nowhere', async () => {
    const ree = await makeRee();
    const stranger = await user('ls-stranger', 100);
    const start = await balanceOf(db(), ree.ownerId);
    const counts = async () => {
      await computeRanks();
      const [row] = await db().select({ answers: answersByOthers, rank: schema.ree.rank }).from(schema.ree).where(eq(schema.ree.id, ree.reeId));
      return {
        answers: row!.answers,
        asked7: row!.rank!.asked7,
        pulls30: row!.rank!.pulls30,
        external: (await roleMetrics(db(), ree.ownerId)).externalQuestions,
        saved: (await savedCounts([ree.reeId], null)).get(ree.reeId) ?? 0,
        questions30: (await adminOverview(await consoleAdministrator())).questions30,
      };
    };
    const quiet = await counts();

    /* Through the route: 201, answered after the response, at the base fee (no query fee on one's own Ree). */
    token = crypto.randomUUID();
    await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: ree.ownerId, expiresAt: new Date(Date.now() + 60_000) });
    const url = `http://localhost:3000/api/rees/${ree.reeId}/try`;
    const headers = { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000' };
    const context = { params: Promise.resolve({ id: ree.reeId }) };
    const asked = await tryRoute.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify({ question: 'When are refunds issued?' }), headers }), context);
    expect(asked.status).toBe(201);
    const { id } = (await asked.json()) as { id: string };
    expect(await balanceOf(db(), ree.ownerId)).toBe(start - BASE);
    later.length = 0;
    await privatePosts.processPrivatePost(id, { answerOne: answered });
    expect(await balanceOf(db(), ree.ownerId)).toBe(start - BASE);
    const [row] = await db().select().from(schema.post).where(eq(schema.post.id, id));
    expect(row).toMatchObject({ source: 'test', visibility: 'private', status: 'published', answerState: 'done' });

    /* One the Ree cannot answer costs nothing. */
    const missed = await reeTry.askReeTry(ree.ownerId, ree.reeId, { question: 'What is the weather on Mars?', lang: 'en' });
    if (!missed?.ok) throw new Error('试问 refused');
    await privatePosts.processPrivatePost(missed.id, { answerOne: unanswered });
    expect(await balanceOf(db(), ree.ownerId)).toBe(start - BASE);
    /* The same question again is a new 试问, not a replay. */
    const again = await reeTry.askReeTry(ree.ownerId, ree.reeId, { question: 'What is the weather on Mars?', lang: 'en' });
    expect(again).toMatchObject({ ok: true });
    expect((again as { id: string }).id).not.toBe(missed.id);
    await privatePosts.processPrivatePost((again as { id: string }).id, { answerOne: unanswered });

    /* Listed on its page, newest first; never in 我的帖子, never anywhere else. */
    const listed = await tryRoute.GET(new NextRequest(url, { headers }), context);
    const { items } = (await listed.json()) as { items: { id: string; answers: { state: string }[] }[] };
    expect(items.map((item) => item.id)).toEqual([(again as { id: string }).id, missed.id, id]);
    expect(items[2]!.answers).toHaveLength(1);
    expect((await posts.listMyPosts(ree.ownerId, 'all')).items.map((item) => item.id)).not.toContain(id);
    expect(await counts()).toEqual(quiet);
    /* The ledger keeps the usage (the owner's statistics, as with the test conversation). */
    expect((await answerCounts([ree.reeId], null)).get(ree.reeId)).toBe(1);

    /* Someone else's Ree: 404, nothing asked or listed. */
    expect(await reeTry.askReeTry(stranger, ree.reeId, { question: 'Hi?', lang: 'en' })).toBeNull();
    expect(await reeTry.listReeTries(stranger, ree.reeId)).toBeNull();
    expect(await reeTry.clearReeTries(stranger, ree.reeId)).toBeNull();

    /* 清空: the finished ones go for good; the usage stays. */
    const cleared = await tryRoute.DELETE(new NextRequest(url, { method: 'DELETE', headers }), context);
    expect(await cleared.json()).toEqual({ cleared: 3 });
    expect(await db().select().from(schema.post).where(and(eq(schema.post.userId, ree.ownerId), eq(schema.post.source, 'test')))).toEqual([]);
    expect((await answerCounts([ree.reeId], null)).get(ree.reeId)).toBe(1);
    token = undefined;
  });
});
