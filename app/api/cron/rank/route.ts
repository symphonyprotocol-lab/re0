import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { clearAnonymousQuota } from '@/lib/services/anonymous-chat';
import { clearExpiredSessions } from '@/lib/services/auth';
import { moderatePending } from '@/lib/services/public-qa';
import { computeRanks } from '@/lib/services/rank';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, hourly): materialises every public Ree's
 * 30-day quality signals and explore order into `ree.rank`, and clears old
 * rate-limit windows, anonymous chat's past days and expired user and
 * console sessions, and retries public answers left unchecked. Posts have
 * their own job (`/api/cron/posts`, every 5 minutes). Same `CRON_SECRET` gate as the other jobs. Idempotent.
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
  return json({ ranked, expired: await clearExpiredSessions(), quotaCleared, moderated });
}
