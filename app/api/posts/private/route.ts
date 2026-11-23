import { after, type NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { processPrivatePost, publishPrivatePost } from '@/lib/services/private-posts';

export const maxDuration = 300;

/**
 * `{question, detail?, reeIds, fees, aiOnly?, clientToken?, images?}`: asks the chosen Rees
 * privately (私密提问) → 201 `{id}`; the same token, or the same text within a
 * minute, → 200 with the post already made, nothing held twice. Every hold
 * is placed before the response; the answers are written after it (the
 * post page polls). `fees` is the price per Ree the composer showed: one now
 * higher → 409 `price_changed` with `prices`; 402 with the balance; 429
 * `daily_limit`; 422 `empty` / `too_long` / `no_rees` / `too_many_rees` /
 * `ree_unavailable` / `invalid_images` / `too_many_images`. `aiOnly` with no `reeIds` (只问 AI): a private post only
 * the AI answers, at the base fee (402 below it).
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  /* As many models as a private question to five Rees: the question's limit. */
  const limited = await rateLimited('ask', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const result = await publishPrivatePost(user.id, {
    question: String(input.question ?? ''),
    detail: String(input.detail ?? ''),
    reeIds: Array.isArray(input.reeIds) ? input.reeIds.filter((id): id is string => typeof id === 'string').slice(0, 10) : [],
    fees: typeof input.fees === 'object' && input.fees !== null && !Array.isArray(input.fees) ? (input.fees as Record<string, unknown>) : null,
    aiOnly: input.aiOnly === true,
    clientToken: typeof input.clientToken === 'string' ? input.clientToken : null,
    images: input.images,
    lang: user.lang,
  });
  if (!result.ok) {
    if (result.error === 'insufficient_credits') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
    if (result.error === 'price_changed') return fail('price_changed', 409, { prices: result.prices });
    return fail(result.error, result.error === 'daily_limit' ? 429 : 422);
  }
  if (result.duplicate) return json({ id: result.id, duplicate: true });
  after(() => processPrivatePost(result.id).catch((error: unknown) => console.error(`private post ${result.id} not answered: ${error instanceof Error ? error.message : 'unknown'}`)));
  return json({ id: result.id }, 201);
}
