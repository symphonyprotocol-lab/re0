/** Redeem code rules (docs/design/redeem-codes.md): format, batch settings, a redeemed Plan's months and where it starts, and the Plan state. */
import { describe, expect, it } from 'vitest';
import { REDEEM } from '@/lib/constants';
import { addMonths, planStateFrom, planUsage, redeemedPeriod, redeemedPeriodIndexAt, type PlanSubscription } from '@/lib/domain/billing';
import {
  batchCredits,
  batchPhase,
  codeLast4,
  displayCode,
  normalizeCode,
  parseBatchInput,
  parseBatchUpdate,
  randomCode,
  redeemedPlanEnd,
  redeemedPlanStart,
} from '@/lib/domain/redeem';

const now = new Date('2026-11-10T08:00:00Z');
const DAY = 86_400_000;

describe('the code', () => {
  it('draws only from the alphabet, at the given length', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = randomCode();
      expect(code).toHaveLength(REDEEM.randomLength);
      expect([...code].every((char) => REDEEM.alphabet.includes(char))).toBe(true);
    }
    expect(REDEEM.alphabet).not.toMatch(/[0O1ILU]/);
  });

  it('throws away bytes past the last full alphabet so no character is favoured', () => {
    /* 240..255 are discarded for a 30-character alphabet; 0 and 30 both map to "A". */
    const bytes = [255, 240, 0, 30, 29, 250, 59];
    let at = 0;
    const code = randomCode(4, (buffer) => {
      for (let i = 0; i < buffer.length; i += 1) buffer[i] = bytes[at++ % bytes.length]!;
    });
    expect(code).toBe(`AA${REDEEM.alphabet[29]}${REDEEM.alphabet[29]}`);
  });

  it('is spread evenly over the alphabet', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 3_000; i += 1) for (const char of randomCode()) counts.set(char, (counts.get(char) ?? 0) + 1);
    const expected = (3_000 * REDEEM.randomLength) / REDEEM.alphabet.length;
    expect(counts.size).toBe(REDEEM.alphabet.length);
    for (const count of counts.values()) expect(Math.abs(count - expected) / expected).toBeLessThan(0.15);
  });

  it('shows in groups of four behind an optional prefix', () => {
    expect(displayCode('7KQ2M9XART4H')).toBe('7KQ2-M9XA-RT4H');
    expect(displayCode('7KQ2M9XART4H', 'SPRING')).toBe('SPRING-7KQ2-M9XA-RT4H');
  });

  it('normalises what users type: case, spaces, dashes, full width', () => {
    expect(normalizeCode('spring-7kq2-m9xa-rt4h')).toBe('SPRING7KQ2M9XART4H');
    expect(normalizeCode(' 7KQ2 M9XA RT4H ')).toBe('7KQ2M9XART4H');
    expect(normalizeCode('７ＫＱ２－Ｍ９ＸＡ－ＲＴ４Ｈ')).toBe('7KQ2M9XART4H');
    expect(normalizeCode('7KQ2—M9XA—RT4H')).toBe('7KQ2M9XART4H');
    expect(normalizeCode('re0launch')).toBe('RE0LAUNCH');
  });

  it('refuses what cannot be a code', () => {
    expect(normalizeCode('ABC')).toBeNull();
    expect(normalizeCode('A'.repeat(41))).toBeNull();
    expect(normalizeCode('7KQ2*M9XA')).toBeNull();
    expect(normalizeCode('码码码码码码')).toBeNull();
    expect(normalizeCode(42)).toBeNull();
    expect(codeLast4('7KQ2M9XART4H')).toBe('RT4H');
  });
});

