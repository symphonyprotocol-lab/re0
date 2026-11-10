/**
 * The money path of one answer (review H2, H3, H5, M6): the owner's query
 * fee is withdrawable only for what the asker paid from money paid in, and
 * only after the maturity period; a full answer that ends on the no-answer
 * sentinel is still charged; a stream cut off by a provider error is not; a
 * question whose stream died leaves holds the chat-hold cron gives back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { handbookPages, makePdf } from '../fixtures/pdf';
import { startFakeFirecrawl } from '../fixtures/fake-firecrawl';
import type { FakeWeb } from '../fixtures/fake-web';
import { CHAT_HOLD_STALE_MS, EARNED_MATURITY_DAYS, QUERY_BASE_FEE } from '@/lib/constants';

const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path)?.length ?? null,
  readBlob: async (path: string) => blobs.get(path) ?? null,
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const chat = await import('@/lib/services/chat');
const { answer, holdQuestion } = await import('@/lib/services/answer');
const { releaseStaleChatHolds } = await import('@/lib/services/chat-holds');
const payouts = await import('@/lib/services/payouts');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const cron = await import('@/app/api/cron/release-chat-holds/route');

const DAY = 24 * 60 * 60 * 1000;
const FEE = 5_000;
const QUESTION = 'When are refunds issued to the original payment method?';

let fake: FakeOpenAi;
let firecrawl: FakeWeb;
beforeAll(async () => {
  firecrawl = startFakeFirecrawl();
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  firecrawl?.restore();
  vi.unstubAllEnvs();
  await fake?.close();
});

async function newUser(prefix: string): Promise<string> {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'zh', '/');
  return userId;
}

/** An owner's Ree with ready knowledge and a query fee, and an asker with a test conversation to it. */
async function setUp(fee = FEE) {
  const ownerId = await newUser('owner');
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: 'Northwind', category: 'business', step: 4, reached: 4 });
  const { ree: created } = await rees.createReeFromDraft(ownerId);
  const path = `knowledge/${ownerId}/h/handbook.pdf`;
  blobs.set(path, makePdf(handbookPages()));
  await knowledge.processKnowledge(await knowledge.addKnowledge(ownerId, created, { kind: 'document', blobPath: path, fileName: 'handbook.pdf' }));
  await db().update(schema.ree).set({ queryFee: fee }).where(eq(schema.ree.id, created.id));
  const ree = { ...created, queryFee: fee };
  const askerId = await newUser('asker');
  const conversation = await chat.testConversation(askerId, ree.id);
  return { ownerId, ree, askerId, conversation };
}

/** A Pack bought through Paddle: a purchase row and the grant it paid for. */
async function boughtPack(userId: string, credits: number) {
  await db().transaction(async (tx) => {
    const [purchase] = await tx
      .insert(schema.purchase)
      .values({ userId, kind: 'pack', paddleTransactionId: uniqueName('txn'), amountMinor: 1_000, credits })
      .returning({ id: schema.purchase.id });
    await addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'purchase', refId: purchase!.id, purchaseId: purchase!.id });
  });
}

async function emptyWelcome(userId: string) {
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(and(eq(schema.creditGrant.userId, userId), eq(schema.creditGrant.source, 'welcome')));
}

async function earnedGrants(userId: string) {
  return db().select().from(schema.creditGrant).where(and(eq(schema.creditGrant.userId, userId), eq(schema.creditGrant.source, 'earned')));
}

async function read(response: Response) {
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string; data?: Record<string, unknown> });
  return {
    text: events.filter((event) => event.type === 'text-delta').map((event) => event.delta).join(''),
    outcome: events.find((event) => event.type === 'data-outcome')?.data as { noAnswer: boolean; failed: boolean; cost: number } | undefined,
  };
}

