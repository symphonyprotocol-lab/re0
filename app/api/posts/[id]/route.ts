import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser, currentUser } from '@/lib/http/session';
import { getPost, setPostTrashed } from '@/lib/services/posts';

type Context = { params: Promise<{ id: string }> };

/** One post with its answers (the post page polls this while Rees answer); its author also sees it pending, rejected or trashed. */
export async function GET(_request: NextRequest, { params }: Context) {
  const viewer = await currentUser();
  const post = await getPost((await params).id, viewer?.id);
  return post ? json(post) : fail('not_found', 404);
}

/** `{trashed}`: the author moves their post to the trash or back. */
export async function PATCH(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const trashed = (await body(request)).trashed === true;
  return (await setPostTrashed(user.id, (await params).id, trashed)) ? json({ trashed }) : fail('not_found', 404);
}
