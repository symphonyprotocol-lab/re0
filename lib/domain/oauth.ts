/**
 * OAuth 2.1 for the MCP server, as pure rules (MCP authorization spec
 * 2026-07-28; lib/services/oauth.ts does the storage): which redirect URIs a
 * client may register and be sent to, PKCE, the resource a token is bound
 * to, how the permissions a user approves read as scopes, and the shape of
 * a client's registration or metadata document.
 *
 * Every client is checked the same way whether it registered itself (RFC
 * 7591) or is known by its metadata document's URL (CIMD): redirect URIs
 * are compared exactly, character for character, with what it declared.
 */
import { WORKSPACE_ACCESS, type WorkspaceAccess } from '@/lib/domain/workspace';

export const OAUTH_ACCESS_TOKEN_PREFIX = 're0_at_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 're0_rt_';
export const OAUTH_CLIENT_SECRET_PREFIX = 're0_cs_';
export const OAUTH_CLIENT_ID_PREFIX = 're0_client_';

export type TokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
export const TOKEN_ENDPOINT_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

/** What the server advertises: base read + ask, the "allow changes" write, and workspace access. */
export const OAUTH_SCOPES = ['read', 'write', 'workspace:read', 'workspace:write'] as const;
/** The scope a 401 asks for: the narrowest useful grant. More is the user's choice on the consent page. */
export const OAUTH_DEFAULT_SCOPE = 'read';

export const OAUTH_CLIENT_NAME_MAX = 100;
export const OAUTH_REDIRECT_URIS_MAX = 10;
export const OAUTH_URI_MAX = 2000;
export const OAUTH_STATE_MAX = 1024;

/** The permissions of a grant, exactly as an API key carries them (lib/services/api-keys.ts). */
export interface GrantPermissions {
  canWrite: boolean;
  workspaceAccess: WorkspaceAccess;
  /** A workspace-only grant: the workspace's `ws_*` tools under `workspaceRoot`, nothing else. */
  workspaceOnly: boolean;
  workspaceRoot: string;
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Whether a client may register this redirect URI: HTTPS anywhere, plain
 * HTTP only to the loopback address (native apps, RFC 8252 §7.3), or a
 * private-use scheme in reverse-domain form (`com.example.app:/cb`, RFC 8252
 * §7.1) for desktop apps that open with one. Never a fragment, credentials
 * or a scheme a browser would run (`javascript:`, `data:`, `file:`).
 */
export function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > OAUTH_URI_MAX || hasControlCharacter(raw) || /\s/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || raw.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return Boolean(url.hostname);
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  const scheme = url.protocol.slice(0, -1);
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/.test(scheme);
}

/** Only to the loopback address: the consent page warns that any app on that device could be listening. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** What the consent page names as where the user goes back to: the host, or the scheme of a desktop app. */
export function redirectLabel(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : `${url.protocol}//`;
  } catch {
    return uri;
  }
}

/**
 * A metadata document's URL as a client id (CIMD): HTTPS, a host, a path
 * beyond `/`, no fragment, credentials, port other than 443 or dot segments.
 */
export function isMetadataDocumentUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > OAUTH_URI_MAX || !raw.startsWith('https://')) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.href !== raw) return false;
  if (url.hash || url.username || url.password || (url.port && url.port !== '443')) return false;
  if (url.pathname === '/' || url.pathname.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  return true;
}

/** PKCE S256 code verifier syntax (RFC 7636 §4.1). */
export function isCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

/** An S256 code challenge: base64url of a SHA-256 digest, 43 characters. */
export function isCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * A URI compared as the MCP spec's canonical form: scheme and host lower
 * case, no fragment, no trailing slash on the path. Null when it is not an
 * absolute http(s) URI.
 */
export function canonicalResource(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > OAUTH_URI_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hash || raw.includes('#')) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** The scope string a grant's permissions read as, for token responses. */
export function scopeOf(grant: GrantPermissions): string {
  if (grant.workspaceOnly) return `workspace:${grant.workspaceAccess}`;
  const parts = ['read'];
  if (grant.canWrite) parts.push('write');
  if (grant.workspaceAccess !== 'none') parts.push(`workspace:${grant.workspaceAccess}`);
  return parts.join(' ');
}

/**
 * What the consent page offers first for a requested scope. Unknown scopes
 * are ignored rather than refused (clients send `openid`, `offline_access`
 * and their own); the user still chooses, and the narrowest is the default.
 */
