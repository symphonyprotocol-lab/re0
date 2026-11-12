import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { QUESTION_MAX_CHARS } from '@/lib/constants';
import {
  ANONYMOUS_ID_COOKIE,
  ANONYMOUS_ID_MAX_AGE_SECONDS,
  anonymousHistory,
  FINGERPRINT_HEADER,
  refusalCodeOf,
  validAnonymousId,
  validFingerprint,
  type AnonymousRefusalBody,
} from '@/lib/domain/anonymous-chat';
import { isSecureDeployment } from '@/lib/http/cookies';
import { clientIp } from '@/lib/http/conversations';
import { rateLimited } from '@/lib/http/rate-limit';
import { body, fail, json } from '@/lib/http/respond';
import { sameOrigin } from '@/lib/http/session';
import { VISITOR_COOKIE } from '@/lib/http/share';
import { anonymousAnswerResponse, anonymousQuota, freeReeForAnonymous, reserveRound, visitorKeys } from '@/lib/services/anonymous-chat';
import { shareVisitorFor } from '@/lib/services/share';
import { isLocale, localeFromRequest } from '@/i18n/locale';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/** The visitor's anonymous id: the cookie's, or a new one the response sets. */
function anonymousIdOf(request: NextRequest): { id: string; fresh: boolean } {
  const current = request.cookies.get(ANONYMOUS_ID_COOKIE)?.value;
  return validAnonymousId(current) ? { id: current, fresh: false } : { id: randomUUID(), fresh: true };
}

function anonymousIdCookie(id: string): string {
  return `${ANONYMOUS_ID_COOKIE}=${id}; Path=/; Max-Age=${ANONYMOUS_ID_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${isSecureDeployment() ? '; Secure' : ''}`;
}

function withCookie<T extends Response>(response: T, anonymousId: { id: string; fresh: boolean }): T {
  if (anonymousId.fresh) response.headers.append('set-cookie', anonymousIdCookie(anonymousId.id));
  return response;
}

/**
 * Anonymous chat with a free Ree (lib/services/anonymous-chat.ts). `GET` →
 * `{limit, remaining, blocked}`, today's rounds left for this visitor and
 * whether a shared limit stops them. Both methods need the browser
 * fingerprint in `x-re0-fingerprint` and a client address (`400
 * client_ip_required` without one); a Ree that is not public, published
 * and free is `404 anonymous_unavailable`.
 */
export async function GET(request: NextRequest, context: Context) {
  const ree = await freeReeForAnonymous((await context.params).id);
  if (!ree) return fail('anonymous_unavailable', 404);
  const fingerprint = request.headers.get(FINGERPRINT_HEADER);
  if (!validFingerprint(fingerprint)) return fail('fingerprint_required', 400);
  const ip = clientIp(request.headers);
  if (!ip) return fail('client_ip_required', 400);
  const anonymousId = anonymousIdOf(request);
  const keys = await visitorKeys({ fingerprint, anonymousId: anonymousId.id, ip, reeId: ree.id });
  return withCookie(json(await anonymousQuota(keys)), anonymousId);
}

/**
 * `{question, history?, lang?, source?}` → the answer as a `useChat` UI
 * message stream, ending on a `data-quota` part with the rounds left.
 * Refused before anything is asked with `429` and `{error, scope, limit,
 * remaining, blocked}`: `anonymous_quota_exceeded` (the visitor's own
 * rounds or attempts), `anonymous_network_limit` (their address's) or
 * `anonymous_capacity_reached` (the Ree's or the platform's day). `history`: the earlier turns the browser
 * kept, capped (anonymousHistory). `source: 'share'` from the share page
 * `/s/[slug]`: the answer counts for the share page when this browser's
 * visitor cookie shows a visit there (share.ts `shareVisitorFor`).
 */
export async function POST(request: NextRequest, context: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const limited = await rateLimited('ask', { userId: null, headers: request.headers });
  if (limited) return limited;
  const ree = await freeReeForAnonymous((await context.params).id);
  if (!ree) return fail('anonymous_unavailable', 404);
  const fingerprint = request.headers.get(FINGERPRINT_HEADER);
  if (!validFingerprint(fingerprint)) return fail('fingerprint_required', 400);
  const input = await body(request);
  const question = String(input.question ?? '').trim();
  if (!question || question.length > QUESTION_MAX_CHARS) return fail('invalid_question', 422);
  const lang = isLocale(input.lang) ? input.lang : localeFromRequest((name) => request.cookies.get(name), request.headers.get('accept-language'));

  /* Without the address only keys the client makes up would count: refused, not asked for free. */
  const ip = clientIp(request.headers);
  if (!ip) return fail('client_ip_required', 400);

  const anonymousId = anonymousIdOf(request);
  const keys = await visitorKeys({ fingerprint, anonymousId: anonymousId.id, ip, reeId: ree.id });
  const reservation = await reserveRound(keys);
  if (!reservation.ok) {
    const refused: AnonymousRefusalBody = { error: refusalCodeOf(reservation.scope), scope: reservation.scope, ...reservation.quota };
    return withCookie(json(refused, 429), anonymousId);
  }
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (anonymousId.fresh) headers.append('set-cookie', anonymousIdCookie(anonymousId.id));
  const shareVisitorId = input.source === 'share' ? await shareVisitorFor(ree.id, request.cookies.get(VISITOR_COOKIE)?.value).catch(() => null) : null;
  return anonymousAnswerResponse({ ree, question, history: anonymousHistory(input.history), lang, shareVisitorId }, reservation, headers);
}
