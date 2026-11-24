import type { NextRequest } from 'next/server';
import { COMPETITION_BUDGET_MS, COMPETITION_CONCURRENCY } from '@/lib/domain/competition';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { runCompetitions } from '@/lib/services/competition-run';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, every minute), apart from `/api/cron/posts` so
 * a competition's batch never starves ordinary posts' answers
 * (docs/design/competitions.md 11.1): reviews, reminders, locking,
 * moving each competition on, the stale sweep, then answers, reviews and
 * judgements within `COMPETITION_BUDGET_MS`. Same `CRON_SECRET` gate as
 * the other jobs; each step is idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  return json(await runCompetitions({}, { budgetMs: COMPETITION_BUDGET_MS, concurrency: COMPETITION_CONCURRENCY }));
}
