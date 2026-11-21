import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { issueRedeemedPlanMonths } from '@/lib/services/redeem';
import { releaseStaleEarnedCheckouts } from '@/lib/services/billing';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, every minute): a redeemed Plan's later months, each
 * granted within a minute of when it begins (docs/design/redeem-codes.md 4.2), and the first
 * month of one that waited behind a Paddle period or another redeemed Plan.
 * Vercel sends `Authorization: Bearer $CRON_SECRET`; without the secret the
 * route stays shut. Idempotent. It also cancels checkouts that held earned
 * credits and were left unpaid for an hour, giving the credits back
 * (`EARNED_CHECKOUT_HOLD_MS`; docs/design/earned-credits.md).
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  /* Each job on its own: one failing never keeps the other from running (review round 2). */
  const [issued, released] = await Promise.allSettled([issueRedeemedPlanMonths(), releaseStaleEarnedCheckouts()]);
  if (issued.status === 'rejected') console.error('cron: issueRedeemedPlanMonths failed', issued.reason);
  if (released.status === 'rejected') console.error('cron: releaseStaleEarnedCheckouts failed', released.reason);
  const body = { ...(issued.status === 'fulfilled' ? issued.value : {}), earnedCheckoutsReleased: released.status === 'fulfilled' ? released.value : null };
  return issued.status === 'fulfilled' && released.status === 'fulfilled' ? json(body) : json({ ...body, error: 'partial_failure' }, 500);
}
