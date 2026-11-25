/**
 * re0 as the OAuth 2.1 authorization server of its own MCP server
 * (`/api/mcp`), so clients that connect only through OAuth -- claude.ai
 * custom connectors, ChatGPT -- can reach it (MCP authorization spec
 * 2026-07-28; lib/domain/oauth.ts holds the pure rules, docs/mcp.md the
 * walkthrough).
 *
 * A client is known by the URL of its metadata document (CIMD, fetched and
 * cached here) or registers itself (RFC 7591, deprecated by the spec but
 * what most clients still do). `/oauth/authorize` stores the request and
 * sends the browser to the consent page, where the signed-in user picks the
 * same permissions an API key has; approving turns the request into a
 * one-time code bound to the client, its redirect URI and the PKCE
 * challenge. The token endpoint exchanges the code for a grant -- an
 * `api_key` row with `oauth_client_id` and no secret, so every tool, scope
 * filter, rate limit, credit rule and usage figure of a key applies to it
 * unchanged -- and an access + refresh token pair, kept by digest only and
 * bound to the MCP server's URL. Refresh tokens rotate; a used one presented
 * again more than a minute later revokes the grant. Revoking the grant (settings, console, the
 * revocation endpoint) ends every token at once.
 */
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { API_KEY_LAST_USED_RESOLUTION_MS, API_KEY_NAME_MAX, OAUTH_LIMITS } from '@/lib/constants';
import { appBaseUrl } from '@/lib/http/cookies';
import { db, schema, type Executor } from '@/lib/infra/db';
import { base64UrlEncode, randomHex, randomToken, sha256, timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { assertFetchable } from '@/lib/infra/connectors/http';
import { publicOnlyDispatcher } from '@/lib/infra/connectors/address';
import {
  canonicalResource,
  documentLifetimeSeconds,
  isAllowedRedirectUri,
  isCodeChallenge,
  isCodeVerifier,
  isLoopbackRedirect,
  redirectUriMatches,
  isMetadataDocumentUrl,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_CLIENT_SECRET_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_STATE_MAX,
  OAuthError,
  parseClientMetadata,
  parsePermissions,
  redirectLabel,
  scopeOf,
  suggestedPermissions,
  type GrantPermissions,
} from '@/lib/domain/oauth';
import { normalizePath } from '@/lib/domain/workspace';
import { keyCaller, keyIsLive, type ApiKeyCaller } from '@/lib/services/api-keys';
import { defaultWorkspace } from '@/lib/services/workspace';

export type OAuthClientRow = typeof schema.oauthClient.$inferSelect;

/** The authorization server's issuer: the site's origin (RFC 8414 metadata at its `/.well-known/oauth-authorization-server`). */
export function oauthIssuer(): string {
  return appBaseUrl();
}

/** The MCP server's canonical URL: the protected resource every token is issued for. */
export function mcpResource(): string {
  return `${appBaseUrl()}/api/mcp`;
}

/* ------------------------------------------------------------------ clients */

/**
 * RFC 7591 registration → the RFC 7591 response. A client that asked for
 * `client_secret_basic` or `client_secret_post` (or named no method, whose
 * default is basic) gets a secret, shown in this response only; every
 * client still has to use PKCE. Clients nobody approved within a week are
 * deleted as new ones arrive.
 */
export async function registerClient(raw: unknown, now = new Date()): Promise<Record<string, unknown>> {
  const metadata = parseClientMetadata(raw, 'registration');
  const id = `${OAUTH_CLIENT_ID_PREFIX}${randomHex(16)}`;
  const secret = metadata.tokenEndpointAuthMethod === 'none' ? null : `${OAUTH_CLIENT_SECRET_PREFIX}${randomHex(32)}`;
  await db()
    .insert(schema.oauthClient)
    .values({
      id,
      kind: 'registered',
      clientName: metadata.clientName,
      clientUri: metadata.clientUri,
      redirectUris: metadata.redirectUris,
      tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
      secretDigest: secret ? await sha256(secret) : null,
      lastSeenAt: now,
      createdAt: now,
    });
  await forgetUnused(now);
  return {
    client_id: id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: metadata.clientName,
    ...(metadata.clientUri ? { client_uri: metadata.clientUri } : {}),
    redirect_uris: metadata.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: metadata.tokenEndpointAuthMethod,
  };
}

/**
 * Clients unseen for a week (`last_seen_at`: registered, fetched, or named
 * by an authorization request) that nobody holds a grant for and that have
 * no request still waiting on its consent page; and authorization requests
 * a day past their expiry (a replayed code is still caught until then).
 */
async function forgetUnused(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - OAUTH_LIMITS.unusedClientDays * 86_400_000);
  await db().execute(sql`
    delete from ${schema.oauthClient} c
    where c.last_seen_at < ${cutoff}
      and not exists (select 1 from ${schema.apiKey} k where k.oauth_client_id = c.id)
      and not exists (select 1 from ${schema.oauthAuthorization} a where a.client_id = c.id and a.expires_at > ${now})`);
  await db()
    .delete(schema.oauthAuthorization)
    .where(lt(schema.oauthAuthorization.expiresAt, new Date(now.getTime() - 86_400_000)));
}

