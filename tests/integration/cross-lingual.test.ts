/**
 * Cross-lingual retrieval: a vague Chinese question over English docs
 * ("Hono 怎么写中间件？") shares only the product's name with every passage,
 * so searched as asked it finds nothing close enough and is declined. Also
 * searched as a rewrite into English, it finds the middleware page and is
 * answered for the usual base fee; the rewrite is a logged call, made only
 * when the knowledge is in another language, and its failure only leaves
 * the question searched as asked.
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
const retrieval = await import('@/lib/services/retrieval');
const privatePosts = await import('@/lib/services/private-posts');
/*
 * These tests are about how a Ree's own answer settles. When no Ree answers,
 * a private post now gets the asker an AI general answer at the base fee
 * (ai-answers.ts, covered by tests/integration/ai-answers.test.ts); here it
 * fails, so its hold is given back and every figure is the Ree's alone.
 */
const noAi = { aiAnswer: async () => { throw new Error('no AI in these tests'); } };
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

/** Asks the user's own Ree privately and waits for its answer row. */
async function ask(userId: string, reeId: string, question: string) {
  const made = await privatePosts.publishPrivatePost(userId, { question, reeIds: [reeId], fees: { [reeId]: 20 }, lang: 'zh' });
  if (!made.ok) throw new Error(made.error);
  await privatePosts.processPrivatePost(made.id, noAi);
  const [answer] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, made.id));
  return answer!;
}

const QUESTION = 'Hono 怎么写中间件？';

describeWithDb('cross-lingual retrieval', () => {
  it('searched as asked, a Chinese question misses the English page that answers it', async () => {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const found = await retrieval.retrieve(ree.id, QUESTION);
    expect(found.evidence).toBe(false);
    expect(found.rewrite).toBeNull();
    expect(found.bestSimilarity!).toBeLessThan(0.3);
  });

  it('answers it from the page once the question is also searched in English, for the base fee only', async () => {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const calls = fake.rewrites.calls;
    const found = await retrieval.retrieve(ree.id, QUESTION, undefined, { rewrite: questionRewriter(userId, QUESTION) });
    expect(fake.rewrites.calls).toBe(calls + 1);
    expect(found.rewrite).toBe('Hono middleware');
    expect(found.evidence).toBe(true);
    expect(found.passages[0]!.content).toBe(MIDDLEWARE);

    const before = await balanceOf(db(), userId);
    const answer = await ask(userId, ree.id, QUESTION);
    expect(answer).toMatchObject({ state: 'answered' });
    expect(await balanceOf(db(), userId)).toBe(before - 20);
    expect(answer.citations[0]!.excerpt).toContain('createMiddleware');
    /* A rewrite is metered as a `retrieval` call, apart from the answer: the asker's here, the platform's for a post's answer. */
    const logged = await db().select().from(schema.modelCall).where(and(eq(schema.modelCall.userId, userId), eq(schema.modelCall.purpose, 'retrieval')));
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged.every((call) => call.status === 'succeeded')).toBe(true);
  });

  it('leaves a question in the knowledge’s own language as it was', async () => {
    const userId = await person();
    const english = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const chinese = await reeWith(userId, 'Hono 中文文档', ['Hono 的自定义中间件用 createMiddleware 来写，在中间件里调用 await next() 让后面的处理函数继续执行。', 'Hono 的路由用 app.get 注册处理函数，路径参数从上下文对象里读取。']);
    const calls = fake.rewrites.calls;
    const asked = 'How do I write custom middleware in Hono?';
    const found = await retrieval.retrieve(english.id, asked, undefined, { rewrite: questionRewriter(userId, asked) });
    expect(found.rewrite).toBeNull();
    expect(found.passages[0]!.content).toBe(MIDDLEWARE);
    const same = await retrieval.retrieve(chinese.id, QUESTION, undefined, { rewrite: questionRewriter(userId, QUESTION) });
    expect(same.rewrite).toBeNull();
    expect(same.passages[0]!.content).toContain('自定义中间件');
    expect(fake.rewrites.calls).toBe(calls);
  });

  it('searches as asked when the rewrite fails, still charging nothing for no answer', async () => {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const before = await balanceOf(db(), userId);
    fake.rewrites.fail = true;
    try {
      expect(await ask(userId, ree.id, QUESTION)).toMatchObject({ state: 'no_answer' });
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
    const found = await retrieval.retrieve(ree.id, QUESTION, undefined, { rewrite: questionRewriter(userId, QUESTION) });
    expect(found.rewrite).toBe('Hono middleware');
    expect(found.evidence).toBe(true);
    const contents = found.passages.map((passage) => passage.content);
    expect(contents).toContain(direct);
    expect(contents).not.toContain(generic);
    /* The word-for-word Chinese passage and the English page lead, each found by both legs of its language. */
    expect(contents.slice(0, 2)).toEqual(expect.arrayContaining([direct, MIDDLEWARE]));
  });

  it('keeps the rewrite’s keywords when its embedding fails', async () => {
    const userId = await person();
    const ree = await reeWith(userId, 'Hono docs', [...OTHER_PAGES, MIDDLEWARE]);
    const asked = await retrieval.embedQuestion(QUESTION);
    fake.embeddings.failModel = 'fake-embed';
    fake.embeddings.after = 0;
    try {
      const found = await retrieval.retrieve(ree.id, QUESTION, asked, { rewrite: questionRewriter(userId, QUESTION) });
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
    const found = await retrieval.retrieve(ree.id, 'hono middleware');
    expect(found.passages[0]!.content).toBe(MIDDLEWARE);
  });

  it('ranks the passages read by whole words, not by words inside other words', async () => {
    /* "set" and "config" inside "settings", "reset" and "configuration", in more passages than the leg reads. */
    const filler = Array.from({ length: 230 }, (_, index) => `Settings reset the configuration of release ${index}.`);
    const wanted = 'Use set to change one config value.';
    const ree = await keywordOnly([...filler, wanted]);
    const found = await retrieval.retrieve(ree.id, 'set config');
    expect(found.passages.map((passage) => passage.content)).toEqual([wanted]);
  });

  it('reads the same passages every time when they tie', async () => {
    /* "middleware" is nowhere: every passage ties on "hono" alone. */
    const ree = await keywordOnly(Array.from({ length: 230 }, (_, index) => `Hono note ${index}: release ${index} changed nothing worth reading here.`));
    const first = await retrieval.retrieve(ree.id, 'hono middleware');
    const again = await retrieval.retrieve(ree.id, 'hono middleware');
    const ids = (await db().select({ id: schema.chunk.id }).from(schema.chunk).where(eq(schema.chunk.reeId, ree.id))).map((row) => row.id).sort();
    expect(first.passages.map((passage) => passage.chunkId)).toEqual(ids.slice(0, 8));
    expect(again.passages.map((passage) => passage.chunkId)).toEqual(ids.slice(0, 8));
  });
});
