import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { removeDomain } from '@/lib/services/connections';

/** New website crawls under it need verifying again; knowledge already crawled stays. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  return (await removeDomain(user.id, id)) ? json({ id }) : fail('not_found', 404);
}
