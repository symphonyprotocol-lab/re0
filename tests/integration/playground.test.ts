/**
 * The playground's generation path and its accounting, against a real
 * database. architecture.md 9.5: retrieval is the shared function (and the
 * only metered step), zero context means no model call, unbound sentences are
 * dropped, provider failure degrades to chunks, and every completion lands in
 * the cost metric with the config's frozen prices. Plus the console side: a
 * config change mints an immutable version and an audit row.
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

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { askPlayground } = await import('@/lib/application/playground');
const { hasPaidSubscription } = await import('@/lib/application/plans');
const {
  recordLlmCost,
  updateLlmAssignment,
  updateLlmConfig,
  readLlmConfiguration,
  activeLlmConfig,
  llmConfigEntries,
  openLlmCredential,
  selectableLlmModels,
} = await import('@/lib/application/administration');
const { createPlatformLibrary } = await import(
  '@/lib/application/administration/manage-platform-libraries'
);
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const created: string[] = [];
/* Every llm_config row this suite mints; cost events reference them, so the
   teardown can scope both deletes to fixture rows and leave a shared dev
   database's live configuration and cost ledger alone. */
const createdConfigIds: string[] = [];
const store = memoryObjectStore();

const nullCache = {
  get: async () => null,
  set: async () => {},
  invalidateTag: async () => {},
};
const retrieval = {
  embeddings: () => {
    throw new Error('not configured');
  },
  rerank: () => {
    throw new Error('not configured');
  },
  cache: () => nullCache,
  configured: () => ({ embeddings: false, rerank: false }),
};

const anonymous = { workspaceId: null, apiKeyId: null, requestId: '', anonymous: true };
const asAnonymous = () => ({ ...anonymous, requestId: `req_${crypto.randomUUID()}` });

const CONFIG = {
  id: '',
  slug: 'fixture',
  label: 'Fixture model',
  baseUrl: 'https://llm.example.test/v1',
  model: 'fixture-llm-1',
  hasCredential: true,
  maxInputTokens: 8_000,
  maxOutputTokens: 800,
  timeoutMs: 15_000,
  promptPriceMicro: 3_000_000,
  completionPriceMicro: 15_000_000,
  cachePriceMicro: 300_000,
  supportsTools: false,
  supportsReasoning: false,
  supportsVision: false,
  reasoningEffort: null as 'minimal' | 'low' | 'medium' | 'high' | null,
  enabled: true,
  createdAt: new Date(),
  assignedTo: [] as ('trial' | 'subscriber')[],
};

/** A registry row from the fixture: `assignedTo` is derived, never stored. */
function rowOf<T extends { assignedTo: unknown }>(config: T): Omit<T, 'assignedTo'> {
  const { assignedTo: _derived, ...row } = config;
  return row;
}

function playgroundDeps(options: {
  completion?: string;
  fail?: boolean;
  config?: typeof CONFIG | null;
  calls?: { userMessage?: string; reasoningEffort?: string | null }[];
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number; reasoningTokens: number };
}) {
  return {
    config: async () => (options.config === undefined ? CONFIG : options.config),
    audience: async () => 'trial' as const,
    credential: async () => 'sk-fixture',
    recordCost: recordLlmCost,
    retrieval,
    llm: () => ({
      stream(input: { userMessage: string; reasoningEffort?: string | null }) {
        options.calls?.push({
          userMessage: input.userMessage,
          reasoningEffort: input.reasoningEffort ?? null,
        });
        const completion = options.completion ?? '';
        return {
          /* Delivered in small deltas, mid-word and mid-marker, because the
             streaming gate is the thing the answer path now depends on. */
          textStream: (async function* deltas() {
            if (options.fail) throw new Error('provider down');
            for (const piece of completion.match(/[\s\S]{1,7}/g) ?? []) yield piece;
          })(),
          usage: Promise.resolve(
            options.usage ?? {
              promptTokens: 1_000,
              completionTokens: 500,
              cachedTokens: 0,
              reasoningTokens: 0,
            },
          ),
        };
      },
    }),
  };
}

