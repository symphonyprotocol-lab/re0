import { authorizationServerMetadata, corsPreflight, withCors } from '@/lib/http/oauth';

export const dynamic = 'force-dynamic';

/** RFC 8414 metadata of re0's OAuth server, which issues the tokens `/api/mcp` accepts (lib/http/oauth.ts). */
export function GET(): Response {
  return withCors(Response.json(authorizationServerMetadata(), { headers: { 'cache-control': 'public, max-age=3600' } }));
}

export const OPTIONS = corsPreflight;
