/**
 * POST /api/agent -- one exchange of the workbench conversation
 * (agent-first-proposal.md 4.4, 4.5, 5). The playground's Agent loop and
 * generation chain (playground/agent.ts), run for the signed-in owner with
 * the workbench's tools; the stream is the playground's, plus the
 * confirmation cards and listings the server writes (lib/http/agent-events.ts).
 *
 * Session only: the workbench is a person at the Dashboard, and a pending
 * action it proposes is confirmed by that person on a card. A Bearer key is
 * not a workbench -- an agent calling with one uses A2A, where the same gate
 * holds. Same-origin only, like the other session POSTs.
 *
 * One question costs one Call, as in the playground, when retrieval served
 * it; listing and proposing cost nothing (proposal 8.2). The exchange is
 * recorded in the conversation it names, or a new one.
 */
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { appendTurn, ownsConversation, startConversation } from '@/lib/application/agent';
import { resolveSession } from '@/lib/application/auth';
import { streamAgentPlayground } from '@/lib/application/playground/agent';
import { normaliseHistory } from '@/lib/domain/generation';
import { emptyRecord, writeAgentEvent } from '@/lib/http/agent-events';
import type { PlaygroundUIMessage } from '@/lib/http/playground-stream';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import { isSameOriginHeaders, SESSION_COOKIE } from '@/lib/http/session';

export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = newRequestId();
  try {
    if (!isSameOriginHeaders((name) => request.headers.get(name))) {
      throw new AppError('access_denied', 'cross-site request refused');
    }
    const session = await resolveSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) throw new AppError('access_denied', 'sign in to use the workbench');

    let body: { question?: unknown; history?: unknown; conversationId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (question.length === 0 || question.length > 2_000) {
      throw new AppError('invalid_request', 'question is required (1-2000 characters)');
    }
    const history = normaliseHistory(body.history);
    const workspaceId = session.workspace.id;
    /* A conversation that is not this workspace's -- stale, or someone else's -- is a new one. */
    const named =
      typeof body.conversationId === 'string' && UUID.test(body.conversationId) && (await ownsConversation(workspaceId, body.conversationId))
        ? body.conversationId
        : null;
    const conversationId = named ?? (await startConversation({ workspaceId, userId: session.user.id, title: question }));
    await appendTurn({ workspaceId, conversationId, role: 'user', content: { question } });

    const caller = { workspaceId, apiKeyId: null, requestId, anonymous: false, entrypoint: 'web' as const };
    const events = streamAgentPlayground(caller, {
      question,
      history,
      pinned: null,
      workbench: { workspaceId, userId: session.user.id, role: session.workspace.role, conversationId },
    });

    const stream = createUIMessageStream<PlaygroundUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: 'start' });
        writer.write({ type: 'data-conversation', data: { id: conversationId } });
        const record = emptyRecord();
        try {
          for await (const event of events) writeAgentEvent(writer, event, { question, requestId, record });
        } catch (error) {
          /* requirement.md 5.1: never an error page once the stream is open; the chunks shown stand. */
          console.error(`workbench stream failed: ${error instanceof Error ? error.message : 'unknown'}`);
          writer.write({ type: 'data-outcome', data: { kind: 'degraded' } });
          record.outcome = 'degraded';
        }
        await appendTurn({ workspaceId, conversationId, role: 'assistant', content: { ...record } }).catch(() => {});
      },
    });
    return createUIMessageStreamResponse({ stream, headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
