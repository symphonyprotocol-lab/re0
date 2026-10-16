/**
 * The conversion behind "redeem as calls" (publisher-revenue-share.md 3.4):
 * settled earnings buy Additional Calls at the pack rate, rounded up in the
 * publisher's favour, and only those who run the workspace may trigger it.
 */
import { describe, expect, it } from 'vitest';
import { canRedeemEarnings, redeemedByTag } from '@/lib/application/revenue';
import { creditCallsFor } from '@/lib/domain';

const pack = { priceMinor: 500, calls: 5_000 };

describe('creditCallsFor', () => {
  it('prices the amount at the pack rate', () => {
    expect(creditCallsFor(500, pack)).toBe(5_000);
    expect(creditCallsFor(1_300, pack)).toBe(13_000);
    /* One cent buys ten calls at $5 per 5,000. */
    expect(creditCallsFor(1, pack)).toBe(10);
  });

  it('rounds a fraction of a call up, so the statement is never under-valued', () => {
    expect(creditCallsFor(7, { priceMinor: 500, calls: 300 })).toBe(5); // 4.2
    expect(creditCallsFor(1, { priceMinor: 500, calls: 300 })).toBe(1); // 0.6
    /* Exact multiples do not gain a call. */
    expect(creditCallsFor(10, { priceMinor: 500, calls: 300 })).toBe(6);
  });

  it('has no threshold: any positive amount buys at least one call', () => {
    expect(creditCallsFor(499, pack)).toBe(4_990);
  });

  it('converts nothing without an amount or a usable rate', () => {
    expect(creditCallsFor(0, pack)).toBe(0);
    expect(creditCallsFor(-100, pack)).toBe(0);
    expect(creditCallsFor(1_000, { priceMinor: 0, calls: 5_000 })).toBe(0);
    expect(creditCallsFor(1_000, { priceMinor: 500, calls: 0 })).toBe(0);
  });
});

describe('canRedeemEarnings', () => {
  it('lets owners and admins spend the workspace earnings, and nobody else', () => {
    expect(canRedeemEarnings('owner')).toBe(true);
    expect(canRedeemEarnings('admin')).toBe(true);
    expect(canRedeemEarnings('developer')).toBe(false);
    expect(canRedeemEarnings('viewer')).toBe(false);
  });
});

describe('redeemedByTag', () => {
  it('records the actor as kind:id', () => {
    expect(redeemedByTag({ kind: 'user', id: 'u1' })).toBe('user:u1');
    expect(redeemedByTag({ kind: 'api_key', id: 'k1' })).toBe('api_key:k1');
  });
});
