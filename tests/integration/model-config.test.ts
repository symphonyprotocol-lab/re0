/**
 * The model registry's round trip, against a real database.
 * architecture.md 9.1, 9.2, 15.3, requirement.md 5.3.
 *
 * What only the rows can show: that a save is what the next resolve returns,
 * that the credential survives the trip without ever being stored in the
 * clear, that an edit which leaves the key blank keeps the one already there,
 * and that neither the credential nor anything derived from it reaches the
 * audit chain.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.CREDENTIAL_ENCRYPTION_KEY ??= 'test-credential-key-long-enough-00000000';

const {
  modelProviderStatus,
  readModelConfiguration,
  resolveEmbeddingProvider,
  resolveRerankProvider,
  updateModelConfig,
  ModelConfigRefused,
} = await import('@/lib/application/administration');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');

const administratorId = crypto.randomUUID();
const configIds: string[] = [];
const actor = { administratorId, email: 'ops@example.test' };

async function save(input: Parameters<typeof updateModelConfig>[0]) {
  const result = await updateModelConfig(input);
  configIds.push(result.configId);
  return result;
}

describeWithDb('model configuration', () => {
  afterAll(async () => {
    const database = db();
    if (configIds.length > 0) {
      await database
        .delete(schema.providerModelConfig)
        .where(inArray(schema.providerModelConfig.id, configIds));
    }
    await database
      .delete(schema.auditLog)
      .where(eq(schema.auditLog.administratorId, administratorId));
    await database.delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
  });

  /*
   * First, while no rerank row exists: an installation upgraded from before
   * this table keeps the reranker its environment configured, instead of
   * losing it on deploy until somebody re-enters the key.
   */
  it('falls back to the environment for a kind that was never saved', async () => {
    const saved = {
      key: process.env.RERANK_PROVIDER_API_KEY,
      url: process.env.RERANK_PROVIDER_BASE_URL,
    };
    try {
      process.env.RERANK_PROVIDER_API_KEY = 'sk-rerank-env';
      process.env.RERANK_PROVIDER_BASE_URL = 'https://rerank-env.example.test/v2/';
      expect(await resolveRerankProvider()).toMatchObject({
        baseUrl: 'https://rerank-env.example.test/v2',
        apiKey: 'sk-rerank-env',
      });
      const view = await readModelConfiguration();
      expect(view.current.rerank).toBeNull();
      expect(view.fromEnvironment.rerank).toBe(true);
      expect(view.usable.rerank).toBe(true);
    } finally {
      if (saved.key === undefined) delete process.env.RERANK_PROVIDER_API_KEY;
      else process.env.RERANK_PROVIDER_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.RERANK_PROVIDER_BASE_URL;
      else process.env.RERANK_PROVIDER_BASE_URL = saved.url;
    }
  });

  it('a saved model is what the next resolve calls, credential and all', async () => {
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: `models-${Date.now()}@example.test`,
      username: `models-${Date.now()}`,
      passwordHash: 'unused',
      status: 'active',
    });

    /* Nothing to carry forward yet, so a blank credential is refused rather
       than saved as a configured model that cannot answer. */
    await expect(
      save({
        actor,
        kind: 'embedding',
        label: 'Fixture embeddings',
        baseUrl: 'https://embed.example.test/v1',
        model: 'fixture-embed-1',
        apiKey: null,
        dimensions: 1_024,
        timeoutMs: 30_000,
        enabled: true,
        reason: 'integration: refused, no credential',
      }),
    ).rejects.toThrow(ModelConfigRefused);

    const { configId } = await save({
      actor,
      kind: 'embedding',
      label: 'Fixture embeddings',
      baseUrl: 'https://embed.example.test/v1/',
      model: 'fixture-embed-1',
      apiKey: 'sk-embed-fixture',
      dimensions: 1_024,
      timeoutMs: 30_000,
      enabled: true,
      reason: 'integration: first embedding model',
    });

    const resolved = await resolveEmbeddingProvider();
    expect(resolved).toMatchObject({
      /* The trailing slash is trimmed on the way in, so the adapter's own
         `${baseUrl}/embeddings` cannot produce a double slash. */
      baseUrl: 'https://embed.example.test/v1',
      model: 'fixture-embed-1',
      apiKey: 'sk-embed-fixture',
      dimensions: 1_024,
      timeoutMs: 30_000,
    });

    /* Sealed at rest: the row itself must not contain the key. */
    const [row] = await db()
      .select()
      .from(schema.providerModelConfig)
      .where(eq(schema.providerModelConfig.id, configId));
    expect(row?.apiKeyCipher).toBeTruthy();
    expect(row?.apiKeyCipher).not.toContain('sk-embed-fixture');

    /* Nor may it reach the audit chain, which is exported and anchored. */
    const [entry] = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, configId));
    expect(JSON.stringify(entry?.afterValue)).not.toContain('sk-embed-fixture');
    expect(entry?.afterValue).toMatchObject({ hasCredential: true, credentialRotated: true });
  });

  it('an edit that leaves the key blank keeps the stored one', async () => {
    await save({
      actor,
      kind: 'embedding',
      label: 'Fixture embeddings',
      baseUrl: 'https://embed.example.test/v1',
      model: 'fixture-embed-1',
      apiKey: null,
      dimensions: 1_024,
      timeoutMs: 45_000,
      enabled: true,
      reason: 'integration: only the timeout moves',
    });

    const resolved = await resolveEmbeddingProvider();
    expect(resolved).toMatchObject({ apiKey: 'sk-embed-fixture', timeoutMs: 45_000 });
  });

  it('refuses to carry a stored key to a different host', async () => {
    /* The embedding entry holds a key from the tests above. Re-pointing it at
       another host with the field blank would hand that key to the new host. */
    await expect(
      save({
        actor,
        kind: 'embedding',
        label: 'Fixture embeddings',
        baseUrl: 'https://collector.example.test/v1',
        model: 'fixture-embed-1',
        apiKey: null,
        dimensions: 1_024,
        timeoutMs: 45_000,
        enabled: true,
        reason: 'integration: refused, host changed',
      }),
    ).rejects.toMatchObject({ code: 'api_key_required' });

    /* Typing the key again is the proof the operator already had it. */
    await save({
      actor,
      kind: 'embedding',
      label: 'Fixture embeddings',
      baseUrl: 'https://collector.example.test/v1',
      model: 'fixture-embed-1',
      apiKey: 'sk-embed-other',
      dimensions: 1_024,
      timeoutMs: 45_000,
      enabled: true,
      reason: 'integration: new host, new key',
    });
    expect(await resolveEmbeddingProvider()).toMatchObject({
      baseUrl: 'https://collector.example.test/v1',
      apiKey: 'sk-embed-other',
    });
  });

  it('switching a model off stops the stage without deleting anything', async () => {
    expect((await modelProviderStatus()).rerank).toBe(false);

    await save({
      actor,
      kind: 'rerank',
      label: 'Fixture reranker',
      baseUrl: 'https://rerank.example.test/v2',
      model: 'fixture-rerank-1',
      apiKey: 'sk-rerank-fixture',
      dimensions: null,
      timeoutMs: 4_000,
      enabled: true,
      reason: 'integration: first reranker',
    });
    expect(await resolveRerankProvider()).toMatchObject({ apiKey: 'sk-rerank-fixture' });
    expect(await modelProviderStatus()).toEqual({ embedding: true, rerank: true });

    await save({
      actor,
      kind: 'rerank',
      label: 'Fixture reranker',
      baseUrl: 'https://rerank.example.test/v2',
      model: 'fixture-rerank-1',
      apiKey: null,
      dimensions: null,
      timeoutMs: 4_000,
      enabled: false,
      reason: 'integration: pause reranking',
    });
    expect(await resolveRerankProvider()).toBeNull();
    /* Append-only: the history is every save, not only the ones in force. */
    const { history, current } = await readModelConfiguration();
    expect(current.rerank).toMatchObject({ enabled: false, hasCredential: true });
    expect(history.filter((row) => row.kind === 'rerank')).toHaveLength(2);
    /* And the view never carries the key, only whether there is one. */
    expect(JSON.stringify(history)).not.toContain('sk-rerank-fixture');
  });

  it('refuses a width the stored column cannot hold, and a plain-http endpoint', async () => {
    const tooWide = save({
      actor,
      kind: 'embedding',
      label: 'Too wide',
      baseUrl: 'https://embed.example.test/v1',
      model: 'text-embedding-3-large',
      apiKey: 'sk-embed-fixture',
      dimensions: 3_072,
      timeoutMs: 30_000,
      enabled: true,
      reason: 'integration: refused',
    });
    await expect(tooWide).rejects.toThrow(ModelConfigRefused);

    /* The server opens this connection carrying a credential, so a plain-http
       endpoint would put the key on the wire. */
    const plainHttp = save({
      actor,
      kind: 'rerank',
      label: 'Insecure',
      baseUrl: 'http://rerank.example.test/v2',
      model: 'fixture-rerank-1',
      apiKey: 'sk-rerank-fixture',
      dimensions: null,
      timeoutMs: 4_000,
      enabled: true,
      reason: 'integration: refused',
    });
    await expect(plainHttp).rejects.toThrow(ModelConfigRefused);
  });
});
