/**
 * `Authorization: Bearer re0_sk_…` for the MCP server. No cookie is read on
 * this path and no CORS header is ever sent, so a browser page on another
 * origin cannot call it with a user's session.
 */
import { NextResponse } from 'next/server';
import { resolveApiKey, type ApiKeyCaller } from '@/lib/services/api-keys';

/** The bearer token, if the header is one. */
export function bearerToken(headers: Headers): string | null {
  const value = headers.get('authorization');
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1]! : null;
}

/**
 * A 401 the MCP clients understand. Phase one has no OAuth, so the challenge
 * names no authorization server: the client has to be configured with a key.
 */
export function unauthorized(error: 'missing_api_key' | 'invalid_api_key'): NextResponse {
  return NextResponse.json(
    { error, message: error === 'missing_api_key' ? 'Send an re0 API key as "Authorization: Bearer re0_sk_…". Create one in Settings → API.' : 'This API key is unknown, revoked or expired, or its account is disabled.' },
    { status: 401, headers: { 'www-authenticate': `Bearer realm="re0", error="${error === 'missing_api_key' ? 'invalid_request' : 'invalid_token'}"`, 'cache-control': 'no-store' } },
  );
}

/** The caller behind the request's key, or the 401 to answer with. */
export async function apiKeyCaller(request: Request): Promise<ApiKeyCaller | NextResponse> {
  const token = bearerToken(request.headers);
  if (!token) return unauthorized('missing_api_key');
  return (await resolveApiKey(token)) ?? unauthorized('invalid_api_key');
}
