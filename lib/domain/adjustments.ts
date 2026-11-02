/**
 * The console's manual credit adjustment (2.5 "手动调整 credits", 8.4 step 5):
 * a grant or a deduction on the Pack or the Plan bucket only, 1 to
 * 10,000,000 whole credits, with a 3–300 character reason. A deduction takes
 * only what the bucket holds; the balance never goes below zero.
 */
import { ADMIN_REASON, CREDIT_ADJUSTMENT } from '@/lib/constants';
import type { Allocation, SpendableGrant } from '@/lib/domain/credits';
import { charLength } from '@/lib/domain/roles';

export type AdjustmentBucket = 'pack' | 'plan';
export type AdjustmentDirection = 'grant' | 'deduct';

export interface Adjustment {
  bucket: AdjustmentBucket;
  direction: AdjustmentDirection;
  amount: number;
  reason: string;
}

export function parseAdminReason(raw: unknown): string | null {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  const length = charLength(reason);
  return length >= ADMIN_REASON.min && length <= ADMIN_REASON.max ? reason : null;
}

export function parseAdjustment(raw: Record<string, unknown>): Adjustment | { error: 'bucket' | 'direction' | 'amount' | 'reason' } {
  if (raw.bucket !== 'pack' && raw.bucket !== 'plan') return { error: 'bucket' };
  if (raw.direction !== 'grant' && raw.direction !== 'deduct') return { error: 'direction' };
  const amount = typeof raw.amount === 'string' ? Number(raw.amount.replaceAll(',', '')) : raw.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < CREDIT_ADJUSTMENT.min || amount > CREDIT_ADJUSTMENT.max) {
    return { error: 'amount' };
  }
  const reason = parseAdminReason(raw.reason);
  if (!reason) return { error: 'reason' };
  return { bucket: raw.bucket, direction: raw.direction, amount, reason };
}

/**
 * Which grants of one bucket a deduction comes out of: soonest to expire,
 * then oldest. Null when the bucket's usable credits fall short.
 */
export function deductFromBucket(grants: readonly SpendableGrant[], bucket: AdjustmentBucket, amount: number, now: Date): Allocation[] | null {
  const usable = grants
    .filter((grant) => grant.source === bucket && grant.remaining > 0 && (grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime()))
    .sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) || a.createdAt.getTime() - b.createdAt.getTime());
  if (usable.reduce((sum, grant) => sum + grant.remaining, 0) < amount) return null;
  const allocations: Allocation[] = [];
  let left = amount;
  for (const grant of usable) {
    if (left === 0) break;
    const take = Math.min(left, grant.remaining);
    allocations.push({ grantId: grant.id, source: grant.source, amount: take });
    left -= take;
  }
  return allocations;
}
