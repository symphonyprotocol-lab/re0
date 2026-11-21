/**
 * Migration 0070 (PR B) drops the conversation tables. Run against seeded
 * conversations -- the tables put back as they were before it
 * (`restoreConversationTables`) -- it must:
 *
 * - stop, dropping nothing, while any chat hold is still open;
 * - keep payout tracing: a conversation answer's earning still traces to
 *   whoever asked, through the snapshot it writes (`payout_trace_legacy`);
 * - keep the public Q&A and posts copied from conversations, visible, with
 *   their votes -- except those whose conversation was in the trash, which
 *   go as the purge would have taken them;
 * - leave every figure that counted conversations as it was (the frozen
 *   counters of 0066 / 0067; legacy-stats.test.ts checks every reader);
 * - and drop the tables and the columns that pointed at them.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { dropConversationTables, migration0070, restoreConversationTables, runBackfill, TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { addGrant, paidShare, placeHold, settleHold } = await import('@/lib/services/credits');
const { payoutFunding } = await import('@/lib/services/payout-funding');
const { syncPublicQa } = await import('@/lib/services/public-qa-sync');
const { listPublicQa } = await import('@/lib/services/public-qa');
const posts = await import('@/lib/services/posts');
const { answersByOthers } = await import('@/lib/services/explore');
const { votesByOthers } = await import('@/lib/services/ree-feedback');
const { roleMetrics } = await import('@/lib/services/roles');
const { consoleAdministrator } = await import('../fixtures/console-administrator');
const { db, schema } = await import('@/lib/infra/db');

const FEE = 5_000;

afterAll(async () => {
  await db().execute(sql`update credit_hold set status = 'released', closed_at = now() where kind = 'chat' and status = 'held'`);
  await dropConversationTables();
});

async function newUser(prefix: string) {
  const subject = uniqueName(prefix);
  const [row] = await db().insert(schema.user).values({ name: prefix, email: `${subject}@example.test`, provider: 'github', providerSubject: subject }).returning();
  return row!.id;
}

async function exists(table: string): Promise<boolean> {
  const result = await db().execute<{ present: boolean }>(sql`select to_regclass(${`public.${table}`}) is not null as present`);
  return result.rows[0]!.present;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await db().execute<{ present: boolean }>(sql`select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = ${column}) as present`);
  return result.rows[0]!.present;
}

/** One exchange in a new conversation of `userId`, as the chat wrote it; answers the question's and the reply's ids. */
async function exchange(userId: string, reeId: string, options: { trashed?: boolean } = {}) {
  const conversationId = randomUUID();
  const questionId = randomUUID();
  const replyId = randomUUID();
  await db().execute(sql`insert into conversation (id, user_id, deleted_at) values (${conversationId}, ${userId}, ${options.trashed ? new Date().toISOString() : null})`);
  await db().execute(sql`insert into conversation_ree (conversation_id, ree_id) values (${conversationId}, ${reeId})`);
  await db().execute(sql`insert into message (id, conversation_id, role, content, request_id) values (${questionId}, ${conversationId}, 'user', 'When are refunds issued?', ${questionId})`);
  await db().execute(sql`insert into message (id, conversation_id, role, ree_id, content, request_id, cost_credits)
    values (${replyId}, ${conversationId}, 'ree', ${reeId}, 'Within 14 days.', ${questionId}, ${FEE})`);
  return { conversationId, questionId, replyId };
}

/** The asker's query fee for the reply, held, settled and credited to the owner as the conversations did (the hold named the question, the earning the reply). */
async function paidFee(askerId: string, ownerId: string, reeId: string, questionId: string, replyId: string) {
  const holdId = await db().transaction((tx) => placeHold(tx, { userId: askerId, kind: 'post', ledger: 'chat_fee', amount: FEE, refId: questionId, reeId }));
  await db().transaction(async (tx) => {
    const paid = await settleHold(tx, holdId, FEE, { reeId, ledger: 'chat_fee' });
    const share = await paidShare(tx, paid!.chargedAllocations);
    for (const [purchaseId, amount] of share.byPurchase) if (amount > 0) await addGrant(tx, { userId: ownerId, source: 'earned', amount, reason: 'query_fee_earned', refId: replyId, reeId, withdrawableAt: new Date(), fundingPurchaseId: purchaseId });
    if (share.free > 0) await addGrant(tx, { userId: ownerId, source: 'earned', amount: share.free, reason: 'query_fee_earned', refId: replyId, reeId, withdrawableAt: null });
  });
}

