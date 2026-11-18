import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { followUpPost } from '@/lib/services/posts';

type Context = { params: Promise<{ id: string }> };

/** `{answerId}`: "继续问" -- a private conversation with that Ree, seeded with the post and its answer → 201 `{conversationId}`. */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('conversation', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const conversationId = await followUpPost(user.id, (await params).id, String((await body(request)).answerId ?? ''));
  return conversationId ? json({ conversationId }, 201) : fail('not_found', 404);
}
