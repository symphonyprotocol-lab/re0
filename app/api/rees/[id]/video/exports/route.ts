import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { videoFailure } from '@/lib/http/video';
import { startExport } from '@/lib/services/video';

/**
 * An export starts (rebuild-proposal.md 5): a cache hit answers the existing
 * file, free and uncounted; otherwise a `video_export` row, 50 credits held
 * unless it is the Ree's first, the props to render and a Blob upload token.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    return json(await startExport(user.id, (await context.params).id));
  } catch (error) {
    return videoFailure(error);
  }
}
