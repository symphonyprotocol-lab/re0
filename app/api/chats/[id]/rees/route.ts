import type { NextRequest } from 'next/server';
import { conversationFailure } from '@/lib/http/conversations';
import { body, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { setParticipants } from '@/lib/services/conversations';

/** `{reeIds}`: the conversation's whole participant set at once (0–5), all or nothing. */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('participants', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  try {
    return json({ reeIds: await setParticipants(user.id, (await context.params).id, (await body(request)).reeIds) });
  } catch (error) {
    return conversationFailure(error);
  }
}
