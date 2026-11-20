import type { NextRequest } from 'next/server';
import { clientIp } from '@/lib/http/client-ip';
import { appBaseUrl } from '@/lib/http/cookies';
import { fail, json } from '@/lib/http/respond';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { keepVisitor, visitorOf } from '@/lib/http/share';
import { isBotAgent } from '@/lib/domain/traffic';
import { recordPageView } from '@/lib/services/traffic';

/** The hosts this site answers on: APP_BASE_URL's and the one the request was sent to (a preview URL, localhost). */
function ownHosts(request: NextRequest): string[] {
  const hosts = [new URL(appBaseUrl()).hostname];
  const sent = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (sent) hosts.push(sent.split(':')[0]!);
  return hosts.map((host) => host.toLowerCase());
}

/**
 * `POST /api/track/view` `{path, referrer, utm_source, utm_medium, utm_campaign}`
 * → `{result}`: the root layout's page-view beacon (components/shell/page-view.tsx),
 * once per page open and per client-side move to a new route. Open to
 * visitors; same-origin only, so another site cannot inflate the count. A
 * crawler or preview fetcher (by user agent, which is not stored) and a
 * path that is never counted get `{result: 'ignored'}`. A browser without
 * the visitor cookie gets one and `{result: 'cookie'}`, and sends the beacon
 * once more. Past the IP limit, 429.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  if (isBotAgent(request.headers.get('user-agent'))) return json({ result: 'ignored' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail('invalid_body', 400);
  const visitor = visitorOf(request);
  const user = await currentUser();
  const result = await recordPageView({
    path: body.path,
    referrer: body.referrer,
    utmSource: body.utm_source,
    utmMedium: body.utm_medium,
    utmCampaign: body.utm_campaign,
    visitorId: visitor.id,
    freshVisitor: visitor.fresh,
    userId: user?.id ?? null,
    ip: clientIp(request.headers),
    ownHosts: ownHosts(request),
  });
  if (result === 'limited') return fail('rate_limited', 429);
  /* An ignored path sets no cookie: nothing was counted, and the console must not hand one out. */
  return result === 'ignored' ? json({ result }) : keepVisitor(json({ result }), visitor);
}
