import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { probeCoolingModels } from '@/lib/services/models';

/* A probe may wait out an entry's timeout (up to 300 s); the entries are probed side by side. */
export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json), every five minutes: one probe of each listed
 * entry cooling for quota, a bad key or a missing model, at most every ten
 * minutes per entry; one that answers is used again (the primary first, so
 * traffic returns to it). Rate limits and server errors recover when their
 * period ends. Without CRON_SECRET the route stays shut.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  return json(await probeCoolingModels());
}
