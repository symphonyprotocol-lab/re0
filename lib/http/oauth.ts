/**
 * The HTTP side of re0's OAuth server (lib/services/oauth.ts): the two
 * discovery documents, the endpoints' error and CORS conventions, and the
 * challenge `/api/mcp` answers a request without a usable token with.
 *
 * The discovery documents and the registration, token and revocation
 * endpoints take no cookie and send `Access-Control-Allow-Origin: *`, so a
 * browser-based MCP client can use them; nothing there is authorized by
 * ambient credentials. The authorization and consent pages are ordinary
 * same-origin pages behind the user's session.
 */
import { generateProtectedResourceMetadata } from 'mcp-handler';
import { NextResponse } from 'next/server';
import { basicCredentials, OAUTH_DEFAULT_SCOPE, OAUTH_SCOPES, OAuthError } from '@/lib/domain/oauth';
import { isSecureDeployment } from '@/lib/http/cookies';
import { mcpResource, oauthIssuer } from '@/lib/services/oauth';

export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  token: '/api/oauth/token',
  register: '/api/oauth/register',
  revoke: '/api/oauth/revoke',
  /** RFC 9728's path-suffixed location for the resource `/api/mcp`; the root location serves the same document. */
  protectedResource: '/.well-known/oauth-protected-resource/api/mcp',
} as const;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

export function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
  return response;
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** A JSON body never cached (RFC 6749 §5.1), with CORS. */
export function oauthJson(body: unknown, status = 200): Response {
  return withCors(NextResponse.json(body, { status, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } }));
}

/** An RFC 6749 §5.2 error; `invalid_client` carries a Basic challenge as the RFC asks. */
export function oauthError(error: OAuthError | { error: string; description: string; status?: number }): Response {
  const response = oauthJson({ error: error.error, error_description: error.description }, error.status ?? 400);
  if (error.error === 'invalid_client' && (error.status ?? 400) === 401) response.headers.set('www-authenticate', 'Basic realm="re0"');
  return response;
}

/**
 * A token or revocation request's parameters: form-encoded as the RFCs say,
 * JSON accepted too. A parameter sent twice is refused (RFC 6749 §3.2).
 */
export async function oauthParams(request: Request): Promise<{ params: Record<string, string>; basic: { clientId: string; secret: string } | null }> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const params: Record<string, string> = {};
  if (type === 'application/json') {
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OAuthError('invalid_request', 'The body must be form-encoded or a JSON object.');
    for (const [name, value] of Object.entries(raw)) if (typeof value === 'string') params[name] = value;
  } else {
    const text = await request.text();
    if (text.length > 16_384) throw new OAuthError('invalid_request', 'The request is too large.');
    const form = new URLSearchParams(text);
    for (const name of new Set(form.keys())) {
      const values = form.getAll(name);
      if (values.length > 1) throw new OAuthError('invalid_request', `${name} is repeated.`);
      params[name] = values[0]!;
    }
  }
  return { params, basic: basicCredentials(request.headers.get('authorization')) };
}

/** RFC 8414 metadata of the authorization server. */
export function authorizationServerMetadata(): Record<string, unknown> {
  const issuer = oauthIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${issuer}${OAUTH_PATHS.token}`,
    registration_endpoint: `${issuer}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${issuer}${OAUTH_PATHS.revoke}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 metadata of `/api/mcp`, built by mcp-handler's helper. */
export function protectedResourceMetadata() {
  return generateProtectedResourceMetadata({
    authServerUrls: [oauthIssuer()],
    resourceUrl: mcpResource(),
    additionalMetadata: { scopes_supported: [...OAUTH_SCOPES], bearer_methods_supported: ['header'], resource_name: 're0' },
  });
}

/**
 * The `WWW-Authenticate` of a 401 from `/api/mcp` (MCP spec, RFC 6750 §3,
 * RFC 9728 §5.1): where the resource's metadata is, so a client can find the
 * authorization server, and the scope to ask for.
 */
export function mcpChallenge(error?: 'invalid_request' | 'invalid_token'): string {
  const parts = [`realm="re0"`, `resource_metadata="${oauthIssuer()}${OAUTH_PATHS.protectedResource}"`, `scope="${OAUTH_DEFAULT_SCOPE}"`];
  if (error) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(', ')}`;
}

/**
 * The cookie that ties a pending authorization request to the browser that
 * started it, scoped to that request's consent page (and its decision
 * route), so several requests in one browser never clobber each other.
 */
export function consentCookieName(): string {
  return isSecureDeployment() ? '__Secure-re0_oauth_consent' : 're0_oauth_consent';
}

export function consentCookiePath(id: string): string {
  return `/oauth/consent/${id}`;
}

export function consentCookieOptions(id: string, maxAgeSeconds: number) {
  return { httpOnly: true, secure: isSecureDeployment(), sameSite: 'lax' as const, path: consentCookiePath(id), maxAge: maxAgeSeconds };
}
