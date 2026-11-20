import { after, type NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { processPrivatePost } from '@/lib/services/private-posts';
import { askReeTry, clearReeTries, listReeTries } from '@/lib/services/ree-try';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 * 试问: `{question, detail?, clientToken?}` asks the owner's own Ree → 201
 * `{id}`, the private post (`source = 'test'`) its answer is written to after
 * the response (the page polls `GET`); the same token → 200 with the post
 * already made. 402 with the balance; 422 `empty` / `too_long`; 404 for a Ree
 * that is not the caller's.
 */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('ask', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const result = await askReeTry(user.id, (await context.params).id, {
    question: String(input.question ?? ''),
    detail: String(input.detail ?? ''),
    clientToken: typeof input.clientToken === 'string' ? input.clientToken : null,
    lang: user.lang,
  });
  if (!result) return fail('not_found', 404);
  if (!result.ok) {
    if (result.error === 'insufficient_credits') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
    if (result.error === 'price_changed') return fail('price_changed', 409, { prices: result.prices });
    return fail(result.error, 422);
  }
  if (result.duplicate) return json({ id: result.id, duplicate: true });
  after(() => processPrivatePost(result.id).catch((error: unknown) => console.error(`ree try ${result.id} not answered: ${error instanceof Error ? error.message : 'unknown'}`)));
  return json({ id: result.id }, 201);
}

/** The owner's latest 试问 of this Ree, newest first, as post views: `{items}`. */
export async function GET(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const items = await listReeTries(user.id, (await context.params).id);
  if (!items) return fail('not_found', 404);
  return json({ items });
}

/** 清空: deletes the owner's finished 试问 of this Ree → `{cleared}` (how many). */
export async function DELETE(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const cleared = await clearReeTries(user.id, (await context.params).id);
  if (cleared === null) return fail('not_found', 404);
  return json({ cleared });
}
