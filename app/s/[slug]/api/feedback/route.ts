/**
 * POST /s/[slug]/api/feedback -- the visitor's thumbs on one answer.
 * The exchange must be the page's own (lib/application/showcase/events.ts).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { recordShowcaseFeedback, resolveShowcasePrincipal } from '@/lib/application/showcase';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { rateLimitKey } from '@/lib/http/auth-endpoints';
import { assertShowcaseOpen } from '@/lib/http/showcase-gate';
import { isShowcaseOrigin } from '@/lib/http/widget-ask';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';

export const runtime = 'nodejs';

/** One browser's share: generous for a reader, far too small for a script inflating the counts. */
const RULE = { limit: 60, windowSeconds: 3_600 };

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;
  const window = await strictRateLimit(await rateLimitKey(request, `showcase:feedback:${slug}`), RULE);
  if (!window.allowed) return new NextResponse(null, { status: 429, headers: { 'retry-after': String(window.retryAfterSeconds) } });
  let body: { exchangeId?: unknown; feedback?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const feedback = body.feedback === 'helpful' || body.feedback === 'unhelpful' ? body.feedback : body.feedback === null ? null : undefined;
  if (feedback === undefined || typeof body.exchangeId !== 'string') return new NextResponse(null, { status: 400 });
  const page = await resolveShowcasePrincipal(slug);
  if (!page) return new NextResponse(null, { status: 404 });
  if (!isShowcaseOrigin(request.headers.get('origin'), request, configuredBaseUrl(), page.customHost)) return new NextResponse(null, { status: 403 });
  try {
    await assertShowcaseOpen(request, page.gate);
  } catch {
    return new NextResponse(null, { status: 403 });
  }
  const ok = await recordShowcaseFeedback({ siteKeyId: page.principal.siteKeyId, exchangeId: body.exchangeId, feedback });
  return new NextResponse(null, { status: ok ? 204 : 404 });
}
