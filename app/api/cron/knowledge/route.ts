import { after, type NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { processQueued, queuedKnowledge, recoverStaleEverywhere } from '@/lib/services/knowledge';

/* The queued sources run after the response: 800 s is Vercel's maximum on Pro (`KNOWLEDGE_RUN_MAX_MS`). */
export const maxDuration = 800;

/**
 * Vercel Cron (vercel.json), every minute: the knowledge queue. Dead runs
 * anywhere are resumed or failed (`recoverStaleEverywhere`), then waiting
 * sources are offered a slot after the response (`processQueued`) -- a
 * burst of repositories runs a few at a time per owner instead of all at
 * once, and nothing waits on its owner keeping the library open.
 * Idempotent; without CRON_SECRET the route stays shut.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const swept = await recoverStaleEverywhere();
  const queued = await queuedKnowledge();
  if (queued.length > 0) after(() => processQueued(queued));
  return json({ swept, offered: queued.length });
}
