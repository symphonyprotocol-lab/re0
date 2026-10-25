/**
 * The rendering fallback's configuration and key pool, against a real
 * database. architecture.md 8.2, 15.3, requirement.md 5.3.
 *
 * What only the rows can show: that a saved provider is what the next build
 * resolves, that keys survive the trip sealed and in the order saved, that a
 * key the vendor calls spent is marked and tried last by the next build, that
 * keys are never sent to a self-hosted base URL, and that no key reaches the
 * audit chain.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.CREDENTIAL_ENCRYPTION_KEY ??= 'test-credential-key-long-enough-00000000';

const {
  probeRenderConfig,
  readRenderConfiguration,
  resolvePageRenderer,
  updateRenderConfig,
  updateRenderKeys,
  RenderConfigRefused,
} = await import('@/lib/application/administration');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');

const administratorId = crypto.randomUUID();
const actor = { administratorId, email: 'ops@example.test' };
const PAGE = new URL('https://docs.example.test/guide/');
const realFetch = globalThis.fetch;

/** AnySearch, answering each key with its status, or the page. */
function anysearch(statusByKey: Record<string, number> = {}) {
  const calls: { url: string; authorization: string | null }[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url: String(input), authorization });
    const status = statusByKey[authorization?.replace('Bearer ', '') ?? ''];
    if (status) return new Response('{"code":-1,"message":"Quota exhausted."}', { status });
    return Response.json({ code: 0, data: { title: 'Guide', content: '# Guide\n\nExtracted.' } });
  }) as typeof fetch;
  return calls;
}

async function keysInOrder(provider: 'anysearch' | 'firecrawl' | 'jina') {
  return (await readRenderConfiguration()).keys[provider];
}