export interface ClientDocumentResponse {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * A client metadata document, fetched once: the URL's host must be public
 * before anything is sent (and its address is checked again as the socket
 * connects), redirects are never followed, and the whole exchange -- connect,
 * headers and body -- has one 5-second budget and a 16 KB cap.
 */
async function fetchClientDocument(url: string): Promise<ClientDocumentResponse> {
  const target = new URL(url);
  assertFetchable(target);
  const response = await fetch(target, {
    headers: { accept: 'application/json', 'user-agent': 're0-oauth/1.0 (client metadata document)' },
    redirect: 'manual',
    signal: AbortSignal.timeout(OAUTH_LIMITS.documentTimeoutMs),
    cache: 'no-store',
    // Node's fetch is undici; the dispatcher option is not in the DOM RequestInit type.
    ...({ dispatcher: publicOnlyDispatcher() } as RequestInit),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, headers: response.headers, body: '' };
  }
  if (Number(response.headers.get('content-length') ?? '0') > OAUTH_LIMITS.documentMaxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('client metadata document too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > OAUTH_LIMITS.documentMaxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('client metadata document too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { status: 200, headers: response.headers, body: new TextDecoder().decode(bytes) };
}

/** Test hook: the metadata document fetcher (the real one refuses every private address, so tests serve documents through this). */
let fetchDocument: (url: string) => Promise<ClientDocumentResponse> = fetchClientDocument;
export function setClientDocumentFetcherForTests(fetcher: ((url: string) => Promise<ClientDocumentResponse>) | null): void {
  fetchDocument = fetcher ?? fetchClientDocument;
}

/**
 * A client by id: a registered one from the table; a metadata document URL
 * from the cached copy while it is fresh, else fetched again and checked:
 * its `client_id` must be its own URL exactly. When the client's site does
 * not answer (an error, a timeout, a status other than 200), a copy that
 * went stale less than a day ago is used instead, so a blip there does not
 * lock its users out; a document that answers but no longer checks out is
 * refused. `refetch: false` (the token and revocation endpoints) never
 * fetches: the client had to pass `/oauth/authorize` first.
 */
export async function findClient(clientId: unknown, options: { refetch?: boolean; now?: Date } = {}): Promise<OAuthClientRow | null> {
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 2000) return null;
  const now = options.now ?? new Date();
  const [cached] = await db().select().from(schema.oauthClient).where(eq(schema.oauthClient.id, clientId)).limit(1);
  if (!isMetadataDocumentUrl(clientId)) return cached?.kind === 'registered' ? cached : null;
  if (cached && (options.refetch === false || (cached.refreshAfter && cached.refreshAfter.getTime() > now.getTime()))) return cached;
  if (options.refetch === false) return null;
  const staleOrNull = () =>
    cached?.refreshAfter && now.getTime() - cached.refreshAfter.getTime() <= OAUTH_LIMITS.documentStaleHours * 3_600_000 ? cached : null;
  let fetched: ClientDocumentResponse;
  try {
    fetched = await fetchDocument(clientId);
  } catch {
    return staleOrNull();
  }
  if (fetched.status !== 200) return staleOrNull();
  let document: unknown;
  try {
    document = JSON.parse(fetched.body);
  } catch {
    return null;
  }
  if (!document || typeof document !== 'object' || (document as { client_id?: unknown }).client_id !== clientId) return null;
  let metadata: ReturnType<typeof parseClientMetadata>;
  try {
    metadata = parseClientMetadata(document, 'document');
  } catch {
    return null;
  }
  const refreshAfter = new Date(now.getTime() + documentLifetimeSeconds(fetched.headers.get('cache-control')) * 1000);
  const values = { clientName: metadata.clientName, clientUri: metadata.clientUri, redirectUris: metadata.redirectUris, fetchedAt: now, refreshAfter, lastSeenAt: now };
  const [row] = await db()
    .insert(schema.oauthClient)
    .values({ id: clientId, kind: 'metadata_document', tokenEndpointAuthMethod: 'none', secretDigest: null, createdAt: now, ...values })
    .onConflictDoUpdate({ target: schema.oauthClient.id, set: values })
    .returning();
  return row ?? null;
}

/**
 * The client a token or revocation request speaks for. A client with a
 * secret must present it (Basic or in the body); a public one is named by
 * `client_id` alone. Anything else is `invalid_client` (401).
 */
export async function authenticateClient(input: { clientId?: unknown; clientSecret?: unknown; basic: { clientId: string; secret: string } | null }): Promise<OAuthClientRow> {
  const clientId = input.basic?.clientId ?? input.clientId;
  const secret = input.basic?.secret ?? (typeof input.clientSecret === 'string' ? input.clientSecret : null);
  if (input.basic && typeof input.clientId === 'string' && input.clientId !== input.basic.clientId) throw new OAuthError('invalid_client', 'The client_id does not match the client credentials.', 401);
  const client = await findClient(clientId, { refetch: false });
  if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401);
  if (client.secretDigest) {
    if (!secret || !timingSafeEqual(await sha256(secret), client.secretDigest)) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
  }
  return client;
}

/* ------------------------------------------------------------------ authorization */

export type AuthorizeOutcome =
  /** The request cannot be trusted with a redirect: show the error on re0. */
  | { kind: 'error_page'; error: 'invalid_client' | 'invalid_redirect_uri' }
  /** The client and redirect URI are good, the rest is not: tell the client. */
  | { kind: 'redirect'; url: string }
  /** Go to the consent page; `browserSecret` binds the request to this browser. */
  | { kind: 'consent'; id: string; browserSecret: string };

/** `redirect_uri` with the authorization response's parameters added, `iss` included (RFC 9207). */
export function authorizationResponseUrl(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries({ ...params, iss: oauthIssuer() })) if (value !== null && value !== undefined) url.searchParams.set(name, value);
  return url.toString();
}

