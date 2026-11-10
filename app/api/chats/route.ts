import type { NextRequest } from 'next/server';
import { parseConversationQuery } from '@/lib/domain/conversation';
import { conversationFailure } from '@/lib/http/conversations';
import { rateLimited } from '@/lib/http/rate-limit';
import { body, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { createConversation, listConversations, matchingConversationIds } from '@/lib/services/conversations';

/**
 * `GET /api/chats?q&view=all|recent|pinned|archived|trash&ree&days=7|30|90&sort=new|old|title&size=20|50|100&page`
 * → `{items, total, page, size, counts}`; with `ids=1`, every matching id
 * ("选择全部 N 个筛选结果").
 */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const params = request.nextUrl.searchParams;
  const query = parseConversationQuery(params);
  if (params.get('ids') === '1') return json({ ids: await matchingConversationIds(user.id, query) });
  return json(await listConversations(user.id, query));
}

/** `{reeIds?, title?}` → `{id}`: a new conversation with up to five Rees, the user's own or public ones. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('conversation', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  try {
    const conversation = await createConversation(user.id, await body(request));
    return json({ id: conversation.id }, 201);
  } catch (error) {
    return conversationFailure(error);
  }
}
