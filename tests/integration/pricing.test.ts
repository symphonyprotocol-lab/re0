import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { db, schema } from '@/lib/infra/db';
import { savePricing, checkoutPrice, pendingCheckoutPricing } from '@/lib/services/pricing';
import { startCheckout, applyPaddleEvent } from '@/lib/services/billing';
import { createSession } from '@/lib/services/auth';
import type { PaddleConfig, CheckoutPrice } from '@/lib/infra/paddle';
import type { CheckoutOrder } from '@/lib/domain/billing';

const config: PaddleConfig = {
  apiKey: 'test',
  webhookSecret: 'test',
  clientToken: 'test',
  planPriceId: 'pri_01pricingplan0000000000000',
  packPriceId: 'pri_01pricingpack0000000000000',
  environment: 'sandbox',
  checkoutUrl: 'http://localhost/checkout',
};
const now = new Date('2026-11-10T00:00:00Z');
const later = new Date('2026-11-11T00:00:00Z');
const input = {
  revision: 'default',
  priceMinor: 1500,
  promotion: { priceMinor: 700, startsAt: now.toISOString(), endsAt: later.toISOString() },
};
let owner: string;
let revision: string;
const priceId = () => `pri_${randomUUID().replaceAll('-', '').slice(0, 26)}`;
const provision = vi.fn(async () => priceId());
const verify = vi.fn(async () => null);
const deps = { config, provision, verify, now };
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
async function buyer() {
  const subject = uniqueName('pricing');
  return (
    await createSession(
      { provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'Buyer', avatarUrl: null },
      'zh',
      '/dashboard',
    )
  ).userId;
}

