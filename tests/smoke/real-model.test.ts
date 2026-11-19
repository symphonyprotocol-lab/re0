/**
 * Smoke test on the real models -- skipped unless SMOKE_REAL_MODEL=1, and
 * run by `./scripts/smoke-real-model.sh`, which copies the local dev
 * database's enabled model settings (read-only) into a throwaway test
 * database. The rest of the suite runs on the fake model; this is what
 * caught the review failing on agnes-3.0-flash (2026-11-19).
 *
 * The whole flow a person sees: a post is published, reviewed on the real
 * model, answered by a free Ree from its own knowledge (real embedding and
 * generation), and the author pays one base fee.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from '../integration/setup';

const run = TEST_DATABASE_URL && process.env.SMOKE_REAL_MODEL === '1' && process.env.SMOKE_MODEL_CONFIGS ? describe : describe.skip;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const posts = await import('@/lib/services/posts');
const { modelJudge } = await import('@/lib/services/public-qa');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache, endpointFor } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE, REWRITE_OUTPUT_TOKENS } = await import('@/lib/constants');
const { MODERATION_OUTPUT_TOKENS } = await import('@/lib/domain/public-qa');
const { suggestQuestions } = await import('@/lib/services/profile');
const { appendFileSync, readFileSync } = await import('node:fs');

async function user(prefix: string, credits = 0) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  /* A known balance: whatever sign-up gave, then exactly `credits`. */
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

/** A public, published Ree with ready knowledge about refunds; free unless a fee is given. */
async function publicRee(queryFee = 0) {
  /* Adding knowledge holds credits. */
  const ownerId = await user('post-owner', 1_000);
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, {
    kind: 'text',
    title: 'Refund policy',
    content: 'Refunds are issued to the original payment method within 14 days of the request. The refund goes back to the card or account that paid.',
  });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee }).where(eq(schema.ree.id, ree.id));
  return { ownerId, reeId: ree.id };
}


