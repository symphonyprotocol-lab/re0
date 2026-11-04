/**
 * The credit ledger's arithmetic (rebuild-proposal.md 2.3, 4), free of the
 * database: which grants a charge comes out of, and which ones a release
 * goes back to.
 *
 * Balance is the sum of grants' `remaining`. A hold takes credits out of
 * grants at once (recording which, in `allocations`), so whatever is held is
 * already gone from the balance; settling returns the unused part and
 * releasing returns all of it.
 */
import { GRANT_SPEND_ORDER, type GrantSource } from '@/lib/constants';

export interface Allocation {
  grantId: string;
  source: GrantSource;
  amount: number;
}

export interface SpendableGrant {
  id: string;
  source: GrantSource;
  remaining: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export class InsufficientCredits extends Error {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(`needs ${needed} credits, ${available} available`);
    this.name = 'InsufficientCredits';
  }
}

function usable(grant: SpendableGrant, now: Date): boolean {
  return grant.remaining > 0 && (grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime());
}

/** Spend order: current Plan → welcome → Pack → earned; within a source, soonest to expire, then oldest. */
export function spendOrder(grants: readonly SpendableGrant[], now: Date): SpendableGrant[] {
  return grants
    .filter((grant) => usable(grant, now))
    .sort((a, b) => {
      const bySource = GRANT_SPEND_ORDER.indexOf(a.source) - GRANT_SPEND_ORDER.indexOf(b.source);
      if (bySource !== 0) return bySource;
      const aEnd = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const bEnd = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (aEnd !== bEnd) return aEnd - bEnd;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
}

export function availableOf(grants: readonly SpendableGrant[], now: Date): number {
  return grants.filter((grant) => usable(grant, now)).reduce((sum, grant) => sum + grant.remaining, 0);
}

/** Which grants `amount` comes out of. Throws when the usable balance cannot cover it. */
export function allocate(grants: readonly SpendableGrant[], amount: number, now: Date): Allocation[] {
  if (!Number.isInteger(amount) || amount < 0) throw new Error(`invalid amount ${amount}`);
  const available = availableOf(grants, now);
  if (available < amount) throw new InsufficientCredits(amount, available);
  const allocations: Allocation[] = [];
  let left = amount;
  for (const grant of spendOrder(grants, now)) {
    if (left === 0) break;
    const take = Math.min(grant.remaining, left);
    allocations.push({ grantId: grant.id, source: grant.source, amount: take });
    left -= take;
  }
  return allocations;
}

/**
 * The part of a hold handed back: refunds walk the spend order backwards, so
 * what stays charged is what was taken first (Plan before welcome before
 * Pack before earned).
 */
export function releaseFrom(allocations: readonly Allocation[], amount: number): Allocation[] {
  const total = allocations.reduce((sum, entry) => sum + entry.amount, 0);
  if (!Number.isInteger(amount) || amount < 0 || amount > total) throw new Error(`cannot release ${amount} of ${total}`);
  const released: Allocation[] = [];
  let left = amount;
  for (const entry of [...allocations].reverse()) {
    if (left === 0) break;
    const give = Math.min(entry.amount, left);
    released.push({ ...entry, amount: give });
    left -= give;
  }
  return released;
}

/** A hold settled at `actual`: more than was held is never charged (2.3, "多退少不补"). */
export function settlement(held: number, actual: number): { charged: number; released: number } {
  const charged = Math.max(0, Math.min(held, Math.round(actual)));
  return { charged, released: held - charged };
}

/**
 * A settlement entry's note: the caller's label (a knowledge title, a Ree's
 * name), then `charged X of Y`. The ledger reads the charge back with
 * `chargedFromNote`, so the two stay in step here.
 */
export function settlementNote(label: string | null | undefined, charged: number, held: number): string {
  const tail = `charged ${charged} of ${held}`;
  return label ? `${label} · ${tail}` : tail;
}

export function chargedFromNote(note: string | null | undefined): number | null {
  const match = /(?:^| · )charged (\d+) of \d+$/.exec(note ?? '');
  return match ? Number(match[1]) : null;
}