/** A payout drawing every earned credit the owner has: its hold names the grants, as payouts.ts places it. */
async function payoutOf(ownerId: string, credits: number) {
  const holdId = await db().transaction((tx) => placeHold(tx, { userId: ownerId, kind: 'payout', amount: credits, refId: randomUUID(), sources: ['earned'] }));
  const [row] = await db().insert(schema.payout).values({ userId: ownerId, credits, paypalEmail: `${uniqueName('pay')}@example.test`, holdId }).returning();
  return row!.id;
}

/** A public Q&A an asker published from the conversation's reply, reviewed, and copied into a post (public-qa-sync.ts). */
async function publishedFrom(askerId: string, reeId: string, replyId: string) {
  const [row] = await db()
    .insert(schema.reePublicQa)
    .values({ reeId, source: 'user', userId: askerId, question: 'When are refunds issued?', answer: 'Within 14 days.', lang: 'en', status: 'published', publishedAt: new Date() })
    .returning({ id: schema.reePublicQa.id });
  await db().execute(sql`update ree_public_qa set message_id = ${replyId} where id = ${row!.id}`);
  await syncPublicQa();
  const [copied] = await db().select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.legacyQaId, row!.id));
  await db().execute(sql`update post set message_id = ${replyId} where id = ${copied!.id}`);
  return { qaId: row!.id, postId: copied!.id };
}

