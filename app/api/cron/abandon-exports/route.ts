import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { abandonExports } from '@/lib/services/video';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, every 15 minutes): releases the holds of video
 * exports whose tab closed before they finished, 30 minutes after they
 * started (rebuild-proposal.md 8.3 "中断的视频导出解冻"). Same `CRON_SECRET`
 * gate as the other jobs. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  return json(await abandonExports());
}
