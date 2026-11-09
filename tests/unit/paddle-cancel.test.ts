/** Replacing a stale Plan checkout must survive a cancellation an interrupted attempt already made. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelCheckoutTransaction, PaddleError, type PaddleConfig } from '@/lib/infra/paddle';

const config: PaddleConfig = {
  apiKey: 'test',
  webhookSecret: 'test',
  clientToken: 'test',
  planPriceId: 'pri_plan',
  packPriceId: 'pri_pack',
  environment: 'sandbox',
  checkoutUrl: 'http://localhost/checkout',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('cancelCheckoutTransaction', () => {
  it('treats a transaction Paddle already canceled as canceled', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(400, { error: { code: 'transaction_immutable', detail: 'canceled' } }))
      .mockResolvedValueOnce(reply(200, { data: { id: 'txn_1', status: 'canceled' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(cancelCheckoutTransaction(config, 'txn_1')).resolves.toBeUndefined();
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'GET' });
  });

  it('still fails when the transaction is not canceled, e.g. already paid', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(400, { error: { code: 'transaction_immutable' } }))
      .mockResolvedValueOnce(reply(200, { data: { id: 'txn_1', status: 'completed' } })));
    await expect(cancelCheckoutTransaction(config, 'txn_1')).rejects.toBeInstanceOf(PaddleError);
  });

  it('does not probe after a network failure', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    await expect(cancelCheckoutTransaction(config, 'txn_1')).rejects.toBeInstanceOf(PaddleError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
