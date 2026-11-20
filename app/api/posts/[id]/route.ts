import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser, currentUser } from '@/lib/http/session';
import { getPost, setPostTrashed } from '@/lib/services/posts';
import { updatePrivatePost, type PrivatePostChange } from '@/lib/services/private-posts';

type Context = { params: Promise<{ id: string }> };

/** One post with its answers (the post page polls this while Rees answer); its author also sees it pending, rejected, trashed or private. */
export async function GET(_request: NextRequest, { params }: Context) {
  const viewer = await currentUser();
  const post = await getPost((await params).id, viewer?.id);
  return post ? json(post) : fail('not_found', 404);
}

/**
 * The author's actions on their post: `{trashed}` moves it to the trash or
 * back; on a private post also `{pinned}`, `{archived}` and `{title}`
 * (重命名, at most 120 characters; empty shows the question again → 422
 * `title_too_long` past it). Answers what changed; 404 when it is not theirs.
 */
export async function PATCH(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const id = (await params).id;
  const input = await body(request);
  const change: PrivatePostChange = {};
  if (typeof input.pinned === 'boolean') change.pinned = input.pinned;
  if (typeof input.archived === 'boolean') change.archived = input.archived;
  if (typeof input.title === 'string' || input.title === null) change.title = input.title as string | null;
  const out: Record<string, unknown> = {};
  if (Object.keys(change).length) {
    const result = await updatePrivatePost(user.id, id, change);
    if (!result.ok) return fail(result.error, result.error === 'not_found' ? 404 : 422);
    Object.assign(out, { pinned: result.pinned, archived: result.archived, title: result.title });
  }
  /* `trashed` as before: sent alone (or with nothing else) it is the trash action. */
  if ('trashed' in input || Object.keys(change).length === 0) {
    const trashed = input.trashed === true;
    if (!(await setPostTrashed(user.id, id, trashed))) return fail('not_found', 404);
    out.trashed = trashed;
  }
  return json(out);
}
