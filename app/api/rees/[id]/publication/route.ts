import { after, type NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { refreshProfile } from '@/lib/services/profile';
import { ReePublicationError, setReePublished } from '@/lib/services/rees';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  if (typeof input.isPublished !== 'boolean') return fail('invalid_publication', 422);
  try {
    const ree = await setReePublished(user.id, (await context.params).id, input.isPublished);
    if (!ree) return fail('not_found', 404);
    if (ree.isPublished) after(() => refreshProfile(ree.id).catch(() => undefined));
    return json({ ree });
  } catch (error) {
    if (error instanceof ReePublicationError) return fail(error.code, 422);
    throw error;
  }
}
