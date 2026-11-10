import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { issueRedeemedPlanMonths } from '@/lib/services/redeem';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, every minute): a redeemed Plan's later months, each
 * granted within a minute of when it begins (docs/design/redeem-codes.md 4.2), and the first
 * month of one that waited behind a Paddle period or another redeemed Plan.
 * Vercel sends `Authorization: Bearer $CRON_SECRET`; without the secret the
 * route stays shut. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  return json(await issueRedeemedPlanMonths());
}
