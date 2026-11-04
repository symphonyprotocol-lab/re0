/** Plan and Pack rules and the Paddle mechanisms (rebuild-proposal.md 2.3; prototype tests/usage.test.mjs). */
import { describe, expect, it } from 'vitest';
import {
  offsetDebts,
  pageQuantity,
  parseOrder,
  planIsActive,
  planUsage,
  reversalCredits,
  subscriptionStatusFrom,
  takeBack,
  type PlanSubscription,
} from '@/lib/domain/billing';
import { chargedFromNote, settlementNote, type SpendableGrant } from '@/lib/domain/credits';
import { checkoutTransactionBody, customUserId, minorUnits, paddleConfig, parsePaddleEvent, signPaddleBody, verifyPaddleSignature } from '@/lib/infra/paddle';
import { parseActivity } from '@/lib/http/billing';
import { safeReturnTo } from '@/lib/domain/auth';

const now = new Date('2026-11-10T00:00:00Z');
const active: PlanSubscription = {
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
};

describe('orders', () => {
  it('takes a Plan, or 1 to 10 whole Packs', () => {
    expect(parseOrder({ kind: 'plan', quantity: 7 })).toEqual({ kind: 'plan', quantity: 1 });
    expect(parseOrder({ kind: 'pack', quantity: 10 })).toEqual({ kind: 'pack', quantity: 10 });
    expect(parseOrder({ kind: 'pack', quantity: '3' })).toEqual({ kind: 'pack', quantity: 3 });
    for (const quantity of [0, 11, 2.5, -1, 'x', null]) expect(parseOrder({ kind: 'pack', quantity })).toEqual({ error: 'invalid_quantity' });
    expect(parseOrder({ kind: 'gift' })).toEqual({ error: 'invalid_kind' });
  });

  it('pulls the checkout page quantity into range, as the prototype does', () => {
    expect(pageQuantity(undefined)).toBe(1);
    expect(pageQuantity('0')).toBe(1);
    expect(pageQuantity('4')).toBe(4);
    expect(pageQuantity('99')).toBe(10);
    expect(pageQuantity('abc')).toBe(1);
  });
});

describe('the Plan', () => {
  it('maps Paddle states: paying is active, ended is cancelled, the rest grants nothing', () => {
    expect(subscriptionStatusFrom('active')).toBe('active');
    expect(subscriptionStatusFrom('trialing')).toBe('active');
    expect(subscriptionStatusFrom('canceled')).toBe('cancelled');
    expect(subscriptionStatusFrom('past_due')).toBe('expired');
    expect(subscriptionStatusFrom('paused')).toBe('expired');
  });

  it('is active inside its period, cancelled renewal included', () => {
    expect(planIsActive(active, now)).toBe(true);
    expect(planIsActive({ ...active, cancelAtPeriodEnd: true }, now)).toBe(true);
    expect(planIsActive(active, new Date('2026-12-01T00:00:01Z'))).toBe(false);
    expect(planIsActive({ ...active, status: 'expired' }, now)).toBe(false);
    expect(planIsActive(null, now)).toBe(false);
  });

  it('meters only the period’s Plan credits (prototype creditUsage)', () => {
    expect(planUsage(active, { amount: 100_000, remaining: 68_120 }, now)).toMatchObject({ allowance: 100_000, used: 31_880, remaining: 68_120, percent: 31.88, warn: false });
    expect(planUsage(active, { amount: 100_000, remaining: 0 }, now)).toMatchObject({ used: 100_000, percent: 100, active: true, warn: true });
    expect(planUsage(active, { amount: 100_000, remaining: 10_000 }, now).warn).toBe(true);
    expect(planUsage(active, { amount: 100_000, remaining: 10_001 }, now).warn).toBe(false);
    expect(planUsage({ ...active, cancelAtPeriodEnd: true }, { amount: 100_000, remaining: 50_000 }, now)).toMatchObject({ active: true, cancelAtPeriodEnd: true });
    expect(planUsage(null, null, now)).toMatchObject({ active: false, allowance: 0, used: 0, percent: 0 });
    /* Paid, but the period's payment has not arrived yet: nothing used. */
    expect(planUsage(active, null, now)).toMatchObject({ used: 0, remaining: 100_000 });
  });
});

describe('refunds', () => {
  const purchase = { credits: 400_000, amountMinor: 4_000, reversedCredits: 0 };

  it('takes back the refunded share, never more than is left', () => {
    expect(reversalCredits(purchase, 1_000)).toBe(100_000);
    expect(reversalCredits(purchase, 4_000)).toBe(400_000);
    expect(reversalCredits({ ...purchase, reversedCredits: 350_000 }, 1_000)).toBe(50_000);
    expect(reversalCredits({ ...purchase, reversedCredits: 400_000 }, 1_000)).toBe(0);
    expect(reversalCredits(purchase, Number.NaN)).toBe(0);
    /* Tax-inclusive totals on both sides: a refund of the whole charge takes everything back. */
    expect(reversalCredits({ credits: 100_000, amountMinor: 1_190, reversedCredits: 0 }, 1_190)).toBe(100_000);
  });

  const grant = (id: string, source: SpendableGrant['source'], remaining: number): SpendableGrant => ({
    id,
    source,
    remaining,
    expiresAt: source === 'plan' ? new Date('2026-12-01T00:00:00Z') : null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
  });

  it('takes from the purchase’s own grant first, then in spending order, and owes the rest', () => {
    const grants = [grant('pack', 'pack', 10_000), grant('plan', 'plan', 5_000), grant('earned', 'earned', 1_000), grant('welcome', 'welcome', 2_000)];
    expect(takeBack(grants, 'pack', 100_000, now)).toEqual({
      allocations: [
        { grantId: 'pack', source: 'pack', amount: 10_000 },
        { grantId: 'plan', source: 'plan', amount: 5_000 },
        { grantId: 'welcome', source: 'welcome', amount: 2_000 },
        { grantId: 'earned', source: 'earned', amount: 1_000 },
      ],
      shortfall: 82_000,
    });
    expect(takeBack(grants, 'pack', 4_000, now)).toEqual({ allocations: [{ grantId: 'pack', source: 'pack', amount: 4_000 }], shortfall: 0 });
  });

  it('pays debts oldest first from arriving credits', () => {
    expect(offsetDebts([{ id: 'a', remaining: 30 }, { id: 'b', remaining: 50 }], 60)).toEqual([
      { debtId: 'a', amount: 30 },
      { debtId: 'b', amount: 30 },
    ]);
    expect(offsetDebts([], 60)).toEqual([]);
  });
});

