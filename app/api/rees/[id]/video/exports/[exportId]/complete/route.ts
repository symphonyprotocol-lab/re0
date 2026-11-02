import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { videoFailure } from '@/lib/http/video';
import { completeExport } from '@/lib/services/video';

/** The browser rendered and uploaded the MP4: the export is done and counted, its hold settled. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; exportId: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, exportId } = await context.params;
  try {
    return json(await completeExport(user.id, id, exportId));
  } catch (error) {
    return videoFailure(error);
  }
}
