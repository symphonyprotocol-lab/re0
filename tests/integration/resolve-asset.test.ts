/**
 * Asset-level discovery against a real database. architecture.md 9.6.
 *
 * The property under test is the one the whole section exists for: a query
 * routes to the right asset by its *content*, when the asset's name says
 * nothing about that content -- and an invisible private asset stays
 * indistinguishable from a nonexistent one.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { unshare } from '../fixtures/channels';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { resolveAsset } = await import('@/lib/application/retrieval/resolve-asset');
const { createPlatformAsset } = await import(
  '@/lib/application/administration/manage-platform-assets'
);
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const created: string[] = [];
const store = memoryObjectStore();

const anonymous = {
  workspaceId: null,
  apiKeyId: null,
  requestId: 'req_test',
  anonymous: true,
};

/** Resolve without an embedding provider: FTS and name paths only. */
const noEmbeddings = {
  embeddings: () => {
    throw new Error('not configured');
  },
  configured: () => ({ embeddings: false }),
};

function dependenciesFor(files: { path: string; url: string; content: string }[]) {
  return {
    async fetchSnapshot() {
      return {
        files,
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

/** A published, routable asset built from the given files. */
async function publishedAsset(
  slug: string,
  title: string,
  files: { path: string; url: string; content: string }[],
): Promise<string> {
  const { assetId } = await createPlatformAsset({
    actor,
    title,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://example.test/${slug}`,
    refreshPolicy: 'manual',
    reason: 'integration test fixture',
  });
  created.push(assetId);

  const built = await buildVersion({
    assetId,
    operationId: uuidv7(),
    dependencies: dependenciesFor(files),
  });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ assetId, versionId: built.versionId });
  await db()
    .update(schema.asset)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.asset.id, assetId));
  return assetId;
}

