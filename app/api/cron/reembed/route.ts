import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { reapMeteredRuns } from '@/lib/services/metered-work';
import { cleanupEmbeddingSpaces, latestReembedJob, reembedStalled, runReembed } from '@/lib/services/reembed';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json): the backstop for a re-embed job nobody is
 * watching -- if the running job is released or silent, take the next step;
 * after a switch, rebuild the knowledge profiles a step did not reach. Also
 * the backstop for metered runs (profiles, example questions) whose function
 * died before settling them (`reapMeteredRuns`); dead knowledge runs are the
 * queue cron's (`/api/cron/knowledge`). Clears vectors
 * of embedding spaces nothing reads any more, a batch at a time
 * (`cleanupEmbeddingSpaces`, also at the end of a step with no job running).
 * Idempotent; without CRON_SECRET the route stays shut.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const reaped = await reapMeteredRuns();
  const job = await latestReembedJob();
  /* A runner is working: leave it. Otherwise take the next step, or finish rebuilding profiles after a switch. */
  if (job?.status === 'running' && !reembedStalled(job)) return json({ job: job.status, ran: false, reaped, cleaned: await cleanupEmbeddingSpaces() });
  const result = await runReembed();
  return json({ job: result?.status ?? job?.status ?? null, ran: true, reaped });
}
