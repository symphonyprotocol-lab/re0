/**
 * The REST and MCP entry layer, against a real database. architecture.md 12.1
 * and 13.1: the routes are shells over the same retrieval use cases, an API
 * key authenticates a workspace, anonymous traffic rides the rate limit, and
 * TXT is rendered from the canonical JSON.
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

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { hashApiKey } = await import('@/lib/application/auth/api-key');
const { createPlatformLibrary } = await import(
  '@/lib/application/administration/manage-platform-libraries'
);
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { GET: searchRoute } = await import('@/app/api/v1/libraries/search/route');
const { GET: contextRoute } = await import('@/app/api/v1/context/route');
const { POST: mcpRoute } = await import('@/app/mcp/route');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const created: string[] = [];
const workspaces: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();

function dependencies() {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/guide.md',
            url: 'https://example.test/guide',
            content:
              '# Entry Guide\n\nAuthentication uses bearer tokens. Send the key in the Authorization header.',
          },
        ],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          folders: [],
          excludeFolders: [],
          excludeFiles: [],
          rules: [],
        },
        revision: 'fixture-revision',
        lastModifiedAt: new Date(),
        hasLicense: true,
        stale: false,
      };
    },
    embeddings: () => ({
      model: 'fixture-embed-1',
      dimensions: EMBEDDING_COLUMN_DIMENSIONS,
      async embed(texts: string[]) {
        return texts.map((text) =>
          Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17),
        );
      },
    }),
    store: () => store,
    configured: () => ({ embeddings: true, storage: true }),
  };
}

async function publishedLibrary(slug: string): Promise<string> {
  const { libraryId } = await createPlatformLibrary({
    actor,
    title: `Entry fixture ${slug}`,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://example.test/${slug}`,
    refreshPolicy: 'manual',
    language: 'en',
    reason: 'integration test fixture',
  });
  created.push(libraryId);
  const built = await buildVersion({ libraryId, operationId: uuidv7(), dependencies: dependencies() });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  await db()
    .update(schema.library)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.library.id, libraryId));
  return libraryId;
}

async function workspaceWithKey(): Promise<{ workspaceId: string; key: string }> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'entry-test' });

  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 100,
    libraryLimit: 10,
    librarySizeBytesLimit: 1_000_000,
    apiKeyLimit: 5,
    shareRateBps: 2000,
    capabilities: {},
    /* Backdated so the live catalogue's newest 'pro' version stays the seeded
       one -- these fixture rows must not win currentPlanVersion() races with
       the plan-configuration suite running in a parallel worker. */
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

  const key = `mm_test_${crypto.randomUUID().replace(/-/g, '')}`;
  await database.insert(schema.apiKey).values({
    id: uuidv7(),
    workspaceId,
    name: 'entry test key',
    keyHash: await hashApiKey(key),
    keyPrefix: 'mm_test_',
    lastFour: key.slice(-4),
    scopes: ['retrieval'],
    environment: 'test',
  });
  return { workspaceId, key };
}

function get(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://api.example.test${url}`, { headers });
}

