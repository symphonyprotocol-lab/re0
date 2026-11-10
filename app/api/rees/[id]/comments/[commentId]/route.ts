import type { NextRequest } from 'next/server';
import { isUuid } from '@/lib/domain/list';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { deleteReeComment } from '@/lib/services/ree-comments';

type Context = { params: Promise<{ id: string; commentId: string }> };

/** The comment's author or the Ree's owner removes it; anyone else, or a comment already gone, is 404. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, commentId } = await params;
  if (!isUuid(id) || !isUuid(commentId)) return fail('not_found', 404);
  if (!(await deleteReeComment(id, commentId, user.id))) return fail('not_found', 404);
  return json({ deleted: true });
}