describeWithDb('asset-level discovery', () => {
  afterAll(async () => {
    const database = db();
    if (created.length === 0) return;
    await database
      .update(schema.asset)
      .set({ currentVersionId: null })
      .where(inArray(schema.asset.id, created));
    await database
      .delete(schema.assetProfileVector)
      .where(inArray(schema.assetProfileVector.assetId, created));
    await database
      .delete(schema.assetProfile)
      .where(inArray(schema.assetProfile.assetId, created));
    await database.delete(schema.chunk).where(inArray(schema.chunk.assetId, created));
    await database.delete(schema.document).where(inArray(schema.document.assetId, created));
    await database
      .delete(schema.assetVersion)
      .where(inArray(schema.assetVersion.assetId, created));
    await database
      .delete(schema.assetScore)
      .where(inArray(schema.assetScore.assetId, created));
    await database.delete(schema.source).where(inArray(schema.source.assetId, created));
    await database
      .delete(schema.assetAlias)
      .where(inArray(schema.assetAlias.assetId, created));
    await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, created));
    await database.delete(schema.asset).where(inArray(schema.asset.id, created));
  });

  it('routes a question to the asset whose name never mentions it', async () => {
    const stamp = Date.now();
    const beetleId = await publishedAsset(`resolve-beetles-${stamp}`, `百科全书甲 ${stamp}`, [
      {
        path: 'docs/beetles.md',
        url: 'https://example.test/beetles',
        content:
          '# 常见甲虫\n\n隐翅虫的防治与危害:隐翅虫体液含隐翅虫素,接触皮肤会引起皮炎。远离灯光可以减少接触。',
      },
    ]);
    await publishedAsset(`resolve-cooking-${stamp}`, `百科全书乙 ${stamp}`, [
      {
        path: 'docs/cooking.md',
        url: 'https://example.test/cooking',
        content: '# 家常菜谱\n\n西红柿炒鸡蛋的做法:先打散鸡蛋,再切西红柿,大火快炒。',
      },
    ]);

    const output = await resolveAsset(
      anonymous,
      { query: '隐翅虫的防治与危害' },
      noEmbeddings,
    );

    expect(output.results.length).toBeGreaterThan(0);
    const top = output.results[0]!;
    expect(top.assetId).toBe(`/websites/resolve-beetles-${stamp}`);
    // The proof the agent decides by: the term that matched, not the name.
    expect(top.evidence.matchedTerms).toContain('隐翅虫');
    expect(top.chunks).toBeGreaterThan(0);
    expect(top.version.length).toBeGreaterThan(0);

    // The cooking asset must not match a beetle question at all.
    const ids = output.results.map((candidate) => candidate.assetId);
    expect(ids).not.toContain(`/websites/resolve-cooking-${stamp}`);
  });

  it('lists every label a candidate can be pinned to, newest first', async () => {
    const stamp = Date.now();
    const slug = `resolve-versions-${stamp}`;
    const page = (body: string) => [
      { path: 'docs/ferns.md', url: 'https://example.test/ferns', content: `# Ferns\n\n${body}` },
    ];
    const assetId = await publishedAsset(slug, `Botany ${stamp}`, page('Bracken spreads by rhizome.'));

    // A second build of changed content supersedes the first, which stays
    // queryable by its label -- so the label has to be discoverable.
    const rebuilt = await buildVersion({
      assetId,
      operationId: uuidv7(),
      dependencies: dependenciesFor(page('Bracken spreads by rhizome and by spore.')),
    });
    if (!rebuilt.changed) throw new Error('fixture rebuild produced no version');
    await publishVersion({ assetId, versionId: rebuilt.versionId });

    const labels = await db()
      .select({ label: schema.assetVersion.label, id: schema.assetVersion.id })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, assetId));
    const current = labels.find((row) => row.id === rebuilt.versionId)!.label;
    const previous = labels.find((row) => row.id !== rebuilt.versionId)!.label;

    const output = await resolveAsset(anonymous, { query: 'bracken rhizome' }, noEmbeddings);
    const candidate = output.results.find((row) => row.assetId === `/websites/${slug}`)!;
    expect(candidate.version).toBe(current);
    expect(candidate.versions).toEqual([current, previous]);
  });

  it('honours the optional name hint alongside content recall', async () => {
    const stamp = Date.now();
    /*
     * Discriminating on purpose: the asset's NAME matches the hint while its
     * content shares no token with the query (and no sibling fixture's content
     * does either), so content FTS alone cannot recall it and this assertion
     * fails if the assetName path is ever dropped.
     */
    const id = await publishedAsset(`resolve-named-${stamp}`, `OpenAI SDK Handbook ${stamp}`, [
      {
        path: 'docs/notes.md',
        url: 'https://example.test/notes',
        content: '# 发布说明\n\n本次更新修复了若干缺陷,并优化了整体性能表现。',
      },
    ]);

    const output = await resolveAsset(
      anonymous,
      { query: 'streaming chat completions', assetName: 'OpenAI SDK' },
      noEmbeddings,
    );

    expect(output.results.map((candidate) => candidate.assetId)).toContain(
      `/websites/resolve-named-${stamp}`,
    );
    void id;
  });

  it('keeps an invisible private asset indistinguishable from none', async () => {
    const stamp = Date.now();
    const assetId = await publishedAsset(
      `resolve-private-${stamp}`,
      `私有资料 ${stamp}`,
      [
        {
          path: 'docs/secret.md',
          url: 'https://example.test/secret',
          content: '# 内部文档\n\n量子退火器的校准步骤:每周校准一次,记录漂移。',
        },
      ],
    );

    const database = db();
    const workspaceId = crypto.randomUUID();
    await database.insert(schema.workspace).values({ id: workspaceId, name: 'resolve-test' });
    await database
      .update(schema.asset)
      .set({ ownerWorkspaceId: workspaceId })
      .where(eq(schema.asset.id, assetId));
    /* Out of every channel: the owner's alone (agent-first-proposal.md 6.2). */
    await unshare(assetId);

    try {
      const anonymousView = await resolveAsset(anonymous, { query: '量子退火器的校准' }, noEmbeddings);
      expect(anonymousView.results).toHaveLength(0);

      const ownerView = await resolveAsset(
        { ...anonymous, workspaceId, anonymous: false },
        { query: '量子退火器的校准' },
        noEmbeddings,
      );
      expect(ownerView.results.map((candidate) => candidate.assetId)).toContain(
        `/websites/resolve-private-${stamp}`,
      );
    } finally {
      await database
        .update(schema.asset)
        .set({ ownerWorkspaceId: null })
        .where(eq(schema.asset.id, assetId));
      await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
    }
  });

  /**
   * The paragraph-level net. The profile keeps at most 256 terms, so a term
   * mentioned once in one paragraph of a term-rich asset falls out of it --
   * and the profile FTS path misses. The rare-term path probes the chunk
   * table's own inverted index and still routes the query.
   */
  it('finds a term the profile extractor dropped', async () => {
    const stamp = Date.now();
    const filler = Array.from(
      { length: 300 },
      (_, i) => `commonword${i} `.repeat(5),
    ).join(' ');
    const id = await publishedAsset(`resolve-rare-${stamp}`, `词条大全 ${stamp}`, [
      {
        path: 'docs/appendix.md',
        url: 'https://example.test/appendix',
        content: `# Appendix\n\n${filler}\n\nThe zqxwvium compound appears exactly once, here.`,
      },
    ]);

    const database = db();
    const [profile] = await database
      .select({ terms: schema.assetProfile.terms })
      .from(schema.assetProfile)
      .where(eq(schema.assetProfile.assetId, id));
    // The premise of this test: the extractor really did drop the term.
    expect(profile!.terms).not.toContain('zqxwvium');

    const output = await resolveAsset(anonymous, { query: 'zqxwvium' }, noEmbeddings);
    expect(output.results.map((candidate) => candidate.assetId)).toContain(
      `/websites/resolve-rare-${stamp}`,
    );
  });

  it('returns empty results for a query nothing matches', async () => {
    const output = await resolveAsset(anonymous, { query: 'zzz-nonexistent-zzz' }, noEmbeddings);
    expect(output.results).toHaveLength(0);
    expect(output.requestId).toBe('req_test');
  });

  it('fuses the semantic path in without breaking keyword recall', async () => {
    const stamp = Date.now();
    const id = await publishedAsset(`resolve-vec-${stamp}`, `向量测试 ${stamp}`, [
      {
        path: 'docs/topic.md',
        url: 'https://example.test/topic',
        content: '# 专题\n\n蓝鲸的洄游路线横跨整个太平洋,季节性明显。',
      },
    ]);

    const withEmbeddings = {
      embeddings: () => ({
        model: 'fixture-embed-1',
        dimensions: EMBEDDING_COLUMN_DIMENSIONS,
        async embed(texts: string[]) {
          return texts.map((text) =>
            Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17),
          );
        },
      }),
      configured: () => ({ embeddings: true }),
    };

    const output = await resolveAsset(anonymous, { query: '蓝鲸的洄游' }, withEmbeddings);
    expect(output.results.map((candidate) => candidate.assetId)).toContain(
      `/websites/resolve-vec-${stamp}`,
    );
    void id;
  });
});