describeWithDb('migration 0070: the conversations go', () => {
  it('stops while a chat hold is open, dropping nothing', async () => {
    await restoreConversationTables();
    const askerId = await newUser('mg-held');
    await db().transaction((tx) => addGrant(tx, { userId: askerId, source: 'pack', amount: 100, reason: 'admin_adjust', refId: randomUUID() }));
    /* As a question whose stream never finished left it: `chat` holds are history now, so written as they were. */
    const [hold] = await db()
      .insert(schema.creditHold)
      .values({ userId: askerId, kind: 'chat', amount: 20, allocations: [], refId: randomUUID() })
      .returning({ id: schema.creditHold.id });

    await expect(dropConversationTables()).rejects.toThrow(/chat hold/);
    expect(await exists('conversation')).toBe(true);
    expect(await columnExists('post', 'message_id')).toBe(true);
    /* The guard is the migration's first statement: in the deploy's one transaction, nothing after it runs. */
    expect((await migration0070())[0]).toMatch(/RAISE EXCEPTION/);

    await db().update(schema.creditHold).set({ status: 'released', closedAt: new Date() }).where(eq(schema.creditHold.id, hold!.id));
  });

  it('keeps payout tracing, the public posts copied from conversations and every figure, and drops the tables', async () => {
    await restoreConversationTables();
    const ownerId = await newUser('mg-owner');
    const askerId = await newUser('mg-asker');
    const voterId = await newUser('mg-voter');
    const [ree] = await db().insert(schema.ree).values({ ownerId, name: 'Refund desk', slug: uniqueName('mg-ree'), isPublic: true, isPublished: true, publicQaEnabled: true }).returning();
    const reeId = ree!.id;
    await db().transaction((tx) => addGrant(tx, { userId: askerId, source: 'pack', amount: 100_000, reason: 'admin_adjust', refId: randomUUID() }));

    /* The conversations: an answered question with a paid fee and a vote, a round-table synthesis and its vote, and one in the trash. */
    const kept = await exchange(askerId, reeId);
    await paidFee(askerId, ownerId, reeId, kept.questionId, kept.replyId);
    await db().execute(sql`insert into ree_feedback (message_id, user_id, vote) values (${kept.replyId}, ${askerId}, 'up')`);
    const synthesisId = randomUUID();
    await db().execute(sql`insert into synthesis (id, conversation_id, request_id, user_id, status, content) values (${synthesisId}, ${kept.conversationId}, ${kept.questionId}, ${askerId}, 'done', 'Both agree.')`);
    await db().execute(sql`insert into synthesis_feedback (synthesis_id, user_id, vote) values (${synthesisId}, ${askerId}, 'up')`);
    const trashed = await exchange(askerId, reeId, { trashed: true });
    await db().execute(sql`insert into answer_check (ree_id, message_id, cited) values (${reeId}, ${kept.replyId}, 2)`);
    await db().execute(sql`insert into ree_share_event (ree_id, kind, visitor_id, user_id, conversation_id) values (${reeId}, 'conversation', ${randomUUID()}, ${askerId}, ${kept.conversationId})`);

    /* Published from the conversations: one kept (saved and voted helpful by someone), one whose conversation is in the trash. */
    const shown = await publishedFrom(askerId, reeId, kept.replyId);
    const hidden = await publishedFrom(askerId, reeId, trashed.replyId);
    await db().insert(schema.postSave).values({ postId: shown.postId, userId: voterId });
    const [answerRow] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, shown.postId));
    expect(await posts.setAnswerHelpful(voterId, answerRow!.id, true)).toMatchObject({ voted: true });

    /* The release froze the figures (0066); the payout draws the earning (traced from the snapshot 0070 writes, so checked after it). */
    await runBackfill('legacy-stats');
    const payoutId = await payoutOf(ownerId, FEE);
    const administrator = await consoleAdministrator();
    const figures = async () => {
      const [row] = await db().select({ answers: answersByOthers, up: votesByOthers('up'), down: votesByOthers('down') }).from(schema.ree).where(eq(schema.ree.id, reeId));
      const metrics = await roleMetrics(db(), ownerId);
      return { ...row!, external: metrics.externalQuestions, helpful: metrics.helpful };
    };
    const before = await figures();
    expect(before.answers).toBeGreaterThan(0);
    expect(before.up).toBeGreaterThan(0);

    await dropConversationTables();

    /* Gone: the tables and the columns that pointed at them. */
    for (const table of ['conversation', 'conversation_ree', 'message', 'ree_feedback', 'synthesis', 'synthesis_feedback']) expect(await exists(table)).toBe(false);
    for (const [table, column] of [['post', 'message_id'], ['ree_public_qa', 'message_id'], ['answer_check', 'message_id'], ['ree_share_event', 'conversation_id']] as const) expect(await columnExists(table, column)).toBe(false);

    /* Payout tracing still names the asker, from the snapshot. */
    const [trace] = await db().select().from(schema.payoutTraceLegacy).where(eq(schema.payoutTraceLegacy.replyId, kept.replyId));
    expect(trace).toMatchObject({ requestId: kept.questionId, reeId, askerId });
    const traced = (await payoutFunding(administrator, payoutId, ownerId)).summary;
    expect(traced).toMatchObject({ drawn: FEE, traced: FEE, payers: 1 });
    expect(traced.ranked.map((payer) => payer.userId)).toEqual([askerId]);
    expect(traced.sources).toMatchObject({ console: FEE });

    /* The public post and Q&A from the kept conversation survive, visible, with their save and vote; the trashed one's are gone. */
    expect(await db().select({ id: schema.reePublicQa.id }).from(schema.reePublicQa).where(eq(schema.reePublicQa.reeId, reeId))).toEqual([{ id: shown.qaId }]);
    const post = await posts.getPost(shown.postId);
    expect(post).toMatchObject({ id: shown.postId, author: { kind: 'hidden' } });
    expect(post!.answers.map((entry) => entry.helpful)).toEqual([1]);
    expect(await db().select().from(schema.postSave).where(eq(schema.postSave.postId, shown.postId))).toHaveLength(1);
    expect(await posts.getPost(hidden.postId)).toBeNull();
    expect((await listPublicQa(reeId))?.items.map((item) => item.postId)).toEqual([shown.postId]);

    /* The figures, the answer check and the old share conversion stay. */
    expect(await figures()).toEqual(before);
    expect(await db().select({ cited: schema.answerCheck.cited }).from(schema.answerCheck).where(eq(schema.answerCheck.reeId, reeId))).toEqual([{ cited: 2 }]);
    expect(await db().select({ kind: schema.reeShareEvent.kind }).from(schema.reeShareEvent).where(eq(schema.reeShareEvent.reeId, reeId))).toEqual([{ kind: 'conversation' }]);
  });
});
