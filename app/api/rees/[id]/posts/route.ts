import type { NextRequest } from 'next/server';
import { isUuid } from '@/lib/domain/list';
import { fail, json } from '@/lib/http/respond';
import { currentUser } from '@/lib/http/session';
import { reeAnsweredPosts } from '@/lib/services/posts';

type Context = { params: Promise<{ id: string }> };

/**
 * `GET ?before=<answerId>` → `{items, total, next}`: one page of the public
 * posts a public Ree answered, as post cards showing its answer -- the Ree
 * page's 回答的帖子 after the first page. 404 for a Ree that is not public.
 */
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  const before = request.nextUrl.searchParams.get('before');
  if (before !== null && !isUuid(before)) return fail('invalid_cursor', 400);
  const viewer = await currentUser();
  const page = await reeAnsweredPosts(id, { before, viewerId: viewer?.id });
  return page ? json(page) : fail('not_found', 404);
}
