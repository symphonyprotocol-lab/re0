import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { clearAnonymousQuota } from '@/lib/services/anonymous-chat';
import { clearExpiredSessions } from '@/lib/services/auth';
import { processStalePosts, purgePostTrash } from '@/lib/services/posts';
import { moderatePending } from '@/lib/services/public-qa';
import { syncPublicQa } from '@/lib/services/public-qa-sync';
import { computeRanks } from '@/lib/services/rank';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, hourly): materialises every public Ree's
 * 30-day quality signals and explore order into `ree.rank`, and clears old
 * rate-limit windows, anonymous chat's past days and expired user and
 * console sessions, and retries public answers left unchecked. v5: copies
 * newly public answers into posts, finishes posts a request left behind
 * and empties post trash older than 30 days. Same `CRON_SECRET` gate as the other jobs. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  /* Anonymous chat's past days, first and on their own: a ranking failure must not leave them, nor their failure fail the ranking. */
  const quotaCleared = await clearAnonymousQuota().then(
    () => true,
    (error: unknown) => {
      console.error(`anonymous quota cleanup failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return false;
    },
  );
  const ranked = await computeRanks();
  /* Public answers a request could not check (public-qa.ts): retried here, never failing the ranking. */
  const moderated = await moderatePending().catch((error: unknown) => {
    console.error(`public answer moderation sweep failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return 0;
  });
  /* Posts (posts.ts): each on its own, never failing the ranking. */
  const quiet = (label: string) => (error: unknown) => {
    console.error(`${label} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return 0;
  };
  const copied = await syncPublicQa().catch(quiet('public answer copy'));
  const posts = await processStalePosts().catch(quiet('post sweep'));
  const purged = await purgePostTrash().catch(quiet('post trash purge'));
  return json({ ranked, expired: await clearExpiredSessions(), quotaCleared, moderated, copied, posts, purged });
}
