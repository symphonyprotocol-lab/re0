import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { purgeKycFiles } from '@/lib/services/kyc';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, daily): identity images 30 days past approval,
 * rejection or a re-verification request are deleted from Blob, the record's
 * other fields kept; images uploaded but never submitted go after a day.
 * Same `CRON_SECRET` gate as the other jobs. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  /* Due records in batches until done or nearly out of time, then one pass over unsubmitted uploads. */
  return json(await purgeKycFiles());
}
