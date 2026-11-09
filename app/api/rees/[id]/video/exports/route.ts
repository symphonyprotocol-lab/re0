import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { videoFailure } from '@/lib/http/video';
import { exportQuote, startExport } from '@/lib/services/video';

/** Beyond 5: what an export would cost now, or the cached file, so the confirmation is exact before anything is held. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    return json(await exportQuote(user.id, (await context.params).id));
  } catch (error) {
    return videoFailure(error);
  }
}

/**
 * An export starts (rebuild-proposal.md 5): a cache hit answers the existing
 * file, free and uncounted; otherwise a `video_export` row, the confirmed price held
 * unless it is the Ree's first, the props to render and a Blob upload token.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { maxCost } = await body(request);
  if (maxCost !== undefined && (typeof maxCost !== 'number' || !Number.isSafeInteger(maxCost) || maxCost < 0)) return fail('invalid_price', 422);
  try {
    return json(await startExport(user.id, (await context.params).id, undefined, maxCost));
  } catch (error) {
    return videoFailure(error);
  }
}
