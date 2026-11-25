/**
 * OAuth for the MCP server (lib/services/oauth.ts) through its routes: the
 * discovery documents and the 401 that points at them; dynamic registration
 * and metadata-document clients; the full flow -- register → authorize →
 * consent → code → token → MCP call → refresh → revoke -- and that a grant
 * is a caller exactly like a key (tool list by permission, per-grant rate
 * limit, workspace-only grants); and the refusals: unregistered or
 * mismatched redirect URIs (never redirected to), missing or wrong PKCE,
 * a replayed code, a reused refresh token, another resource, another
 * browser's request, cross-site consent, revoked grants and disabled
 * accounts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq, like } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const state = vi.hoisted(() => ({ session: null as string | null }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (state.session && name === 're0_session' ? { value: state.session } : undefined) }),
  headers: async () => new Headers(),
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { db, schema } = await import('@/lib/infra/db');
const apiKeys = await import('@/lib/services/api-keys');
const oauth = await import('@/lib/services/oauth');
const { base64UrlEncode } = await import('@/lib/infra/crypto/tokens');
const mcpRoute = await import('@/app/api/mcp/route');
const authorizeRoute = await import('@/app/oauth/authorize/route');
const decideRoute = await import('@/app/oauth/consent/[id]/decide/route');
const tokenRoute = await import('@/app/api/oauth/token/route');
const registerRoute = await import('@/app/api/oauth/register/route');
const revokeRoute = await import('@/app/api/oauth/revoke/route');
const asMetadata = await import('@/app/.well-known/oauth-authorization-server/route');
const prmRoot = await import('@/app/.well-known/oauth-protected-resource/route');
const prmPath = await import('@/app/.well-known/oauth-protected-resource/api/mcp/route');

const BASE = 'http://localhost:3000';
const MCP_URL = `${BASE}/api/mcp`;
const REDIRECT = 'https://client.example.test/callback';

afterEach(() => {
  state.session = null;
  oauth.setClientDocumentFetcherForTests(null);
});

async function person() {
  const subject = uniqueName('oauth');
  const session = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  return { userId: session.userId, token: session.sessionToken };
}

async function pkce() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function register(body: unknown, ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
  return registerRoute.POST(new NextRequest(`${BASE}/api/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) }));
}

async function publicClient(redirectUris = [REDIRECT]) {
  const response = await register({ client_name: 'Test Connector', redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; client_secret?: string };
}

function authorize(params: Record<string, string>) {
  const url = new URL(`${BASE}/oauth/authorize`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return authorizeRoute.GET(new NextRequest(url));
}

/** `/oauth/authorize` → the consent page's request id and this browser's cookie for it. */
async function startFlow(clientId: string, options: { scope?: string; redirectUri?: string; resource?: string } = {}) {
  const { verifier, challenge } = await pkce();
  const response = await authorize({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: options.redirectUri ?? REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    resource: options.resource ?? MCP_URL,
    ...(options.scope ? { scope: options.scope } : {}),
  });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location')!);
  expect(location.pathname).toMatch(/^\/oauth\/consent\/[0-9a-f-]{36}$/);
  const id = location.pathname.split('/').pop()!;
  const setCookie = response.headers.get('set-cookie')!;
  expect(setCookie).toContain(`Path=/oauth/consent/${id}`);
  expect(setCookie.toLowerCase()).toContain('httponly');
  const cookie = /re0_oauth_consent=([^;]+)/.exec(setCookie)![1]!;
  return { id, cookie, verifier };
}

function decide(id: string, cookie: string | null, body: unknown, origin = BASE) {
  return decideRoute.POST(
    new NextRequest(`${BASE}/oauth/consent/${id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie: `re0_oauth_consent=${cookie}` } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  return tokenRoute.POST(new NextRequest(`${BASE}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params).toString() }));
}

/** A signed-in user approves `permissions` for the client → the code from the redirect. */
async function approve(clientId: string, session: string, permissions: Record<string, unknown> = {}, options: { scope?: string } = {}) {
  const flow = await startFlow(clientId, options);
  state.session = session;
  const response = await decide(flow.id, flow.cookie, { approve: true, permissions });
  state.session = null;
  expect(response.status).toBe(200);
  const redirect = new URL(((await response.json()) as { redirect: string }).redirect);
  expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
  expect(redirect.searchParams.get('state')).toBe('state-123');
  expect(redirect.searchParams.get('iss')).toBe(BASE);
  return { code: redirect.searchParams.get('code')!, verifier: flow.verifier };
}

