/**
 * Library-level discovery against a real database. architecture.md 9.6.
 *
 * The property under test is the one the whole section exists for: a query
 * routes to the right library by its *content*, when the library's name says
 * nothing about that content -- and an invisible private library stays
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
const { resolveLibrary } = await import('@/lib/application/retrieval/resolve-library');
const { createPlatformLibrary } = await import(
  '@/lib/application/administration/manage-platform-libraries'
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

/** A published, routable library built from the given files. */
async function publishedLibrary(
  slug: string,
  title: string,
  files: { path: string; url: string; content: string }[],
): Promise<string> {
  const { libraryId } = await createPlatformLibrary({
    actor,
    title,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://example.test/${slug}`,
    refreshPolicy: 'manual',
    reason: 'integration test fixture',
  });
  created.push(libraryId);

  const built = await buildVersion({
    libraryId,
    operationId: uuidv7(),
    dependencies: dependenciesFor(files),
  });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  await db()
    .update(schema.library)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.library.id, libraryId));
  return libraryId;
}

describeWithDb('library-level discovery', () => {
  afterAll(async () => {
    const database = db();
    if (created.length === 0) return;
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
  });

  it('routes a question to the library whose name never mentions it', async () => {
    const stamp = Date.now();
    const beetleId = await publishedLibrary(`resolve-beetles-${stamp}`, `百科全书甲 ${stamp}`, [
      {
        path: 'docs/beetles.md',
        url: 'https://example.test/beetles',
        content:
          '# 常见甲虫\n\n隐翅虫的防治与危害:隐翅虫体液含隐翅虫素,接触皮肤会引起皮炎。远离灯光可以减少接触。',
      },
    ]);
    await publishedLibrary(`resolve-cooking-${stamp}`, `百科全书乙 ${stamp}`, [
      {
        path: 'docs/cooking.md',
        url: 'https://example.test/cooking',
        content: '# 家常菜谱\n\n西红柿炒鸡蛋的做法:先打散鸡蛋,再切西红柿,大火快炒。',
      },
    ]);

    const output = await resolveLibrary(
      anonymous,
      { query: '隐翅虫的防治与危害' },
      noEmbeddings,
    );

    expect(output.results.length).toBeGreaterThan(0);
    const top = output.results[0]!;
    expect(top.libraryId).toBe(`/websites/resolve-beetles-${stamp}`);
    // The proof the agent decides by: the term that matched, not the name.
    expect(top.evidence.matchedTerms).toContain('隐翅虫');
    expect(top.chunks).toBeGreaterThan(0);
    expect(top.version.length).toBeGreaterThan(0);

    // The cooking library must not match a beetle question at all.
    const ids = output.results.map((candidate) => candidate.libraryId);
    expect(ids).not.toContain(`/websites/resolve-cooking-${stamp}`);
  });

  it('lists every label a candidate can be pinned to, newest first', async () => {
    const stamp = Date.now();
    const slug = `resolve-versions-${stamp}`;
    const page = (body: string) => [
      { path: 'docs/ferns.md', url: 'https://example.test/ferns', content: `# Ferns\n\n${body}` },
    ];
    const libraryId = await publishedLibrary(slug, `Botany ${stamp}`, page('Bracken spreads by rhizome.'));

    // A second build of changed content supersedes the first, which stays
    // queryable by its label -- so the label has to be discoverable.
    const rebuilt = await buildVersion({
      libraryId,
      operationId: uuidv7(),
      dependencies: dependenciesFor(page('Bracken spreads by rhizome and by spore.')),
    });
    if (!rebuilt.changed) throw new Error('fixture rebuild produced no version');
    await publishVersion({ libraryId, versionId: rebuilt.versionId });

    const labels = await db()
      .select({ label: schema.libraryVersion.label, id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId));
    const current = labels.find((row) => row.id === rebuilt.versionId)!.label;
    const previous = labels.find((row) => row.id !== rebuilt.versionId)!.label;

    const output = await resolveLibrary(anonymous, { query: 'bracken rhizome' }, noEmbeddings);
    const candidate = output.results.find((row) => row.libraryId === `/websites/${slug}`)!;
    expect(candidate.version).toBe(current);
    expect(candidate.versions).toEqual([current, previous]);
  });

  it('honours the optional name hint alongside content recall', async () => {
    const stamp = Date.now();
    /*
     * Discriminating on purpose: the library's NAME matches the hint while its
     * content shares no token with the query (and no sibling fixture's content
     * does either), so content FTS alone cannot recall it and this assertion
     * fails if the libraryName path is ever dropped.
     */
    const id = await publishedLibrary(`resolve-named-${stamp}`, `OpenAI SDK Handbook ${stamp}`, [
      {
        path: 'docs/notes.md',
        url: 'https://example.test/notes',
        content: '# 发布说明\n\n本次更新修复了若干缺陷,并优化了整体性能表现。',
      },
    ]);

    const output = await resolveLibrary(
      anonymous,
      { query: 'streaming chat completions', libraryName: 'OpenAI SDK' },
      noEmbeddings,
    );

    expect(output.results.map((candidate) => candidate.libraryId)).toContain(
      `/websites/resolve-named-${stamp}`,
    );
    void id;
  });

  it('keeps an invisible private library indistinguishable from none', async () => {
    const stamp = Date.now();
    const libraryId = await publishedLibrary(
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
      .update(schema.library)
      .set({ ownerWorkspaceId: workspaceId })
      .where(eq(schema.library.id, libraryId));
    /* Out of every channel: the owner's alone (agent-first-proposal.md 6.2). */
    await unshare(libraryId);

    try {
      const anonymousView = await resolveLibrary(anonymous, { query: '量子退火器的校准' }, noEmbeddings);
      expect(anonymousView.results).toHaveLength(0);

      const ownerView = await resolveLibrary(
        { ...anonymous, workspaceId, anonymous: false },
        { query: '量子退火器的校准' },
        noEmbeddings,
      );
      expect(ownerView.results.map((candidate) => candidate.libraryId)).toContain(
        `/websites/resolve-private-${stamp}`,
      );
    } finally {
      await database
        .update(schema.library)
        .set({ ownerWorkspaceId: null })
        .where(eq(schema.library.id, libraryId));
      await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
    }
  });

  /**
   * The paragraph-level net. The profile keeps at most 256 terms, so a term
   * mentioned once in one paragraph of a term-rich library falls out of it --
   * and the profile FTS path misses. The rare-term path probes the chunk
   * table's own inverted index and still routes the query.
   */
  it('finds a term the profile extractor dropped', async () => {
    const stamp = Date.now();
    const filler = Array.from(
      { length: 300 },
      (_, i) => `commonword${i} `.repeat(5),
    ).join(' ');
    const id = await publishedLibrary(`resolve-rare-${stamp}`, `词条大全 ${stamp}`, [
      {
        path: 'docs/appendix.md',
        url: 'https://example.test/appendix',
        content: `# Appendix\n\n${filler}\n\nThe zqxwvium compound appears exactly once, here.`,
      },
    ]);

    const database = db();
    const [profile] = await database
      .select({ terms: schema.libraryProfile.terms })
      .from(schema.libraryProfile)
      .where(eq(schema.libraryProfile.libraryId, id));
    // The premise of this test: the extractor really did drop the term.
    expect(profile!.terms).not.toContain('zqxwvium');

    const output = await resolveLibrary(anonymous, { query: 'zqxwvium' }, noEmbeddings);
    expect(output.results.map((candidate) => candidate.libraryId)).toContain(
      `/websites/resolve-rare-${stamp}`,
    );
  });

  it('returns empty results for a query nothing matches', async () => {
    const output = await resolveLibrary(anonymous, { query: 'zzz-nonexistent-zzz' }, noEmbeddings);
    expect(output.results).toHaveLength(0);
    expect(output.requestId).toBe('req_test');
  });

  it('fuses the semantic path in without breaking keyword recall', async () => {
    const stamp = Date.now();
    const id = await publishedLibrary(`resolve-vec-${stamp}`, `向量测试 ${stamp}`, [
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

    const output = await resolveLibrary(anonymous, { query: '蓝鲸的洄游' }, withEmbeddings);
    expect(output.results.map((candidate) => candidate.libraryId)).toContain(
      `/websites/resolve-vec-${stamp}`,
    );
    void id;
  });
});
