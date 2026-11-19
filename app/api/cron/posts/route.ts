import type { NextRequest } from 'next/server';
import { POST_SWEEP_BUDGET_MS, POST_SWEEP_CONCURRENCY } from '@/lib/domain/post';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { processStalePosts, purgePostTrash } from '@/lib/services/posts';
import { syncPublicQa } from '@/lib/services/public-qa-sync';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, every 5 minutes), on its own budget apart from
 * the hourly ranking: copies newly public Q&A into posts, then
 * `processStalePosts` -- rejects reviews that died (refunds), settles runs
 * that died while answering (refunds or settles), and answers posts a
 * request never started, `POST_SWEEP_CONCURRENCY` at a time, starting new
 * ones for `POST_SWEEP_BUDGET_MS` so the started ones finish inside
 * `maxDuration` -- and empties post trash older than 30 days. A post
 * whose background work died is picked up within about 5 minutes (2 for a
 * post never started, 10 for one stuck answering, plus the next run).
 * Same `CRON_SECRET` gate as the other jobs; each step is idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const quiet = (label: string) => (error: unknown) => {
    console.error(`${label} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return 0;
  };
  const copied = await syncPublicQa().catch(quiet('public answer copy'));
  const posts = await processStalePosts({}, { budgetMs: POST_SWEEP_BUDGET_MS, concurrency: POST_SWEEP_CONCURRENCY }).catch(quiet('post sweep'));
  const purged = await purgePostTrash().catch(quiet('post trash purge'));
  return json({ copied, posts, purged });
}
