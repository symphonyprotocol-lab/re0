/**
 * POST /api/playground -- the web playground's one exchange. architecture.md
 * 9.5 and 9.6: this is the server-side auto-routed entry -- the question goes
 * through the same resolve-library-id the MCP agent would call, the server
 * reads the top candidates and lets the confirmed ones answer together
 * (scatter-gather, retrieval/gather.ts), and the generation path does the
 * rest through the shared retrieval function. A BFF for the site, not part of
 * /v1: the stream it writes serves the transcript component and nothing else.
 *
 * The response is an AI SDK UI message stream, but it carries no model text
 * part: every claim arrives as a `data-claim` the server has already bound to
 * a chunk of this request (requirement.md 5.1 rule 5). Piping the model's own
 * text stream through would put unbindable prose on screen and then take it
 * back, which is the thing that rule forbids.
 *
 * The body may carry the turns before the question (`history`, at most three,
 * clipped by `normaliseHistory`). They resolve what a follow-up refers to and
 * nothing else: the planner (agent mode) or the rewrite on a miss (fixed
 * path) is shown them as data, and the answering call never is -- rule 4
 * confines the answer to the chunks this request retrieved, and a transcript
 * in that prompt is exactly the outside knowledge the rule excludes.
 *
 * Two paths (playground-agent-proposal.md). With the console's agent switch
 * on and a model that declares tool calling, the model plans its own
 * resolve-library-id and query-docs calls and the transcript shows each one
 * as it runs (`data-step`). Otherwise the fixed path below routes the
 * question once and reads the top candidates; a follow-up that routes
 * nowhere reads the libraries the last turn answered from.
 *
 * Which model runs is the console's decision, never the caller's: the body has
 * no model field, so a visitor cannot spend the platform's budget on the most
 * expensive entry configured. What the caller's plan buys decides which
 * entries it is answered by (the console's `audience`).
 *
 * Signed-in callers only (`playgroundCaller`): a visitor runs as their
 * workspace, metered by its quota and answered by its plan's models; a
 * Bearer key works the same way, and is held to the same scopes it would
 * need on /v1 -- one exchange routes and then reads context, so a key that
 * may do neither must not do both here. Anyone else is refused before
 * anything is read or generated.
 *
 * An optional `libraryId` pins the exchange to one public library -- the
 * detail page's fixed entry (requirement.md 5.1: 针对该库的固定查询入口，复用
 * 在线试用的同一实现). Routing is skipped, nothing else changes.
 */
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { AppError } from '@/contracts/errors';
import { libraryIdSchema } from '@/contracts/schemas';
import { requireScope } from '@/lib/application/auth';
import { publicLibraryHeading } from '@/lib/application/libraries';
import { routeQuestion, streamPlayground } from '@/lib/application/playground';
import {
  playgroundAgentOn,
  streamAgentPlayground,
  type AgentEvent,
} from '@/lib/application/playground/agent';
import { fencedCodeBlocks } from '@/lib/domain/code-blocks';
import { normaliseHistory } from '@/lib/domain/generation';
import { playgroundCaller } from '@/lib/http/retrieval-caller';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import type { PlaygroundUIMessage } from '@/lib/http/playground-stream';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = newRequestId();
  try {
    const caller = await playgroundCaller(request, requestId);
    /* A Bearer key reaches this route too, and one exchange spends the same
       quota /v1 does: routing reads the catalogue and the answer reads chunks,
       so a key must hold both scopes here as it would there. A session
       carries no scopes and passes (requireScope). */
    requireScope(caller, 'knowledge:search');
    requireScope(caller, 'knowledge:read');

    let body: { question?: unknown; libraryId?: unknown; history?: unknown };
    try {
      body = (await request.json()) as { question?: unknown; libraryId?: unknown; history?: unknown };
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (question.length === 0 || question.length > 2_000) {
      throw new AppError('invalid_request', 'question is required (1-2000 characters)');
    }
    const pinnedId =
      body.libraryId === undefined || body.libraryId === null || body.libraryId === ''
        ? null
        : libraryIdSchema.safeParse(body.libraryId);
    if (pinnedId && !pinnedId.success) {
      throw new AppError('invalid_request', 'libraryId must look like /owner/name');
    }

    const history = normaliseHistory(body.history);

    /* A pinned id that is not a routable public library is a 404 here, before
       any stream opens, exactly as it would be on the detail page. */
    let pinned: { libraryId: string; title: string; version: string | null } | null = null;
    if (pinnedId) {
      const heading = await publicLibraryHeading(pinnedId.data);
      if (!heading) throw new AppError('library_not_found', 'no public library with that id');
      pinned = { libraryId: heading.publicId, title: heading.title, version: heading.version };
    }

    let events: AsyncIterable<AgentEvent>;
    if (await playgroundAgentOn(caller)) {
      events = streamAgentPlayground(caller, { question, history, pinned });
    } else {
      /*
       * Routing runs before the stream opens. It is one round trip and it
       * decides whether there is anything to stream at all, so a failure here
       * can still be an honest error response rather than a stream that opens
       * only to say nothing happened. A pinned library skips it: the caller
       * already chose.
       */
      const routed = pinned
        ? {
            candidates: [{ libraryId: pinned.libraryId, title: pinned.title }],
            top: pinned,
          }
        : await routeQuestion(caller, question, history);
      events = (async function* fixed(): AsyncGenerator<AgentEvent> {
        yield { type: 'routing', candidates: routed.candidates, top: routed.top, pinned: pinned !== null };
        if (!routed.top) {
          yield { type: 'no_library' };
          return;
        }
        yield* streamPlayground(caller, { libraries: routed.candidates, question, history });
      })();
    }

    const stream = createUIMessageStream<PlaygroundUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: 'start' });
        try {
          for await (const event of events) {
            if (event.type === 'routing') {
              writer.write({
                type: 'data-routing',
                data: {
                  question,
                  candidates: event.candidates,
                  libraryId: event.top?.libraryId ?? null,
                  libraryTitle: event.top?.title ?? null,
                  version: event.top?.version ?? null,
                  requestId,
                  pinned: event.pinned,
                },
              });
            } else if (event.type === 'no_library') {
              writer.write({ type: 'data-outcome', data: { kind: 'no_library' } });
            } else if (event.type === 'step') {
              /* Same id twice: the running card is replaced by the finished one. */
              writer.write({ type: 'data-step', id: event.step.id, data: event.step });
            } else if (event.type === 'resolved') {
              writer.write({ type: 'data-resolved', data: { question: event.question } });
            } else if (event.type === 'gather') {
              writer.write({
                type: 'data-gather',
                data: { libraries: event.libraries },
              });
            } else if (event.type === 'model') {
              writer.write({
                type: 'data-model',
                data: {
                  label: event.label,
                  audience: event.audience,
                  upgrade: event.upgrade,
                },
              });
            } else if (event.type === 'context') {
              writer.write({
                type: 'data-sources',
                data: {
                  sources: event.chunks.map((chunk) => ({
                    chunkId: chunk.chunkId,
                    sourceUrl: chunk.citation.sourceUrl,
                    documentTitle: chunk.citation.documentTitle,
                    section: chunk.citation.section,
                    libraryId: chunk.libraryId,
                    libraryTitle: chunk.libraryTitle,
                    codeBlocks: fencedCodeBlocks(chunk.text),
                  })),
                },
              });
            } else if (event.type === 'claim') {
              writer.write({
                type: 'data-claim',
                data: { claim: event.claim, chunkIds: event.chunkIds },
              });
            } else if (event.type === 'rewrite') {
              writer.write({ type: 'data-rewrite', data: { query: event.query } });
            } else {
              writer.write({
                type: 'data-outcome',
                data: { kind: event.kind },
              });
            }
          }
        } catch (error) {
          /*
           * Rule 6: the reader gets the chunks and a degraded notice, never an
           * error page -- and the stream is already open, so this is the only
           * place left to say so.
           */
          console.error(
            `playground stream failed: ${error instanceof Error ? error.message : 'unknown'}`,
          );
          writer.write({ type: 'data-outcome', data: { kind: 'degraded' } });
        }
      },
    });

    return createUIMessageStreamResponse({
      stream,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return errorResponse(error, requestId) as unknown as NextResponse;
  }
}