describe('batch settings', () => {
  const base = { name: 'Spring', kind: 'pack', packQuantity: 2, codeCount: 100 };

  it('fills in a start of now, a 90-day expiry and once per code and user', () => {
    const input = parseBatchInput(base, now);
    expect(input).toMatchObject({ name: 'Spring', kind: 'pack', packQuantity: 2, planMonths: null, codeCount: 100, maxRedemptions: 1, perUserLimit: 1, prefix: null, customCode: null });
    if ('error' in input) throw new Error(input.error);
    expect(input.startsAt).toEqual(now);
    expect(input.expiresAt).toEqual(new Date(now.getTime() + 90 * DAY));
  });

  it('takes a Plan of 1–12 months and a Pack of 1–10', () => {
    expect(parseBatchInput({ ...base, kind: 'plan', planMonths: 3 }, now)).toMatchObject({ kind: 'plan', planMonths: 3, packQuantity: null });
    expect(parseBatchInput({ ...base, kind: 'plan', planMonths: 13 }, now)).toEqual({ error: 'invalid_target' });
    expect(parseBatchInput({ ...base, kind: 'plan' }, now)).toEqual({ error: 'invalid_target' });
    expect(parseBatchInput({ ...base, packQuantity: 11 }, now)).toEqual({ error: 'invalid_target' });
    expect(parseBatchInput({ ...base, kind: 'gift' }, now)).toEqual({ error: 'invalid_kind' });
  });

  it('checks the name, the count and the limits', () => {
    expect(parseBatchInput({ ...base, name: '  ' }, now)).toEqual({ error: 'invalid_name' });
    expect(parseBatchInput({ ...base, name: 'x'.repeat(81) }, now)).toEqual({ error: 'invalid_name' });
    expect(parseBatchInput({ ...base, note: 'x'.repeat(501) }, now)).toEqual({ error: 'invalid_note' });
    expect(parseBatchInput({ ...base, codeCount: 0 }, now)).toEqual({ error: 'invalid_count' });
    expect(parseBatchInput({ ...base, codeCount: 10_001 }, now)).toEqual({ error: 'invalid_count' });
    expect(parseBatchInput({ ...base, codeCount: 1.5 }, now)).toEqual({ error: 'invalid_count' });
    expect(parseBatchInput({ ...base, maxRedemptions: 0 }, now)).toEqual({ error: 'invalid_limits' });
    expect(parseBatchInput({ ...base, perUserLimit: 0 }, now)).toEqual({ error: 'invalid_limits' });
    /* Unlimited uses only for a batch of one code. */
    expect(parseBatchInput({ ...base, maxRedemptions: null }, now)).toEqual({ error: 'invalid_limits' });
    expect(parseBatchInput({ ...base, codeCount: 1, maxRedemptions: null }, now)).toMatchObject({ codeCount: 1, maxRedemptions: null });
    expect(parseBatchInput({ ...base, codeCount: '5', maxRedemptions: '3', perUserLimit: '2' }, now)).toMatchObject({ codeCount: 5, maxRedemptions: 3, perUserLimit: 2 });
  });

  it('takes a prefix, or a custom code for a batch of one', () => {
    expect(parseBatchInput({ ...base, prefix: 'spring' }, now)).toMatchObject({ prefix: 'SPRING' });
    expect(parseBatchInput({ ...base, prefix: 'S' }, now)).toEqual({ error: 'invalid_prefix' });
    expect(parseBatchInput({ ...base, prefix: 'SPRING-26' }, now)).toEqual({ error: 'invalid_prefix' });
    expect(parseBatchInput({ ...base, codeCount: 1, maxRedemptions: 500, customCode: 're0-launch' }, now)).toMatchObject({ customCode: 'RE0LAUNCH' });
    expect(parseBatchInput({ ...base, customCode: 'RE0LAUNCH' }, now)).toEqual({ error: 'invalid_custom_code' });
    expect(parseBatchInput({ ...base, codeCount: 1, customCode: 'SHORT' }, now)).toEqual({ error: 'invalid_custom_code' });
    expect(parseBatchInput({ ...base, codeCount: 1, prefix: 'AB', customCode: 'RE0LAUNCH' }, now)).toEqual({ error: 'invalid_custom_code' });
  });

  it('checks the window', () => {
    const later = new Date(now.getTime() + DAY).toISOString();
    expect(parseBatchInput({ ...base, expiresAt: null }, now)).toMatchObject({ expiresAt: null });
    expect(parseBatchInput({ ...base, startsAt: later, expiresAt: now.toISOString() }, now)).toEqual({ error: 'invalid_window' });
    expect(parseBatchInput({ ...base, expiresAt: new Date(now.getTime() - DAY).toISOString() }, now)).toEqual({ error: 'invalid_window' });
    expect(parseBatchInput({ ...base, startsAt: '2026-11-11' }, now)).toEqual({ error: 'invalid_window' });
    expect(parseBatchInput({ ...base, startsAt: '2026-11-11T09:00+08:00' }, now)).toMatchObject({ startsAt: new Date('2026-11-11T01:00:00Z') });
  });

  it('snapshots credits: per month for a Plan, the total for Packs', () => {
    expect(batchCredits({ kind: 'plan', packQuantity: null }, 50_000)).toBe(50_000);
    expect(batchCredits({ kind: 'pack', packQuantity: 3 }, 100_000)).toBe(300_000);
  });

  it('edits only name, note, status and expiry', () => {
    const batch = { startsAt: now };
    expect(parseBatchUpdate({ status: 'disabled', name: ' B ', note: '' }, batch, now)).toEqual({ status: 'disabled', name: 'B', note: null });
    expect(parseBatchUpdate({ status: 'gone' }, batch, now)).toEqual({ error: 'invalid_status' });
    expect(parseBatchUpdate({ expiresAt: null }, batch, now)).toEqual({ expiresAt: null });
    expect(parseBatchUpdate({ expiresAt: now.toISOString() }, batch, now)).toEqual({ error: 'invalid_window' });
    expect(parseBatchUpdate({ kind: 'plan', codeCount: 9 }, batch, now)).toEqual({});
  });

  it('reads a batch as active, scheduled, expired or disabled', () => {
    const batch = { status: 'active' as const, startsAt: new Date(now.getTime() - DAY), expiresAt: new Date(now.getTime() + DAY) };
    expect(batchPhase(batch, now)).toBe('active');
    expect(batchPhase({ ...batch, startsAt: new Date(now.getTime() + 1) }, now)).toBe('scheduled');
    expect(batchPhase({ ...batch, expiresAt: now }, now)).toBe('expired');
    expect(batchPhase({ ...batch, expiresAt: null }, now)).toBe('active');
    expect(batchPhase({ ...batch, status: 'disabled' }, now)).toBe('disabled');
  });
});

