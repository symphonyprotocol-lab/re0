import type { NextRequest } from 'next/server';
import { isUuid } from '@/lib/domain/list';
import { reeCommentContent } from '@/lib/domain/ree-comment';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { addReeComment, listReeComments } from '@/lib/services/ree-comments';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  if (!isUuid(id)) return fail('not_found', 404);
  const before = request.nextUrl.searchParams.get('before');
  if (before !== null && !isUuid(before)) return fail('invalid_cursor', 400);
  const page = await listReeComments(id, before ?? undefined);
  return page ? json(page) : fail('not_found', 404);
}

export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!isUuid(id)) return fail('not_found', 404);
  const input = await body(request);
  const content = reeCommentContent(input.content);
  if (!isUuid(input.id) || content === null) return fail('invalid_comment', 422);
  const comment = await addReeComment(id, user, { id: input.id, content });
  if (!comment) return fail('not_found', 404);
  if (comment === 'conflict') return fail('comment_conflict', 409);
  return json({ comment }, 201);
}
