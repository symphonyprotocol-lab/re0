import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { purgeRemovedWorkspaceBlobs } from '@/lib/services/removed-workspace-blobs';
import { purgeOrphanUploads } from '@/lib/services/upload-reaper';

export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, daily): uploads that were never registered —
 * knowledge files, avatars, Ree covers — are deleted a day after upload;
 * then what the removed agent workspace left in Blob, for the workspaces
 * migration 0101 listed, within the time left. Same `CRON_SECRET` gate as
 * the other jobs. Idempotent.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const presented = request.headers.get('authorization') ?? '';
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) return fail('unauthorized', 401);
  const started = Date.now();
  const uploads = await purgeOrphanUploads();
  const removedWorkspaces = await purgeRemovedWorkspaceBlobs({ deadline: started + 270_000 });
  return json({ ...uploads, removedWorkspaces });
}
