import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { expireDuePlans, releaseStaleEarnedCheckouts } from '@/lib/services/billing';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, daily): the backstop that writes off Plan
 * credits whose period has ended. Renewals do this themselves when Paddle's
 * webhook arrives (8.3); this catches cancelled and lapsed Plans. Vercel
 * sends `Authorization: Bearer $CRON_SECRET`; without the secret the route
 * stays shut. Idempotent. Daily is enough: an ended period is already
 * unspendable and outside the balance; this only writes the `expire` entry.
 * It also cancels checkouts that held earned credits and were left unpaid
 * (`EARNED_CHECKOUT_HOLD_MS`), giving the credits back.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const expired = await expireDuePlans();
  return json({ ...expired, earnedCheckoutsReleased: await releaseStaleEarnedCheckouts() });
}
