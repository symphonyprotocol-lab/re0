import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { releaseStaleChatHolds } from '@/lib/services/chat-holds';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, every 5 minutes): releases the holds of chat and
 * MCP questions whose answer never finished -- the function was killed or
 * redeployed mid-stream -- once they are 10 minutes old (review H5). Same
 * `CRON_SECRET` gate as the other jobs. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  return json(await releaseStaleChatHolds());
}
