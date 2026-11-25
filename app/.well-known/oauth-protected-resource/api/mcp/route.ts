import { corsPreflight, protectedResourceMetadata, withCors } from '@/lib/http/oauth';

export const dynamic = 'force-dynamic';

/** RFC 9728 metadata of the MCP server `/api/mcp`, at its path-suffixed location (what `/api/mcp`'s 401 points to). */
export function GET(): Response {
  return withCors(Response.json(protectedResourceMetadata(), { headers: { 'cache-control': 'public, max-age=3600' } }));
}

export const OPTIONS = corsPreflight;