describeWithDb('who may withdraw a query fee (H2)', () => {
  it('a fee paid from welcome credits is earned but never withdrawable', async () => {
    const { ownerId, ree, askerId, conversation } = await setUp();
    const result = await read(await answer({ userId: askerId, lang: 'en', conversation, targets: [ree], question: QUESTION }));
    expect(result.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    const earned = await earnedGrants(ownerId);
    expect(earned.map((grant) => [grant.amount, grant.withdrawableAt])).toEqual([[FEE, null]]);
    /* Spendable by the owner, but not a payout, now or later. */
    expect(await balanceOf(db(), ownerId)).toBeGreaterThanOrEqual(FEE);
    expect(await payouts.withdrawable(db(), ownerId, false, new Date(Date.now() + 365 * DAY))).toBe(0);
  });

  it('a fee paid from a bought Pack is withdrawable once it has matured', async () => {
    const { ownerId, ree, askerId, conversation } = await setUp();
    await emptyWelcome(askerId);
    await boughtPack(askerId, 100_000);
    const result = await read(await answer({ userId: askerId, lang: 'en', conversation, targets: [ree], question: QUESTION }));
    expect(result.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    const [grant] = await earnedGrants(ownerId);
    expect(grant).toMatchObject({ amount: FEE });
    expect(grant!.withdrawableAt!.getTime() - grant!.createdAt.getTime()).toBeGreaterThanOrEqual(EARNED_MATURITY_DAYS * DAY - 60_000);
    expect(await payouts.withdrawable(db(), ownerId)).toBe(0);
    expect(await payouts.withdrawable(db(), ownerId, false, new Date(Date.now() + (EARNED_MATURITY_DAYS + 1) * DAY))).toBe(FEE);
  });

  it('a fee paid partly from free and partly from paid credits is split', async () => {
    const { ownerId, ree, askerId, conversation } = await setUp();
    /* Spend order is welcome before Pack: 20 base + 1,000 of the fee from welcome, the other 4,000 from the Pack. */
    await db().update(schema.creditGrant).set({ remaining: QUERY_BASE_FEE + 1_000 }).where(and(eq(schema.creditGrant.userId, askerId), eq(schema.creditGrant.source, 'welcome')));
    await boughtPack(askerId, 100_000);
    await read(await answer({ userId: askerId, lang: 'en', conversation, targets: [ree], question: QUESTION }));
    const earned = await earnedGrants(ownerId);
    expect(earned.map((grant) => [grant.amount, grant.withdrawableAt !== null]).sort()).toEqual([
      [1_000, false],
      [4_000, true],
    ]);
  });
});

describeWithDb('settling the stream (H3, M6)', () => {
  it('charges a full answer that ends on the no-answer sentinel, and keeps a short refusal free', async () => {
    const { ownerId, ree, askerId, conversation } = await setUp();
    const before = await balanceOf(db(), askerId);
    const long = await read(await answer({ userId: askerId, lang: 'en', conversation, targets: [ree], question: `${QUESTION} LONG THEN SENTINEL` }));
    expect(long.text).toContain('14 days');
    expect(long.text).not.toContain('[[NO_ANSWER]]');
    expect(long.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    expect(await balanceOf(db(), askerId)).toBe(before - QUERY_BASE_FEE - FEE);
    expect((await earnedGrants(ownerId)).map((grant) => grant.amount)).toEqual([FEE]);

    /* A conversation of its own: earlier turns are part of what the model reads. */
    const other = await setUp();
    const otherBefore = await balanceOf(db(), other.askerId);
    const short = await read(await answer({ userId: other.askerId, lang: 'en', conversation: other.conversation, targets: [other.ree], question: `${QUESTION} LATE REFUSAL` }));
    expect(short.outcome).toMatchObject({ noAnswer: true, cost: 0 });
    expect(await balanceOf(db(), other.askerId)).toBe(otherBefore);
  });

  it('a stream cut off by a provider error fails the Ree and charges nothing', async () => {
    const { ownerId, ree, askerId, conversation } = await setUp();
    const before = await balanceOf(db(), askerId);
    const result = await read(await answer({ userId: askerId, lang: 'en', conversation, targets: [ree], question: `${QUESTION} STREAM ERROR` }));
    expect(result.outcome).toMatchObject({ failed: true, cost: 0 });
    expect(await balanceOf(db(), askerId)).toBe(before);
    expect(await earnedGrants(ownerId)).toHaveLength(0);
    const replies = (await chat.messagesOf(conversation.id)).filter((row) => row.role === 'ree');
    expect(replies).toHaveLength(0);
    const open = await db().select().from(schema.creditHold).where(and(eq(schema.creditHold.userId, askerId), eq(schema.creditHold.status, 'held')));
    expect(open).toHaveLength(0);
  });
});

describeWithDb('the chat-hold cron (H5)', () => {
  it('gives back the holds of a question whose stream died, under each hold’s own reasons, once', async () => {
    const { ree, askerId, conversation } = await setUp();
    const before = await balanceOf(db(), askerId);
    /* Held, then the function "dies": nothing ever runs the question. */
    const holding = await holdQuestion({ userId: askerId, lang: 'en', conversation, targets: [ree], question: QUESTION, verify: true });
    expect(holding.ok).toBe(true);
    const askedId = holding.ok ? holding.question.askedId : '';
    expect(await balanceOf(db(), askerId)).toBeLessThan(before);

    const mine = () => db().select().from(schema.creditHold).where(and(eq(schema.creditHold.userId, askerId), eq(schema.creditHold.status, 'held')));
    /* Young holds belong to a stream that may still be running. */
    await releaseStaleChatHolds();
    expect(await mine()).toHaveLength(3);
    /* Age them past the limit (other files share the database, so the clock stays real). */
    await db().update(schema.creditHold).set({ createdAt: new Date(Date.now() - CHAT_HOLD_STALE_MS - 60_000) }).where(eq(schema.creditHold.refId, askedId));
    const first = await releaseStaleChatHolds();
    expect(first.released).toBeGreaterThanOrEqual(3);
    expect(first.failed).toBe(0);
    expect(await mine()).toHaveLength(0);
    expect(await balanceOf(db(), askerId)).toBe(before);
    const entries = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, askerId), eq(schema.creditEntry.refId, askedId)));
    expect(entries.filter((entry) => entry.delta > 0).map((entry) => [entry.reason, entry.reeId]).sort()).toEqual([
      ['query_refund', ree.id],
      ['query_refund', ree.id],
      ['verify_refund', ree.id],
    ]);
    await releaseStaleChatHolds();
    expect(await balanceOf(db(), askerId)).toBe(before);
    expect((await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, askerId), eq(schema.creditEntry.refId, askedId)))).length).toBe(entries.length);
  });

  it('the cron route wants the cron secret', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-test-secret');
    const unauthorized = await cron.GET(new Request('http://localhost/api/cron/release-chat-holds') as never);
    expect(unauthorized.status).toBe(401);
    const ok = await cron.GET(new Request('http://localhost/api/cron/release-chat-holds', { headers: { authorization: 'Bearer cron-test-secret' } }) as never);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ failed: 0 });
  });
});
