/**
 * Cross-lingual retrieval: a vague Chinese question over English docs
 * ("Hono 怎么写中间件？") shares only the product's name with every passage,
 * so searched as asked it finds nothing close enough and is declined. Also
 * searched as a rewrite into English, it finds the middleware page and is
 * answered for the usual base fee; the rewrite is one logged call per
 * language per question, made only when the knowledge is in another
 * language, and its failure only leaves the question searched as asked.
 * In a Ree with knowledge in both languages, the question's own direct
 * matches still rank beside the rewrite's; a rewrite whose embedding fails
 * is still searched by its keywords. The keyword leg reads the passages
 * matching the most terms as whole words first, ties by id, so a term in
 * every passage (or inside other words) does not crowd out the one that has
 * them all, and the same question reads the same passages.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const chat = await import('@/lib/services/chat');
const { answer } = await import('@/lib/services/answer');
const { questionRewriter } = await import('@/lib/services/question-rewrite');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fake?.close();
});

const MIDDLEWARE =
  'Custom middleware: write your own middleware in Hono with createMiddleware from hono/factory, then call await next() inside it so the handler runs after your code.';
/* Doc pages about everything else, each naming Hono and as long as the middleware page. */
const OTHER_PAGES = [
  'Routing in Hono: app.get registers a handler for a path, and path parameters such as :id are read from the context object.',
  'Hono validation guide: the validator checks query strings, form fields and JSON bodies before the handler sees any request data.',
  'Hono JSX renders components on the server, streams HTML to the browser and supports async components with suspense boundaries.',
  'Testing a Hono app: call app.request with a path and options, then assert the status code, headers and body of the response.',
  'The Hono RPC client shares route types between server and client, so calls are checked by the compiler before deployment.',
  'Hono presets: hono/tiny keeps the bundle smallest, hono/quick registers routes fastest, and the default router balances both.',
  'Hono helpers cover cookies, streaming responses, server sent events, accepted languages and connection information for each runtime.',
  'Hono best practices: group related routes in separate files, mount them with app.route, and avoid controllers that hide types.',
  'Hono on Bun: install the package, export the app as the default fetch handler and start the server with the bun command.',
  'Hono context: c.json, c.text and c.html build responses, while c.req exposes the raw request, headers and parsed parameters.',
  'Hono error handling: app.onError catches thrown exceptions, and HTTPException carries a status code with a custom message.',
  'Hono static files: serveStatic reads assets from a root folder, with options for paths, rewrites and precompressed variants.',
];

async function person() {
  const subject = uniqueName('xl');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'X', avatarUrl: null }, 'zh', '/');
  return userId;
}

/** A Ree whose knowledge is the given pages, one passage each. */
async function reeWith(userId: string, name: string, pages: readonly string[]) {
  await rees.saveDraft(userId, { ...newReeDraft(), name, category: 'technology', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  for (const [index, content] of pages.entries()) {
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: `Page ${index + 1}`, content });
    await knowledge.processKnowledge(id);
  }
  return ree;
}

async function consume(response: Response) {
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as { type: string; data?: Record<string, unknown> });
  return events.filter((event) => event.type === 'data-outcome').map((event) => event.data as { reeId: string; noAnswer: boolean; reason: string | null; cost: number });
}

const QUESTION = 'Hono 怎么写中间件？';