function mcpPost(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://api.example.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describeWithDb('rest and mcp entry', () => {
  afterAll(async () => {
    const database = db();
    if (created.length > 0) {
      await database
        .update(schema.library)
        .set({ currentVersionId: null })
        .where(inArray(schema.library.id, created));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.libraryId, created));
      await database
        .delete(schema.libraryProfileVector)
        .where(inArray(schema.libraryProfileVector.libraryId, created));
      await database
        .delete(schema.libraryProfile)
        .where(inArray(schema.libraryProfile.libraryId, created));
      await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, created));
      await database.delete(schema.document).where(inArray(schema.document.libraryId, created));
      await database
        .delete(schema.libraryVersion)
        .where(inArray(schema.libraryVersion.libraryId, created));
      await database
        .delete(schema.libraryScore)
        .where(inArray(schema.libraryScore.libraryId, created));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, created));
      await database
        .delete(schema.libraryAlias)
        .where(inArray(schema.libraryAlias.libraryId, created));
      await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, created));
      await database.delete(schema.library).where(inArray(schema.library.id, created));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.requestLog)
        .where(inArray(schema.requestLog.workspaceId, workspaces));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database
        .delete(schema.usageReservation)
        .where(inArray(schema.usageReservation.workspaceId, workspaces));
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

  it('searches and retrieves through REST with an API key', async () => {
    const stamp = Date.now();
    await publishedLibrary(`entry-rest-${stamp}`);
    const { key } = await workspaceWithKey();
    const bearer = { authorization: `Bearer ${key}` };

    const search = await searchRoute(
      get(`/api/v1/libraries/search?query=bearer+token+authentication`, bearer),
    );
    expect(search.status).toBe(200);
    const found = (await search.json()) as {
      results: { libraryId: string; evidence: { matchedTerms: string[] } }[];
    };
    const hit = found.results.find((r) => r.libraryId === `/websites/entry-rest-${stamp}`);
    expect(hit).toBeDefined();
    expect(hit!.evidence.matchedTerms.length).toBeGreaterThan(0);

    const context = await contextRoute(
      get(
        `/api/v1/context?libraryId=/websites/entry-rest-${stamp}&query=authorization+header&maxTokens=4000`,
        bearer,
      ),
    );
    expect(context.status).toBe(200);
    const output = (await context.json()) as {
      chunks: { citation: { sourceUrl: string } }[];
      usage: { callsUsed: number; planAllowanceRemaining: number };
    };
    expect(output.chunks.length).toBeGreaterThan(0);
    expect(output.usage.callsUsed).toBe(1);
    expect(output.usage.planAllowanceRemaining).toBe(99);
  });

  it('renders txt from the canonical object', async () => {
    const stamp = Date.now();
    await publishedLibrary(`entry-txt-${stamp}`);

    const response = await contextRoute(
      get(`/api/v1/context?libraryId=/websites/entry-txt-${stamp}&query=bearer+tokens&type=txt`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain(`/websites/entry-txt-${stamp}`);
    expect(text).toContain('Source: https://example.test/guide');
  });

  it('maps refusals to the contract error envelope', async () => {
    const missing = await contextRoute(get('/api/v1/context?libraryId=/none/here&query=x'));
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('library_not_found');
    expect(body.error.requestId.length).toBeGreaterThan(0);

    const invalid = await searchRoute(get('/api/v1/libraries/search'));
    expect(invalid.status).toBe(400);

    const badKey = await searchRoute(
      get('/api/v1/libraries/search?query=x', { authorization: 'Bearer mm_test_wrong' }),
    );
    expect(badKey.status).toBe(401);
  });

  it('speaks MCP: initialize, list tools, call both', async () => {
    const stamp = Date.now();
    await publishedLibrary(`entry-mcp-${stamp}`);
    const { key } = await workspaceWithKey();
    const bearer = { authorization: `Bearer ${key}` };

    const initialize = await mcpRoute(
      mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    );
    const initialized = (await initialize.json()) as {
      result: { serverInfo: { name: string }; capabilities: { tools: object } };
    };
    expect(initialized.result.serverInfo.name).toBe('re0');

    const list = await mcpRoute(mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const tools = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((tool) => tool.name)).toEqual([
      'resolve-library-id',
      'query-docs',
    ]);

    const resolve = await mcpRoute(
      mcpPost(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'resolve-library-id', arguments: { query: 'bearer token authentication' } },
        },
        bearer,
      ),
    );
    const resolved = (await resolve.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    expect(resolved.result.isError).toBeUndefined();
    expect(resolved.result.content[0]!.text).toContain(`/websites/entry-mcp-${stamp}`);

    const docs = await mcpRoute(
      mcpPost(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'query-docs',
            arguments: { libraryId: `/websites/entry-mcp-${stamp}`, query: 'authorization header' },
          },
        },
        bearer,
      ),
    );
    const answered = (await docs.json()) as { result: { content: { text: string }[] } };
    expect(answered.result.content[0]!.text).toContain('https://example.test/guide');

    /* A tool failure is a tool result the model can read, not a protocol error. */
    const refused = await mcpRoute(
      mcpPost(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'query-docs', arguments: { libraryId: '/none/here', query: 'x' } },
        },
        bearer,
      ),
    );
    const failure = (await refused.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(failure.result.isError).toBe(true);
    expect(failure.result.content[0]!.text).toContain('library_not_found');
  });
});
