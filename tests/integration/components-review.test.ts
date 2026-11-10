/**
 * Server halves of the components review fixes (rebuild review section 七):
 * a page knows when its latest question is still being answered, so it
 * waits instead of inviting a second paid ask (C3); and a Paddle payment
 * link is opened only for the viewer's own transaction (C12).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import type { PaddleConfig, PaddleTransaction } from '@/lib/infra/paddle';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { placeHold, releaseHold } = await import('@/lib/services/credits');
const { answeringQuestion, ANSWER_PENDING_MS } = await import('@/lib/services/chat');
const { ownsPaddleTransaction } = await import('@/lib/services/pricing');
const { db, schema } = await import('@/lib/infra/db');

async function user() {
  const subject = uniqueName('cr');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

describeWithDb('a question still being answered (C3)', () => {
  it('is answering while one of its chat holds is open, and not once it closes or goes stale', async () => {
    const userId = await user();
    const [conversation] = await db().insert(schema.conversation).values({ userId, kind: 'normal' }).returning();
    const [asked] = await db().insert(schema.message).values({ conversationId: conversation!.id, role: 'user', content: 'Can I get a refund?' }).returning();
    const rows = [{ id: asked!.id, role: 'user' as const }];
    expect(await answeringQuestion(userId, rows)).toBe(false);

    const holdId = await db().transaction((tx) => placeHold(tx, { userId, kind: 'chat', amount: 20, refId: asked!.id, reeId: null, note: 'test' }));
    expect(await answeringQuestion(userId, rows)).toBe(true);
    /* Another user's view of the same ids never sees it. */
    expect(await answeringQuestion(await user(), rows)).toBe(false);
    /* A hold older than any answer can run belongs to a killed function: nothing more will come. */
    expect(await answeringQuestion(userId, rows, new Date(Date.now() + ANSWER_PENDING_MS + 1_000))).toBe(false);
    /* An earlier question's open hold does not count once a newer question was asked. */
    const [later] = await db().insert(schema.message).values({ conversationId: conversation!.id, role: 'user', content: 'And after 30 days?' }).returning();
    expect(await answeringQuestion(userId, [...rows, { id: later!.id, role: 'user' }])).toBe(false);

    await db().transaction((tx) => releaseHold(tx, holdId, { reeId: null, note: 'test' }));
    expect(await answeringQuestion(userId, rows)).toBe(false);
  });
});

describeWithDb('payment link owner (C12)', () => {
  afterEach(() => vi.unstubAllEnvs());

  function paddleEnv() {
    vi.stubEnv('PADDLE_API_KEY', 'pdl_test_key');
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', 'whsec');
    vi.stubEnv('PADDLE_CLIENT_TOKEN', 'test_token');
    vi.stubEnv('PADDLE_PLAN_PRICE_ID', 'pri_01plan00000000000000000000');
    vi.stubEnv('PADDLE_PACK_PRICE_ID', 'pri_01pack00000000000000000000');
    vi.stubEnv('APP_BASE_URL', 'http://localhost:3000');
  }
  const transaction = (fields: Partial<PaddleTransaction>) => async (_config: PaddleConfig, id: string): Promise<PaddleTransaction> => ({
    id, status: 'ready', customer_id: null, subscription_id: null, currency_code: 'USD', custom_data: null, billing_period: null, items: [], details: null, ...fields,
  });

  it('accepts a transaction Paddle says is the user’s, by custom data or by subscription', async () => {
    paddleEnv();
    const userId = await user();
    const subscription = `sub_${randomUUID()}`;
    await db().insert(schema.subscription).values({ userId, paddleSubscriptionId: subscription, status: 'active' });
    expect(await ownsPaddleTransaction(userId, `txn_${randomUUID().replace(/-/g, '')}`, transaction({ custom_data: { re0_user_id: userId } }))).toBe(true);
    expect(await ownsPaddleTransaction(userId, `txn_${randomUUID().replace(/-/g, '')}`, transaction({ subscription_id: subscription }))).toBe(true);
  });

  it('refuses another user’s transaction, any of our own checkouts not live for this user, and every doubt', async () => {
    paddleEnv();
    const userId = await user();
    const other = await user();
    expect(await ownsPaddleTransaction(userId, 'txn_other00000000', transaction({ custom_data: { re0_user_id: other } }))).toBe(false);
    expect(await ownsPaddleTransaction(userId, 'txn_unknown000000', transaction({ subscription_id: 'sub_not_theirs' }))).toBe(false);

    /* B's checkout row, even if Paddle's custom data were to say A: never opened for A. */
    const theirs = `txn_${randomUUID().replace(/-/g, '')}`;
    await db().insert(schema.paddleCheckout).values({ paddleTransactionId: theirs, userId: other, kind: 'pack', quantity: 10 });
    expect(await ownsPaddleTransaction(userId, theirs, transaction({ custom_data: { re0_user_id: userId } }))).toBe(false);

    const failing = vi.fn().mockRejectedValue(new Error('paddle down'));
    expect(await ownsPaddleTransaction(userId, 'txn_error00000000', failing)).toBe(false);

    vi.unstubAllEnvs();
    vi.stubEnv('PADDLE_API_KEY', '');
    const unused = vi.fn();
    expect(await ownsPaddleTransaction(userId, 'txn_nopaddle00000', unused)).toBe(false);
    expect(unused).not.toHaveBeenCalled();
  });
});
