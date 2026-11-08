import type { NextRequest } from 'next/server';
import { apiKeyCaller, bearerToken } from '@/lib/http/api-key';
import { authInfoFor, mcpHandler } from '@/lib/http/mcp';
import { fail } from '@/lib/http/respond';
import { sameOrigin } from '@/lib/http/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/* An `ask_ree` waits for the whole answer, as a web question streams it. */
export const maxDuration = 300;

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
  request.auth = authInfoFor(caller, bearerToken(request.headers)!);
  return mcpHandler(request);
}

export { serve as GET, serve as POST, serve as DELETE };