describe('a redeemed Plan’s months', () => {
  it('adds calendar months, clamping the day to the month’s end', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1)).toEqual(new Date('2026-02-28T10:00:00Z'));
    expect(addMonths(new Date('2028-01-31T10:00:00Z'), 1)).toEqual(new Date('2028-02-29T10:00:00Z'));
    expect(addMonths(new Date('2026-11-30T00:00:00Z'), 3)).toEqual(new Date('2027-02-28T00:00:00Z'));
    expect(addMonths(new Date('2026-12-15T00:00:00Z'), 1)).toEqual(new Date('2027-01-15T00:00:00Z'));
  });

  it('counts every month from the start, so a short month does not shift the rest', () => {
    const start = new Date('2026-01-31T00:00:00Z');
    expect(redeemedPeriod(start, 1)).toEqual({ start: new Date('2026-02-28T00:00:00Z'), end: new Date('2026-03-31T00:00:00Z') });
    expect(redeemedPeriod(start, 2).end).toEqual(new Date('2026-04-30T00:00:00Z'));
    expect(redeemedPlanEnd(start, 3)).toEqual(new Date('2026-04-30T00:00:00Z'));
    const plan = { startsAt: start, endsAt: redeemedPlanEnd(start, 3), months: 3 };
    expect(redeemedPeriodIndexAt(plan, new Date('2026-02-27T23:59:59Z'))).toBe(0);
    expect(redeemedPeriodIndexAt(plan, new Date('2026-02-28T00:00:00Z'))).toBe(1);
    expect(redeemedPeriodIndexAt(plan, new Date('2026-04-29T00:00:00Z'))).toBe(2);
    expect(redeemedPeriodIndexAt(plan, new Date('2026-04-30T00:00:00Z'))).toBeNull();
    expect(redeemedPeriodIndexAt(plan, new Date('2026-01-30T00:00:00Z'))).toBeNull();
  });
});

