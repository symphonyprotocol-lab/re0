/**
 * POST /api/embed/ask -- one question from the website widget.
 * requirement.md 9.4, lib/application/embed, lib/http/widget-ask.ts.
 *
 * The widget's own BFF, not part of /v1: the body carries the site key and
 * the question, and the response is a newline-delimited JSON stream the
 * widget page reads line by line (`WidgetStreamLine`). What this route
 * decides is who may ask: the embedding page's origin, as the loader
 * reported it, and the browser's own `Origin` header must both be ones the
 * owner listed -- except that the browser's may be this deployment, where
 * the widget page lives, and the owner's own preview from the dashboard is
 * admitted by the session that owns the key. The answering is shared with
 * the showcase page.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { AppError } from '@/contracts/errors';
import { requireParentOrigin, resolveSiteKey } from '@/lib/application/embed';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { isPreviewOwner, isPreviewParent } from '@/lib/http/embed-preview';
import { normaliseHistory } from '@/lib/domain/generation';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import { readQuestion, streamWidgetAnswer } from '@/lib/http/widget-ask';

export type { WidgetStreamLine } from '@/lib/http/widget-ask';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  try {
    let body: { key?: unknown; question?: unknown; parent?: unknown; history?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const question = readQuestion(body.question);
    const principal = await resolveSiteKey(body.key);

    const parent = typeof body.parent === 'string' ? body.parent : null;
    /* The owner's preview (lib/http/embed-preview.ts) is admitted by the
       session that owns the key; every other parent by the allowlist. */
    const preview = isPreviewParent(parent, request);
    if (preview) {
      if (!(await isPreviewOwner(request, principal.workspaceId))) {
        throw new AppError('access_denied', 'the preview is for the key\'s own workspace');
      }
    } else {
      requireParentOrigin(principal, parent);
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== configuredBaseUrl() && origin !== new URL(request.url).origin) {
      requireParentOrigin(principal, origin);
    }

    return await streamWidgetAnswer({
      request,
      principal,
      question,
      parent,
      preview,
      markOrigin: true,
      requestId,
      startedAt,
      history: normaliseHistory(body.history),
    });
  } catch (error) {
    return errorResponse(error, requestId) as unknown as NextResponse;
  }
}
