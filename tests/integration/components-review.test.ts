/**
 * Server half of a components review fix (rebuild review section 七): a
 * Paddle payment link is opened only for the viewer's own transaction (C12).
 * (C3, a conversation page waiting for its latest answer, went with the
 * conversations.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import type { PaddleConfig, PaddleTransaction } from '@/lib/infra/paddle';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { ownsPaddleTransaction } = await import('@/lib/services/pricing');
const { db, schema } = await import('@/lib/infra/db');

async function user() {
  const subject = uniqueName('cr');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

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
