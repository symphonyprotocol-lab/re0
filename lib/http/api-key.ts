/**
 * `Authorization: Bearer …` for the MCP server: an API key (`re0_sk_…`) or
 * an OAuth access token (`re0_at_…`, lib/services/oauth.ts), which resolve
 * to the same caller. No cookie is read on this path and no CORS header is
 * ever sent, so a browser page on another origin cannot call it with a
 * user's session.
 */
import { NextResponse } from 'next/server';
import { resolveApiKey, type ApiKeyCaller } from '@/lib/services/api-keys';
import { looksLikeAccessToken, mcpResource, resolveAccessToken } from '@/lib/services/oauth';
import { mcpChallenge } from '@/lib/http/oauth';

/** The bearer token, if the header is one. */
export function bearerToken(headers: Headers): string | null {
  const value = headers.get('authorization');
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1]! : null;
}

const MESSAGES = {
  missing_api_key: 'Connect with OAuth (the client finds re0’s authorization server through this response’s WWW-Authenticate header), or send an re0 API key as "Authorization: Bearer re0_sk_…" (Settings → API).',
  invalid_api_key: 'This API key is unknown, revoked or expired, or its account is disabled.',
  invalid_token: 'This access token is unknown, expired or revoked, was issued for another resource, or its account is disabled. Refresh it or connect again.',
} as const;

/**
 * A 401 the MCP clients understand: the challenge names the protected
 * resource metadata (RFC 9728), which names re0's authorization server, so
 * an OAuth client can start its flow from here; a key client reads the body.
 */
export function unauthorized(error: keyof typeof MESSAGES): NextResponse {
  return NextResponse.json(
    { error, message: MESSAGES[error] },
    { status: 401, headers: { 'www-authenticate': mcpChallenge(error === 'missing_api_key' ? undefined : 'invalid_token'), 'cache-control': 'no-store' } },
  );
}

/** The caller behind the request's key or access token, or the 401 to answer with. */
export async function apiKeyCaller(request: Request): Promise<ApiKeyCaller | NextResponse> {
  const token = bearerToken(request.headers);
  if (!token) return unauthorized('missing_api_key');
  if (looksLikeAccessToken(token)) return (await resolveAccessToken(token, mcpResource())) ?? unauthorized('invalid_token');
  return (await resolveApiKey(token)) ?? unauthorized('invalid_api_key');
}
