import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { deleteFollowup } from '@/lib/services/post-followups';

type Context = { params: Promise<{ followupId: string }> };

/** Its asker deletes a follow-up (追问): gone for everyone, its answers with it; what was settled stays settled. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return (await deleteFollowup(user.id, (await params).followupId)) ? json({ deleted: true }) : fail('not_found', 404);
}
