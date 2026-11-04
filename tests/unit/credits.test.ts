/** The ledger's arithmetic (rebuild-proposal.md 2.3; 8.2 "扣费顺序", "知识处理费"). */
import { describe, expect, it } from 'vitest';
import { allocate, availableOf, InsufficientCredits, releaseFrom, settlement, type SpendableGrant } from '@/lib/domain/credits';

const now = new Date('2026-11-02T00:00:00Z');
const grant = (id: string, source: SpendableGrant['source'], remaining: number, expiresAt: Date | null = null, created = 0): SpendableGrant => ({
  id,
  source,
  remaining,
  expiresAt,
  createdAt: new Date(now.getTime() - 1000 * (10 - created)),
});

describe('allocate', () => {
  it('spends current Plan, then welcome, then Pack, then earned', () => {
    const grants = [grant('earned', 'earned', 50), grant('pack', 'pack', 50), grant('welcome', 'welcome', 50), grant('plan', 'plan', 50, new Date('2026-12-01'))];
    expect(allocate(grants, 120, now)).toEqual([
      { grantId: 'plan', source: 'plan', amount: 50 },
      { grantId: 'welcome', source: 'welcome', amount: 50 },
      { grantId: 'pack', source: 'pack', amount: 20 },
    ]);
  });

  it('skips expired grants and refuses to overdraw', () => {
    const grants = [grant('old-plan', 'plan', 100, new Date('2026-11-01')), grant('welcome', 'welcome', 10)];
    expect(availableOf(grants, now)).toBe(10);
    expect(() => allocate(grants, 20, now)).toThrow(InsufficientCredits);
  });

  it('allows a zero hold', () => {
    expect(allocate([grant('w', 'welcome', 5)], 0, now)).toEqual([]);
  });
});

describe('release and settlement', () => {
  it('returns credits in reverse spending order', () => {
    const allocations = [
      { grantId: 'plan', source: 'plan' as const, amount: 10 },
      { grantId: 'welcome', source: 'welcome' as const, amount: 10 },
    ];
    expect(releaseFrom(allocations, 12)).toEqual([
      { grantId: 'welcome', source: 'welcome', amount: 10 },
      { grantId: 'plan', source: 'plan', amount: 2 },
    ]);
    expect(() => releaseFrom(allocations, 21)).toThrow();
  });

  it('charges the real price, never more than was held', () => {
    expect(settlement(20, 19)).toEqual({ charged: 19, released: 1 });
    expect(settlement(20, 41)).toEqual({ charged: 20, released: 0 });
  });


});