/**
 * `/oauth/authorize`'s query. The client and its exact redirect URI are
 * checked first and failures stay on re0 (never an open redirect); after
 * that, an unsupported response type, missing or non-S256 PKCE, or a
 * resource other than the MCP server goes back to the client as an error.
 */
export async function startAuthorization(query: URLSearchParams, now = new Date()): Promise<AuthorizeOutcome> {
  const one = (name: string) => {
    const values = query.getAll(name);
    return values.length === 1 ? values[0]! : values.length === 0 ? null : undefined;
  };
  const client = await findClient(one('client_id'), { now });
  if (!client) return { kind: 'error_page', error: 'invalid_client' };
  const redirectUri = one('redirect_uri');
  if (!redirectUri || !isAllowedRedirectUri(redirectUri) || !client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri))) return { kind: 'error_page', error: 'invalid_redirect_uri' };
  await db().update(schema.oauthClient).set({ lastSeenAt: now }).where(eq(schema.oauthClient.id, client.id));
  const state = one('state');
  const back = (error: string, description: string): AuthorizeOutcome => ({
    kind: 'redirect',
    url: authorizationResponseUrl(redirectUri, { error, error_description: description, state: typeof state === 'string' && state.length <= OAUTH_STATE_MAX ? state : null }),
  });
  if (state === undefined || (typeof state === 'string' && state.length > OAUTH_STATE_MAX)) return back('invalid_request', 'state is repeated or too long.');
  if (one('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = one('code_challenge');
  if (!isCodeChallenge(challenge) || one('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.');
  const resourceParam = one('resource');
  if (resourceParam === undefined) return back('invalid_target', 'Send one resource.');
  const resource = canonicalResource(mcpResource())!;
  if (resourceParam !== null && canonicalResource(resourceParam) !== resource) return back('invalid_target', `This server issues tokens only for ${mcpResource()}.`);
  const scope = one('scope');
  if (scope === undefined || (scope && scope.length > 1000)) return back('invalid_scope', 'scope is repeated or too long.');
  const browserSecret = randomToken();
  if (Math.random() < 0.05) await forgetUnused(now);
  const [row] = await db()
    .insert(schema.oauthAuthorization)
    .values({
      clientId: client.id,
      browserDigest: await sha256(browserSecret),
      redirectUri,
      codeChallenge: challenge,
      scope: scope ?? '',
      state: state ?? null,
      resource,
      createdAt: now,
      expiresAt: new Date(now.getTime() + OAUTH_LIMITS.requestMinutes * 60_000),
    })
    .returning({ id: schema.oauthAuthorization.id });
  return { kind: 'consent', id: row!.id, browserSecret };
}

export interface PendingAuthorization {
  id: string;
  client: { id: string; name: string; uri: string | null; kind: OAuthClientRow['kind']; documentHost: string | null };
  redirectUri: string;
  redirectLabel: string;
  loopbackRedirect: boolean;
  suggested: GrantPermissions;
  requestedScope: string;
  expiresAt: Date;
}

async function pendingRow(id: string, browserSecret: string | undefined, now: Date) {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !browserSecret) return null;
  const [row] = await db()
    .select({ authorization: schema.oauthAuthorization, client: schema.oauthClient })
    .from(schema.oauthAuthorization)
    .innerJoin(schema.oauthClient, eq(schema.oauthClient.id, schema.oauthAuthorization.clientId))
    .where(eq(schema.oauthAuthorization.id, id))
    .limit(1);
  if (!row || row.authorization.decidedAt || row.authorization.expiresAt.getTime() <= now.getTime()) return null;
  if (!timingSafeEqual(await sha256(browserSecret), row.authorization.browserDigest)) return null;
  return row;
}

/** What the consent page shows: null for an unknown, decided or expired request, or one started in another browser. */
export async function pendingAuthorization(id: string, browserSecret: string | undefined, now = new Date()): Promise<PendingAuthorization | null> {
  const row = await pendingRow(id, browserSecret, now);
  if (!row) return null;
  const { authorization, client } = row;
  return {
    id: authorization.id,
    client: { id: client.id, name: client.clientName, uri: client.clientUri, kind: client.kind, documentHost: client.kind === 'metadata_document' ? new URL(client.id).host : null },
    redirectUri: authorization.redirectUri,
    redirectLabel: redirectLabel(authorization.redirectUri),
    loopbackRedirect: isLoopbackRedirect(authorization.redirectUri),
    suggested: suggestedPermissions(authorization.scope),
    requestedScope: authorization.scope,
    expiresAt: authorization.expiresAt,
  };
}

export class ConsentError extends Error {
  constructor(readonly code: 'expired' | 'invalid_permissions' | 'too_many_apps') {
    super(code);
  }
}

/**
 * The user's decision on the consent page → where the browser goes next:
 * the client's redirect URI with a one-time code (valid five minutes) and
 * the client's `state`, or with `access_denied`. A request is decided once.
 */
export async function decideAuthorization(
  userId: string,
  id: string,
  browserSecret: string | undefined,
  decision: { approve: boolean; permissions?: Record<string, unknown> },
  now = new Date(),
): Promise<{ redirect: string }> {
  const row = await pendingRow(id, browserSecret, now);
  if (!row) throw new ConsentError('expired');
  const { authorization } = row;
  if (!decision.approve) {
    const updated = await db()
      .update(schema.oauthAuthorization)
      .set({ decidedAt: now, userId })
      .where(and(eq(schema.oauthAuthorization.id, id), isNull(schema.oauthAuthorization.decidedAt)))
      .returning({ id: schema.oauthAuthorization.id });
    if (updated.length === 0) throw new ConsentError('expired');
    return { redirect: authorizationResponseUrl(authorization.redirectUri, { error: 'access_denied', error_description: 'The user declined.', state: authorization.state }) };
  }
  const permissions = parsePermissions(decision.permissions ?? {}, normalizePath);
  if (!permissions) throw new ConsentError('invalid_permissions');
  const [{ live } = { live: 0 }] = await db()
    .select({ live: sql<number>`count(*)::int` })
    .from(schema.apiKey)
    .where(and(eq(schema.apiKey.userId, userId), isNotNull(schema.apiKey.oauthClientId), isNull(schema.apiKey.revokedAt), sql`(${schema.apiKey.expiresAt} is null or ${schema.apiKey.expiresAt} > ${now})`));
  if (live >= OAUTH_LIMITS.maxGrants) throw new ConsentError('too_many_apps');
  const code = randomToken();
  const updated = await db()
    .update(schema.oauthAuthorization)
    .set({
      decidedAt: now,
      userId,
      codeDigest: await sha256(code),
      canWrite: permissions.canWrite,
      workspaceAccess: permissions.workspaceAccess,
      workspaceOnly: permissions.workspaceOnly,
      workspaceRoot: permissions.workspaceRoot,
      expiresAt: new Date(now.getTime() + OAUTH_LIMITS.codeSeconds * 1000),
    })
    .where(and(eq(schema.oauthAuthorization.id, id), isNull(schema.oauthAuthorization.decidedAt)))
    .returning({ id: schema.oauthAuthorization.id });
  if (updated.length === 0) throw new ConsentError('expired');
  return { redirect: authorizationResponseUrl(authorization.redirectUri, { code, state: authorization.state }) };
}

/* ------------------------------------------------------------------ tokens */

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return timingSafeEqual(base64UrlEncode(digest), challenge);
}

