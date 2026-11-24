import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { VercelApiError } from '@/lib/domain/crawler-traffic';
import { collectCrawlerTraffic } from '@/lib/services/crawler-traffic';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, daily, after /api/cron/traffic): reads each
 * finished UTC+8 day's crawler traffic from Vercel Observability, and the
 * project's billing charges, for the console's 「爬虫 / 基础设施」
 * (lib/services/crawler-traffic.ts). Vercel sends
 * `Authorization: Bearer $CRON_SECRET`; anything else is refused, and with
 * no secret configured the route stays shut. Without
 * `VERCEL_OBSERVABILITY_TOKEN` it answers `configured: false` and reads
 * nothing.
 *
 * Every day Observability still keeps (about 30) that is not fetched yet is
 * fetched, oldest first, so the first run after the token is set fills the
 * past month by itself. To fetch days again by hand, with the same secret:
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD&refetch=1` (both optional; `from` also
 * re-reads billing charges from that day).
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const params = request.nextUrl.searchParams;
  try {
    const result = await collectCrawlerTraffic(new Date(), {
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      refetch: params.get('refetch') === '1',
      deadline: Date.now() + 240_000,
    });
    return json(result);
  } catch (error) {
    if (error instanceof VercelApiError && error.auth) return fail('vercel_token_refused', 502, { configured: true, status: error.status });
    throw error;
  }
}
