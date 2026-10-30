/**
 * Key management, against a real database. architecture.md 5.1: the plaintext
 * works exactly as minted and is never stored, the plan's key limit gates
 * creation, and a revoked key stops authenticating without losing its row.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.API_KEY_HASH_SECRET ??= 'test-api-key-hash-secret-000000000000';

const { createApiKey, listApiKeys, revokeApiKey, resolveApiKey, rotateApiKey } = await import(
  '@/lib/application/auth'
);
const { hashApiKey, requireScope } = await import('@/lib/application/auth/api-key');
const { API_KEY_READ_SCOPES: API_KEY_SCOPES, normaliseScopes } = await import('@/lib/domain/api-key');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { GET: usageRoute } = await import('@/app/api/v1/usage/route');
const { GET: requestsRoute } = await import('@/app/api/v1/requests/route');
const { GET: searchRoute } = await import('@/app/api/v1/libraries/search/route');
const { GET: contextRoute } = await import('@/app/api/v1/context/route');
const { POST: mcpRoute } = await import('@/app/mcp/route');
const { surfaceEnabled } = await import('@/lib/domain/surfaces');

const workspaces: string[] = [];
const planVersions: string[] = [];

async function workspaceOnPlan(apiKeyLimit: number): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'keys-test' });

  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'free',
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls: 100,
    apiKeyLimit,
    capabilities: {},
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  await database.insert(schema.subscription).values({
    id: uuidv7(),
    workspaceId,
    planVersionId,
    status: 'active',
    periodStart: new Date(Date.now() - 86_400_000),
    periodEnd: new Date(Date.now() + 86_400_000),
  });
  return workspaceId;
}

function get(url: string, key: string): NextRequest {
  return new NextRequest(`https://api.example.test${url}`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

/** The standard refusal envelope: 403 and `access_denied`, never a 401. */
async function expectDenied(response: Promise<Response> | Response): Promise<void> {
  const resolved = await response;
  expect(resolved.status).toBe(403);
  const body = (await resolved.json()) as { error: { code: string; requestId: string } };
  expect(body.error.code).toBe('access_denied');
  expect(body.error.requestId).toBeTruthy();
}