describe('where a redeemed Plan starts', () => {
  const periodEnd = new Date('2026-12-01T00:00:00Z');

  it('starts now with nothing else in force', () => {
    expect(redeemedPlanStart([], [], now)).toEqual({ startsAt: now });
    expect(redeemedPlanStart([{ status: 'cancelled', cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd }], [], now)).toEqual({ startsAt: now });
  });

  it('follows earlier redeemed Plans', () => {
    const later = new Date('2027-02-10T00:00:00Z');
    expect(redeemedPlanStart([], [new Date('2026-12-10T00:00:00Z'), later], now)).toEqual({ startsAt: later });
    /* An ended one does not hold the start back. */
    expect(redeemedPlanStart([], [new Date('2026-10-01T00:00:00Z')], now)).toEqual({ startsAt: now });
  });

  it('waits for a Paddle period whose renewal is off', () => {
    expect(redeemedPlanStart([{ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd }], [], now)).toEqual({ startsAt: periodEnd });
    const queued = new Date('2027-01-01T00:00:00Z');
    expect(redeemedPlanStart([{ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd }], [queued], now)).toEqual({ startsAt: queued });
  });

  it('refuses a Paddle Plan that will renew, or one still being collected', () => {
    expect(redeemedPlanStart([{ status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd }], [], now)).toEqual({ error: 'plan_subscription_renewing' });
    expect(redeemedPlanStart([{ status: 'expired', cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd }], [], now)).toEqual({ error: 'plan_renewal_pending' });
  });
});

describe('the Plan state', () => {
  const paddle: PlanSubscription = {
    status: 'active',
    cancelAtPeriodEnd: true,
    currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
  };
  const redeemed = (start: string, months: number) => ({ startsAt: new Date(start), endsAt: redeemedPlanEnd(new Date(start), months), months });

  it('is Paddle’s while it is paying, with a redeemed Plan waiting behind it', () => {
    const state = planStateFrom(paddle, [redeemed('2026-12-01T00:00:00Z', 2)], now);
    expect(state).toMatchObject({ active: true, source: 'paddle', cancelAtPeriodEnd: true, periodEnd: paddle.currentPeriodEnd });
    expect(state.redeemedNext).toEqual(new Date('2026-12-01T00:00:00Z'));
    expect(state.redeemedUntil).toEqual(new Date('2027-02-01T00:00:00Z'));
  });

  it('is the redeemed Plan’s inside it, in the current month', () => {
    const state = planStateFrom(null, [redeemed('2026-10-20T08:00:00Z', 3), redeemed('2027-01-20T08:00:00Z', 1)], now);
    expect(state).toMatchObject({ active: true, source: 'redeemed', cancelAtPeriodEnd: false, redeemedNext: null });
    expect(state.periodStart).toEqual(new Date('2026-10-20T08:00:00Z'));
    expect(state.periodEnd).toEqual(new Date('2026-11-20T08:00:00Z'));
    /* Back to back, so it reaches the end of the second. */
    expect(state.redeemedUntil).toEqual(new Date('2027-02-20T08:00:00Z'));
  });

  it('takes over when the Paddle period ends', () => {
    const after = new Date('2026-12-05T00:00:00Z');
    expect(planStateFrom(paddle, [redeemed('2026-12-01T00:00:00Z', 2)], after)).toMatchObject({ active: true, source: 'redeemed' });
    expect(planStateFrom(paddle, [], after)).toMatchObject({ active: false, source: null });
  });

  it('meters a redeemed Plan like a paid one', () => {
    const state = planStateFrom(null, [redeemed('2026-11-01T00:00:00Z', 1)], now);
    expect(planUsage(state, { amount: 50_000, remaining: 40_000 }, now)).toMatchObject({
      active: true,
      source: 'redeemed',
      used: 10_000,
      periodEnd: '2026-12-01T00:00:00.000Z',
      redeemedUntil: '2026-12-01T00:00:00.000Z',
    });
    expect(planUsage(planStateFrom(null, [], now), null, now)).toMatchObject({ active: false, source: null });
  });
});
