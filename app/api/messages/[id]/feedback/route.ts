import type { NextRequest } from 'next/server';
import { conversationFailure } from '@/lib/http/conversations';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { setFeedback } from '@/lib/services/conversations';

type Context = { params: Promise<{ id: string }> };

/** `{vote: 'up' | 'down' | null}` on one of the user's Ree answers ("有用 / 没用"; null takes it back). */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  const vote = input.vote === 'up' || input.vote === 'down' ? input.vote : input.vote === null ? null : undefined;
  if (vote === undefined) return fail('invalid_vote', 422);
  try {
    return json({ vote: await setFeedback(user.id, (await context.params).id, vote) });
  } catch (error) {
    return conversationFailure(error);
  }
}