/** One MCP `tools/call`, unwrapped to the tool result the client would read. */
async function mcpTool(
  key: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  const response = await mcpRoute(
    new NextRequest('https://api.example.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await response.json()) as {
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  return {
    isError: body.result?.isError,
    text: body.result?.content?.map((part) => part.text ?? '').join('\n') ?? '',
  };
}

/* MCP is offline (lib/domain/surfaces.ts); the scope check on its tools waits behind the switch. */
const whileOn = surfaceEnabled('mcp') ? it : it.skip;

describeWithDb('api key management', () => {
  afterAll(async () => {
    const database = db();
    if (workspaces.length > 0) {
      /* Driving the REST and MCP routes writes the log rows they describe. */
      await database
        .delete(schema.requestLog)
        .where(inArray(schema.requestLog.workspaceId, workspaces));
      await database.delete(schema.apiKey).where(inArray(schema.apiKey.workspaceId, workspaces));
      await database
        .delete(schema.subscription)
        .where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database
        .delete(schema.planVersion)
        .where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('mints a working key once, lists the mask, enforces the limit, revokes', async () => {
    const workspaceId = await workspaceOnPlan(2);

    const first = await createApiKey({ role: 'owner', workspaceId, name: 'ci retrieval' });
    expect(first.key.startsWith('mm_live_')).toBe(true);

    /* The plaintext authenticates; the table holds only its hash. */
    const principal = await resolveApiKey(`Bearer ${first.key}`);
    expect(principal?.workspaceId).toBe(workspaceId);
    const [stored] = await db()
      .select({ keyHash: schema.apiKey.keyHash })
      .from(schema.apiKey)
      .where(eq(schema.apiKey.id, first.view.id));
    expect(stored?.keyHash).not.toContain(first.key.slice(-12));

    const listed = await listApiKeys(workspaceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.masked.endsWith(first.key.slice(-4))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(first.key);

    await createApiKey({ role: 'owner', workspaceId, name: 'second' });
    await expect(createApiKey({ role: 'owner', workspaceId, name: 'third' })).rejects.toMatchObject({
      code: 'api_key_limit_exceeded',
    });

    await revokeApiKey({ role: 'owner', workspaceId, keyId: first.view.id });
    await expect(resolveApiKey(`Bearer ${first.key}`)).rejects.toMatchObject({
      code: 'invalid_api_key',
    });
    expect(await listApiKeys(workspaceId)).toHaveLength(1);

    /* A stranger cannot revoke someone else's key. */
    const stranger = await workspaceOnPlan(2);
    const second = (await listApiKeys(workspaceId))[0]!;
    await revokeApiKey({ role: 'owner', workspaceId: stranger, keyId: second.id });
    expect(await listApiKeys(workspaceId)).toHaveLength(1);
  });

  /**
   * requirement.md 3.3: API keys are the owner's. Both actions are reached
   * through a server action -- a public endpoint with a generated name -- so
   * the page choosing not to render a button decides nothing.
   */
  it('refuses to mint or revoke a key for anyone but the owner', async () => {
    const workspaceId = await workspaceOnPlan(2);
    const mine = await createApiKey({ role: 'owner', workspaceId, name: 'owner key' });

    for (const role of ['admin', 'developer', 'viewer'] as const) {
      await expect(createApiKey({ role, workspaceId, name: 'not mine' })).rejects.toMatchObject({
        code: 'access_denied',
      });
      await expect(
        revokeApiKey({ role, workspaceId, keyId: mine.view.id }),
      ).rejects.toMatchObject({ code: 'access_denied' });
    }

    /* Still live: none of those refusals touched it. */
    expect((await resolveApiKey(`Bearer ${mine.key}`))?.workspaceId).toBe(workspaceId);
  });

  /**
   * requirement.md 5.2: rotation is a swap. The replacement inherits name,
   * environment and scopes; the predecessor is silenced in the same
   * transaction, so there is never a moment with two live keys and never one
   * with none.
   */
  it('rotates into a replacement carrying the same name, environment and scopes', async () => {
    const workspaceId = await workspaceOnPlan(2);
    const original = await createApiKey({
      role: 'owner',
      workspaceId,
      name: 'ci retrieval',
      environment: 'test',
      scopes: ['knowledge:read', 'usage:read'],
    });
    /* The workspace is at its ceiling: rotation is a swap, not a mint. */
    const second = await createApiKey({ role: 'owner', workspaceId, name: 'second' });
    await expect(createApiKey({ role: 'owner', workspaceId, name: 'third' })).rejects.toMatchObject({
      code: 'api_key_limit_exceeded',
    });

    const rotated = await rotateApiKey({ role: 'owner', workspaceId, keyId: original.view.id });
    expect(rotated).not.toBeNull();
    expect(rotated!.replaced).toBe(original.view.id);
    expect(rotated!.view.id).not.toBe(original.view.id);
    expect(rotated!.view.name).toBe('ci retrieval');
    expect(rotated!.view.environment).toBe('test');
    expect([...rotated!.view.scopes].sort()).toEqual(['knowledge:read', 'usage:read']);
    expect(rotated!.key.startsWith('mm_test_')).toBe(true);
    expect(rotated!.key).not.toBe(original.key);

    /* The replacement works and carries exactly the inherited scopes. */
    const principal = await resolveApiKey(`Bearer ${rotated!.key}`);
    expect(principal?.workspaceId).toBe(workspaceId);
    expect([...(principal?.scopes ?? [])].sort()).toEqual(['knowledge:read', 'usage:read']);

    /* The predecessor is dead but not gone: the row explains historical usage. */
    await expect(resolveApiKey(`Bearer ${original.key}`)).rejects.toMatchObject({
      code: 'invalid_api_key',
    });
    const [old] = await db()
      .select({ revokedAt: schema.apiKey.revokedAt, name: schema.apiKey.name })
      .from(schema.apiKey)
      .where(eq(schema.apiKey.id, original.view.id));
    expect(old?.name).toBe('ci retrieval');
    expect(old?.revokedAt).toBeInstanceOf(Date);

    /* Still two live keys: the swap neither breached the plan's ceiling nor
       was refused by it, which is what a swap at the ceiling must do. */
    const listed = await listApiKeys(workspaceId);
    expect([...listed.map((row) => row.id)].sort()).toEqual(
      [rotated!.view.id, second.view.id].sort(),
    );

    /* The plaintext exists once: nothing readable afterwards contains it. */
    expect(JSON.stringify(listed)).not.toContain(rotated!.key);
    const [storedNew] = await db()
      .select({ keyHash: schema.apiKey.keyHash })
      .from(schema.apiKey)
      .where(eq(schema.apiKey.id, rotated!.view.id));
    expect(storedNew?.keyHash).not.toContain(rotated!.key.slice(-12));
    expect(storedNew?.keyHash).toBe(await hashApiKey(rotated!.key));

    /* Rotating the already-rotated id is "no such live key". */
    expect(await rotateApiKey({ role: 'owner', workspaceId, keyId: original.view.id })).toBeNull();

    /* Rotating again mints a different plaintext again. */
    const again = await rotateApiKey({ role: 'owner', workspaceId, keyId: rotated!.view.id });
    expect(again!.key).not.toBe(rotated!.key);
    await expect(resolveApiKey(`Bearer ${rotated!.key}`)).rejects.toMatchObject({
      code: 'invalid_api_key',
    });
    expect(await listApiKeys(workspaceId)).toHaveLength(2);
  });

  it('rotates a workspace whose plan allows exactly one key', async () => {
    const workspaceId = await workspaceOnPlan(1);
    const only = await createApiKey({ role: 'owner', workspaceId, name: 'only key' });
    const rotated = await rotateApiKey({ role: 'owner', workspaceId, keyId: only.view.id });
    expect(rotated).not.toBeNull();
    expect((await resolveApiKey(`Bearer ${rotated!.key}`))?.workspaceId).toBe(workspaceId);
    expect(await listApiKeys(workspaceId)).toHaveLength(1);
  });

  it('refuses rotation for a non-owner, and hides another workspace’s key', async () => {
    const workspaceId = await workspaceOnPlan(2);
    const mine = await createApiKey({ role: 'owner', workspaceId, name: 'owner key' });

    for (const role of ['admin', 'developer', 'viewer'] as const) {
      await expect(rotateApiKey({ role, workspaceId, keyId: mine.view.id })).rejects.toMatchObject({
        code: 'access_denied',
      });
    }

    /* Another workspace's key is indistinguishable from one that never was. */
    const stranger = await workspaceOnPlan(2);
    expect(
      await rotateApiKey({ role: 'owner', workspaceId: stranger, keyId: mine.view.id }),
    ).toBeNull();
    expect(
      await rotateApiKey({ role: 'owner', workspaceId, keyId: crypto.randomUUID() }),
    ).toBeNull();

    /* None of that touched the key. */
    expect((await resolveApiKey(`Bearer ${mine.key}`))?.workspaceId).toBe(workspaceId);
    expect(await listApiKeys(workspaceId)).toHaveLength(1);
  });

  /* --------------------------------------------------- scope enforcement */

  it('admits a key only to the paths its scopes name', async () => {
    const workspaceId = await workspaceOnPlan(5);
    const search = await createApiKey({
      role: 'owner',
      workspaceId,
      name: 'search only',
      scopes: ['knowledge:search'],
    });
    const read = await createApiKey({
      role: 'owner',
      workspaceId,
      name: 'read only',
      scopes: ['knowledge:read'],
    });
    const usage = await createApiKey({
      role: 'owner',
      workspaceId,
      name: 'usage only',
      scopes: ['usage:read'],
    });

    /* The gate itself, against a principal resolved from the real row. */
    const searchPrincipal = await resolveApiKey(`Bearer ${search.key}`);
    expect(searchPrincipal?.scopes).toEqual(['knowledge:search']);
    expect(() => requireScope(searchPrincipal, 'knowledge:search')).not.toThrow();
    expect(() => requireScope(searchPrincipal, 'knowledge:read')).toThrow(
      expect.objectContaining({ code: 'access_denied' }),
    );

    /* /v1/libraries/search needs knowledge:search. */
    expect(
      (await searchRoute(get('/api/v1/libraries/search?query=ledger', search.key))).status,
    ).toBe(200);
    await expectDenied(searchRoute(get('/api/v1/libraries/search?query=ledger', read.key)));
    await expectDenied(searchRoute(get('/api/v1/libraries/search?query=ledger', usage.key)));

    /* /v1/context needs knowledge:read. The holder reaches the use case --
       the library is not there, which is a 404 and not a refusal. */
    const reached = await contextRoute(
      get('/api/v1/context?libraryId=/websites/nothing-here&query=ledger', read.key),
    );
    expect(reached.status).toBe(404);
    await expectDenied(
      contextRoute(get('/api/v1/context?libraryId=/websites/nothing-here&query=ledger', search.key)),
    );
    await expectDenied(
      contextRoute(get('/api/v1/context?libraryId=/websites/nothing-here&query=ledger', usage.key)),
    );

    /* /v1/usage and /v1/requests need usage:read. */
    expect((await usageRoute(get('/api/v1/usage', usage.key))).status).toBe(200);
    expect((await requestsRoute(get('/api/v1/requests', usage.key))).status).toBe(200);
    await expectDenied(usageRoute(get('/api/v1/usage', search.key)));
    await expectDenied(requestsRoute(get('/api/v1/requests', read.key)));
  });

  whileOn('applies the same scopes to the MCP tools', async () => {
    const workspaceId = await workspaceOnPlan(5);
    const search = await createApiKey({
      role: 'owner',
      workspaceId,
      name: 'mcp search',
      scopes: ['knowledge:search'],
    });
    const usage = await createApiKey({
      role: 'owner',
      workspaceId,
      name: 'mcp usage',
      scopes: ['usage:read'],
    });

    const denied = await mcpTool(usage.key, 'resolve-library-id', { query: 'ledger' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('access_denied');

    const allowed = await mcpTool(search.key, 'resolve-library-id', { query: 'ledger' });
    expect(allowed.isError ?? false).toBe(false);

    /* query-docs is knowledge:read, which neither key holds. */
    const readDenied = await mcpTool(search.key, 'query-docs', {
      libraryId: '/websites/nothing-here',
      query: 'ledger',
    });
    expect(readDenied.isError).toBe(true);
    expect(readDenied.text).toContain('access_denied');
  });

  /**
   * Rows minted before scopes existed carry the single word `retrieval`. They
   * must keep working as the everything-key they were.
   */
  it('reads a legacy `retrieval` row as the full grantable set', async () => {
    const workspaceId = await workspaceOnPlan(5);
    const key = `mm_live_${crypto.randomUUID().replace(/-/g, '')}`;
    await db().insert(schema.apiKey).values({
      id: uuidv7(),
      workspaceId,
      name: 'pre-scopes key',
      keyHash: await hashApiKey(key),
      keyPrefix: 'mm_live_',
      lastFour: key.slice(-4),
      scopes: ['retrieval'],
      environment: 'live',
    });

    expect([...normaliseScopes(['retrieval'])].sort()).toEqual([...API_KEY_SCOPES].sort());
    const principal = await resolveApiKey(`Bearer ${key}`);
    expect([...(principal?.scopes ?? [])].sort()).toEqual([...API_KEY_SCOPES].sort());

    expect((await searchRoute(get('/api/v1/libraries/search?query=ledger', key))).status).toBe(200);
    expect((await usageRoute(get('/api/v1/usage', key))).status).toBe(200);
    expect(
      (await contextRoute(get('/api/v1/context?libraryId=/websites/nothing-here&query=x', key)))
        .status,
    ).toBe(404);

    /* And its rotation inherits the expanded set, not the legacy word. */
    const listed = await listApiKeys(workspaceId);
    const rotated = await rotateApiKey({ role: 'owner', workspaceId, keyId: listed[0]!.id });
    expect([...rotated!.view.scopes].sort()).toEqual([...API_KEY_SCOPES].sort());
  });
});