async function tokensFor(clientId: string, session: string, permissions: Record<string, unknown> = {}) {
  const { code, verifier } = await approve(clientId, session, permissions);
  const response = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId, resource: MCP_URL });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string };
}

const routeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const handler = { GET: mcpRoute.GET, POST: mcpRoute.POST, DELETE: mcpRoute.DELETE }[request.method as 'GET' | 'POST' | 'DELETE'];
  if (!handler) return new Response(null, { status: 405 });
  return handler(request as Parameters<typeof mcpRoute.POST>[0]);
};

async function connect(accessToken: string) {
  const client = new Client({ name: 'oauth-tests', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: routeFetch, requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  return client;
}

function rawMcp(accessToken: string) {
  return routeFetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

describeWithDb('MCP OAuth: discovery', () => {
  it('publishes authorization server and protected resource metadata, with CORS', async () => {
    const as = asMetadata.GET();
    expect(as.headers.get('access-control-allow-origin')).toBe('*');
    const metadata = (await as.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/api/oauth/token`,
      registration_endpoint: `${BASE}/api/oauth/register`,
      revocation_endpoint: `${BASE}/api/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    for (const route of [prmRoot, prmPath]) {
      const prm = (await route.GET().json()) as Record<string, unknown>;
      expect(prm).toMatchObject({ resource: MCP_URL, authorization_servers: [BASE], bearer_methods_supported: ['header'] });
    }
  });

  it('answers /api/mcp without a token with a challenge naming the resource metadata', async () => {
    const response = await routeFetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate')!;
    expect(challenge).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`);
    expect(challenge).toContain('scope="read"');
    expect((await rawMcp(`re0_at_${'0'.repeat(64)}`)).headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

describeWithDb('MCP OAuth: client registration', () => {
  it('registers public and confidential clients and refuses unsafe redirect URIs', async () => {
    const pub = await publicClient(['https://claude.example.test/api/mcp/auth_callback', 'http://localhost:33418/callback', 'com.example.app:/oauth']);
    expect(pub.client_id).toMatch(/^re0_client_[0-9a-f]{32}$/);
    expect(pub.client_secret).toBeUndefined();

    const confidential = await register({ client_name: 'Server app', redirect_uris: [REDIRECT] });
    expect(confidential.status).toBe(201);
    const body = (await confidential.json()) as { client_secret: string; token_endpoint_auth_method: string };
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(body.client_secret).toMatch(/^re0_cs_/);
    const [row] = await db().select().from(schema.oauthClient).where(like(schema.oauthClient.clientName, 'Server app'));
    expect(row!.secretDigest).not.toContain(body.client_secret.slice(7));

    for (const bad of ['http://evil.example.test/cb', 'https://client.example.test/cb#frag', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'relative/path']) {
      const response = await register({ redirect_uris: [bad], token_endpoint_auth_method: 'none' });
      expect(response.status, bad).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    }
    /* Other grant types are not offered, whatever the client lists. */
    const listed = await register({ redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'client_credentials'], token_endpoint_auth_method: 'none' });
    expect(listed.status).toBe(201);
    expect(((await listed.json()) as { grant_types: string[] }).grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect((await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' })).status).toBe(400);
    expect((await register({ redirect_uris: [] })).status).toBe(400);
  });

  it('limits registrations per address generously (platforms register from shared servers), and overall', async () => {
    const ip = `10.250.${Math.floor(Math.random() * 250)}.1`;
    const statuses: number[] = [];
    for (let i = 0; i < 301; i += 1) statuses.push((await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }, ip)).status);
    expect(statuses.slice(0, 300).every((status) => status === 201)).toBe(true);
    expect(statuses[300]).toBe(429);
    /* The overall ceiling: once its bucket is full, every address is refused. */
    await db().update(schema.rateBucket).set({ hits: 5_000 }).where(eq(schema.rateBucket.key, 'oauth:register:all'));
    const elsewhere = await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }, '10.251.0.1');
    expect(elsewhere.status).toBe(429);
    expect(elsewhere.headers.get('retry-after')).toBe('3600');
    await db().delete(schema.rateBucket).where(eq(schema.rateBucket.key, 'oauth:register:all'));
  });

  it('refuses bodies over 16 KB at the registration and token endpoints', async () => {
    const big = await register({ client_name: 'x'.repeat(20_000), redirect_uris: [REDIRECT] });
    expect(big.status).toBe(413);
    const bigToken = await token({ grant_type: 'refresh_token', refresh_token: 'x'.repeat(20_000), client_id: 'c' });
    expect(bigToken.status).toBe(413);
    expect(await bigToken.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('deletes unused clients by when they were last seen, never one with a request waiting on its consent page', async () => {
    const old = new Date(Date.now() - 8 * 86_400_000);
    const idle = await publicClient();
    const waiting = await publicClient();
    const recent = await publicClient();
    await startFlow(waiting.client_id);
    await db().update(schema.oauthClient).set({ createdAt: old, lastSeenAt: old }).where(eq(schema.oauthClient.id, idle.client_id));
    await db().update(schema.oauthClient).set({ createdAt: old, lastSeenAt: old }).where(eq(schema.oauthClient.id, waiting.client_id));
    /* Old, but seen yesterday (an authorization request names it). */
    await db().update(schema.oauthClient).set({ createdAt: old }).where(eq(schema.oauthClient.id, recent.client_id));
    await publicClient(); /* registration runs the clean-up */
    const left = new Set((await db().select({ id: schema.oauthClient.id }).from(schema.oauthClient)).map((row) => row.id));
    expect(left.has(idle.client_id)).toBe(false);
    expect(left.has(waiting.client_id)).toBe(true);
    expect(left.has(recent.client_id)).toBe(true);
    /* Naming a client in an authorization request moves its last-seen time. */
    await db().update(schema.oauthClient).set({ lastSeenAt: old }).where(eq(schema.oauthClient.id, recent.client_id));
    await startFlow(recent.client_id);
    const [seen] = await db().select().from(schema.oauthClient).where(eq(schema.oauthClient.id, recent.client_id));
    expect(seen!.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('accepts a client by its metadata document URL, checked against the document', async () => {
    const documentUrl = `https://app.example.test/oauth/${uniqueName('doc')}.json`;
    const serve = (document: unknown, status = 200) =>
      oauth.setClientDocumentFetcherForTests(async () => ({ status, headers: new Headers({ 'cache-control': 'max-age=600' }), body: JSON.stringify(document) }));

    serve({ client_id: 'https://other.example.test/client.json', client_name: 'Liar', redirect_uris: [REDIRECT] });
    const mismatched = await authorize({ response_type: 'code', client_id: documentUrl, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
    expect(mismatched.headers.get('location')).toBe(`${BASE}/oauth/error?reason=invalid_client`);

    /* A redirect is never followed. */
    serve({ client_id: documentUrl, client_name: 'Doc Client', redirect_uris: [REDIRECT] }, 302);
    expect((await authorize({ client_id: documentUrl, redirect_uri: REDIRECT })).headers.get('location')).toContain('reason=invalid_client');

    serve({ client_id: documentUrl, client_name: 'Doc Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' });
    expect((await authorize({ client_id: documentUrl, redirect_uri: REDIRECT })).headers.get('location')).toContain('reason=invalid_client');

    serve({ client_id: documentUrl, client_name: 'Doc Client', redirect_uris: [REDIRECT] });
    const { userId, token: session } = await person();
    const tokens = await tokensFor(documentUrl, session);
    expect(tokens.scope).toBe('read');
    const [row] = await db().select().from(schema.oauthClient).where(eq(schema.oauthClient.id, documentUrl));
    expect(row).toMatchObject({ kind: 'metadata_document', clientName: 'Doc Client' });
    expect(row!.refreshAfter!.getTime() - row!.fetchedAt!.getTime()).toBe(600_000);
    const [app] = (await apiKeys.listApiKeys(userId)).filter((item) => item.oauthClient);
    expect(app!.oauthClient).toMatchObject({ id: documentUrl, name: 'Doc Client', documentHost: 'app.example.test', redirectHosts: ['client.example.test'] });

    /* Its site goes down: a copy less than a day past its refresh time is still used; an older one is not. */
    oauth.setClientDocumentFetcherForTests(async () => {
      throw new Error('ECONNRESET');
    });
    await db().update(schema.oauthClient).set({ refreshAfter: new Date(Date.now() - 3_600_000) }).where(eq(schema.oauthClient.id, documentUrl));
    expect((await authorize({ response_type: 'code', client_id: documentUrl, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })).headers.get('location')).toMatch(/\/oauth\/consent\//);
    serve({}, 503);
    expect((await authorize({ response_type: 'code', client_id: documentUrl, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })).headers.get('location')).toMatch(/\/oauth\/consent\//);
    await db().update(schema.oauthClient).set({ refreshAfter: new Date(Date.now() - 25 * 3_600_000) }).where(eq(schema.oauthClient.id, documentUrl));
    expect((await authorize({ client_id: documentUrl, redirect_uri: REDIRECT })).headers.get('location')).toContain('reason=invalid_client');
    /* A site that answers with a document that no longer checks out is refused even with a fresh-enough copy. */
    await db().update(schema.oauthClient).set({ refreshAfter: new Date(Date.now() - 1000) }).where(eq(schema.oauthClient.id, documentUrl));
    serve({ client_id: 'https://other.example.test/c.json', redirect_uris: [REDIRECT] });
    expect((await authorize({ client_id: documentUrl, redirect_uri: REDIRECT })).headers.get('location')).toContain('reason=invalid_client');

    /* The real fetcher refuses private and loopback hosts before sending anything. */
    oauth.setClientDocumentFetcherForTests(null);
    for (const local of ['https://127.0.0.1/client.json', 'https://localhost/client.json', 'https://10.0.0.8/client.json', 'https://[::1]/client.json']) {
      expect((await authorize({ client_id: local, redirect_uri: REDIRECT })).headers.get('location'), local).toContain('reason=invalid_client');
    }

    /* Not a valid document URL: plain http, no path. */
    for (const bad of ['http://app.example.test/client.json', 'https://app.example.test/', 'https://app.example.test:8443/c.json']) {
      expect((await authorize({ client_id: bad, redirect_uri: REDIRECT })).headers.get('location'), bad).toContain('reason=invalid_client');
    }
  });
});

describeWithDb('MCP OAuth: the flow', () => {
  it('registers, authorizes, consents, exchanges, calls MCP, refreshes and revokes', async () => {
    const { userId, token: session } = await person();
    const client = await publicClient();
    const tokens = await tokensFor(client.client_id, session);
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'read', expires_in: 3600 });
    expect(tokens.access_token).toMatch(/^re0_at_[0-9a-f]{64}$/);
    expect(tokens.refresh_token).toMatch(/^re0_rt_[0-9a-f]{64}$/);

    /* Stored by digest only. */
    const stored = await db().select().from(schema.oauthToken);
    expect(JSON.stringify(stored)).not.toContain(tokens.access_token.slice(7));
    expect(JSON.stringify(stored)).not.toContain(tokens.refresh_token.slice(7));

    /* The grant is a key row without a secret, listed as a connected app, not a key. */
    const items = await apiKeys.listApiKeys(userId);
    const grant = items.find((item) => item.oauthClient)!;
    expect(grant).toMatchObject({ name: 'Test Connector', canWrite: false, workspaceAccess: 'none', kind: 'account' });
    const [grantRow] = await db().select().from(schema.apiKey).where(eq(schema.apiKey.id, grant.id));
    expect(grantRow!.keyDigest).toBeNull();

    /* The MCP server takes it like a key: read tools only, calls counted per grant. */
    const mcp = await connect(tokens.access_token);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('search_rees');
    expect(names).toContain('ask_ree');
    expect(names.some((name) => name.startsWith('ws_'))).toBe(false);
    const write = (await mcp.callTool({ name: 'favorite_ree', arguments: { ree: 'nothing', favorite: true } })) as { isError?: boolean; structuredContent?: { error?: string } };
    expect(write.isError).toBe(true);
    expect(write.structuredContent?.error).toBe('write_not_allowed');
    const listed = (await mcp.callTool({ name: 'list_my_rees', arguments: {} })) as { isError?: boolean };
    expect(listed.isError).toBeFalsy();
    const buckets = await db().select().from(schema.rateBucket).where(like(schema.rateBucket.key, `mcp:key:${grant.id}`));
    expect(buckets.length).toBe(1);
    await mcp.close();

    /* Refresh: a new pair; the old refresh token is spent, the old access token still lives until it expires. */
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: MCP_URL });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await rawMcp(next.access_token)).status).toBe(200);

    /* Revocation of the refresh token ends the whole grant. */
    const revoked = await revokeRoute.POST(new NextRequest(`${BASE}/api/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: next.refresh_token, client_id: client.client_id }).toString() }));
    expect(revoked.status).toBe(200);
    expect((await rawMcp(next.access_token)).status).toBe(401);
    expect((await rawMcp(tokens.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: client.client_id })).status).toBe(400);
    expect((await apiKeys.listApiKeys(userId)).find((item) => item.id === grant.id)!.revokedAt).not.toBeNull();
  });

  it('gives a grant exactly the permissions approved: changes, workspace, workspace only', async () => {
    const { userId, token: session } = await person();
    const client = await publicClient();
    const writer = await tokensFor(client.client_id, session, { canWrite: true, workspaceAccess: 'read' });
    expect(writer.scope).toBe('read write workspace:read');
    const writerClient = await connect(writer.access_token);
    const writerTools = (await writerClient.listTools()).tools.map((tool) => tool.name);
    expect(writerTools).toContain('create_post');
    expect(writerTools).toContain('ws_read');
    const wsWrite = (await writerClient.callTool({ name: 'ws_write', arguments: { path: '/a.md', content: 'x' } })) as { isError?: boolean; structuredContent?: { error?: string } };
    expect(wsWrite.isError).toBe(true);
    expect(wsWrite.structuredContent?.error).toBe('workspace_not_allowed');

    /* Approving the same client again adds a second grant (say, a personal and a team claude.ai organisation); the first keeps working. */
    const files = await tokensFor(client.client_id, session, { workspaceOnly: true, workspaceAccess: 'write', workspaceRoot: '/notes', canWrite: true });
    expect(files.scope).toBe('workspace:write');
    expect((await rawMcp(writer.access_token)).status).toBe(200);
    const fileTools = (await (await connect(files.access_token)).listTools()).tools.map((tool) => tool.name);
    expect(fileTools.every((name) => name.startsWith('ws_'))).toBe(true);
    expect(fileTools).toContain('ws_write');
    const live = (await apiKeys.listApiKeys(userId)).filter((item) => item.oauthClient && !item.revokedAt);
    expect(live).toHaveLength(2);
    const workspaceGrant = live.find((item) => item.kind === 'workspace')!;
    expect(workspaceGrant).toMatchObject({ workspaceRoot: '/notes', canWrite: false });

    /* Revoking one from settings (the keys route) ends that one at once, and only that one. */
    expect(await apiKeys.revokeApiKey(userId, workspaceGrant.id)).toBe(true);
    expect((await rawMcp(files.access_token)).status).toBe(401);
    expect((await rawMcp(writer.access_token)).status).toBe(200);
  });

  it('suggests permissions from the requested scope and shows a pending request only to its browser', async () => {
    const client = await publicClient(['http://127.0.0.1:4567/callback']);
    const flow = await startFlow(client.client_id, { scope: 'read write workspace:read', redirectUri: 'http://127.0.0.1:4567/callback' });
    const pending = await oauth.pendingAuthorization(flow.id, flow.cookie);
    expect(pending).toMatchObject({ client: { name: 'Test Connector', kind: 'registered', documentHost: null }, loopbackRedirect: true, redirectLabel: '127.0.0.1:4567' });
    expect(pending!.suggested).toEqual({ canWrite: true, workspaceAccess: 'read', workspaceOnly: false, workspaceRoot: '/' });
    expect(await oauth.pendingAuthorization(flow.id, 'another-browser')).toBeNull();
    expect(await oauth.pendingAuthorization(flow.id, undefined)).toBeNull();
  });

  it('sends a denial back as access_denied with the state', async () => {
    const { token: session } = await person();
    const client = await publicClient();
    const flow = await startFlow(client.client_id);
    state.session = session;
    const response = await decide(flow.id, flow.cookie, { approve: false });
    const redirect = new URL(((await response.json()) as { redirect: string }).redirect);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('state-123');
    expect(redirect.searchParams.get('code')).toBeNull();
    /* Decided once. */
    expect((await decide(flow.id, flow.cookie, { approve: true })).status).toBe(410);
  });
});

describeWithDb('MCP OAuth: refusals', () => {
  it('matches a loopback redirect on any port, everything else of it exactly', async () => {
    const { token: session } = await person();
    const client = await publicClient(['http://127.0.0.1:4567/callback', 'http://localhost:8000/cb', 'https://client.example.test:8443/callback']);
    const flow = await startFlow(client.client_id, { redirectUri: 'http://127.0.0.1:51234/callback' });
    state.session = session;
    const decided = await decide(flow.id, flow.cookie, { approve: true });
    state.session = null;
    const redirect = new URL(((await decided.json()) as { redirect: string }).redirect);
    expect(redirect.host).toBe('127.0.0.1:51234');
    const exchanged = await token({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, redirect_uri: 'http://127.0.0.1:51234/callback', code_verifier: flow.verifier, client_id: client.client_id });
    expect(exchanged.status).toBe(200);
    await startFlow(client.client_id, { redirectUri: 'http://localhost:9/cb' });
    for (const redirectUri of ['http://127.0.0.1:51234/other', 'http://127.0.0.1:51234/callback?x=1', 'http://[::1]:4567/callback', 'http://localhost:8000/callback', 'https://client.example.test:9443/callback', 'https://client.example.test/callback']) {
      const response = await authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri });
      expect(response.headers.get('location'), redirectUri).toBe(`${BASE}/oauth/error?reason=invalid_redirect_uri`);
    }
  });

  it('answers a wrong API key with the key challenge and no OAuth pointer', async () => {
    const wrongKey = await rawMcp(`re0_sk_${'0'.repeat(64)}`);
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.headers.get('www-authenticate')).toBe('Bearer realm="re0", error="invalid_token"');
    expect(await wrongKey.json()).toMatchObject({ error: 'invalid_api_key' });
    const stranger = await rawMcp('some-other-token');
    expect(stranger.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(await stranger.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('never redirects to an unknown client or an unregistered redirect URI', async () => {
    const client = await publicClient();
    const unknown = await authorize({ response_type: 'code', client_id: 're0_client_ffffffffffffffffffffffffffffffff', redirect_uri: REDIRECT });
    expect(unknown.headers.get('location')).toBe(`${BASE}/oauth/error?reason=invalid_client`);
    for (const redirectUri of ['https://evil.example.test/callback', `${REDIRECT}/`, `${REDIRECT}?x=1`, 'https://CLIENT.example.test/callback', '']) {
      const response = await authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
      expect(response.headers.get('location'), redirectUri).toBe(`${BASE}/oauth/error?reason=invalid_redirect_uri`);
    }
  });

  it('sends other faults back to the registered redirect URI: no PKCE, plain PKCE, wrong response type, another resource', async () => {
    const client = await publicClient();
    const base = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: (await pkce()).challenge, code_challenge_method: 'S256' };
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge: '' }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ resource: 'https://other.example.test/mcp' }, 'invalid_target'],
    ];
    for (const [change, error] of cases) {
      const response = await authorize({ ...base, ...change });
      const location = new URL(response.headers.get('location')!);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get('error'), JSON.stringify(change)).toBe(error);
      expect(location.searchParams.get('state')).toBe('s');
      expect(location.searchParams.get('iss')).toBe(BASE);
    }
  });

  it('refuses a wrong verifier, a replayed code, another client, another redirect URI or resource', async () => {
    const { token: session } = await person();
    const client = await publicClient();
    const other = await publicClient();

    const wrong = await approve(client.client_id, session);
    const bad = await token({ grant_type: 'authorization_code', code: wrong.code, redirect_uri: REDIRECT, code_verifier: (await pkce()).verifier, client_id: client.client_id });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });
    /* The code was spent by the failed attempt. */
    expect((await token({ grant_type: 'authorization_code', code: wrong.code, redirect_uri: REDIRECT, code_verifier: wrong.verifier, client_id: client.client_id })).status).toBe(400);

    const missing = await approve(client.client_id, session);
    expect((await token({ grant_type: 'authorization_code', code: missing.code, redirect_uri: REDIRECT, client_id: client.client_id })).status).toBe(400);

    const foreign = await approve(client.client_id, session);
    expect((await token({ grant_type: 'authorization_code', code: foreign.code, redirect_uri: REDIRECT, code_verifier: foreign.verifier, client_id: other.client_id })).status).toBe(400);

    const elsewhere = await approve(client.client_id, session);
    expect((await token({ grant_type: 'authorization_code', code: elsewhere.code, redirect_uri: 'https://client.example.test/other', code_verifier: elsewhere.verifier, client_id: client.client_id })).status).toBe(400);

    const resource = await approve(client.client_id, session);
    const target = await token({ grant_type: 'authorization_code', code: resource.code, code_verifier: resource.verifier, client_id: client.client_id, resource: 'https://other.example.test/mcp' });
    expect(await target.json()).toMatchObject({ error: 'invalid_target' });

    /* A replayed code revokes the grant its first use made. */
    const good = await approve(client.client_id, session);
    const first = await token({ grant_type: 'authorization_code', code: good.code, redirect_uri: REDIRECT, code_verifier: good.verifier, client_id: client.client_id });
    expect(first.status).toBe(200);
    const issued = (await first.json()) as { access_token: string };
    expect((await rawMcp(issued.access_token)).status).toBe(200);
    expect((await token({ grant_type: 'authorization_code', code: good.code, redirect_uri: REDIRECT, code_verifier: good.verifier, client_id: client.client_id })).status).toBe(400);
    expect((await rawMcp(issued.access_token)).status).toBe(401);

    expect((await token({ grant_type: 'password', client_id: client.client_id })).status).toBe(400);
    expect((await token({ grant_type: 'authorization_code', code: 'x', client_id: 're0_client_00000000000000000000000000000000' })).status).toBe(401);
  });

  it('expires codes after five minutes', async () => {
    const { token: session } = await person();
    const client = await publicClient();
    const { code, verifier } = await approve(client.client_id, session);
    await db().update(schema.oauthAuthorization).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.oauthAuthorization.clientId, client.client_id));
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id })).status).toBe(400);
  });

  it('authenticates confidential clients', async () => {
    const { token: session } = await person();
    const registered = (await (await register({ client_name: 'Confidential', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' })).json()) as { client_id: string; client_secret: string };
    const noSecret = await approve(registered.client_id, session);
    const refused = await token({ grant_type: 'authorization_code', code: noSecret.code, code_verifier: noSecret.verifier, client_id: registered.client_id });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: 'invalid_client' });
    const basic = await approve(registered.client_id, session);
    const accepted = await token({ grant_type: 'authorization_code', code: basic.code, code_verifier: basic.verifier }, { authorization: `Basic ${btoa(`${registered.client_id}:${registered.client_secret}`)}` });
    expect(accepted.status).toBe(200);
  });

  it('lets a spent refresh token be retried within a minute, and revokes the grant when it comes back later', async () => {
    const { token: session } = await person();
    const client = await publicClient();
    const tokens = await tokensFor(client.client_id, session);
    const refresh = (value: string) => token({ grant_type: 'refresh_token', refresh_token: value, client_id: client.client_id });
    const rotated = (await (await refresh(tokens.refresh_token)).json()) as { access_token: string; refresh_token: string };

    /* A retry after a lost response, or a racing refresh: another pair, and nothing revoked. */
    const retried = await refresh(tokens.refresh_token);
    expect(retried.status).toBe(200);
    const second = (await retried.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(rotated.refresh_token);
    expect((await rawMcp(rotated.access_token)).status).toBe(200);
    expect((await rawMcp(second.access_token)).status).toBe(200);
    const [racing1, racing2] = await Promise.all([refresh(second.refresh_token), refresh(second.refresh_token)]);
    expect([racing1.status, racing2.status]).toEqual([200, 200]);
    const latest = (await racing1.json()) as { access_token: string; refresh_token: string };

    /* The window does not slide: a minute after the first use, the same token is a replay. */
    const { sha256 } = await import('@/lib/infra/crypto/tokens');
    await db().update(schema.oauthToken).set({ rotatedAt: new Date(Date.now() - 61_000) }).where(eq(schema.oauthToken.digest, await sha256(tokens.refresh_token)));
    const replayed = await refresh(tokens.refresh_token);
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await rawMcp(latest.access_token)).status).toBe(401);
    expect((await refresh(latest.refresh_token)).status).toBe(400);
  });

  it('refuses a refresh token for another client and expired access tokens', async () => {
    const { token: session } = await person();
    const client = await publicClient();
    const other = await publicClient();
    const tokens = await tokensFor(client.client_id, session);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: other.client_id })).status).toBe(400);
    /* Another client cannot revoke it either. */
    await revokeRoute.POST(new NextRequest(`${BASE}/api/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.access_token, client_id: other.client_id }).toString() }));
    expect((await rawMcp(tokens.access_token)).status).toBe(200);
    const { sha256 } = await import('@/lib/infra/crypto/tokens');
    await db().update(schema.oauthToken).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.oauthToken.digest, await sha256(tokens.access_token)));
    expect((await rawMcp(tokens.access_token)).status).toBe(401);
  });

  it('refuses a token issued for another resource', async () => {
    const { token: session } = await person();
    const client = await publicClient();
    const tokens = await tokensFor(client.client_id, session);
    const { sha256 } = await import('@/lib/infra/crypto/tokens');
    await db().update(schema.oauthToken).set({ resource: 'https://other.example.test/mcp' }).where(eq(schema.oauthToken.digest, await sha256(tokens.access_token)));
    expect((await rawMcp(tokens.access_token)).status).toBe(401);
  });

  it('refuses consent from another site, another browser, or without a session', async () => {
    const { token: session } = await person();
    const client = await publicClient();
    const flow = await startFlow(client.client_id);
    expect((await decide(flow.id, flow.cookie, { approve: true })).status).toBe(401);
    state.session = session;
    expect((await decide(flow.id, flow.cookie, { approve: true }, 'https://evil.example.test')).status).toBe(403);
    expect((await decide(flow.id, null, { approve: true })).status).toBe(410);
    expect((await decide(flow.id, 'forged', { approve: true })).status).toBe(410);
    expect((await decide(flow.id, flow.cookie, { approve: true, permissions: { workspaceOnly: true, workspaceAccess: 'none' } })).status).toBe(422);
    expect((await decide(flow.id, flow.cookie, { approve: true, permissions: { workspaceOnly: true, workspaceAccess: 'read', workspaceRoot: '/../x' } })).status).toBe(422);
    /* Still pending after the refusals. */
    expect((await decide(flow.id, flow.cookie, { approve: true })).status).toBe(200);
  });

  it('ends access for a disabled account and keeps OAuth grants out of the key cap', async () => {
    const { userId, token: session } = await person();
    const client = await publicClient();
    const tokens = await tokensFor(client.client_id, session);
    for (let i = 0; i < 10; i += 1) await apiKeys.createApiKey(userId, { name: `k${i}` });
    await expect(apiKeys.createApiKey(userId, { name: 'eleventh' })).rejects.toMatchObject({ code: 'too_many_keys' });
    expect((await rawMcp(tokens.access_token)).status).toBe(200);
    await db().update(schema.user).set({ disabledAt: new Date() }).where(eq(schema.user.id, userId));
    expect((await rawMcp(tokens.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).status).toBe(400);
  });

  it('never accepts an OAuth grant row as an API key', async () => {
    const rows = await db().select().from(schema.apiKey).where(and(eq(schema.apiKey.keyTail, ''))).limit(1);
    expect(rows.every((row) => row.keyDigest === null)).toBe(true);
    expect(await apiKeys.resolveApiKey(`re0_sk_${'0'.repeat(64)}`)).toBeNull();
  });
});
