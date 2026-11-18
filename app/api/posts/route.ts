import { after, type NextRequest } from 'next/server';
import { feedTabOf } from '@/lib/domain/post';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser, currentUser } from '@/lib/http/session';
import { listFeed, processPost, publishPost } from '@/lib/services/posts';

export const maxDuration = 300;

/** `GET ?tab=for_you|latest|unanswered&cursor=&q=` → `{items, next}`: one page of the public posts feed, anyone. */
export async function GET(request: NextRequest) {
  const viewer = await currentUser();
  const limited = await rateLimited('browse', { userId: viewer?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const params = request.nextUrl.searchParams;
  return json(await listFeed(feedTabOf(params.get('tab')), { cursor: params.get('cursor'), q: params.get('q')?.slice(0, 200), viewerId: viewer?.id }));
}

/**
 * `{question, detail?, anonymous?, mentionReeId?}`: publishes a public
 * post → 201 `{id, charge}`. Its review, matching and answers run after the
 * response (the post page polls). 402 with the balance when a post past
 * the free ones cannot be paid for; 429 `daily_limit`; 422 `empty` /
 * `too_long`.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('post', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const result = await publishPost(user.id, {
    question: String(input.question ?? ''),
    detail: String(input.detail ?? ''),
    anonymous: input.anonymous === true,
    mentionReeId: typeof input.mentionReeId === 'string' ? input.mentionReeId : null,
    lang: user.lang,
  });
  if (!result.ok) {
    if (result.error === 'insufficient_credits') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
    return fail(result.error, result.error === 'daily_limit' ? 429 : 422);
  }
  after(() => processPost(result.id).catch((error: unknown) => console.error(`post ${result.id} not processed: ${error instanceof Error ? error.message : 'unknown'}`)));
  return json({ id: result.id, charge: result.charge }, 201);
}
