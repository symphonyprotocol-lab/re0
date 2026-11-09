/**
 * A product ID (`pro_…`) set as PADDLE_PLAN_PRICE_ID was once saved into an
 * enabled catalogue row, which then overrode the corrected environment and
 * failed every checkout. These cover each guard against that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN } from '@/lib/constants';
import { isPaddlePriceId, paddleConfig, PaddleError, provisionPrice, verifyPrice, type PaddleConfig } from '@/lib/infra/paddle';
import { checkoutPrice, savePricing } from '@/lib/services/pricing';
import { schema, type Executor } from '@/lib/infra/db';

type Row = typeof schema.billingPrice.$inferSelect;
const store = vi.hoisted(() => ({ rows: [] as unknown[], inserts: [] as { table: unknown; values: Record<string, unknown> }[] }));
vi.mock('@/lib/infra/db', async (original) => {
  const actual = await original<typeof import('@/lib/infra/db')>();
  const tx = {
    execute: async () => ({}),
    select: () => ({ from: () => ({ where: async () => store.rows }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        store.inserts.push({ table, values });
        return Object.assign(Promise.resolve(), {
          returning: async () => [{ id: `row-${store.inserts.length}`, credits: null, promotionPriceMinor: null, enabled: true, ...values }],
        });
      },
    }),
  };
  return { ...actual, db: () => ({ ...tx, transaction: async (run: (t: typeof tx) => unknown) => run(tx) }) };
});

const id = (tag: string) => `pri_${tag.padEnd(26, '0')}`;
const PLAN_ID = id('01envplan');
const PACK_ID = id('01envpack');
const PRODUCT_ID = 'pro_01jcproduct0000000000000000';
const config: PaddleConfig = {
  apiKey: 'test',
  webhookSecret: 'test',
  clientToken: 'test',
  planPriceId: PLAN_ID,
  packPriceId: PACK_ID,
  environment: 'production',
  checkoutUrl: 'http://localhost/checkout',
};
const env = {
  PADDLE_API_KEY: 'k',
  PADDLE_WEBHOOK_SECRET: 's',
  PADDLE_CLIENT_TOKEN: 't',
  PADDLE_PLAN_PRICE_ID: PLAN_ID,
  PADDLE_PACK_PRICE_ID: PACK_ID,
  APP_BASE_URL: 'https://re0.example',
} as unknown as NodeJS.ProcessEnv;
function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'row-old',
    environment: 'production',
    kind: 'plan',
    priceMinor: PLAN.priceMinor,
    credits: 50_000,
    paddlePriceId: id('01stored'),
    promotionPriceMinor: null,
    promotionStartsAt: null,
    promotionEndsAt: null,
    enabled: true,
    updatedBy: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const paddlePrice = (overrides: Record<string, unknown> = {}) => ({
  id: PLAN_ID,
  status: 'active',
  product_id: PRODUCT_ID,
  tax_mode: 'account_setting',
  unit_price: { amount: String(PLAN.priceMinor), currency_code: 'USD' },
  billing_cycle: { interval: 'month', frequency: 1 },
  quantity: { minimum: 1, maximum: 1 },
  ...overrides,
});
const catalogueInserts = () => store.inserts.filter((i) => i.table === schema.billingPrice).map((i) => i.values);
let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

beforeEach(() => {
  store.rows = [];
  store.inserts = [];
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Paddle price ID format', () => {
  it('accepts only pri_ followed by 26 lowercase letters or digits', () => {
    expect(isPaddlePriceId(PLAN_ID)).toBe(true);
    for (const bad of [PRODUCT_ID, 'pri_plan', `${PLAN_ID}0`, PLAN_ID.toUpperCase(), ` ${PLAN_ID}`, '', null, undefined])
      expect(isPaddlePriceId(bad)).toBe(false);
  });

  it('disables payments for a product ID in PADDLE_PLAN_PRICE_ID and names the variable, not the value', () => {
    expect(paddleConfig({ ...env, PADDLE_PLAN_PRICE_ID: PRODUCT_ID })).toBeNull();
    expect(logged()).toContain('PADDLE_PLAN_PRICE_ID');
    expect(logged()).toContain('"pro_"');
    expect(logged()).not.toContain(PRODUCT_ID);
  });

  it('checks PADDLE_PACK_PRICE_ID too, and keeps a valid configuration', () => {
    expect(paddleConfig({ ...env, PADDLE_PACK_PRICE_ID: 'pri_pack' })).toBeNull();
    expect(logged()).toContain('PADDLE_PACK_PRICE_ID');
    expect(logged()).not.toContain('PADDLE_PLAN_PRICE_ID');
    errors.mockClear();
    expect(paddleConfig(env)).toMatchObject({ planPriceId: PLAN_ID, packPriceId: PACK_ID });
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('verifyPrice', () => {
  it('passes an active monthly USD Plan price', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply(200, { data: paddlePrice() }));
    vi.stubGlobal('fetch', fetch);
    expect(await verifyPrice(config, 'plan', PLAN_ID)).toBeNull();
    expect(String(fetch.mock.calls[0]![0])).toBe(`https://api.paddle.com/prices/${PLAN_ID}`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('never sends a malformed ID to Paddle', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await verifyPrice(config, 'plan', PRODUCT_ID)).toMatch(/not a Paddle price ID/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports archived prices, prices on the wrong cycle and prices Paddle does not know', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(200, { data: paddlePrice({ status: 'archived' }) }))
      .mockResolvedValueOnce(reply(200, { data: paddlePrice({ billing_cycle: null }) }))
      .mockResolvedValueOnce(reply(200, { data: paddlePrice() }))
      .mockResolvedValueOnce(reply(404, { error: { code: 'entity_not_found' } })));
    expect(await verifyPrice(config, 'plan', PLAN_ID)).toMatch(/archived/);
    expect(await verifyPrice(config, 'plan', PLAN_ID)).toMatch(/monthly/);
    expect(await verifyPrice(config, 'pack', PACK_ID)).toMatch(/recurring/);
    expect(await verifyPrice(config, 'plan', PLAN_ID)).toMatch(/404/);
  });

  it('throws when Paddle is unavailable rather than calling the price bad', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(503, { error: { code: 'service_unavailable' } })));
    await expect(verifyPrice(config, 'plan', PLAN_ID)).rejects.toBeInstanceOf(PaddleError);
  });
});

describe('provisionPrice', () => {
  it('refuses a malformed source ID without calling Paddle', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(provisionPrice(config, 'plan', 2000, PRODUCT_ID)).rejects.toBeInstanceOf(PaddleError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates a new version instead of reusing an archived price of the same amount', async () => {
    const created = id('01created');
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(200, { data: paddlePrice({ status: 'archived' }) }))
      .mockResolvedValueOnce(reply(201, { data: { id: created } }));
    vi.stubGlobal('fetch', fetch);
    expect(await provisionPrice(config, 'plan', PLAN.priceMinor, PLAN_ID)).toBe(created);
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  });
});

describe('savePricing keeps only verified Paddle prices', () => {
  const unchanged = { revision: 'default', priceMinor: PLAN.priceMinor, credits: 60_000, promotion: null };

  it('verifies the environment price before storing it unchanged', async () => {
    const verify = vi.fn(async () => null);
    const provision = vi.fn();
    await savePricing('admin', 'plan', unchanged, { config, verify, provision });
    expect(verify).toHaveBeenCalledWith(config, 'plan', PLAN_ID);
    expect(provision).not.toHaveBeenCalled();
    expect(catalogueInserts()).toEqual([expect.objectContaining({ paddlePriceId: PLAN_ID, credits: 60_000 })]);
  });

  it('refuses to store a price Paddle rejects', async () => {
    const verify = vi.fn(async () => 'Paddle answered 404');
    await expect(savePricing('admin', 'plan', unchanged, { config, verify })).rejects.toMatchObject({ code: 'invalid_paddle_price' });
    expect(catalogueInserts()).toEqual([]);
    expect(logged()).toContain('PADDLE_PLAN_PRICE_ID');
  });

  it('names the catalogue row when its own price fails verification', async () => {
    store.rows = [row()];
    await expect(savePricing('admin', 'plan', { ...unchanged, revision: 'row-old' }, { config, verify: async () => 'status is archived' }))
      .rejects.toMatchObject({ code: 'invalid_paddle_price' });
    expect(logged()).toContain('billing_price row-old');
  });

  it('replaces a stored product ID with the environment price when the amount is unchanged', async () => {
    store.rows = [row({ paddlePriceId: PRODUCT_ID })];
    const verify = vi.fn(async () => null);
    await savePricing('admin', 'plan', { ...unchanged, revision: 'row-old' }, { config, verify });
    expect(verify).toHaveBeenCalledWith(config, 'plan', PLAN_ID);
    expect(catalogueInserts().at(-1)).toMatchObject({ paddlePriceId: PLAN_ID });
  });

  it('provisions from the environment price, not a stored product ID, when the amount changes', async () => {
    store.rows = [row({ paddlePriceId: PRODUCT_ID })];
    const created = id('01created');
    const provision = vi.fn(async () => created);
    await savePricing('admin', 'plan', { ...unchanged, revision: 'row-old', priceMinor: 2000 }, { config, provision, verify: vi.fn() });
    expect(provision).toHaveBeenCalledWith(config, 'plan', 2000, PLAN_ID);
    expect(catalogueInserts().at(-1)).toMatchObject({ paddlePriceId: created });
  });

  it('never stores a malformed ID a provisioning call returned, and archives it', async () => {
    const archive = vi.fn(async () => {});
    await expect(savePricing('admin', 'plan', { ...unchanged, priceMinor: 2000 }, { config, provision: async () => 'pri_short', archive }))
      .rejects.toBeInstanceOf(PaddleError);
    expect(catalogueInserts()).toEqual([]);
    expect(archive).toHaveBeenCalledWith(config, 'pri_short');
  });
});

describe('checkoutPrice', () => {
  const executor = () => ({ select: () => ({ from: () => ({ where: async () => store.rows }) }) }) as unknown as Executor;
  const now = new Date('2026-11-09T00:00:00Z');

  it('charges the catalogue row price, or the environment price without one', async () => {
    expect((await checkoutPrice(executor(), config, 'plan', now)).priceId).toBe(PLAN_ID);
    store.rows = [row()];
    expect((await checkoutPrice(executor(), config, 'plan', now)).priceId).toBe(id('01stored'));
    expect(errors).not.toHaveBeenCalled();
  });

  it('falls back to the environment price for a row holding an invalid ID, and logs the row', async () => {
    store.rows = [row({ paddlePriceId: PRODUCT_ID, credits: 65_000 })];
    expect(await checkoutPrice(executor(), config, 'plan', now)).toMatchObject({ priceId: PLAN_ID, credits: 65_000, revision: 'row-old' });
    expect(logged()).toContain('billing_price row-old');
    expect(logged()).toContain('PADDLE_PLAN_PRICE_ID');
    expect(logged()).not.toContain(PRODUCT_ID);
  });
});
