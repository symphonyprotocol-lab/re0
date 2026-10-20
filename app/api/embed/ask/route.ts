/**
 * POST /api/embed/ask -- one question from the website widget.
 * requirement.md 9.4, lib/application/embed.
 *
 * The widget's own BFF, not part of /v1: the body carries the site key and
 * the question, and the response is a newline-delimited JSON stream the
 * widget page reads line by line. Generation is the playground's
 * (architecture.md 9.5): the same retrieval, the same binding of every
 * sentence to a retrieved passage, and the same degradation to the passage
 * list when no model is configured -- which is what makes the widget a site
 * search even before it is a chat.
 *
 * Who asks is the owner's workspace, by way of the site key; what stops a
 * public key spending that workspace's quota is `admitWidgetQuestion`. The
 * library is pinned by the key, so no routing runs and no other library is
 * read.
 *
 * Order matters for what gets charged: a library that cannot answer yet is
 * told so before the limiters run, so retries against a building library do
 * not spend the owner's day; the limiters run before retrieval, which is the
 * only place they can stand in front of it.
 *
 * The browser's `Origin` is checked when present: the widget page is served
 * from this deployment, so a request from it carries this origin, and one
 * from the owner's site directly carries a listed origin. Anything else is
 * refused before the limiter is touched.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { AppError } from '@/contracts/errors';
import {
  admitWidgetQuestion,
  noteWidgetOrigin,
  requireParentOrigin,
  resolveSiteKey,
  widgetCaller,
} from '@/lib/application/embed';
import { streamPlayground } from '@/lib/application/playground';
import { pagesOf, type WidgetSource } from '@/lib/domain/widget';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { isPreviewOwner, isPreviewParent } from '@/lib/http/embed-preview';
import { errorResponse, newRequestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

/**
 * One line of the stream. The widget page (public/embed-app.js) reads these.
 *
 * `outcome.kind` is what the visitor is told at the end: the playground's
 * three, plus `not_ready` (the library has no published version) and
 * `unavailable` (the exchange was refused after the stream opened -- the
 * workspace's quota is spent, or the library was suspended meanwhile).
 */
export type WidgetStreamLine =
  | { type: 'allowance'; remaining: number; limit: number }
  | {
      type: 'sources';
      /** One entry per page, in the order retrieval ranked its first passage. */
      sources: WidgetSource[];
    }
  | { type: 'claim'; text: string; chunkIds: string[] }
  /** The question missed and was searched again as `query`; the sources are that search's. */
  | { type: 'rewrite'; query: string }
  | {
      type: 'outcome';
      kind: 'answer' | 'no_context' | 'degraded' | 'not_ready' | 'unavailable';
    };

/** Refusals retrieval can raise once the stream is open, and what each means to a visitor. */
const UNAVAILABLE_CODES = new Set<string>([
  'quota_exceeded',
  'subscription_required',
  'library_not_ready',
  'library_suspended',
  'library_not_found',
  'access_rule_blocked',
  'access_denied',
]);

function ndjson(lines: (write: (line: WidgetStreamLine) => void) => Promise<void>, requestId: string): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /* A visitor who closes the widget mid-answer cancels the stream; a
         write after that must not turn a routine abort into an error. */
      const write = (line: WidgetStreamLine) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        await lines(write);
      } finally {
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-re0-request-id': requestId,
    },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = newRequestId();
  try {
    let body: { key?: unknown; question?: unknown; parent?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (question.length === 0 || question.length > 2_000) {
      throw new AppError('invalid_request', 'question is required (1-2000 characters)');
    }

    const principal = await resolveSiteKey(body.key);

    /* The embedding page's origin, as the loader reported it, and the
       browser's own Origin header: both must be ones the owner listed, except
       that the browser's may be this deployment, where the widget page lives. */
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

    /* Nothing to retrieve from yet: say so without touching the limiters. */
    if (!principal.ready) {
      return ndjson(async (write) => {
        write({ type: 'outcome', kind: 'not_ready' });
      }, requestId);
    }

    const allowance = await admitWidgetQuestion(request, principal);
    /* Admitted, so it will be answered and charged: count it against the
       site -- unless the site is the owner's own dashboard. */
    if (!preview) noteWidgetOrigin(principal.siteKeyId, parent, 'question');
    const caller = widgetCaller(principal, requestId);

    return ndjson(async (write) => {
      write({ type: 'allowance', remaining: allowance.remaining, limit: allowance.limit });
      try {
        for await (const event of streamPlayground(caller, {
          libraries: [{ libraryId: principal.libraryPublicId, title: principal.libraryTitle }],
          question,
        })) {
          if (event.type === 'context') {
            write({ type: 'sources', sources: pagesOf(event.chunks) });
          } else if (event.type === 'claim') {
            write({ type: 'claim', text: event.claim, chunkIds: event.chunkIds });
          } else if (event.type === 'rewrite') {
            write({ type: 'rewrite', query: event.query });
          } else if (event.type === 'done') {
            write({ type: 'outcome', kind: event.kind });
          }
        }
      } catch (error) {
        /*
         * The stream is open, so this is the only place left to say so. A
         * refusal retrieval itself raised -- the workspace out of Calls, the
         * library suspended since the key was resolved -- is told as
         * `unavailable`, which the widget words honestly; anything else is a
         * fault, logged, and degrades to whatever passages arrived.
         */
        const refused = error instanceof AppError && UNAVAILABLE_CODES.has(error.code);
        if (!refused) {
          console.error(
            `widget stream failed requestId=${requestId}: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        }
        write({ type: 'outcome', kind: refused ? 'unavailable' : 'degraded' });
      }
    }, requestId);
  } catch (error) {
    return errorResponse(error, requestId) as unknown as NextResponse;
  }
}
