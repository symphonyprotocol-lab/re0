import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { clearExpiredSessions } from '@/lib/services/auth';
import { computeRanks } from '@/lib/services/rank';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, hourly): materialises every public Ree's
 * 30-day quality signals and explore order into `ree.rank`, and clears old
 * rate-limit windows and expired user and console sessions. Same
 * `CRON_SECRET` gate as the other jobs. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const ranked = await computeRanks();
  return json({ ranked, expired: await clearExpiredSessions() });
}