describe('Paddle', () => {
  const secret = 'pdl_ntfset_secret';

  it('verifies signatures over the exact body, within five minutes, any h1', () => {
    const body = '{"event_id":"evt_1"}';
    const header = signPaddleBody(body, secret, 1_800_000_000_000);
    expect(verifyPaddleSignature(body, header, secret, 1_800_000_000_000)).toBe(true);
    expect(verifyPaddleSignature(body + ' ', header, secret, 1_800_000_000_000)).toBe(false);
    expect(verifyPaddleSignature(body, header, 'other', 1_800_000_000_000)).toBe(false);
    expect(verifyPaddleSignature(body, header, secret, 1_800_000_000_000 + 301_000)).toBe(false);
    const rotated = `${header.split(';')[0]};h1=deadbeef;${header.split(';')[1]}`;
    expect(verifyPaddleSignature(body, rotated, secret, 1_800_000_000_000)).toBe(true);
    expect(verifyPaddleSignature(body, 'garbage', secret)).toBe(false);
  });

  it('parses events and reads our tag back', () => {
    expect(parsePaddleEvent('not json')).toBeNull();
    expect(parsePaddleEvent('{"event_id":"evt_1"}')).toBeNull();
    expect(parsePaddleEvent('{"event_id":"evt_1","event_type":"transaction.completed","data":{}}')?.event_type).toBe('transaction.completed');
    expect(customUserId({ re0_user_id: '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8' })).toBe('6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8');
    expect(customUserId({ re0_user_id: 'robert); drop table' })).toBeNull();
    expect(minorUnits('1000')).toBe(1000);
    expect(minorUnits('10.00')).toBeNaN();
  });

  it('builds the checkout transaction from catalogue prices and tags the buyer', () => {
    const config = paddleConfig({
      PADDLE_API_KEY: 'k',
      PADDLE_WEBHOOK_SECRET: 's',
      PADDLE_CLIENT_TOKEN: 't',
      PADDLE_PLAN_PRICE_ID: 'pri_plan',
      PADDLE_PACK_PRICE_ID: 'pri_pack',
      PADDLE_ENVIRONMENT: 'sandbox',
      APP_BASE_URL: 'http://localhost:3000',
      PADDLE_CHECKOUT_BASE_URL: 'https://tunnel.example/',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(config.environment).toBe('sandbox');
    expect(config.checkoutUrl).toBe('https://tunnel.example/checkout');
    expect(checkoutTransactionBody(config, { kind: 'pack', quantity: 3 }, 'user-1')).toEqual({
      items: [{ price_id: 'pri_pack', quantity: 3 }],
      custom_data: { re0_user_id: 'user-1', re0_kind: 'pack' },
      checkout: { url: 'https://tunnel.example/checkout' },
    });
    expect(paddleConfig({ PADDLE_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('settlement notes', () => {
  it('keep the caller’s label and let the ledger read the charge back', () => {
    expect(settlementNote('Handbook.pdf', 15, 20)).toBe('Handbook.pdf · charged 15 of 20');
    expect(settlementNote(null, 0, 20)).toBe('charged 0 of 20');
    expect(chargedFromNote('Handbook.pdf · charged 15 of 20')).toBe(15);
    expect(chargedFromNote('charged 0 of 20')).toBe(0);
    expect(chargedFromNote('Handbook.pdf')).toBeNull();
    expect(chargedFromNote('a title that says charged 9 of 9 somewhere · x')).toBeNull();
  });
});

describe('pages', () => {
  it('reads the ledger filter from the URL', () => {
    expect(parseActivity(new URLSearchParams('activity=spend&page=3&size=50'), [20, 50, 100])).toMatchObject({ activity: 'spend', page: 3, size: 50, period: 'all', q: '' });
    expect(parseActivity(new URLSearchParams('activity=bogus&page=-2&size=7'), [20, 50, 100])).toMatchObject({ activity: 'all', page: 1, size: 20, period: 'all', q: '' });
  });

  it('normalizes reporting dates and search terms for both the page and API', () => {
    const now = new Date('2026-11-04T04:00:00Z');
    expect(parseActivity(new URLSearchParams('period=custom&start=2026-11-03&end=2026-11-01&q=%20Handbook%20'), [20, 50], now))
      .toMatchObject({ period: 'custom', start: '2026-11-01', end: '2026-11-03', q: 'Handbook' });
    expect(parseActivity(new URLSearchParams('period=day&date=broken'), [20], now))
      .toMatchObject({ period: 'day', date: '2026-11-04' });
  });

  it('lets sign-in return to checkout with its query', () => {
    expect(safeReturnTo('/checkout?kind=pack&quantity=3')).toBe('/checkout?kind=pack&quantity=3');
    expect(safeReturnTo('/billing')).toBe('/billing');
  });
});