export function suggestedPermissions(scope: string): GrantPermissions {
  const asked = new Set(scope.split(/\s+/).filter(Boolean));
  const workspaceAccess: WorkspaceAccess = asked.has('workspace:write') ? 'write' : asked.has('workspace:read') ? 'read' : 'none';
  const onlyWorkspace = workspaceAccess !== 'none' && !asked.has('read') && !asked.has('write');
  return { canWrite: !onlyWorkspace && asked.has('write'), workspaceAccess, workspaceOnly: onlyWorkspace, workspaceRoot: '/' };
}

/** The permissions the consent page sent, checked as `createApiKey` checks a key's. Null when they make no sense. */
export function parsePermissions(raw: { canWrite?: unknown; workspaceAccess?: unknown; workspaceOnly?: unknown; workspaceRoot?: unknown }, normalizePath: (value: unknown) => string | null): GrantPermissions | null {
  const workspaceOnly = raw.workspaceOnly === true;
  const access = raw.workspaceAccess === undefined || raw.workspaceAccess === null ? 'none' : raw.workspaceAccess;
  if (!(WORKSPACE_ACCESS as readonly unknown[]).includes(access)) return null;
  if (workspaceOnly && access === 'none') return null;
  const root = workspaceOnly ? normalizePath(raw.workspaceRoot ?? '/') : '/';
  if (!root) return null;
  return { canWrite: !workspaceOnly && raw.canWrite === true, workspaceAccess: access as WorkspaceAccess, workspaceOnly, workspaceRoot: root };
}

export interface ClientMetadata {
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}

function cleanName(raw: unknown, fallback: string): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return Array.from(name || fallback).slice(0, OAUTH_CLIENT_NAME_MAX).join('');
}

function cleanUri(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > OAUTH_URI_MAX) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A registration request (RFC 7591 §2) or a metadata document, as stored:
 * name, website, redirect URIs and how it authenticates. An omitted
 * `token_endpoint_auth_method` is `client_secret_basic` for a registration
 * (RFC 7591's default) and `none` for a metadata document, which cannot
 * hold a secret.
 */
export function parseClientMetadata(raw: unknown, source: 'registration' | 'document'): ClientMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OAuthError('invalid_client_metadata', 'The client metadata must be a JSON object.');
  const body = raw as Record<string, unknown>;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > OAUTH_REDIRECT_URIS_MAX) {
    throw new OAuthError('invalid_redirect_uri', `redirect_uris must list 1 to ${OAUTH_REDIRECT_URIS_MAX} URIs.`);
  }
  for (const uri of uris) {
    if (!isAllowedRedirectUri(uri)) throw new OAuthError('invalid_redirect_uri', 'Each redirect URI must be HTTPS, http://localhost (or a loopback address), or a reverse-domain app scheme, with no fragment.');
  }
  /*
   * Grant and response types are not checked: re0 offers the authorization
   * code flow with refresh tokens and nothing else whatever a client lists,
   * and says so in its registration response. Refusing a document that also
   * lists, say, `client_credentials` would only lock out a real client.
   */
  const method = body.token_endpoint_auth_method ?? (source === 'registration' ? 'client_secret_basic' : 'none');
  if (!(TOKEN_ENDPOINT_AUTH_METHODS as readonly unknown[]).includes(method) || (source === 'document' && method !== 'none')) {
    throw new OAuthError('invalid_client_metadata', source === 'document' ? 'A client metadata document must use token_endpoint_auth_method "none".' : 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.');
  }
  const redirectUris = Array.from(new Set(uris as string[]));
  const fallback = (() => {
    try {
      return new URL(redirectUris[0]!).host || 'OAuth client';
    } catch {
      return 'OAuth client';
    }
  })();
  return {
    clientName: cleanName(body.client_name, fallback),
    clientUri: cleanUri(body.client_uri),
    redirectUris,
    tokenEndpointAuthMethod: method as TokenEndpointAuthMethod,
  };
}

/** `Authorization: Basic` client credentials (RFC 6749 §2.3.1: each half form-encoded). */
export function basicCredentials(header: string | null): { clientId: string; secret: string } | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = atob(match[1]!);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  try {
    return { clientId: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')) };
  } catch {
    return null;
  }
}

/**
 * Seconds a metadata document may be reused for, from its `Cache-Control`:
 * `max-age` within [5 minutes, 1 day], an hour when it says nothing, and the
 * floor for `no-store` / `no-cache` (a client cannot make us fetch on every
 * authorization request).
 */
export function documentLifetimeSeconds(cacheControl: string | null): number {
  const floor = 300;
  const ceiling = 86_400;
  if (!cacheControl) return 3_600;
  if (/(^|,)\s*(no-store|no-cache)\s*(,|$)/i.test(cacheControl)) return floor;
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(cacheControl);
  if (!match) return 3_600;
  return Math.min(ceiling, Math.max(floor, Number(match[1])));
}
