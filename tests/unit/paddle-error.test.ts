/** A rejected Paddle call must log why Paddle rejected it, and nothing of the request. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutBodyShape, checkoutTransactionBody, createCheckoutTransaction, PaddleError, paddleErrorReason, type PaddleConfig } from '@/lib/infra/paddle';

const API_KEY = 'pdl_live_apikey_SECRET_123';
const BUYER = '00000000-0000-4000-8000-000000000001';
const VALID = 'pri_01m6z9r342xpqqspjndnzxvjvb';
const config: PaddleConfig = {
  apiKey: API_KEY,
  webhookSecret: 'whsec_SECRET',
  clientToken: 'live_client_token',
  planPriceId: 'pri_plan',
  packPriceId: 'pri_pack',
  environment: 'production',
  checkoutUrl: 'https://re0.io/checkout',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

async function failure(body: unknown, status = 400): Promise<PaddleError> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(status, body)));
  const error = await createCheckoutTransaction(config, { kind: 'plan', quantity: 1 }, '00000000-0000-4000-8000-000000000001').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PaddleError);
  return error as PaddleError;
}

describe('PaddleError message', () => {
  it('carries the field-level validation errors and the request id', async () => {
    const error = await failure({
      error: {
        type: 'request_error',
        code: 'bad_request',
        detail: 'Invalid request.',
        documentation_url: 'https://developer.paddle.com/v1/errors/shared/bad_request',
        errors: [
          { field: 'checkout.url', message: 'must be a valid url' },
          { field: 'items[0].price_id', message: 'price is archived' },
        ],
      },
      meta: { request_id: 'req_01abc' },
    });
    expect(error.status).toBe(400);
    expect(error.message).toBe(
      'paddle POST /transactions: 400 bad_request Invalid request. [checkout.url: must be a valid url; items[0].price_id: price is archived] (request_id req_01abc)',
    );
  });

  it('never includes the request headers, key or body', async () => {
    const error = await failure({
      error: { code: 'bad_request', detail: 'Invalid request.', errors: [{ field: 'discount.amount', message: 'must be positive' }] },
      meta: { request_id: 'req_02' },
    });
    for (const secret of ['Authorization', 'Bearer', API_KEY, config.webhookSecret, 'custom_data', 're0_user_id', '00000000-0000-4000-8000-000000000001']) {
      expect(error.message).not.toContain(secret);
    }
  });

  it('keeps the old shape when Paddle sends no field errors', async () => {
    const error = await failure({ error: { code: 'not_found', detail: 'Entity not found.' } }, 404);
    expect(error.message).toBe('paddle POST /transactions: 404 not_found Entity not found.');
  });

  it('caps the number and length of the field errors', () => {
    const errors = Array.from({ length: 24 }, (_, i) => ({ field: `items[${i}].price_id`, message: 'x'.repeat(1000) }));
    const reason = paddleErrorReason({ error: { code: 'bad_request', detail: 'Invalid request.', errors } });
    expect(reason).toContain('items[19].price_id');
    expect(reason).not.toContain('items[20].price_id');
    expect(reason).toContain('+4 more');
    expect(reason).not.toContain('x'.repeat(201));
    expect(reason.length).toBeLessThan(20 * 320);
  });

  it('shows every field error of a typical oneOf rejection', () => {
    const errors = [
      { field: 'items.0', message: 'Must validate one and only one schema (oneOf)' },
      { field: 'items.0', message: 'price is required' },
      { field: 'items.0', message: 'price_id is required' },
      { field: 'items.0.price_id', message: 'Does not match pattern' },
      { field: 'items.0.price_id', message: 'Invalid type' },
      { field: 'items.0.quantity', message: 'Must be at most 1' },
    ];
    const reason = paddleErrorReason({ error: { code: 'bad_request', detail: 'Invalid request.', errors } });
    expect(reason).toContain('items.0.quantity: Must be at most 1');
    expect(reason).not.toContain('more');
  });

  it('logs the shape of a refused checkout body without the key or the buyer', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(400, { error: { code: 'bad_request' } })));
      const price = { priceId: VALID, priceMinor: 799, regularPriceMinor: 1500 };
      await expect(createCheckoutTransaction(config, { kind: 'pack', quantity: 3 }, BUYER, price)).rejects.toBeInstanceOf(PaddleError);
      const line = String(log.mock.calls[0]![0]);
      const shape = JSON.parse(line.slice(line.indexOf('sent ') + 5));
      expect(shape).toEqual({
        items: [{ price_id: VALID, price_id_type: 'string', price_id_length: 30, price_id_valid: true, quantity: 3 }],
        discount: true,
        currency_code: 'USD',
        checkout_url: 'https://re0.io/checkout',
        custom_data_keys: ['re0_user_id', 're0_kind'],
      });
      for (const secret of ['Authorization', 'Bearer', API_KEY, config.webhookSecret, BUYER]) expect(line).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });

  it('flags a malformed or missing price ID in the logged shape', () => {
    const body = checkoutTransactionBody(config, { kind: 'plan', quantity: 1 }, BUYER);
    expect(checkoutBodyShape(body)).toMatchObject({
      items: [{ price_id: 'pri_plan', price_id_length: 8, price_id_valid: false, quantity: 1 }],
      discount: false,
      currency_code: null,
    });
    const missing = { ...body, items: [{ price_id: undefined as unknown as string, quantity: 1 }] };
    expect(checkoutBodyShape(missing).items[0]).toEqual({ price_id: null, price_id_type: 'undefined', price_id_length: null, price_id_valid: false, quantity: 1 });
  });

  it('does not log a checkout that succeeds', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(201, { data: { id: 'txn_1' } })));
    expect(await createCheckoutTransaction(config, { kind: 'plan', quantity: 1 }, BUYER)).toEqual({ id: 'txn_1' });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('tolerates malformed error bodies', () => {
    expect(paddleErrorReason(null)).toBe('');
    expect(paddleErrorReason('oops')).toBe('');
    expect(paddleErrorReason({ error: { errors: [null, 7, { field: 'a' }, { message: 'b' }] } })).toBe('[?; ?; a; b]');
    expect(paddleErrorReason({ error: { code: { nested: true } }, meta: { request_id: 42 } })).toBe('');
  });
});
