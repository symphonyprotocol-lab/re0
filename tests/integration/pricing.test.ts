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
  planPriceId: 'pri_pricing_original_plan',
  packPriceId: 'pri_pricing_original_pack',
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
const provision = vi.fn(async () => `pri_${randomUUID().replaceAll('-', '')}`);
const deps = { config, provision, now };
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
  it('credits historical prices after a new regular price is published', async () => {
    const old = await checkoutPrice(db(), config, 'plan', now);
    await savePricing(owner, 'plan', { priceMinor: 2000, promotion: null, revision }, deps);
    const userId = await buyer();
    const transactionId = `txn_${randomUUID()}`,
      subscriptionId = `sub_${randomUUID()}`;
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
    expect(purchase).toMatchObject({ amountMinor: 1500, credits: 100_000 });
  });
  it('retains promotional payment snapshots for a missing webhook total', async () => {
    const price = await savePricing(owner, 'pack', input, deps);
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
    expect(purchase).toMatchObject({ amountMinor: 2100, credits: 300_000 });
    await savePricing(owner, 'pack', { revision: price.revision, priceMinor: 2000, promotion: null }, deps);
    expect(await pendingCheckoutPricing(userId, transactionId)).toMatchObject({
      kind: 'pack',
      quantity: 3,
      price: { priceMinor: 1500, effectivePriceMinor: 700 },
    });
    expect(await pendingCheckoutPricing(await buyer(), transactionId)).toBeNull();
  });
});