function grantPermissions(key: typeof schema.apiKey.$inferSelect): GrantPermissions {
  return { canWrite: key.canWrite, workspaceAccess: key.workspaceAccess, workspaceOnly: Boolean(key.workspaceId), workspaceRoot: key.workspaceRoot };
}

async function issueTokens(executor: Executor, grantId: string, resource: string, grantExpiresAt: Date, now: Date): Promise<{ access: string; refresh: string; expiresIn: number }> {
  const access = `${OAUTH_ACCESS_TOKEN_PREFIX}${randomHex(32)}`;
  const refresh = `${OAUTH_REFRESH_TOKEN_PREFIX}${randomHex(32)}`;
  const accessExpiresAt = new Date(Math.min(now.getTime() + OAUTH_LIMITS.accessTokenSeconds * 1000, grantExpiresAt.getTime()));
  await executor.insert(schema.oauthToken).values([
    { apiKeyId: grantId, kind: 'access', digest: await sha256(access), resource, createdAt: now, expiresAt: accessExpiresAt },
    { apiKeyId: grantId, kind: 'refresh', digest: await sha256(refresh), resource, createdAt: now, expiresAt: grantExpiresAt },
  ]);
  return { access, refresh, expiresIn: Math.max(1, Math.floor((accessExpiresAt.getTime() - now.getTime()) / 1000)) };
}