const QUESTION = 'When are refunds issued to the original payment method?';
/* Printed, and kept in SMOKE_LOG for the runner to show at the end (a passing test's output may be folded). */
const log = (label: string, value: unknown) => {
  const line = `[smoke] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  console.log(line);
  if (process.env.SMOKE_LOG) appendFileSync(process.env.SMOKE_LOG, `${line}\n`);
};

run('real models (smoke)', () => {
  beforeAll(async () => {
    /* The local settings, keys still sealed (the runner passes the key that opens them). */
    const rows = JSON.parse(readFileSync(process.env.SMOKE_MODEL_CONFIGS!, 'utf8')) as Record<string, unknown>[];
    for (const row of rows) await db().execute(sql`insert into model_config select * from jsonb_populate_record(null::model_config, ${JSON.stringify(row)}::jsonb)`);
    forgetModelCache();
    const generation = await endpointFor('generation');
    /* The local unit prices (owner-billed calls such as example questions are refused without one). */
    for (const row of JSON.parse(readFileSync(process.env.SMOKE_PRICES ?? '/dev/null', 'utf8') || '[]') as Record<string, unknown>[]) {
      await db().execute(sql`insert into provider_pricing (id, revision, rates) values (${row.id as number}, ${row.revision as string}, ${JSON.stringify(row.rates)}::jsonb) on conflict (id) do nothing`);
    }
    const embedding = await endpointFor('embedding');
    log('models', { generation: `${generation.transport} ${generation.model}`, embedding: `${embedding.transport} ${embedding.model}`, keys: [Boolean(generation.apiKey), Boolean(embedding.apiKey)] });
  }, 60_000);

  it('reviews on the real model: an ordinary question passes, one with a phone number does not', async () => {
    for (const [question, expected] of [
      [QUESTION, true],
      ['加我微信 13812345678 聊退款，怎么退？', false],
      ['退款问题请联系我 vx: linmei_88，怎么退比较快？', false],
      ['Email me at lin.mei@example.com about refunds, how long do they take?', false],
      ['全场低价代购名牌包，加我领优惠券！', false],
      ['asdfgh qwerty zxcvb', false],
    ] as const) {
      const started = Date.now();
      const verdict = await modelJudge(question, '');
      log(`review "${question.slice(0, 30)}"`, { ...verdict, ms: Date.now() - started });
      expect(verdict.publish).toBe(expected);
    }
  }, 120_000);

  it('passes ordinary questions consistently (each reviewed several times)', async () => {
    const ordinary = [
      'How long does a refund take, and where does the money go?',
      'What should I know before travelling to Brazil?',
      'How do I set up middleware in Hono?',
      '我想去巴西玩，需要注意什么？',
      '退款一般多久到账？',
      'Which is better for a beginner, Python or JavaScript?',
    ];
    const refused: { question: string; reason?: string }[] = [];
    let total = 0;
    for (const question of ordinary) {
      for (let index = 0; index < Number(process.env.SMOKE_REVIEW_REPEATS ?? 4); index += 1) {
        total += 1;
        const verdict = await modelJudge(question, '');
        if (!verdict.publish) refused.push({ question, reason: verdict.reason });
      }
    }
    log('ordinary questions refused', { refused: refused.length, of: total, examples: refused.slice(0, 6) });
    expect(refused).toEqual([]);
  }, 600_000);

  it('posts, reviews, has a free Ree answer from its knowledge, and charges one base fee', async () => {
    const { reeId } = await publicRee();
    const author = await user('smoke-author', 100);
    /* A new author: no other post of theirs to be a duplicate of, so the plain question will do. */
    const asked = QUESTION;
    const verdicts: { publish: boolean; reason?: string }[] = [];
    for (let index = 0; index < 5; index += 1) verdicts.push(await modelJudge(asked, ''));
    log('the same question reviewed 5 times', verdicts);
    const posted = await posts.publishPost(author, { question: asked, lang: 'en', mentionReeId: reeId });
    if (!posted.ok) throw new Error(posted.error);
    const started = Date.now();
    await posts.processPost(posted.id);
    const [row] = await db().select().from(schema.post).where(eq(schema.post.id, posted.id));
    log('question as stored (redacted) and reviewed', row!.question);
    const answers = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, posted.id));
    log('post', { status: row!.status, moderationAttempts: row!.moderationAttempts, answerState: row!.answerState, answerCount: row!.answerCount, ms: Date.now() - started });
    for (const entry of answers) log(`answer ${entry.reeId === reeId ? '(named Ree)' : '(other)'}`, { state: entry.state, model: entry.model, price: entry.price, citations: entry.citations.length, text: entry.text.slice(0, 160) });
    expect(row).toMatchObject({ status: 'published', moderationAttempts: 1, answerState: 'done' });
    const named = answers.find((entry) => entry.reeId === reeId)!;
    expect(named).toMatchObject({ state: 'answered', price: QUERY_BASE_FEE });
    expect(named.text).toMatch(/14/);
    const charged = answers.filter((entry) => entry.state === 'answered' && entry.baseHoldId).length;
    const balance = await balanceOf(db(), author);
    log('author balance', { before: 100, after: balance, answersCharged: charged });
    expect(balance).toBe(100 - charged * QUERY_BASE_FEE);
    const ledger = await db().select({ reason: schema.creditEntry.reason, delta: schema.creditEntry.delta }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, author), eq(schema.creditEntry.refId, named.id)));
    log('ledger for the named answer', ledger);
  }, 300_000);

  it('writes a summary and example questions on the real model within their budgets, and no call runs out of tokens', async () => {
    const first = await publicRee();
    const second = await publicRee();
    const author = await user('smoke-summary', 200);
    const posted = await posts.publishPost(author, { question: 'How long does a refund take, and where does the money go?', lang: 'en', mentionReeId: first.reeId });
    if (!posted.ok) throw new Error(posted.error);
    await posts.processPost(posted.id, {
      match: async () => ({ answerers: [{ reeId: first.reeId, similarity: 0.9, mentioned: true }, { reeId: second.reeId, similarity: 0.8, mentioned: false }], candidates: 2, skipped: 0, vector: null }),
    });
    const answered = (await posts.getPost(posted.id, author))!;
    log('summary post', { status: answered.status, answers: answered.answers.map((entry) => entry.state) });
    const outcome = await posts.summarizePost(author, posted.id, 'en');
    const [row] = await db().select({ content: schema.post.summaryContent }).from(schema.post).where(eq(schema.post.id, posted.id));
    log('summary', { outcome, text: (row?.content ?? '').slice(0, 200) });
    expect(outcome).toBe('done');

    const suggested = await suggestQuestions(first.reeId);
    log('example questions', suggested);
    expect(suggested.length).toBeGreaterThan(0);

    /* Every generation call of the run, against its budget: an output at its ceiling would mean thinking ate it. */
    const calls = await db()
      .select({ purpose: schema.modelCall.purpose, status: schema.modelCall.status, output: schema.modelCall.outputTokens })
      .from(schema.modelCall)
      .where(eq(schema.modelCall.kind, 'generation'));
    const byPurpose = new Map<string, { calls: number; maxOutput: number; failed: number }>();
    for (const call of calls) {
      const entry = byPurpose.get(call.purpose ?? 'other') ?? { calls: 0, maxOutput: 0, failed: 0 };
      entry.calls += 1;
      entry.maxOutput = Math.max(entry.maxOutput, call.output ?? 0);
      if (call.status !== 'succeeded') entry.failed += 1;
      byPurpose.set(call.purpose ?? 'other', entry);
    }
    const budgets: Record<string, number> = { moderation: MODERATION_OUTPUT_TOKENS, post_answer: 1_500, synthesis: 1_500, suggestions: 300, retrieval: REWRITE_OUTPUT_TOKENS };
    log('generation calls by purpose (max output tokens / budget)', Object.fromEntries([...byPurpose].map(([purpose, entry]) => [purpose, `${entry.calls} calls, max ${entry.maxOutput} / ${budgets[purpose] ?? '?'}, failed ${entry.failed}`])));
    for (const [purpose, entry] of byPurpose) if (budgets[purpose]) expect(entry.maxOutput, purpose).toBeLessThan(budgets[purpose]!);
  }, 600_000);
});
