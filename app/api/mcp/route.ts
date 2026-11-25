import type { NextRequest } from 'next/server';
import { apiKeyCaller, bearerToken } from '@/lib/http/api-key';
import { authInfoFor, mcpHandlerFor } from '@/lib/http/mcp';
import { noteKeyClient } from '@/lib/services/api-keys';
import { clientFromUserAgent } from '@/lib/domain/workspace';
import { fail } from '@/lib/http/respond';
import { sameOrigin } from '@/lib/http/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/*
 * An `ask_ree` waits for the whole answer, as a web question streams it; and
 * `add_knowledge` processes its source after the call, as the web's
 * knowledge routes do, so it gets their time (`KNOWLEDGE_RUN_MAX_MS`): a run
 * cut short is resumed by the cron, but uses up one of its resumes.
 */
export const maxDuration = 800;

/**
 * The MCP server (Streamable HTTP; `lib/http/mcp.ts`), for clients that send
 * `Authorization: Bearer re0_sk_…`. No session cookie is read here and no
 * CORS header is sent; a browser page on another origin is refused outright
 * (the MCP transport's Origin rule), so a key never works from someone
 * else's site.
 */
async function serve(request: NextRequest): Promise<Response> {
  if (request.headers.get('origin') && !sameOrigin(request.headers)) return fail('cross_origin', 403);
  const caller = await apiKeyCaller(request);
  if (caller instanceof Response) return caller;
  /* A request whose User-Agent names a known tool is that tool's, even on a key another tool connected with last. */
  const agent = clientFromUserAgent(request.headers.get('user-agent'));
  if (agent) caller.clientName = agent;
  request.auth = authInfoFor(caller, bearerToken(request.headers)!);
  /* The client's own name (`initialize`), so the files it writes say which tool wrote them; the server is stateless, so later calls cannot tell. */
  if (request.method === 'POST' && (request.headers.get('content-type') ?? '').includes('application/json')) {
    const message = (await request.clone().json().catch(() => null)) as { method?: unknown; params?: { clientInfo?: { name?: unknown } } } | null;
    if (message?.method === 'initialize') await noteKeyClient(caller.keyId, message.params?.clientInfo?.name);
  }
  return mcpHandlerFor(caller)(request);
}

export { serve as GET, serve as POST, serve as DELETE };
