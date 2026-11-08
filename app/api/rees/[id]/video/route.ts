import type { NextRequest } from 'next/server';
import { parseVideoPatch } from '@/lib/domain/video';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { videoFailure } from '@/lib/http/video';
import { introsFor, saveVideo, videoStudio } from '@/lib/services/video';

type Context = { params: Promise<{ id: string }> };

/** The editor's state: the saved script and style, the Player's props, readiness and the last export. */
export async function GET(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    const { ree, ...studio } = await videoStudio(user.id, (await context.params).id);
    return json({ ...studio, ree: { id: ree.id, name: ree.name, slug: ree.slug } });
  } catch (error) {
    return videoFailure(error);
  }
}

/**
 * Saves the video type, accent and music (rebuild-proposal.md 5); the script
 * itself is only ever generated.
 */
export async function PATCH(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const parsed = parseVideoPatch(await body(request));
  if ('error' in parsed) return fail(parsed.error, 422);
  const id = (await context.params).id;
  try {
    const video = await saveVideo(user.id, id, parsed.patch, parsed.revision);
    return json({ video, props: (await introsFor([id])).get(id) ?? null });
  } catch (error) {
    return videoFailure(error);
  }
}
