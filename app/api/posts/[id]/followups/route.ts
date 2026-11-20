import { after, type NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { askFollowup, processFollowup } from '@/lib/services/post-followups';
import { askPrivateFollowup, isPrivatePost, processPrivateFollowup } from '@/lib/services/private-posts';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 10) : []);

/**
 * `{question, mentionReeIds?, clientToken?}`: asks a follow-up (追问) under a
 * visible post → 201 `{id}`; the same token, or the same text within a
 * minute, → 200 with the follow-up already asked. Its review, answerers and
 * answers run after the response (the post page polls). Only Rees that
 * answered the first round may be @-mentioned (422 `mention_unavailable`);
 * 402 with the balance below one base fee; 429 `daily_limit` /
 * `post_daily_limit`; 409 `full`; 404 for a post that cannot be seen;
 * 422 `empty` / `too_long` / `no_candidates`.
 *
 * On a private post (私密提问), only its author, with `{addReeIds?, fees}`
 * too: no review, the Rees chosen and charged before the response at the
 * prices shown (409 `price_changed` with `prices`; 402 with the balance);
 * 422 `ree_unavailable` / `too_many_rees` past five Rees in the thread.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const id = (await params).id;
  const isPrivate = await isPrivatePost(id);
  const limited = await rateLimited(isPrivate ? 'ask' : 'post', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const question = String(input.question ?? '');
  const clientToken = typeof input.clientToken === 'string' ? input.clientToken : null;
  const status = { not_found: 404, daily_limit: 429, post_daily_limit: 429, full: 409 } as Record<string, number>;
  if (isPrivate) {
    const result = await askPrivateFollowup(user.id, id, {
      question,
      mentionReeIds: ids(input.mentionReeIds),
      addReeIds: ids(input.addReeIds),
      fees: typeof input.fees === 'object' && input.fees !== null && !Array.isArray(input.fees) ? (input.fees as Record<string, unknown>) : null,
      clientToken,
      lang: user.lang,
    });
    if (!result.ok) {
      if (result.error === 'insufficient_credits') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
      if (result.error === 'price_changed') return fail('price_changed', 409, { prices: result.prices });
      return fail(result.error, status[result.error] ?? 422);
    }
    if (result.duplicate) return json({ id: result.id, duplicate: true });
    after(() => processPrivateFollowup(result.id).catch((error: unknown) => console.error(`followup ${result.id} not answered: ${error instanceof Error ? error.message : 'unknown'}`)));
    return json({ id: result.id }, 201);
  }
  const result = await askFollowup(user.id, id, { question, mentionReeIds: ids(input.mentionReeIds), clientToken, lang: user.lang });
  if (!result.ok) {
    if (result.error === 'insufficient_credits') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
    return fail(result.error, status[result.error] ?? 422);
  }
  if (result.duplicate) return json({ id: result.id, duplicate: true });
  after(() => processFollowup(result.id).catch((error: unknown) => console.error(`followup ${result.id} not processed: ${error instanceof Error ? error.message : 'unknown'}`)));
  return json({ id: result.id }, 201);
}
