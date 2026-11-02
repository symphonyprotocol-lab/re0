import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { trashedPreview } from '@/lib/services/conversations';

type Context = { params: Promise<{ id: string }> };

/** `GET`: a conversation in the trash, read-only → `{id, title, messages}`, its last 8 messages oldest first; the owner's only. */
export async function GET(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const preview = await trashedPreview(user.id, (await context.params).id);
  return preview ? json(preview) : fail('not_found', 404);
}
