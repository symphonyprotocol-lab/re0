import { corsPreflight, protectedResourceMetadata, withCors } from '@/lib/http/oauth';

export const dynamic = 'force-dynamic';

/**
 * RFC 9728 metadata of the MCP server at the root location. re0 has one
 * protected resource, so this is the same document as the path-suffixed
 * `/.well-known/oauth-protected-resource/api/mcp`, for clients that try the
 * root first.
 */
export function GET(): Response {
  return withCors(Response.json(protectedResourceMetadata(), { headers: { 'cache-control': 'public, max-age=3600' } }));
}

export const OPTIONS = corsPreflight;