describeWithDb('cross-lingual retrieval', () => {
  it('searched as asked, a Chinese question misses the English page that answers it', async () => {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const found = await chat.retrieve(ree.id, QUESTION);
    expect(found.evidence).toBe(false);
    expect(found.rewrite).toBeNull();
    expect(found.bestSimilarity!).toBeLessThan(0.3);
  });

  it('answers it from the page once the question is also searched in English, for the base fee only', async () => {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const calls = fake.rewrites.calls;
    const found = await chat.retrieve(ree.id, QUESTION, undefined, { rewrite: questionRewriter(userId, QUESTION) });
    expect(fake.rewrites.calls).toBe(calls + 1);
    expect(found.rewrite).toBe('Hono middleware');
    expect(found.evidence).toBe(true);
    expect(found.passages[0]!.content).toBe(MIDDLEWARE);

    const conversation = await chat.testConversation(userId, ree.id);
    const before = await balanceOf(db(), userId);
    const [outcome] = await consume(await answer({ userId, lang: 'zh', conversation, targets: [ree], question: QUESTION }));
    expect(outcome).toMatchObject({ noAnswer: false, cost: 20 });
    expect(await balanceOf(db(), userId)).toBe(before - 20);
    const stored = await chat.messagesOf(conversation.id);
    expect(stored[1]!.citations[0]!.excerpt).toContain('createMiddleware');
    /* The rewrite is metered as the asker's `retrieval` call, apart from the answer. */
    const logged = await db().select().from(schema.modelCall).where(and(eq(schema.modelCall.userId, userId), eq(schema.modelCall.purpose, 'retrieval')));
    expect(logged.length).toBeGreaterThanOrEqual(2);
    expect(logged.every((call) => call.status === 'succeeded')).toBe(true);
  });

  it('rewrites once per language however many Rees are asked', async () => {
    const userId = await person();
    const first = await reeWith(userId, 'Hono docs A', [...OTHER_PAGES.slice(0, 6), MIDDLEWARE]);
    const second = await reeWith(userId, 'Hono docs B', [...OTHER_PAGES.slice(6), MIDDLEWARE]);
    const [conversation] = await db()
      .insert(schema.conversation)
      .values({ userId, kind: 'normal', title: 'Two Rees' })
      .returning();
    await db().insert(schema.conversationRee).values([
      { conversationId: conversation!.id, reeId: first.id },
      { conversationId: conversation!.id, reeId: second.id },
    ]);
    const calls = fake.rewrites.calls;
    const outcomes = await consume(await answer({ userId, lang: 'zh', conversation: conversation!, targets: [first, second], question: QUESTION }));
    expect(fake.rewrites.calls).toBe(calls + 1);
    expect(outcomes.map((outcome) => outcome.noAnswer)).toEqual([false, false]);
  });

  it('leaves a question in the knowledge’s own language as it was', async () => {
    const userId = await person();
    const english = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const chinese = await reeWith(userId, 'Hono 中文文档', ['Hono 的自定义中间件用 createMiddleware 来写，在中间件里调用 await next() 让后面的处理函数继续执行。', 'Hono 的路由用 app.get 注册处理函数，路径参数从上下文对象里读取。']);
    const calls = fake.rewrites.calls;
    const asked = 'How do I write custom middleware in Hono?';
    const found = await chat.retrieve(english.id, asked, undefined, { rewrite: questionRewriter(userId, asked) });
    expect(found.rewrite).toBeNull();
    expect(found.passages[0]!.content).toBe(MIDDLEWARE);
    const same = await chat.retrieve(chinese.id, QUESTION, undefined, { rewrite: questionRewriter(userId, QUESTION) });
    expect(same.rewrite).toBeNull();
    expect(same.passages[0]!.content).toContain('自定义中间件');
    expect(fake.rewrites.calls).toBe(calls);
  });

  it('searches as asked when the rewrite fails, still charging nothing for no answer', async () => {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const conversation = await chat.testConversation(userId, ree.id);
    const before = await balanceOf(db(), userId);
    fake.rewrites.fail = true;
    try {
      const [outcome] = await consume(await answer({ userId, lang: 'zh', conversation, targets: [ree], question: QUESTION }));
      expect(outcome).toMatchObject({ noAnswer: true, reason: 'out_of_scope', cost: 0 });
    } finally {
      fake.rewrites.fail = false;
    }
    expect(await balanceOf(db(), userId)).toBe(before);
  });

  it('keeps a mixed Ree’s direct matches in the question’s own language', async () => {
    const userId = await person();
    const direct = '怎么写中间件：先定义一个中间件函数，再把它注册到应用上。';
    /* Shares only the product's name with the question: no direct match. */
    const generic = 'Hono 是一个小巧的框架，可以运行在很多平台上。';
    const ree = await reeWith(userId, 'Hono guides', [...OTHER_PAGES, MIDDLEWARE, direct, generic]);
    const found = await chat.retrieve(ree.id, QUESTION, undefined, { rewrite: questionRewriter(userId, QUESTION) });
    expect(found.rewrite).toBe('Hono middleware');
    expect(found.evidence).toBe(true);
    const contents = found.passages.map((passage) => passage.content);
    expect(contents).toContain(direct);
    expect(contents).not.toContain(generic);
    expect(contents[0]).toBe(MIDDLEWARE);
  });

  it('keeps the rewrite’s keywords when its embedding fails', async () => {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const asked = await chat.embedQuestion(QUESTION);
    fake.embeddings.failModel = 'fake-embed';
    fake.embeddings.after = 0;
    try {
      const found = await chat.retrieve(ree.id, QUESTION, asked, { rewrite: questionRewriter(userId, QUESTION) });
      expect(found.rewrite).toBe('Hono middleware');
      expect(found.evidence).toBe(true);
      expect(found.passages[0]!.content).toBe(MIDDLEWARE);
    } finally {
      fake.embeddings.failModel = null;
    }
    /* The embedding is retried with backoff before it gives up. */
  }, 30_000);

  /** A Ree searched by keywords alone (no passage has a vector): one page, then `contents`. */
  async function keywordOnly(contents: readonly string[]) {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [OTHER_PAGES[0]!]);
    const [source] = await db().select().from(schema.chunk).where(eq(schema.chunk.reeId, ree.id));
    await db().update(schema.chunk).set({ embedding: null, embeddingSpace: null }).where(eq(schema.chunk.reeId, ree.id));
    await db()
      .insert(schema.chunk)
      .values(contents.map((content, index) => ({ knowledgeId: source!.knowledgeId, reeId: ree.id, ordinal: 1 + index, content, locator: {} })));
    return ree;
  }

  it('reads the passages matching the most terms, not the first that match one', async () => {
    /* More passages naming Hono than the leg reads, then the one page that also says middleware. */
    const filler = Array.from({ length: 230 }, (_, index) => `Hono note ${index}: release ${index} changed nothing worth reading here.`);
    const ree = await keywordOnly([...filler, MIDDLEWARE]);
    const found = await chat.retrieve(ree.id, 'hono middleware');
    expect(found.passages[0]!.content).toBe(MIDDLEWARE);
  });

  it('ranks the passages read by whole words, not by words inside other words', async () => {
    /* "set" and "config" inside "settings", "reset" and "configuration", in more passages than the leg reads. */
    const filler = Array.from({ length: 230 }, (_, index) => `Settings reset the configuration of release ${index}.`);
    const wanted = 'Use set to change one config value.';
    const ree = await keywordOnly([...filler, wanted]);
    const found = await chat.retrieve(ree.id, 'set config');
    expect(found.passages.map((passage) => passage.content)).toEqual([wanted]);
  });

  it('reads the same passages every time when they tie', async () => {
    /* "middleware" is nowhere: every passage ties on "hono" alone. */
    const ree = await keywordOnly(Array.from({ length: 230 }, (_, index) => `Hono note ${index}: release ${index} changed nothing worth reading here.`));
    const first = await chat.retrieve(ree.id, 'hono middleware');
    const again = await chat.retrieve(ree.id, 'hono middleware');
    const ids = (await db().select({ id: schema.chunk.id }).from(schema.chunk).where(eq(schema.chunk.reeId, ree.id))).map((row) => row.id).sort();
    expect(first.passages.map((passage) => passage.chunkId)).toEqual(ids.slice(0, 8));
    expect(again.passages.map((passage) => passage.chunkId)).toEqual(ids.slice(0, 8));
  });
});
