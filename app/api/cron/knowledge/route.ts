import { after, type NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { processQueued, queuedKnowledge, recoverStaleEverywhere } from '@/lib/services/knowledge';

/* The queued sources run after the response: 800 s is Vercel's maximum on Pro (`KNOWLEDGE_RUN_MAX_MS`). */
export const maxDuration = 800;

/**
 * Vercel Cron (vercel.json), every minute: the knowledge queue. Dead runs
 * anywhere are resumed or failed (`recoverStaleEverywhere`), then waiting
 * sources are offered a slot after the response (`processQueued`), fairly
 * across owners (`queuedKnowledge`) -- a burst runs a few at a time per
 * owner instead of all at once, and nothing waits on its owner keeping the
 * library open. Runs are claimed only in the function's first minute
 * (`KNOWLEDGE_CLAIM_WINDOW_MS`), so none is started too late to finish.
 * Idempotent; without CRON_SECRET the route stays shut.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const swept = await recoverStaleEverywhere();
  const queued = await queuedKnowledge();
  if (queued.length > 0) after(() => processQueued(queued, { startedAt }));
  return json({ swept, offered: queued.length });
}