/** Ends a grant and every token of it. */
export async function revokeGrant(executor: Executor, grantId: string, now: Date): Promise<void> {
  await executor.update(schema.apiKey).set({ revokedAt: now }).where(and(eq(schema.apiKey.id, grantId), isNull(schema.apiKey.revokedAt)));
  await executor.update(schema.oauthToken).set({ revokedAt: now }).where(and(eq(schema.oauthToken.apiKeyId, grantId), isNull(schema.oauthToken.revokedAt)));
}

function checkResource(raw: unknown, bound: string): void {
  if (raw === undefined || raw === null || raw === '') return;
  if (canonicalResource(raw) !== bound) throw new OAuthError('invalid_target', 'The resource does not match the one this grant is for.');
}

/**
 * `grant_type=authorization_code`: the code (once, within five minutes),
 * for the client it was issued to, with the same redirect URI and a
 * verifier matching the PKCE challenge → a grant and its first tokens. A
 * code presented a second time revokes the grant the first use made. A user
 * may hold several grants for one client at once -- every claude.ai user
 * shares one metadata-document client id, and one person may connect from a
 * personal and a team organisation -- each listed and revoked on its own.
 */
export async function exchangeCode(client: OAuthClientRow, input: { code?: unknown; redirectUri?: unknown; codeVerifier?: unknown; resource?: unknown }, now = new Date()): Promise<TokenResponse> {
  if (typeof input.code !== 'string' || input.code.length === 0 || input.code.length > 200) throw new OAuthError('invalid_request', 'code is required.');
  if (!isCodeVerifier(input.codeVerifier)) throw new OAuthError('invalid_request', 'A valid code_verifier is required (PKCE).');
  const digest = await sha256(input.code);
  const [claimed] = await db()
    .update(schema.oauthAuthorization)
    .set({ usedAt: now })
    .where(and(eq(schema.oauthAuthorization.codeDigest, digest), isNull(schema.oauthAuthorization.usedAt)))
    .returning();
  if (!claimed) {
    const [replayed] = await db().select().from(schema.oauthAuthorization).where(eq(schema.oauthAuthorization.codeDigest, digest)).limit(1);
    if (replayed?.apiKeyId) await db().transaction((tx) => revokeGrant(tx, replayed.apiKeyId!, now));
    throw new OAuthError('invalid_grant', 'The authorization code is invalid, expired or already used.');
  }
  if (claimed.expiresAt.getTime() <= now.getTime() || claimed.clientId !== client.id || !claimed.userId) throw new OAuthError('invalid_grant', 'The authorization code is invalid, expired or already used.');
  if (input.redirectUri !== undefined && input.redirectUri !== claimed.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
  if (!(await pkceMatches(input.codeVerifier, claimed.codeChallenge))) throw new OAuthError('invalid_grant', 'The code_verifier does not match the code_challenge.');
  checkResource(input.resource, claimed.resource);
  const userId = claimed.userId;
  const grantExpiresAt = new Date(now.getTime() + OAUTH_LIMITS.refreshDays * 86_400_000);
  return db().transaction(async (tx) => {
    const [owner] = await tx.select({ disabledAt: schema.user.disabledAt }).from(schema.user).where(eq(schema.user.id, userId)).for('update');
    if (!owner || owner.disabledAt) throw new OAuthError('invalid_grant', 'The account is not available.');
    const permissions: GrantPermissions = { canWrite: claimed.canWrite, workspaceAccess: claimed.workspaceAccess, workspaceOnly: claimed.workspaceOnly, workspaceRoot: claimed.workspaceRoot };
    const [grant] = await tx
      .insert(schema.apiKey)
      .values({
        userId,
        name: Array.from(client.clientName).slice(0, API_KEY_NAME_MAX).join('').trim() || 'OAuth client',
        keyDigest: null,
        keyTail: '',
        oauthClientId: client.id,
        expiresAt: grantExpiresAt,
        canWrite: permissions.canWrite,
        workspaceAccess: permissions.workspaceAccess,
        workspaceId: permissions.workspaceOnly ? await defaultWorkspace(userId, tx) : null,
        workspaceRoot: permissions.workspaceRoot,
        createdAt: now,
      })
      .returning();
    await tx.update(schema.oauthAuthorization).set({ apiKeyId: grant!.id }).where(eq(schema.oauthAuthorization.id, claimed.id));
    const tokens = await issueTokens(tx, grant!.id, claimed.resource, grantExpiresAt, now);
    return { access_token: tokens.access, token_type: 'Bearer' as const, expires_in: tokens.expiresIn, refresh_token: tokens.refresh, scope: scopeOf(permissions) };
  });
}

/**
 * `grant_type=refresh_token`: a live refresh token of a live grant, from the
 * client the grant belongs to → a new pair, the old refresh token spent and
 * the grant's life moved out again. A spent refresh token presented again
 * within a minute of its first use is a client retrying after a lost
 * response or two refreshes racing: it gets another pair (the earlier
 * successor stays valid too), as Auth0's and Okta's reuse intervals do.
 * Later than that it was leaked or replayed: the grant is revoked.
 */
export async function refreshTokens(client: OAuthClientRow, input: { refreshToken?: unknown; resource?: unknown }, now = new Date()): Promise<TokenResponse> {
  const invalid = () => new OAuthError('invalid_grant', 'The refresh token is invalid, expired or revoked.');
  if (typeof input.refreshToken !== 'string' || !input.refreshToken.startsWith(OAUTH_REFRESH_TOKEN_PREFIX) || input.refreshToken.length > 200) throw invalid();
  const digest = await sha256(input.refreshToken);
  const [row] = await db()
    .select({ token: schema.oauthToken, key: schema.apiKey, user: schema.user })
    .from(schema.oauthToken)
    .innerJoin(schema.apiKey, eq(schema.apiKey.id, schema.oauthToken.apiKeyId))
    .innerJoin(schema.user, eq(schema.user.id, schema.apiKey.userId))
    .where(and(eq(schema.oauthToken.digest, digest), eq(schema.oauthToken.kind, 'refresh')))
    .limit(1);
  if (!row || row.key.oauthClientId !== client.id) throw invalid();
  const graceMs = OAUTH_LIMITS.refreshReuseGraceSeconds * 1000;
  if (row.token.rotatedAt && now.getTime() - row.token.rotatedAt.getTime() > graceMs) {
    await db().transaction((tx) => revokeGrant(tx, row.key.id, now));
    throw invalid();
  }
  if (row.token.revokedAt || row.token.expiresAt.getTime() <= now.getTime() || !keyIsLive(row.key, now) || row.user.disabledAt) throw invalid();
  checkResource(input.resource, row.token.resource);
  const grantExpiresAt = new Date(now.getTime() + OAUTH_LIMITS.refreshDays * 86_400_000);
  return db().transaction(async (tx) => {
    /* The first use stamps `rotated_at`; a retry within the grace keeps that stamp, so the window never slides. */
    const spent = await tx
      .update(schema.oauthToken)
      .set({ rotatedAt: sql`coalesce(${schema.oauthToken.rotatedAt}, ${now})` })
      .where(and(eq(schema.oauthToken.id, row.token.id), isNull(schema.oauthToken.revokedAt), sql`(${schema.oauthToken.rotatedAt} is null or ${schema.oauthToken.rotatedAt} >= ${new Date(now.getTime() - graceMs)})`))
      .returning({ id: schema.oauthToken.id });
    if (spent.length === 0) throw invalid();
    await tx.update(schema.apiKey).set({ expiresAt: grantExpiresAt }).where(eq(schema.apiKey.id, row.key.id));
    /* Spent and expired tokens of this grant go; a rotated refresh token stays until its own expiry, to catch its reuse. */
    await tx.delete(schema.oauthToken).where(and(eq(schema.oauthToken.apiKeyId, row.key.id), lt(schema.oauthToken.expiresAt, now)));
    const tokens = await issueTokens(tx, row.key.id, row.token.resource, grantExpiresAt, now);
    return { access_token: tokens.access, token_type: 'Bearer' as const, expires_in: tokens.expiresIn, refresh_token: tokens.refresh, scope: scopeOf(grantPermissions(row.key)) };
  });
}

/**
 * RFC 7009 revocation by the client the token belongs to: a refresh token
 * ends the whole grant, an access token only itself. Unknown tokens, or
 * another client's, change nothing (the endpoint answers 200 either way).
 */
export async function revokeToken(client: OAuthClientRow, token: unknown, now = new Date()): Promise<void> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200) return;
  const [row] = await db()
    .select({ token: schema.oauthToken, key: schema.apiKey })
    .from(schema.oauthToken)
    .innerJoin(schema.apiKey, eq(schema.apiKey.id, schema.oauthToken.apiKeyId))
    .where(eq(schema.oauthToken.digest, await sha256(token)))
    .limit(1);
  if (!row || row.key.oauthClientId !== client.id) return;
  if (row.token.kind === 'refresh') await db().transaction((tx) => revokeGrant(tx, row.key.id, now));
  else await db().update(schema.oauthToken).set({ revokedAt: now }).where(and(eq(schema.oauthToken.id, row.token.id), isNull(schema.oauthToken.revokedAt)));
}

