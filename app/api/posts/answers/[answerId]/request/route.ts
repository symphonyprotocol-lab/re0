import { after, type NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { agreePaidAnswer, answerPaid, declinePaidAnswer } from '@/lib/services/posts';

type Context = { params: Promise<{ answerId: string }> };

/**
 * A paid Ree's request to answer the caller's post. `{action: 'agree', price}`
 * holds the price shown and starts the answer → `{ok}`; a higher price now is
 * `409 price_changed` with `{price}`, too little balance `402 insufficient`
 * with `{balance, needed}`, a Ree that can no longer answer `409 unavailable`
 * (the request is closed), one agreed already (another tab) `409 already`.
 * `{action: 'decline'}` → `{ok}`. Only whoever asked: the post's author for
 * its first round, the asker for a follow-up's (追问).
 */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const id = (await params).answerId;
  const input = await body(request);
  if (input.action === 'decline') return (await declinePaidAnswer(user.id, id)) ? json({ ok: true }) : fail('not_found', 404);
  if (input.action !== 'agree') return fail('invalid_action', 422);
  const result = await agreePaidAnswer(user.id, id, input.price);
  if (result.ok) {
    after(() => answerPaid(id).catch((error: unknown) => console.error(`paid answer ${id} not written: ${error instanceof Error ? error.message : 'unknown'}`)));
    return json({ ok: true });
  }
  if (result.error === 'price_changed') return json({ error: 'price_changed', price: result.price }, 409);
  if (result.error === 'insufficient') return json({ error: 'insufficient', balance: result.balance, needed: result.needed }, 402);
  if (result.error === 'unavailable' || result.error === 'already') return fail(result.error, 409);
  return fail('not_found', 404);
}