const BEETLES =
  '# Rove beetles\n\nDo not crush the insect against skin. Rinse exposed skin with water.';

function dependencies(content: string = BEETLES) {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/beetles.md',
            url: 'https://example.test/beetles',
            content,
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

async function publishedLibrary(slug: string, content?: string): Promise<string> {
  const { libraryId } = await createPlatformLibrary({
    actor,
    title: `Playground fixture ${slug}`,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://example.test/${slug}`,
    refreshPolicy: 'manual',
    language: 'en',
    reason: 'integration test fixture',
  });
  created.push(libraryId);
  const built = await buildVersion({
    libraryId,
    operationId: uuidv7(),
    dependencies: dependencies(content),
  });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  await db()
    .update(schema.library)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.library.id, libraryId));
  return libraryId;
}

describeWithDb('playground', () => {
  afterAll(async () => {
    const database = db();
    if (createdConfigIds.length > 0) {
      await database
        .delete(schema.llmCostEvent)
        .where(inArray(schema.llmCostEvent.configId, createdConfigIds));
      await database
        .delete(schema.llmConfig)
        .where(inArray(schema.llmConfig.id, createdConfigIds));
    }
    if (created.length > 0) {
      await database
        .update(schema.library)
        .set({ currentVersionId: null })
        .where(inArray(schema.library.id, created));
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
  });

  it('answers with bound citations, drops the unbindable, records the cost', async () => {
    const stamp = Date.now();
    await publishedLibrary(`pg-answer-${stamp}`);

    const [config] = await db()
      .insert(schema.llmConfig)
      .values({ ...rowOf(CONFIG), id: uuidv7() })
      .returning();
    createdConfigIds.push(config!.id);

    const output = await askPlayground(
      asAnonymous(),
      { libraries: [{ libraryId: `/websites/pg-answer-${stamp}`, title: 'fixture' }], question: 'how to treat rove beetle exposure' },
      playgroundDeps({
        config: { ...CONFIG, id: config!.id },
        completion:
          'Rinse the exposed skin with water. [ref:1] Uncited speculation here. Cited to nowhere. [ref:99]',
      }),
    );

    expect(output.kind).toBe('answer');
    expect(output.text).toBe('Rinse the exposed skin with water.');
    expect(output.citations).toHaveLength(1);
    expect(output.citations[0]!.chunkId).toBe(output.chunks[0]!.chunkId);

    const events = await db()
      .select()
      .from(schema.llmCostEvent)
      .where(eq(schema.llmCostEvent.configId, config!.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.promptTokens).toBe(1_000);
    expect(events[0]!.completionTokens).toBe(500);
    // $3/M x 1000 + $15/M x 500 = $0.0105 = 10,500 micro-USD
    expect(events[0]!.costMicroUsd).toBe(10_500);
    expect(events[0]!.libraryPublicId).toBe(`/websites/pg-answer-${stamp}`);
  });

  it('gathers from every confirmed candidate, names the library on each passage, and skips the rest', async () => {
    const stamp = Date.now();
    await publishedLibrary(`pg-gather-a-${stamp}`);
    await publishedLibrary(
      `pg-gather-b-${stamp}`,
      '# Field notes\n\nRove beetle exposure: wash with soap, the paederin toxin blisters skin.',
    );
    await publishedLibrary(
      `pg-gather-c-${stamp}`,
      '# Orchard notes\n\nThe quorl-apple harvest is pressed every equinox.',
    );

    const calls: { userMessage?: string }[] = [];
    const output = await askPlayground(
      asAnonymous(),
      {
        libraries: [
          { libraryId: `/websites/pg-gather-a-${stamp}`, title: 'A' },
          { libraryId: `/websites/pg-gather-b-${stamp}`, title: 'B' },
          { libraryId: `/websites/pg-gather-c-${stamp}`, title: 'C' },
          /* Not a library at all: one bad candidate must not sink the exchange. */
          { libraryId: `/websites/pg-gather-missing-${stamp}`, title: 'missing' },
        ],
        question: 'rove beetle exposure',
      },
      playgroundDeps({ completion: 'Rinse with water. [ref:1] Wash with soap. [ref:2]', calls }),
    );

    expect(output.kind).toBe('answer');
    const from = new Set(output.chunks.map((chunk) => chunk.libraryId));
    expect(from).toEqual(
      new Set([`/websites/pg-gather-a-${stamp}`, `/websites/pg-gather-b-${stamp}`]),
    );
    for (const chunk of output.chunks) {
      expect(chunk.libraryTitle).toBe(chunk.libraryId.includes('-a-') ? 'A' : 'B');
      expect(chunk.version).toMatch(/\S/);
    }
    /* The model saw both libraries' passages in one context block. */
    expect(calls[0]!.userMessage).toContain('Rinse exposed skin');
    expect(calls[0]!.userMessage).toContain('paederin');

    const byId = new Map(output.libraries.map((library) => [library.libraryId, library]));
    expect(byId.get(`/websites/pg-gather-a-${stamp}`)).toMatchObject({ confirmed: true, failed: false });
    expect(byId.get(`/websites/pg-gather-b-${stamp}`)).toMatchObject({ confirmed: true, failed: false });
    /* Read, but nothing in it matched: not context. */
    expect(byId.get(`/websites/pg-gather-c-${stamp}`)).toMatchObject({ confirmed: false, chunks: 0 });
    expect(byId.get(`/websites/pg-gather-missing-${stamp}`)).toMatchObject({ failed: true, confirmed: false });
  });

  it('never calls the model without context, and degrades on provider failure', async () => {
    const stamp = Date.now();
    await publishedLibrary(`pg-degrade-${stamp}`);

    const calls: { userMessage?: string }[] = [];
    const noContext = await askPlayground(
      asAnonymous(),
      { libraries: [{ libraryId: `/websites/pg-degrade-${stamp}`, title: 'fixture' }], question: 'zzz-nothing-matches-zzz' },
      playgroundDeps({ calls }),
    );
    expect(noContext.kind).toBe('no_context');
    expect(calls).toHaveLength(0);

    const failed = await askPlayground(
      asAnonymous(),
      { libraries: [{ libraryId: `/websites/pg-degrade-${stamp}`, title: 'fixture' }], question: 'rove beetle exposure' },
      playgroundDeps({ fail: true }),
    );
    expect(failed.kind).toBe('degraded');
    expect(failed.chunks.length).toBeGreaterThan(0);

    const unconfigured = await askPlayground(
      asAnonymous(),
      { libraries: [{ libraryId: `/websites/pg-degrade-${stamp}`, title: 'fixture' }], question: 'rove beetle exposure' },
      playgroundDeps({ config: null }),
    );
    expect(unconfigured.kind).toBe('degraded');

    /* A completion whose every citation points nowhere binds no fact at all. */
    const unbound = await askPlayground(
      asAnonymous(),
      { libraries: [{ libraryId: `/websites/pg-degrade-${stamp}`, title: 'fixture' }], question: 'rove beetle exposure' },
      playgroundDeps({
        config: { ...CONFIG, id: (await ensureConfig()).id },
        completion: 'Confident nonsense. [ref:42] More of it. [ref:77]',
      }),
    );
    expect(unbound.kind).toBe('degraded');
    expect(unbound.text).toBeNull();
  });

  it('passes chunks as untrusted data in the user message, never the system prompt', async () => {
    const stamp = Date.now();
    await publishedLibrary(`pg-prompt-${stamp}`);

    const calls: { userMessage?: string }[] = [];
    await askPlayground(
      asAnonymous(),
      { libraries: [{ libraryId: `/websites/pg-prompt-${stamp}`, title: 'fixture' }], question: 'rove beetle exposure' },
      playgroundDeps({ completion: 'Rinse with water. [ref:1]', calls, config: { ...CONFIG, id: (await ensureConfig()).id } }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessage).toContain('untrusted data');
    expect(calls[0]!.userMessage).toContain('rove beetle exposure');
  });

  it('sends reasoning effort only for a reasoning model, and bills the cache once', async () => {
    const stamp = Date.now();
    await publishedLibrary(`pg-reason-${stamp}`);
    const libraryId = `/websites/pg-reason-${stamp}`;

    const [row] = await db()
      .insert(schema.llmConfig)
      .values({ ...rowOf(CONFIG), id: uuidv7() })
      .returning();
    createdConfigIds.push(row!.id);
    const base = { ...CONFIG, id: row!.id };

    /* A plain model: nothing is sent, so an endpoint that does not reason is
       never handed a field it would reject. */
    const plain: { userMessage?: string; reasoningEffort?: string | null }[] = [];
    await askPlayground(
      asAnonymous(),
      { libraries: [{ libraryId, title: 'fixture' }], question: 'rove beetle exposure' },
      playgroundDeps({ config: base, completion: 'Rinse. [ref:1]', calls: plain }),
    );
    expect(plain[0]!.reasoningEffort).toBeNull();

    const thinking: { userMessage?: string; reasoningEffort?: string | null }[] = [];
    const output = await askPlayground(
      asAnonymous(),
      { libraries: [{ libraryId, title: 'fixture' }], question: 'rove beetle exposure' },
      playgroundDeps({
        config: { ...base, supportsReasoning: true, reasoningEffort: 'high' },
        completion: 'Rinse the skin. [ref:1]',
        calls: thinking,
        usage: {
          promptTokens: 1_000,
          completionTokens: 500,
          cachedTokens: 800,
          reasoningTokens: 300,
        },
      }),
    );
    expect(output.kind).toBe('answer');
    expect(thinking[0]!.reasoningEffort).toBe('high');

    const events = await db()
      .select()
      .from(schema.llmCostEvent)
      .where(eq(schema.llmCostEvent.configId, row!.id));
    const billed = events.find((event) => event.cachedTokens === 800);
    expect(billed).toBeDefined();
    /* The breakdowns are recorded beside the totals, never added to them. */
    expect(billed!.promptTokens).toBe(1_000);
    expect(billed!.completionTokens).toBe(500);
    expect(billed!.reasoningTokens).toBe(300);
    // 200 x $3/M + 800 x $0.30/M + 500 x $15/M = 840 + 7,500 micro-USD
    expect(billed!.costMicroUsd).toBe(8_340);
  });

  it('names the field it refuses, and accepts a current model\'s real budgets', async () => {
    const administratorId = crypto.randomUUID();
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: `llm-bounds-${Date.now()}@example.test`,
      username: `llm-bounds-${Date.now()}`,
      passwordHash: 'unused',
      status: 'active',
    });
    const entry = {
      actor: { administratorId, email: 'ops@example.test' },
      slug: `bounds-${Date.now()}`,
      apiKey: 'sk-fixture',
      label: 'Bounds fixture',
      baseUrl: 'https://llm.example.test/v1',
      model: 'fixture-bounds',
      maxInputTokens: 200_000,
      maxOutputTokens: 800,
      timeoutMs: 15_000,
      promptPriceMicro: 3_000_000,
      completionPriceMicro: 15_000_000,
      cachePriceMicro: 300_000,
      supportsTools: false,
      supportsReasoning: false,
      supportsVision: false,
      reasoningEffort: null,
      enabled: true,
      reason: 'bounds fixture',
    };

    try {
      /* Each budget refuses under its own name, so an operator is told which
         field is wrong rather than that one of six is. */
      await expect(updateLlmConfig({ ...entry, maxInputTokens: 500 })).rejects.toMatchObject({
        code: 'invalid_max_input',
      });
      await expect(updateLlmConfig({ ...entry, maxOutputTokens: 0 })).rejects.toMatchObject({
        code: 'invalid_max_output',
      });
      await expect(updateLlmConfig({ ...entry, timeoutMs: 10 })).rejects.toMatchObject({
        code: 'invalid_timeout',
      });
      await expect(updateLlmConfig({ ...entry, cachePriceMicro: -1 })).rejects.toMatchObject({
        code: 'invalid_price',
      });

      /* The budgets a current model actually has. These were refused before:
         the ceilings were 8,192 output tokens and 60s, so entering the truth
         about a modern model was an error. The output budget now has no
         ceiling at all, so a figure past any current model still saves. */
      const saved = await updateLlmConfig({
        ...entry,
        maxOutputTokens: 1_000_000,
        timeoutMs: 120_000,
      });
      createdConfigIds.push(saved.configId);
      const stored = await activeLlmConfig(entry.slug, 'trial');
      expect(stored?.maxOutputTokens).toBe(1_000_000);
      expect(stored?.timeoutMs).toBe(120_000);
    } finally {
      await db()
        .delete(schema.auditLog)
        .where(eq(schema.auditLog.administratorId, administratorId));
      await db().delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
    }
  });

  it('refuses a reasoning effort on a model that does not reason', async () => {
    const administratorId = crypto.randomUUID();
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: `llm-effort-${Date.now()}@example.test`,
      username: `llm-effort-${Date.now()}`,
      passwordHash: 'unused',
      status: 'active',
    });
    const entry = {
      actor: { administratorId, email: 'ops@example.test' },
      slug: `effort-${Date.now()}`,
      apiKey: 'sk-fixture',
      label: 'Effort fixture',
      baseUrl: 'https://llm.example.test/v1',
      model: 'fixture-effort',
      maxInputTokens: 8_000,
      maxOutputTokens: 800,
      timeoutMs: 15_000,
      promptPriceMicro: 0,
      completionPriceMicro: 0,
      cachePriceMicro: 0,
      supportsTools: false,
      supportsVision: false,
      enabled: true,
      reason: 'effort fixture',
    };

    try {
      await expect(
        updateLlmConfig({ ...entry, supportsReasoning: false, reasoningEffort: 'high' }),
      ).rejects.toMatchObject({ code: 'invalid_effort' });
      await expect(
        updateLlmConfig({ ...entry, supportsReasoning: true, reasoningEffort: 'ludicrous' }),
      ).rejects.toMatchObject({ code: 'invalid_effort' });

      /* A reasoning model with no effort chosen is legitimate -- the provider's
         own default applies. */
      const saved = await updateLlmConfig({
        ...entry,
        supportsReasoning: true,
        reasoningEffort: null,
      });
      createdConfigIds.push(saved.configId);
      expect((await activeLlmConfig(entry.slug, 'trial'))?.reasoningEffort).toBeNull();
    } finally {
      await db()
        .delete(schema.auditLog)
        .where(eq(schema.auditLog.administratorId, administratorId));
      await db().delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
    }
  });

  it('keeps several models side by side and answers with the assigned one', async () => {
    const administratorId = crypto.randomUUID();
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: `llm-multi-${Date.now()}@example.test`,
      username: `llm-multi-${Date.now()}`,
      passwordHash: 'unused',
      status: 'active',
    });
    const stamp = Date.now();
    const shared = {
      actor: { administratorId, email: 'ops@example.test' },
      apiKey: 'sk-fixture',
      baseUrl: 'https://llm.example.test/v1',
      maxInputTokens: 8_000,
      maxOutputTokens: 800,
      timeoutMs: 15_000,
      promptPriceMicro: 3_000_000,
      completionPriceMicro: 15_000_000,
      cachePriceMicro: 300_000,
      supportsTools: false,
      supportsReasoning: false,
      supportsVision: false,
      reasoningEffort: null,
      reason: 'multi-model fixture',
    };

    try {
      const cheap = await updateLlmConfig({
        ...shared,
        slug: `cheap-${stamp}`,
        label: 'Cheap',
        model: 'fixture-cheap',
        enabled: true,
      });
      const strong = await updateLlmConfig({
        ...shared,
        slug: `strong-${stamp}`,
        label: 'Strong',
        model: 'fixture-strong',
        enabled: true,
      });
      const retired = await updateLlmConfig({
        ...shared,
        slug: `retired-${stamp}`,
        label: 'Retired',
        model: 'fixture-retired',
        enabled: false,
      });
      createdConfigIds.push(cheap.configId, strong.configId, retired.configId);

      /* Two live entries and one switched off; the off one is not offered. */
      const selectable = await selectableLlmModels('trial');
      const slugs = selectable.map((entry) => entry.slug);
      expect(slugs).toContain(`cheap-${stamp}`);
      expect(slugs).toContain(`strong-${stamp}`);
      expect(slugs).not.toContain(`retired-${stamp}`);

      /* Assigning names the entry; assigning one that is off is refused. */
      await expect(
        updateLlmAssignment({
          actor: shared.actor,
          trialSlug: `retired-${stamp}`,
          subscriberSlug: null,
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'unknown_model' });
      await updateLlmAssignment({
        actor: shared.actor,
        trialSlug: `cheap-${stamp}`,
        subscriberSlug: null,
        reason: 'cheap for everyone',
      });

      /* `strong` was written later, but `cheap` is the one assigned. */
      expect((await activeLlmConfig(null, 'trial'))?.model).toBe('fixture-cheap');
      expect((await selectableLlmModels('trial'))[0]!.slug).toBe(`cheap-${stamp}`);

      /* Naming an entry picks it; naming one that is off picks nothing at all,
         rather than quietly falling back to a model the caller did not ask
         for. */
      expect((await activeLlmConfig(`strong-${stamp}`, 'trial'))?.model).toBe('fixture-strong');
      expect(await activeLlmConfig(`retired-${stamp}`, 'trial')).toBeNull();
      expect(await activeLlmConfig('no-such-entry', 'trial')).toBeNull();

      /* A new assignment is an append, and the newest wins. */
      await updateLlmAssignment({
        actor: shared.actor,
        trialSlug: `strong-${stamp}`,
        subscriberSlug: null,
        reason: 'promote strong',
      });
      expect((await activeLlmConfig(null, 'trial'))?.model).toBe('fixture-strong');
    } finally {
      await db()
        .delete(schema.auditLog)
        .where(eq(schema.auditLog.administratorId, administratorId));
      await db().delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
    }
  });

  it('answers each audience with its assigned model, and never a visitor with the subscriber one', async () => {
    const administratorId = crypto.randomUUID();
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: `llm-audience-${Date.now()}@example.test`,
      username: `llm-audience-${Date.now()}`,
      passwordHash: 'unused',
      status: 'active',
    });
    const stamp = Date.now();
    const shared = {
      actor: { administratorId, email: 'ops@example.test' },
      apiKey: 'sk-fixture',
      baseUrl: 'https://llm.example.test/v1',
      maxInputTokens: 8_000,
      maxOutputTokens: 800,
      timeoutMs: 15_000,
      promptPriceMicro: 3_000_000,
      completionPriceMicro: 15_000_000,
      cachePriceMicro: 300_000,
      supportsTools: false,
      supportsReasoning: false,
      supportsVision: false,
      reasoningEffort: null,
      enabled: true,
      reason: 'audience fixture',
    };

    try {
      const trial = await updateLlmConfig({
        ...shared,
        slug: `trial-${stamp}`,
        label: 'Trial',
        model: 'fixture-trial',
      });
      const premium = await updateLlmConfig({
        ...shared,
        slug: `premium-${stamp}`,
        label: 'Premium',
        model: 'fixture-premium',
      });
      createdConfigIds.push(trial.configId, premium.configId);

      await updateLlmAssignment({
        actor: shared.actor,
        trialSlug: `trial-${stamp}`,
        subscriberSlug: null,
        reason: 'trial only',
      });
      /* No subscriber model assigned: a paid plan is answered by the trial
         model rather than by nothing, and told so. */
      const same = await activeLlmConfig(null, 'subscriber');
      expect(same?.model).toBe('fixture-trial');
      expect(same?.assignedTo).toEqual(['trial']);

      await updateLlmAssignment({
        actor: shared.actor,
        trialSlug: `trial-${stamp}`,
        subscriberSlug: `premium-${stamp}`,
        reason: 'premium for subscribers',
      });

      expect((await activeLlmConfig(null, 'trial'))?.model).toBe('fixture-trial');
      const paid = await activeLlmConfig(null, 'subscriber');
      expect(paid?.model).toBe('fixture-premium');
      expect(paid?.assignedTo).toEqual(['subscriber']);

      /* A subscriber may still name the trial model; a visitor naming the
         subscriber model gets nothing, not a substitute. */
      expect((await activeLlmConfig(`trial-${stamp}`, 'subscriber'))?.model).toBe('fixture-trial');
      expect(await activeLlmConfig(`premium-${stamp}`, 'trial')).toBeNull();

      const forVisitors = (await selectableLlmModels('trial')).map((entry) => entry.slug);
      expect(forVisitors).toContain(`trial-${stamp}`);
      expect(forVisitors).not.toContain(`premium-${stamp}`);
      const forSubscribers = (await selectableLlmModels('subscriber')).map((entry) => entry.slug);
      expect(forSubscribers[0]).toBe(`premium-${stamp}`);
      expect(forSubscribers).toContain(`trial-${stamp}`);

      const configuration = await readLlmConfiguration();
      expect(configuration.assignment.subscriberSlug).toBe(`premium-${stamp}`);
      expect(configuration.resolved.trial?.slug).toBe(`trial-${stamp}`);
      expect(configuration.resolved.subscriber?.slug).toBe(`premium-${stamp}`);

      /* The transcript is told which model answered, and what a plan buys. */
      const events: { type: string; label?: string; audience?: string; upgrade?: string | null }[] = [];
      const libraryStamp = Date.now();
      await publishedLibrary(`pg-audience-${libraryStamp}`);
      const { streamPlayground } = await import('@/lib/application/playground');
      for await (const event of streamPlayground(
        asAnonymous(),
        { libraries: [{ libraryId: `/websites/pg-audience-${libraryStamp}`, title: 'fixture' }], question: 'how to treat rove beetle exposure' },
        {
          ...playgroundDeps({ completion: 'Rinse with water. [ref:1]', config: null }),
          config: activeLlmConfig,
          audience: async () => 'trial' as const,
        },
      )) {
        if (event.type === 'model') events.push(event);
      }
      expect(events).toEqual([
        { type: 'model', label: 'Trial', audience: 'trial', upgrade: 'Premium' },
      ]);
    } finally {
      await db()
        .delete(schema.auditLog)
        .where(eq(schema.auditLog.administratorId, administratorId));
      await db().delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
    }
  });

  it('counts an active paid subscription as a subscriber, and nothing else', async () => {
    const database = db();
    const workspaceId = crypto.randomUUID();
    await database.insert(schema.workspace).values({ id: workspaceId, name: 'audience-test' });
    const versions: string[] = [];
    const plan = async (planId: 'free' | 'pro') => {
      const id = uuidv7();
      versions.push(id);
      await database.insert(schema.planVersion).values({
        id,
        planId,
        priceMinor: planId === 'free' ? 0 : 2000,
        currency: 'USD',
        monthlyCalls: 100,
        libraryLimit: 10,
        librarySizeBytesLimit: 1_000_000,
        apiKeyLimit: 5,
        shareRateBps: 2000,
        capabilities: {},
        createdAt: new Date('2000-01-01T00:00:00Z'),
      });
      return id;
    };
    const subscribe = (planVersionId: string, status: 'active' | 'canceled', ended = false) =>
      database.insert(schema.subscription).values({
        id: uuidv7(),
        workspaceId,
        planVersionId,
        status,
        periodStart: new Date(Date.now() - 2 * 86_400_000),
        periodEnd: new Date(Date.now() + (ended ? -86_400_000 : 86_400_000)),
      });

    try {
      expect(await hasPaidSubscription(workspaceId)).toBe(false);

      const free = await plan('free');
      await subscribe(free, 'active');
      expect(await hasPaidSubscription(workspaceId)).toBe(false);

      const pro = await plan('pro');
      await subscribe(pro, 'canceled');
      expect(await hasPaidSubscription(workspaceId)).toBe(false);
      await subscribe(pro, 'active', true);
      expect(await hasPaidSubscription(workspaceId)).toBe(false);

      await subscribe(pro, 'active');
      expect(await hasPaidSubscription(workspaceId)).toBe(true);
    } finally {
      await database.delete(schema.subscription).where(eq(schema.subscription.workspaceId, workspaceId));
      await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, versions));
    }
  });

  it('mints immutable config versions with an audit trail, and aggregates spend', async () => {
    const administratorId = crypto.randomUUID();
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: `llm-admin-${Date.now()}@example.test`,
      username: `llm-admin-${Date.now()}`,
      passwordHash: 'unused',
      status: 'active',
    });

    try {
      const entry = {
        actor: { administratorId, email: 'ops@example.test' },
        slug: `chain-${Date.now()}`,
        label: 'Chained entry',
        baseUrl: 'https://llm.example.test/v1',
        maxInputTokens: 8_000,
        maxOutputTokens: 800,
        timeoutMs: 15_000,
        promptPriceMicro: 3_000_000,
        completionPriceMicro: 15_000_000,
        cachePriceMicro: 300_000,
        supportsTools: false,
        supportsReasoning: false,
        supportsVision: false,
        reasoningEffort: null,
        enabled: true,
      };
      const first = await updateLlmConfig({
        ...entry,
        apiKey: 'sk-fixture',
        model: 'fixture-llm-1',
        reason: 'initial configuration',
      });
      /* No credential on the edit: a re-mint carries the stored one forward,
         so changing a model does not mean re-typing a provider key. */
      const second = await updateLlmConfig({
        ...entry,
        model: 'fixture-llm-2',
        reason: 'switch model',
      });
      createdConfigIds.push(first.configId, second.configId);
      expect(second.configId).not.toBe(first.configId);

      /* Same slug, so the second row succeeds the first rather than adding an
         entry beside it -- one model with a history, which is what freezes
         the prices the earlier cost events were written against. */
      const active = await activeLlmConfig(entry.slug, 'trial');
      expect(active?.id).toBe(second.configId);
      expect(active?.model).toBe('fixture-llm-2');
      expect(active?.hasCredential).toBe(true);
      expect(await openLlmCredential(second.configId)).toBe('sk-fixture');
      expect((await llmConfigEntries()).filter((e) => e.slug === entry.slug)).toHaveLength(1);

      const audits = await db()
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, second.configId));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe('llm_config.update');

      await recordLlmCost({
        configId: second.configId,
        libraryPublicId: '/websites/spend-fixture',
        workspaceId: null,
        model: 'fixture-llm-2',
        promptTokens: 2_000,
        completionTokens: 1_000,
        cachedTokens: 0,
        reasoningTokens: 0,
        costMicroUsd: 21_000,
        latencyMs: 500,
      });
      const { stats, history } = await readLlmConfiguration();
      expect(stats.monthCostMicroUsd).toBeGreaterThanOrEqual(21_000);
      expect(stats.monthCalls).toBeGreaterThanOrEqual(1);
      expect(stats.totalCostMicroUsd).toBeGreaterThanOrEqual(stats.monthCostMicroUsd);
      expect(history.length).toBeGreaterThanOrEqual(2);
    } finally {
      await db()
        .delete(schema.auditLog)
        .where(eq(schema.auditLog.administratorId, administratorId));
      await db().delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
    }
  });
});

async function ensureConfig() {
  /* Reuse only a config this suite created itself: cost events must never be
     recorded against (and later deleted with) a live configuration. */
  const existing = await activeLlmConfig(null, 'trial');
  if (existing && createdConfigIds.includes(existing.id)) return existing;
  const [row] = await db()
    .insert(schema.llmConfig)
    .values({ ...rowOf(CONFIG), id: uuidv7() })
    .returning();
  createdConfigIds.push(row!.id);
  return row!;
}
