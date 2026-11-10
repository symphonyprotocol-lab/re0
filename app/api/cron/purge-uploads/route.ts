import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { purgeOrphanUploads } from '@/lib/services/upload-reaper';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, daily): uploads that were never registered —
 * knowledge files, avatars, Ree covers — are deleted a day after upload.
 * Same `CRON_SECRET` gate as the other jobs. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  return json(await purgeOrphanUploads());
}
