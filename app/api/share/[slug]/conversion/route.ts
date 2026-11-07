import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { visitorOf } from '@/lib/http/share';
import { recordShareConversion } from '@/lib/services/share';

type Context = { params: Promise<{ slug: string }> };

/**
 * `POST /api/share/[slug]/conversion` `{conversationId}` → `{result}`: the
 * signed-in visitor started or joined a conversation with the Ree from
 * `/s/[slug]`. The conversation must be theirs and have just taken the
 * Ree in, and this browser must have visited the share page; otherwise the
 * answer is `unattributed` and nothing is counted. No visitor cookie, no
 * visit: nothing to attribute, so no cookie is set here.
 */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  const visitor = visitorOf(request);
  if (visitor.fresh) return json({ result: 'unattributed' });
  const result = await recordShareConversion({ slug: (await context.params).slug, visitorId: visitor.id, userId: user.id, conversationId: String(input.conversationId ?? '') });
  if (result === 'not_found') return fail('not_found', 404);
  return json({ result });
}