export function looksLikeAccessToken(value: string): boolean {
  return new RegExp(`^${OAUTH_ACCESS_TOKEN_PREFIX}[0-9a-f]{64}$`).test(value);
}

/**
 * The caller behind an access token at the MCP server, exactly the shape an
 * API key resolves to, or null: unknown, expired or revoked tokens, tokens
 * issued for another resource, a revoked or lapsed grant, a disabled
 * account.
 */
export async function resolveAccessToken(secret: string, resource: string, now = new Date()): Promise<ApiKeyCaller | null> {
  if (!looksLikeAccessToken(secret)) return null;
  const [row] = await db()
    .select({ token: schema.oauthToken, key: schema.apiKey, user: schema.user })
    .from(schema.oauthToken)
    .innerJoin(schema.apiKey, eq(schema.apiKey.id, schema.oauthToken.apiKeyId))
    .innerJoin(schema.user, eq(schema.user.id, schema.apiKey.userId))
    .where(eq(schema.oauthToken.digest, await sha256(secret)))
    .limit(1);
  if (!row || row.token.kind !== 'access' || row.token.revokedAt || row.token.expiresAt.getTime() <= now.getTime()) return null;
  if (!row.key.oauthClientId || !keyIsLive(row.key, now) || row.user.disabledAt) return null;
  if (row.token.resource !== canonicalResource(resource)) return null;
  if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() >= API_KEY_LAST_USED_RESOLUTION_MS) {
    await db().update(schema.apiKey).set({ lastUsedAt: now }).where(eq(schema.apiKey.id, row.key.id));
  }
  return keyCaller(row.key, row.user);
}
