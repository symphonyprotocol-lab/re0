import { after, type NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { processPost } from '@/lib/services/posts';
import { convertToPublic } from '@/lib/services/private-posts';

type Context = { params: Promise<{ id: string }> };

/**
 * `{anonymous?}`: 转为公开 -- the author copies their private post and its
 * answers into a new public post → 201 `{id}`, reviewed after the response
 * (question and answers together). Once per private post: 409 `already` with
 * the copy's `id`; 404 for anything but the author's own live private post.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('post', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const result = await convertToPublic(user.id, (await params).id, { anonymous: (await body(request)).anonymous === true });
  if (!result.ok) return result.error === 'already' ? fail('already', 409, { id: result.id }) : fail('not_found', 404);
  after(() => processPost(result.id).catch((error: unknown) => console.error(`post ${result.id} not reviewed: ${error instanceof Error ? error.message : 'unknown'}`)));
  return json({ id: result.id }, 201);
}
