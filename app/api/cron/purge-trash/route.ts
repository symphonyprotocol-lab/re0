import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { purgeConversationTrash } from '@/lib/services/conversations';
import { purgeTrash } from '@/lib/services/knowledge-library';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, daily): knowledge in the trash for 30 days is
 * removed with its passages and files, and so are conversations, with
 * their messages (step 4). Vercel sends
 * `Authorization: Bearer $CRON_SECRET`; anything else is refused, and with
 * no secret configured the route stays shut. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  let purged = 0;
  let files = 0;
  /* Bounded batches until a run finds nothing more, or the function's time is nearly gone. */
  const started = Date.now();
  for (;;) {
    const batch = await purgeTrash();
    purged += batch.purged;
    files += batch.files;
    if (batch.purged === 0 || Date.now() - started > 240_000) break;
  }
  let conversations = 0;
  for (;;) {
    const batch = await purgeConversationTrash();
    conversations += batch;
    if (batch === 0 || Date.now() - started > 270_000) break;
  }
  return json({ purged, files, conversations });
}
