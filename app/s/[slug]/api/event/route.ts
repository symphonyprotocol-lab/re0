/**
 * POST /s/[slug]/api/event -- a page view or a CTA click, counted
 * per day (lib/application/showcase/events.ts). A beacon: the page does not
 * wait for it, and nothing about the visitor is kept.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { lookupShowcase, noteShowcaseEvent } from '@/lib/application/showcase';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { rateLimitKey } from '@/lib/http/auth-endpoints';
import { showcaseGateFor } from '@/lib/http/showcase-gate';
import { isShowcaseOrigin } from '@/lib/http/widget-ask';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';

export const runtime = 'nodejs';

/** One browser's share: generous for a reader, far too small for a script inflating the counts. */
const RULE = { limit: 120, windowSeconds: 3_600 };

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  /* agent-first-proposal.md 3.6: shared pages are offline. */
  if (!surfaceEnabled('showcase')) return new NextResponse(null, { status: 404 });
  const { slug } = await context.params;
  const window = await strictRateLimit(await rateLimitKey(request, `showcase:event:${slug}`), RULE);
  if (!window.allowed) return new NextResponse(null, { status: 429, headers: { 'retry-after': String(window.retryAfterSeconds) } });
  let body: { event?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* A beacon with no body counts as a view. */
  }
  const event = body.event === 'cta_click' ? 'cta_click' : body.event === 'view' || body.event === undefined ? 'view' : null;
  if (!event) return new NextResponse(null, { status: 400 });
  const found = await lookupShowcase(slug);
  if (found.kind !== 'page') return new NextResponse(null, { status: 404 });
  if (!isShowcaseOrigin(request.headers.get('origin'), request, configuredBaseUrl(), found.page.customHost)) return new NextResponse(null, { status: 403 });
  if ((await showcaseGateFor(request.cookies, found.page.gate)) !== 'open') return new NextResponse(null, { status: 403 });
  noteShowcaseEvent(found.page.id, event);
  return new NextResponse(null, { status: 204 });
}
