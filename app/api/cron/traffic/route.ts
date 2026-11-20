import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { rollUpTraffic } from '@/lib/services/traffic';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, daily): rolls up each finished UTC+8 day of
 * site-wide page views (console 「流量」) and deletes raw views older than 90
 * days (lib/services/traffic.ts). Vercel sends
 * `Authorization: Bearer $CRON_SECRET`; anything else is refused, and with
 * no secret configured the route stays shut. Idempotent: a day is rolled up
 * once, and a run cut short is finished by the next.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const { days, purged } = await rollUpTraffic(new Date(), Date.now() + 270_000);
  return json({ rolledUp: days.length, days, purged });
}
