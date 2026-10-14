/**
 * The conversion behind "redeem as calls" (publisher-revenue-share.md 3.4):
 * settled earnings buy Additional Calls at the pack rate, rounded down, and
 * nothing else about the rate or the threshold leaks in.
 */
import { describe, expect, it } from 'vitest';
import { creditCallsFor } from '@/lib/domain';

const pack = { priceMinor: 500, calls: 5_000 };

describe('creditCallsFor', () => {
  it('prices the amount at the pack rate', () => {
    expect(creditCallsFor(500, pack)).toBe(5_000);
    expect(creditCallsFor(1_300, pack)).toBe(13_000);
    /* One cent buys ten calls at $5 per 5,000. */
    expect(creditCallsFor(1, pack)).toBe(10);
  });

  it('rounds down rather than granting a fraction of a call', () => {
    expect(creditCallsFor(7, { priceMinor: 500, calls: 300 })).toBe(4); // 4.2
    expect(creditCallsFor(1, { priceMinor: 500, calls: 300 })).toBe(0); // 0.6
  });

  it('has no threshold other than one whole call', () => {
    expect(creditCallsFor(499, pack)).toBe(4_990);
  });

  it('converts nothing without an amount or a usable rate', () => {
    expect(creditCallsFor(0, pack)).toBe(0);
    expect(creditCallsFor(-100, pack)).toBe(0);
    expect(creditCallsFor(1_000, { priceMinor: 0, calls: 5_000 })).toBe(0);
    expect(creditCallsFor(1_000, { priceMinor: 500, calls: 0 })).toBe(0);
  });
});
