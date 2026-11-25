import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { runIndexQueue } from '@/lib/services/workspace-index';
import { continueStitching, reapUploads } from '@/lib/services/workspace-upload';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json), every minute: the agent workspace's index
 * (lib/services/workspace-index.ts). Files whose two quiet minutes are over
 * are indexed -- only their changed passages embedded, within each owner's
 * daily budget -- and the Rees bound to them follow. A file another run
 * holds is skipped; one a dead run held is taken again after
 * WORKSPACE_INDEX_CLAIM_MS. Large uploads being put together are carried on
 * first, and uploads that will not finish are ended, their parts deleted
 * (lib/services/workspace-upload.ts). Without CRON_SECRET the
 * route stays shut.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const stitched = await continueStitching().catch((error) => {
    console.warn('workspace uploads not stitched', error instanceof Error ? error.message : error);
    return null;
  });
  const uploads = await reapUploads().catch((error) => {
    console.warn('workspace uploads not reaped', error instanceof Error ? error.message : error);
    return null;
  });
  return json({ ...(await runIndexQueue()), uploads: uploads && { ...uploads, stitched } });
}
