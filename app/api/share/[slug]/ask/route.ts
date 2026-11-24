import { after, type NextRequest } from 'next/server';
import { clientIp } from '@/lib/http/client-ip';
import { rateLimited } from '@/lib/http/rate-limit';
import { body, fail, json } from '@/lib/http/respond';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { keepVisitor, visitorOf } from '@/lib/http/share';
import { processPost } from '@/lib/services/posts';
import { askAsVisitor, tellOwnerVisitorsBlocked, visitorAskStatus } from '@/lib/services/visitor-asks';
import { FINGERPRINT_HEADER } from '@/lib/domain/visitor-ask';

export const maxDuration = 300;

type Context = { params: Promise<{ slug: string }> };

/** After the response, best-effort: the visitor's request never waits for, nor fails with, the owner's notice (at most one a day). */
function tellOwnerLater(reeId: string): void {
  after(() => tellOwnerVisitorsBlocked(reeId).then(() => undefined, (error: unknown) => console.error(`visitor-ask notice for ree ${reeId} failed: ${error instanceof Error ? error.message : 'unknown'}`)));
}

/**
 * `GET /api/share/[slug]/ask` → `{open, remaining, limit, blocked, asked}`:
 * a signed-out visitor's box on the share page -- whether the owner lets
 * visitors ask, what this browser has left today, and its questions of the
 * last days with their answers. A private or unknown Ree is 404; past the
 * signed-out browsing limit, 429.
 */
export async function GET(request: NextRequest, context: Context) {
  /* Polled while a question is pending: held to the signed-out browsing limit. */
  const limited = await rateLimited('browse', { userId: null, headers: request.headers });
  if (limited) return limited;
  const visitor = visitorOf(request);
  const status = await visitorAskStatus((await context.params).slug, { fingerprint: request.headers.get(FINGERPRINT_HEADER) ?? '', visitorId: visitor.id, ip: clientIp(request.headers) });
  if (!status) return fail('not_found', 404);
  /* The box will not offer to send at all: this is where the owner hears visitors are being turned away. */
  if (status.blocked === 'owner_credits') tellOwnerLater(status.reeId);
  return keepVisitor(json(status), visitor);
}

/**
 * `POST /api/share/[slug]/ask` `{question, fingerprint, lang}` → 201 `{id}`:
 * a signed-out visitor asks the Ree on its share page, its owner paying
 * (lib/services/visitor-asks.ts); the same text again within a minute →
 * 200 with the question already made. Same-origin only. Refused: 409
 * `signed_in` (a signed-in user posts as themselves), 403 `closed`, 429
 * `visitor_limit` / `network_limit` / `capacity`, 402 `owner_credits`, 422
 * `empty` / `too_long` / `invalid_visitor`. Review and the answer run after
 * the response; the box polls GET.
 */
export async function POST(request: NextRequest, context: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  if (await currentUser()) return fail('signed_in', 409);
  const visitor = visitorOf(request);
  const input = await body(request);
  const result = await askAsVisitor(
    (await context.params).slug,
    { question: String(input.question ?? ''), lang: input.lang === 'en' ? 'en' : 'zh' },
    { fingerprint: String(input.fingerprint ?? ''), visitorId: visitor.id, ip: clientIp(request.headers) },
  );
  if (!result.ok) {
    if (result.error === 'owner_credits') tellOwnerLater(result.reeId);
    const status = result.error === 'closed' ? 403 : result.error === 'owner_credits' ? 402 : result.error === 'empty' || result.error === 'too_long' || result.error === 'invalid_visitor' ? 422 : 429;
    return keepVisitor(fail(result.error, status), visitor);
  }
  if (result.duplicate) return keepVisitor(json({ id: result.id, duplicate: true }), visitor);
  after(() => processPost(result.id).catch((error: unknown) => console.error(`visitor post ${result.id} not processed: ${error instanceof Error ? error.message : 'unknown'}`)));
  return keepVisitor(json({ id: result.id }, 201), visitor);
}
