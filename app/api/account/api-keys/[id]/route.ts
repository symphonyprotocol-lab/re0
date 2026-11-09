import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { revokeApiKey } from '@/lib/services/api-keys';

/** Revokes one of the user's keys; the row stays, so its usage still shows. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  return (await revokeApiKey(user.id, id)) ? json({ id }) : fail('not_found', 404);
}
