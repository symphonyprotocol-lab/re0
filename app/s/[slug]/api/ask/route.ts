/**
 * POST /s/[slug]/api/ask -- one question from a showcase page.
 * lib/application/showcase, lib/http/widget-ask.ts.
 *
 * The page names itself by its path, never by key: its internal site key
 * stays server-side, resolved here from the slug, so nothing in the page's
 * HTML can be lifted into another site. The browser's `Origin`, when sent,
 * must be this deployment or the page's own host. Under `/s/{slug}` like
 * the page itself, so the unlock cookie can be scoped to that path. The answering, the brakes and the exchange log are
 * the widget's; the stream opens with the log row's id so the page can
 * send the visitor's thumbs for it.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { AppError } from '@/contracts/errors';
import { noteShowcaseEvent, resolveShowcasePrincipal } from '@/lib/application/showcase';
import { uuidv7 } from '@/lib/domain/id';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { normaliseHistory } from '@/lib/domain/generation';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import { assertShowcaseOpen } from '@/lib/http/showcase-gate';
import { isShowcaseOrigin, readQuestion, streamWidgetAnswer } from '@/lib/http/widget-ask';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  /* agent-first-proposal.md 3.6: shared pages are offline. */
  if (!surfaceEnabled('showcase')) return new NextResponse(null, { status: 404 });
  const requestId = newRequestId();
  const startedAt = Date.now();
  try {
    const { slug } = await context.params;
    let body: { question?: unknown; history?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const question = readQuestion(body.question);
    const page = await resolveShowcasePrincipal(slug);
    if (!page) throw new AppError('library_not_found', 'no such page');
    if (!isShowcaseOrigin(request.headers.get('origin'), request, configuredBaseUrl(), page.customHost)) {
      throw new AppError('access_denied', 'a showcase page answers only on its own site');
    }
    await assertShowcaseOpen(request, page.gate);

    const exchangeId = uuidv7();
    return await streamWidgetAnswer({
      request,
      principal: page.principal,
      question,
      parent: new URL(request.url).origin,
      preview: false,
      markOrigin: false,
      requestId,
      startedAt,
      exchangeId,
      preface: [{ type: 'exchange', id: exchangeId }],
      onAdmitted: () => noteShowcaseEvent(page.showcaseId, 'question'),
      history: normaliseHistory(body.history),
    });
  } catch (error) {
    return errorResponse(error, requestId) as unknown as NextResponse;
  }
}