describeWithDb('admin pricing and checkout', () => {
  beforeAll(async () => {
    await db().delete(schema.billingPrice);
    const [admin] = await db()
      .insert(schema.administrator)
      .values({
        email: `${uniqueName('pricing-admin')}@example.test`,
        name: 'Pricing admin',
        role: 'owner',
        passwordHash: 'test',
        totpSecretCipher: 'test',
      })
      .returning();
    owner = admin!.id;
  });
  afterAll(async () => {
    await db().delete(schema.billingPrice);
  });
  it('persists an audited schedule and retains the original price ID', async () => {
    const result = await savePricing(owner, 'plan', input, deps);
    revision = result.revision;
    expect(result).toMatchObject({ effectivePriceMinor: 700, promotional: true, priceMinor: 1500 });
    expect(await checkoutPrice(db(), config, 'plan', later)).toMatchObject({ priceMinor: 1500, promotional: false });
    const rows = await db().select().from(schema.billingPrice).where(eq(schema.billingPrice.kind, 'plan'));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => !r.enabled)?.paddlePriceId).toBe(config.planPriceId);
    expect(
      await db()
        .select()
        .from(schema.adminAudit)
        .where(and(eq(schema.adminAudit.administratorId, owner), eq(schema.adminAudit.action, 'pricing.update'))),
    ).toHaveLength(1);
  });
  it('rejects stale admin writes and rolls back provider failures', async () => {
    const count = provision.mock.calls.length;
    await expect(savePricing(owner, 'plan', input, deps)).rejects.toMatchObject({ code: 'pricing_conflict' });
    expect(provision).toHaveBeenCalledTimes(count);
    await expect(
      savePricing(
        owner,
        'plan',
        { ...input, revision, priceMinor: 1700 },
        {
          ...deps,
          provision: async () => {
            throw new Error('provider unavailable');
          },
        },
      ),
    ).rejects.toThrow('provider unavailable');
    expect(await checkoutPrice(db(), config, 'plan', now)).toMatchObject({ priceMinor: 700, revision });
  });
  it('archives a newly created Paddle price when its catalogue row cannot be saved', async () => {
    const created = priceId();
    const archive = vi.fn(async () => {});
    // An administrator that does not exist fails the row's foreign key after Paddle has the price.
    await expect(savePricing(randomUUID(), 'plan', { ...input, revision, priceMinor: 1900 }, { ...deps, provision: async () => created, archive })).rejects.toThrow();
    expect(archive).toHaveBeenCalledWith(config, created);
    expect(await checkoutPrice(db(), config, 'plan', now)).toMatchObject({ revision });
    const before = archive.mock.calls.length;
    await expect(savePricing(owner, 'plan', { ...input, revision: 'stale' }, { ...deps, archive })).rejects.toMatchObject({ code: 'pricing_conflict' });
    expect(archive).toHaveBeenCalledTimes(before);
  });
  it('blocks stale page quotes and cancels an old Plan checkout before replacing it', async () => {
    const userId = await buyer();
    const create = vi.fn(async (_config: PaddleConfig, _order: CheckoutOrder, _user: string, _price?: CheckoutPrice) => ({
      id: `txn_${randomUUID()}`,
    }));
    const cancel = vi.fn(async () => {});
    const quote = await checkoutPrice(db(), config, 'plan', now);
    const first = await startCheckout(userId, { kind: 'plan', consent: true, quoteKey: quote.quoteKey }, { config, create, now });
    expect(first.ok).toBe(true);
    expect(create.mock.calls[0]![3]).toMatchObject({ priceMinor: 700, regularPriceMinor: 1500 });
    // A boundary within the reuse window exercises replacement, rather than normal expiration.
    const endSoon = new Date(now.getTime() + 10 * 60_000);
    const changed = await savePricing(
      owner,
      'plan',
      { ...input, revision, promotion: { ...input.promotion, endsAt: endSoon.toISOString() } },
      deps,
    );
    revision = changed.revision;
    expect(await startCheckout(userId, { kind: 'plan', consent: true, quoteKey: quote.quoteKey }, { config, create, now })).toEqual({
      ok: false,
      error: 'price_changed',
    });
    const current = await checkoutPrice(db(), config, 'plan', endSoon);
    await startCheckout(userId, { kind: 'plan', consent: true, quoteKey: current.quoteKey }, { config, create, cancel, now: endSoon });
    expect(cancel).toHaveBeenCalledWith(config, first.ok ? first.transactionId : '');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![3]).toMatchObject({ priceMinor: 1500, regularPriceMinor: 1500 });
  });
  it('keeps a Paddle cancellation recorded when creating its replacement fails', async () => {
    const userId = await buyer();
    const staleId = `txn_${randomUUID()}`;
    await db().insert(schema.paddleCheckout).values({ paddleTransactionId: staleId, userId, kind: 'plan', quantity: 1, priceKey: 'stale:regular', createdAt: now });
    const quote = await checkoutPrice(db(), config, 'plan', now);
    const cancel = vi.fn(async () => {});
    const failing = vi.fn(async () => {
      throw new Error('paddle unavailable');
    });
    await expect(startCheckout(userId, { kind: 'plan', consent: true, quoteKey: quote.quoteKey }, { config, create: failing, cancel, now })).rejects.toThrow('paddle unavailable');
    const [stale] = await db().select().from(schema.paddleCheckout).where(eq(schema.paddleCheckout.paddleTransactionId, staleId));
    expect(stale!.supersededAt).not.toBeNull();
    const replacement = `txn_${randomUUID()}`;
    const retried = await startCheckout(userId, { kind: 'plan', consent: true, quoteKey: quote.quoteKey }, { config, create: async () => ({ id: replacement }), cancel, now });
    expect(retried).toMatchObject({ ok: true, transactionId: replacement });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('honors the first checkout quote and uses the new allowance on renewal at the historical price', async () => {
    const old = await checkoutPrice(db(), config, 'plan', now);
    const userId = await buyer();
    const transactionId = `txn_${randomUUID()}`,
      subscriptionId = `sub_${randomUUID()}`;
    const checkout = await startCheckout(userId, { kind: 'plan', consent: true, quoteKey: old.quoteKey }, {
      config, create: async () => ({ id: transactionId }), now,
    });
    expect(checkout.ok).toBe(true);
    const calls = provision.mock.calls.length;
    const changed = await savePricing(owner, 'plan', { priceMinor: 1500, credits: 65_000, promotion: old.promotion, revision }, deps);
    expect(changed.credits).toBe(65_000);
    expect(changed.quoteKey).not.toBe(old.quoteKey);
    expect(provision).toHaveBeenCalledTimes(calls);
    await savePricing(owner, 'plan', { priceMinor: 2000, promotion: null, revision: changed.revision }, deps);
    expect(
      await applyPaddleEvent(
        {
          event_id: `evt_${randomUUID()}`,
          event_type: 'subscription.created',
          occurred_at: now.toISOString(),
          data: {
            id: subscriptionId,
            status: 'active',
            items: [{ price: { id: old.priceId } }],
            custom_data: { re0_user_id: userId },
            current_billing_period: { starts_at: now.toISOString(), ends_at: later.toISOString() },
          },
        },
        config,
        now,
      ),
    ).toBe('subscription');
    expect(
      await applyPaddleEvent(
        {
          event_id: `evt_${randomUUID()}`,
          event_type: 'transaction.paid',
          occurred_at: now.toISOString(),
          data: {
            id: transactionId,
            subscription_id: subscriptionId,
            items: [{ price: { id: old.priceId }, quantity: 1 }],
            custom_data: { re0_user_id: userId },
            details: { totals: { grand_total: '1500' } },
          },
        },
        config,
        now,
      ),
    ).toBe('credited');
    const [purchase] = await db().select().from(schema.purchase).where(eq(schema.purchase.paddleTransactionId, transactionId));
    expect(purchase).toMatchObject({ amountMinor: 1500, credits: 50_000 });
    expect(await pendingCheckoutPricing(userId, transactionId)).toMatchObject({ price: { credits: 50_000 } });

    const renewalId = `txn_${randomUUID()}`;
    const periodEnd = new Date(later.getTime() + 30 * 86400_000);
    expect(await applyPaddleEvent({
      event_id: `evt_${randomUUID()}`,
      event_type: 'transaction.paid',
      occurred_at: later.toISOString(),
      data: {
        id: renewalId,
        subscription_id: subscriptionId,
        items: [{ price: { id: old.priceId }, quantity: 1 }],
        billing_period: { starts_at: later.toISOString(), ends_at: periodEnd.toISOString() },
        details: { totals: { grand_total: '1500' } },
      },
    }, config, later)).toBe('credited');
    const [renewal] = await db().select().from(schema.purchase).where(eq(schema.purchase.paddleTransactionId, renewalId));
    expect(renewal).toMatchObject({ amountMinor: 1500, credits: 65_000 });
  });
  it('retains promotional payment snapshots for a missing webhook total', async () => {
    const price = await savePricing(owner, 'pack', { ...input, credits: 60_000 }, deps);
    const userId = await buyer();
    await db()
      .insert(schema.subscription)
      .values({ userId, paddleSubscriptionId: `sub_${randomUUID()}`, status: 'active', currentPeriodStart: now, currentPeriodEnd: later });
    const create = vi.fn(async (_config: PaddleConfig, _order: CheckoutOrder, _user: string, _price?: CheckoutPrice) => ({
      id: `txn_${randomUUID()}`,
    }));
    const checkout = await startCheckout(
      userId,
      { kind: 'pack', quantity: 3, consent: true, quoteKey: price.quoteKey },
      { config, create, now },
    );
    expect(checkout.ok).toBe(true);
    const quote = create.mock.calls[0]![3]!;
    const transactionId = checkout.ok ? checkout.transactionId : '';
    await savePricing(owner, 'pack', { revision: price.revision, priceMinor: 2000, credits: 70_000, promotion: null }, deps);
    await applyPaddleEvent(
      {
        event_id: `evt_${randomUUID()}`,
        event_type: 'transaction.paid',
        occurred_at: later.toISOString(),
        data: {
          id: transactionId,
          items: [{ price: { id: quote.priceId }, quantity: 3 }],
          custom_data: { re0_user_id: userId },
          details: null,
        },
      },
      config,
      later,
    );
    const [purchase] = await db().select().from(schema.purchase).where(eq(schema.purchase.paddleTransactionId, transactionId));
    expect(purchase).toMatchObject({ amountMinor: 2100, credits: 180_000 });
    expect(await pendingCheckoutPricing(userId, transactionId)).toMatchObject({
      kind: 'pack',
      quantity: 3,
      price: { priceMinor: 1500, effectivePriceMinor: 700, credits: 60_000 },
    });
    expect(await pendingCheckoutPricing(await buyer(), transactionId)).toBeNull();
  });
  it('uses the new allowance for legacy catalogue prices while preserving legacy checkout quotes', async () => {
    const legacyConfig = { ...config, environment: 'production' as const };
    await db().insert(schema.billingPrice).values({
      environment: legacyConfig.environment, kind: 'plan', priceMinor: 1000, paddlePriceId: config.planPriceId,
    });
    expect(await checkoutPrice(db(), legacyConfig, 'plan', now)).toMatchObject({ priceMinor: 1000, credits: 50_000 });

    const userId = await buyer();
    const transactionId = `txn_${randomUUID()}`;
    await db().insert(schema.paddleCheckout).values({
      paddleTransactionId: transactionId, userId, kind: 'plan', quantity: 1, createdAt: now,
    });
    expect(await pendingCheckoutPricing(userId, transactionId)).toMatchObject({ price: { credits: 100_000 } });
  });
  it('charges the environment price over a stored product ID and replaces it on a verified save', async () => {
    const production = { ...config, environment: 'production' as const };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [bad] = await db().insert(schema.billingPrice).values({
      environment: 'production', kind: 'pack', priceMinor: 1000, paddlePriceId: 'pro_01jcproduct0000000000000000',
    }).returning();
    expect(await checkoutPrice(db(), production, 'pack', now)).toMatchObject({ priceId: config.packPriceId, revision: bad!.id });
    const settings = { revision: bad!.id, priceMinor: 1000, credits: 90_000, promotion: null };
    await expect(savePricing(owner, 'pack', settings, { ...deps, config: production, verify: async () => 'Paddle answered 404' }))
      .rejects.toMatchObject({ code: 'invalid_paddle_price' });
    const saved = await savePricing(owner, 'pack', settings, { ...deps, config: production });
    expect(verify).toHaveBeenLastCalledWith(production, 'pack', config.packPriceId);
    const [current] = await db().select().from(schema.billingPrice).where(and(
      eq(schema.billingPrice.environment, 'production'), eq(schema.billingPrice.kind, 'pack'), eq(schema.billingPrice.enabled, true),
    ));
    expect(current).toMatchObject({ id: saved.revision, paddlePriceId: config.packPriceId, credits: 90_000 });
    errors.mockRestore();
  });
});