describeWithDb('rendering configuration', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    const database = db();
    await database.delete(schema.renderConfig);
    await database.delete(schema.renderProviderKey);
    await database.delete(schema.auditLog).where(eq(schema.auditLog.administratorId, administratorId));
    await database.delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
  });

  it('runs on the deployment variables until something is saved', async () => {
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: `render-${Date.now()}@example.test`,
      username: `render-${Date.now()}`,
      passwordHash: 'unused',
      status: 'active',
    });
    const saved = { provider: process.env.RENDER_PROVIDER, key: process.env.RENDER_PROVIDER_API_KEY };
    try {
      process.env.RENDER_PROVIDER = 'jina';
      process.env.RENDER_PROVIDER_API_KEY = 'env-1,env-2';
      const view = await readRenderConfiguration();
      expect(view.current).toBeNull();
      expect(view.environment).toEqual({ provider: 'jina', selfHosted: false, keys: 2 });
      expect(view.usable).toBe(true);
      expect((await resolvePageRenderer())?.name).toBe('jina');
    } finally {
      if (saved.provider === undefined) delete process.env.RENDER_PROVIDER;
      else process.env.RENDER_PROVIDER = saved.provider;
      if (saved.key === undefined) delete process.env.RENDER_PROVIDER_API_KEY;
      else process.env.RENDER_PROVIDER_API_KEY = saved.key;
    }
  });

  it('saves keys sealed, in order, and keeps every key out of the audit chain', async () => {
    await updateRenderConfig({ actor, provider: 'anysearch', baseUrl: '', enabled: true, reason: 'switch' });
    await updateRenderKeys({
      actor,
      provider: 'anysearch',
      keep: [],
      add: [
        { label: 'primary', apiKey: 'as-key-one' },
        { label: '', apiKey: 'as-key-two' },
        { label: 'spare', apiKey: 'as-key-three' },
      ],
      reason: 'top up',
    });
    const keys = await keysInOrder('anysearch');
    expect(keys.map((key) => key.label)).toEqual(['primary', 'Key 2', 'spare']);

    const rows = await db().select().from(schema.renderProviderKey);
    for (const row of rows) expect(row.apiKeyCipher).not.toContain('as-key');

    const audit = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.administratorId, administratorId));
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['render_config.update', 'render_keys.update']),
    );
    expect(JSON.stringify(audit)).not.toContain('as-key');
  });

  it('reorders, relabels, switches off and removes in one save', async () => {
    const [one, two, three] = await keysInOrder('anysearch');
    await updateRenderKeys({
      actor,
      provider: 'anysearch',
      keep: [
        { id: three!.id, label: 'spare', enabled: true, clearFailure: false },
        { id: one!.id, label: 'primary', enabled: false, clearFailure: false },
      ],
      add: [],
      reason: 'reorder',
    });
    const keys = await keysInOrder('anysearch');
    expect(keys.map((key) => [key.label, key.enabled])).toEqual([
      ['spare', true],
      ['primary', false],
    ]);
    expect(keys.some((key) => key.id === two!.id)).toBe(false);

    /* Back to three healthy keys for what follows. */
    await updateRenderKeys({
      actor,
      provider: 'anysearch',
      keep: [
        { id: one!.id, label: 'primary', enabled: true, clearFailure: false },
        { id: three!.id, label: 'spare', enabled: true, clearFailure: false },
      ],
      add: [{ label: 'third', apiKey: 'as-key-four' }],
      reason: 'restore',
    });
  });

  it('refuses a key it does not hold and a pool past the ceiling', async () => {
    await expect(
      updateRenderKeys({
        actor,
        provider: 'anysearch',
        keep: [{ id: crypto.randomUUID(), label: 'x', enabled: true, clearFailure: false }],
        add: [],
        reason: 'stale form',
      }),
    ).rejects.toBeInstanceOf(RenderConfigRefused);
    await expect(
      updateRenderKeys({
        actor,
        provider: 'firecrawl',
        keep: [],
        add: Array.from({ length: 21 }, (_, index) => ({ label: '', apiKey: `fc-${index}` })),
        reason: 'too many',
      }),
    ).rejects.toMatchObject({ code: 'too_many_keys' });
  });

  it('marks a spent key during a build, and the next build tries it last', async () => {
    const calls = anysearch({ 'as-key-one': 402 });
    const renderer = await resolvePageRenderer();
    const page = await renderer!.render(PAGE);
    expect(page.renderedBy).toBe('anysearch');
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer as-key-one', 'Bearer as-key-three']);

    const [primary] = await keysInOrder('anysearch');
    expect(primary).toMatchObject({ label: 'primary', failure: 'exhausted', coolingDown: true });

    const next = anysearch();
    await (await resolvePageRenderer())!.render(PAGE);
    expect(next.map((call) => call.authorization)).toEqual(['Bearer as-key-three']);
  });

  it('clears the mark the first time a marked key answers again', async () => {
    /* Every healthy key spent, so the marked one is tried last -- and answers. */
    anysearch({ 'as-key-three': 402, 'as-key-four': 402 });
    await (await resolvePageRenderer())!.render(PAGE);
    const keys = await keysInOrder('anysearch');
    expect(keys.find((key) => key.label === 'primary')?.failure).toBeNull();
    expect(keys.find((key) => key.label === 'spare')?.failure).toBe('exhausted');
  });

  it('never sends a stored key to a self-hosted base URL', async () => {
    await updateRenderConfig({
      actor,
      provider: 'anysearch',
      baseUrl: 'http://anysearch.internal:8080/',
      enabled: true,
      reason: 'self-host',
    });
    const calls = anysearch();
    await (await resolvePageRenderer())!.render(PAGE);
    expect(calls).toEqual([{ url: 'http://anysearch.internal:8080/v1/extract', authorization: null }]);
  });

  it('refuses a base URL with credentials in it, and turns off when switched off', async () => {
    await expect(
      updateRenderConfig({
        actor,
        provider: 'firecrawl',
        baseUrl: 'https://user:pw@firecrawl.example.test',
        enabled: true,
        reason: 'bad',
      }),
    ).rejects.toMatchObject({ code: 'invalid_base_url' });
    await updateRenderConfig({ actor, provider: 'firecrawl', baseUrl: '', enabled: false, reason: 'off' });
    expect(await resolvePageRenderer()).toBeNull();
    expect((await readRenderConfiguration()).usable).toBe(false);
  });

  it('probes hosted Firecrawl only when it has a key', async () => {
    await expect(probeRenderConfig({ provider: 'firecrawl', baseUrl: '' })).resolves.toEqual({
      refused: 'no_key',
    });
    anysearch();
    const result = await probeRenderConfig({ provider: 'anysearch', baseUrl: '' });
    expect(result).toMatchObject({ ok: true });
  });

  it('keeps each provider’s pool apart', async () => {
    const view = await readRenderConfiguration();
    expect(view.keys.firecrawl).toEqual([]);
    expect(view.keys.anysearch.length).toBe(3);
    const ids = view.keys.anysearch.map((key) => key.id);
    const rows = await db()
      .select({ provider: schema.renderProviderKey.provider })
      .from(schema.renderProviderKey)
      .where(inArray(schema.renderProviderKey.id, ids));
    expect(new Set(rows.map((row) => row.provider))).toEqual(new Set(['anysearch']));
  });
});
