import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { latestReembedJob, reembedStalled, runReembed } from '@/lib/services/reembed';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json): the backstop for a re-embed job nobody is
 * watching -- if the running job has gone quiet, take the next step.
 * Idempotent; without CRON_SECRET the route stays shut.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const job = await latestReembedJob();
  if (!job || !reembedStalled(job)) return json({ job: job?.status ?? null, ran: false });
  const result = await runReembed();
  return json({ job: result?.status ?? null, ran: true });
}
