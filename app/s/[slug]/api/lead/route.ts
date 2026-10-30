/**
 * POST /s/[slug]/api/lead -- a visitor the page could not answer
 * leaves their contact (lib/application/showcase/leads.ts).
 *
 * Only a published page takes leads, only from its own site, and only a
 * few per browser: five an hour is a person, more is a script. The page's
 * daily cap keeps one page from filling the owner's inbox.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { AppError } from '@/contracts/errors';
import { LeadInvalid, recordShowcaseLead, resolveShowcasePrincipal } from '@/lib/application/showcase';
import { rateLimitKey } from '@/lib/http/auth-endpoints';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import { assertShowcaseOpen } from '@/lib/http/showcase-gate';
import { isShowcaseOrigin } from '@/lib/http/widget-ask';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';

export const runtime = 'nodejs';

const VISITOR_RULE = { limit: 5, windowSeconds: 3_600 };
const PAGE_RULE = { limit: 200, windowSeconds: 86_400 };

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  /* agent-first-proposal.md 3.6: shared pages are offline. */
  if (!surfaceEnabled('showcase')) return new NextResponse(null, { status: 404 });
  const requestId = newRequestId();
  try {
    const { slug } = await context.params;
    let body: { email?: unknown; name?: unknown; message?: unknown; exchangeId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }

    const page = await resolveShowcasePrincipal(slug);
    if (!page) throw new AppError('library_not_found', 'no such page');
    if (!isShowcaseOrigin(request.headers.get('origin'), request, configuredBaseUrl(), page.customHost)) {
      throw new AppError('access_denied', 'a showcase page takes leads only on its own site');
    }
    await assertShowcaseOpen(request, page.gate);

    const visitor = await strictRateLimit(await rateLimitKey(request, `showcase:lead:${slug}`), VISITOR_RULE);
    if (!visitor.allowed) throw new AppError('rate_limited', 'too many leads from this browser');
    const daily = await strictRateLimit(`showcase:lead:daily:${page.showcaseId}`, PAGE_RULE);
    if (!daily.allowed) throw new AppError('quota_exceeded', 'this page has taken enough leads for today');

    await recordShowcaseLead({
      showcaseId: page.showcaseId,
      assetId: page.principal.assetId,
      workspaceId: page.principal.workspaceId,
      siteKeyId: page.principal.siteKeyId,
      exchangeId: body.exchangeId,
      email: body.email,
      name: body.name,
      message: body.message,
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof LeadInvalid) {
      return NextResponse.json({ error: { code: 'invalid_request', field: error.field, requestId } }, { status: 400 });
    }
    return errorResponse(error, requestId) as unknown as NextResponse;
  }
}
