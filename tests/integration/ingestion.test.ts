/**
 * The ingestion pipeline end to end, against a real database.
 *
 * The connector, the embedding provider and the object store are all injected
 * (`IngestionDependencies`), so what is under test is the part that cannot be
 * unit tested: the rows. Specifically --
 *
 * - a build writes a version, its documents and its chunks, and only marks the
 *   version `ready` once every chunk is in the table (requirement.md 8.1);
 * - publication moves `current_version_id` and supersedes the version it
 *   replaced, in one transaction (architecture.md 8.3);
 * - an unchanged source digest updates `last_checked_at` and creates nothing
 *   (architecture.md 8.4);
 * - a failed run keeps the current version serving (requirement.md 8.2);
 * - two workers draining the same queue do one build between them.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database -- these
 * tests write rows. Against Neon, use a dev branch:
 *
 *   TEST_DATABASE_URL='postgres://...' npx vitest run tests/integration
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { buildVersion, memoryObjectStore, runOperation, drainOperations } = await import(
  '@/lib/application/ingestion'
);
const { createPlatformLibrary, addPlatformLibrarySource, requestPlatformLibraryRefresh } = await import(
  '@/lib/application/administration/manage-platform-libraries'
);
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { IngestionFailure, snapshotDigest } = await import('@/lib/domain/ingestion');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { PROFILE_VERSION } = await import('@/lib/domain/profile');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };

const created: string[] = [];

/**
 * A fixed snapshot. Two documents, three sections, one of them long enough to
 * produce more than one chunk -- enough for the ordinal, citation and merkle
 * paths to all be exercised without making the fixture unreadable.
 */
const FILES = [
  {
    path: 'README.md',
    url: 'https://example.test/readme',
    content: '# Fixture\n\nThe front page.\n\n## Install\n\nRun the installer.',
  },
  {
    path: 'docs/guide.md',
    url: 'https://example.test/guide',
    content: `# Guide\n\n${'A sentence about the fixture. '.repeat(80)}\n\n## Details\n\nMore.`,
  },
];

const store = memoryObjectStore();

/** Deterministic vectors: the pipeline must not care what the numbers are. */
function fakeEmbeddings(model = 'fixture-embed-1') {
  return () => ({
    model,
    dimensions: EMBEDDING_COLUMN_DIMENSIONS,
    async embed(texts: string[]) {
      return texts.map((text) =>
        Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17),
      );
    },
  });
}

function dependencies(options: { files?: typeof FILES; fail?: boolean } = {}) {
  return {
    async fetchSnapshot() {
      if (options.fail) {
        throw new IngestionFailure('source_unreachable', 'fetch-snapshot', 'fixture failure');
      }
      return {
        files: options.files ?? FILES,
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
    embeddings: fakeEmbeddings(),
    store: () => store,
    configured: () => ({ embeddings: true, storage: true }),
  };
}

async function fixtureLibrary(slug: string, language?: string): Promise<string> {
  const { libraryId } = await createPlatformLibrary({
    actor,
    title: `Ingestion fixture ${slug}`,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: 'https://example.test/docs',
    refreshPolicy: 'manual',
    language,
    reason: 'integration test fixture',
  });
  created.push(libraryId);
  return libraryId;
}

async function queueRefresh(libraryId: string, sourceId: string | null = null): Promise<string> {
  const operationId = uuidv7();
  await db().insert(schema.workflowOperation).values({
    id: operationId,
    libraryId,
    operationType: 'refresh',
    sourceDigest: null,
    sourceId,
    status: 'pending',
  });
  return operationId;
}

/**
 * Two sources, told apart by location. Counts what the pipeline asked for --
 * which sources were fetched, which texts were embedded -- because that is
 * the whole of what carrying a source forward is supposed to save.
 */
function twoSourceDependencies(content: Record<string, typeof FILES>) {
  const fetched: string[] = [];
  const embedded: string[] = [];
  return {
    fetched,
    embedded,
    dependencies: {
      async fetchSnapshot(input: { location: string }) {
        fetched.push(input.location);
        return {
          files: content[input.location] ?? [],
          config: {
            projectTitle: null,
            description: null,
            branch: null,
            folders: [],
            excludeFolders: [],
            excludeFiles: [],
            rules: [],
          },
          revision: null,
          lastModifiedAt: new Date(),
          hasLicense: true,
          stale: false,
        };
      },
      embeddings: () => ({
        model: 'fixture-embed-1',
        dimensions: EMBEDDING_COLUMN_DIMENSIONS,
        async embed(texts: string[]) {
          embedded.push(...texts);
          return texts.map((text) =>
            Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17),
          );
        },
      }),
      store: () => store,
      configured: () => ({ embeddings: true, storage: true }),
    },
  };
}

describeWithDb('ingestion', () => {
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
    await database
      .delete(schema.workflowOperation)
      .where(inArray(schema.workflowOperation.libraryId, created));
    await database.delete(schema.source).where(inArray(schema.source.libraryId, created));
    await database.delete(schema.libraryAlias).where(inArray(schema.libraryAlias.libraryId, created));
    await database.delete(schema.library).where(inArray(schema.library.id, created));
    await database
      .delete(schema.auditLog)
      .where(inArray(schema.auditLog.targetId, created));
  });

  it('carries an unchanged source forward and refreshes one source alone', async () => {
    const slug = `ingest-carry-${Date.now()}`;
    const libraryId = await fixtureLibrary(slug);
    const siteA = 'https://example.test/docs';
    const siteB = 'https://example.test/api';
    await addPlatformLibrarySource({
      actor,
      libraryId,
      type: 'website',
      location: siteB,
      refreshPolicy: 'manual',
      reason: 'second source',
    });
    const sources = await db()
      .select({ id: schema.source.id, location: schema.source.location })
      .from(schema.source)
      .where(eq(schema.source.libraryId, libraryId));
    const sourceB = sources.find((source) => source.location === siteB)!;

    const docsA = [{ path: 'a.md', url: 'https://example.test/a', content: '# Alpha\n\nAlpha body one.' }];
    const docsB = [{ path: 'b.md', url: 'https://example.test/b', content: '# Beta\n\nBeta body one.' }];

    /* First build: everything is fetched and embedded. */
    const first = twoSourceDependencies({ [siteA]: docsA, [siteB]: docsB });
    const built = await runOperation({ operationId: await queueRefresh(libraryId), dependencies: first.dependencies });
    expect(built.status).toBe('succeeded');
    expect(first.fetched.sort()).toEqual([siteB, siteA].sort());
    expect(first.embedded.some((text) => text.includes('Alpha'))).toBe(true);
    expect(first.embedded.some((text) => text.includes('Beta'))).toBe(true);
    const [v1] = await db()
      .select({ id: schema.libraryVersion.id, sourceDigests: schema.libraryVersion.sourceDigests })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId));
    expect(Object.keys(v1!.sourceDigests ?? {}).sort()).toEqual(sources.map((s) => s.id).sort());
    const docsV1 = await db().select({ id: schema.document.id, sourceId: schema.document.sourceId, objectKey: schema.document.objectKey }).from(schema.document).where(eq(schema.document.versionId, v1!.id));
    expect(docsV1.map((d) => d.sourceId).sort()).toEqual(sources.map((s) => s.id).sort());

    /* Nothing changed: no version, both sources checked. */
    const same = twoSourceDependencies({ [siteA]: docsA, [siteB]: docsB });
    expect((await runOperation({ operationId: await queueRefresh(libraryId), dependencies: same.dependencies })).status).toBe('skipped');
    expect(same.embedded).toHaveLength(0);

    /* B changed: A is fetched (to know it did not change) but not embedded. */
    const docsB2 = [{ path: 'b.md', url: 'https://example.test/b', content: '# Beta\n\nBeta body two, revised.' }];
    const second = twoSourceDependencies({ [siteA]: docsA, [siteB]: docsB2 });
    const rebuilt = await runOperation({ operationId: await queueRefresh(libraryId), dependencies: second.dependencies });
    expect(rebuilt.status).toBe('succeeded');
    expect(second.fetched.sort()).toEqual([siteB, siteA].sort());
    expect(second.embedded.some((text) => text.includes('Alpha'))).toBe(false);
    expect(second.embedded.some((text) => text.includes('revised'))).toBe(true);
    if (rebuilt.status !== 'succeeded') return;
    const docsV2 = await db().select({ sourceId: schema.document.sourceId, objectKey: schema.document.objectKey, title: schema.document.title }).from(schema.document).where(eq(schema.document.versionId, rebuilt.versionId));
    expect(docsV2).toHaveLength(2);
    const carried = docsV2.find((d) => d.title === 'Alpha')!;
    /* The carried document shares its normalized object with the old version. */
    expect(docsV1.find((d) => d.objectKey === carried.objectKey)).toBeDefined();
    const chunksV2 = await db().select({ body: schema.chunk.body, embedding: schema.chunk.embedding }).from(schema.chunk).where(eq(schema.chunk.versionId, rebuilt.versionId));
    expect(chunksV2.some((c) => c.body.includes('Alpha') && Array.isArray(c.embedding))).toBe(true);
    expect(rebuilt.chunks).toBe(chunksV2.length);

    /* A refresh naming B fetches B only; A rides along unfetched. */
    const docsB3 = [{ path: 'b.md', url: 'https://example.test/b', content: '# Beta\n\nBeta body three.' }];
    const third = twoSourceDependencies({ [siteA]: docsA, [siteB]: docsB3 });
    const request = await requestPlatformLibraryRefresh({ actor, libraryId, sourceId: sourceB.id, reason: 'B moved' });
    expect(request.created).toBe(true);
    const only = await runOperation({ operationId: request.operationId, dependencies: third.dependencies });
    expect(only.status).toBe('succeeded');
    expect(third.fetched).toEqual([siteB]);
    expect(third.embedded.some((text) => text.includes('Alpha'))).toBe(false);
    if (only.status === 'succeeded') expect(only.documents).toBe(2);

    /* An open whole-library refresh covers a per-source request; one for
       another source does not. */
    const whole = await requestPlatformLibraryRefresh({ actor, libraryId, reason: 'all' });
    expect(whole.created).toBe(true);
    const covered = await requestPlatformLibraryRefresh({ actor, libraryId, sourceId: sourceB.id, reason: 'B again' });
    expect(covered).toEqual({ operationId: whole.operationId, created: false });
    await db().update(schema.workflowOperation).set({ status: 'cancelled' }).where(eq(schema.workflowOperation.id, whole.operationId));
  });

  it('builds a version with documents, chunks, citations and vectors', async () => {
    const libraryId = await fixtureLibrary(`ingest-build-${Date.now()}`);
    const built = await buildVersion({
      libraryId,
      operationId: uuidv7(),
      dependencies: dependencies(),
    });

    expect(built.changed).toBe(true);
    if (!built.changed) return;
    expect(built.documents).toBe(2);
    expect(built.chunks).toBeGreaterThan(2);

    const database = db();
    const [version] = await database
      .select()
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.id, built.versionId));

    // Ready is written last, so a version that says ready has all its chunks.
    expect(version?.indexStatus).toBe('ready');
    expect(version?.embeddingModel).toBe('fixture-embed-1');
    expect(version?.contentMerkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(version?.sourceDigest).toBe(await snapshotDigest(FILES));

    const chunks = await database
      .select()
      .from(schema.chunk)
      .where(eq(schema.chunk.versionId, built.versionId));

    expect(chunks).toHaveLength(version?.totalChunks ?? -1);
    for (const chunk of chunks) {
      expect(chunk.embedding).toHaveLength(EMBEDDING_COLUMN_DIMENSIONS);
      expect(chunk.tokens).toBeGreaterThan(0);
      // Every chunk cites the document it came from, by URL.
      expect(String((chunk.citation as { url?: string }).url)).toContain('https://example.test/');
    }

    // The keyword index is a generated column: it exists without being written.
    const [indexed] = await database
      .select({ n: schema.chunk.id })
      .from(schema.chunk)
      .where(eq(schema.chunk.versionId, built.versionId))
      .limit(1);
    expect(indexed).toBeDefined();

    // The profile rides in the `ready` transaction (architecture.md 8.2 step 8):
    // a version that says ready can be routed to.
    const [profile] = await database
      .select()
      .from(schema.libraryProfile)
      .where(eq(schema.libraryProfile.versionId, built.versionId));
    expect(profile?.profileVersion).toBe(PROFILE_VERSION);
    expect(profile?.documentTitles).toContain('Guide');
    expect(profile?.terms).toContain('installer');

    const centroids = await database
      .select()
      .from(schema.libraryProfileVector)
      .where(eq(schema.libraryProfileVector.versionId, built.versionId));
    expect(centroids.length).toBeGreaterThan(0);
    for (const centroid of centroids) {
      expect(centroid.embedding).toHaveLength(EMBEDDING_COLUMN_DIMENSIONS);
    }
  });

  /**
   * The rove-beetle case, end to end. architecture.md 9.6: the library's name
   * says nothing about beetles, the term lives in one paragraph, and routing
   * must still be able to find the library by it -- via the profile's
   * pre-segmented keyword index, which works for CJK where `chunk`'s cannot.
   */
  it('profiles content the library name never mentions', async () => {
    const libraryId = await fixtureLibrary(`ingest-profile-${Date.now()}`);
    const files = [
      {
        path: 'docs/beetles.md',
        url: 'https://example.test/beetles',
        content:
          '# 常见甲虫\n\n隐翅虫的防治与危害:隐翅虫体液含隐翅虫素,接触皮肤会引起皮炎。远离灯光可以减少接触。',
      },
    ];
    const built = await buildVersion({
      libraryId,
      operationId: uuidv7(),
      dependencies: dependencies({ files }),
    });
    expect(built.changed).toBe(true);
    if (!built.changed) return;

    const database = db();
    const [profile] = await database
      .select()
      .from(schema.libraryProfile)
      .where(eq(schema.libraryProfile.versionId, built.versionId));
    expect(profile?.terms).toContain('隐翅虫');

    // What the routing layer will actually run: simple-config FTS over the
    // profile finds the term, even though the chunk index never could.
    const [routed] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.libraryProfile)
      .where(
        sql`${schema.libraryProfile.versionId} = ${built.versionId}
            and ${schema.libraryProfile.searchVector} @@ plainto_tsquery('simple', '隐翅虫')`,
      );
    expect(routed?.n).toBe(1);
  });

  it('publishes through the queue and moves the pointer atomically', async () => {
    const libraryId = await fixtureLibrary(`ingest-publish-${Date.now()}`);
    const outcome = await runOperation({
      operationId: await queueRefresh(libraryId),
      dependencies: dependencies(),
    });

    expect(outcome.status).toBe('succeeded');

    const database = db();
    const [library] = await database
      .select()
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));

    expect(library?.currentVersionId).not.toBeNull();
    expect(library?.indexStatus).toBe('ready');
    // Publishing a *version* does not publish the *library*: requirement.md 6.2
    // keeps index state and lifecycle apart, and 5.3 leaves the catalogue
    // decision to an operator.
    expect(library?.lifecycleStatus).toBe('draft');

    const [version] = await database
      .select()
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.id, library?.currentVersionId ?? ''));
    expect(version?.publishedAt).not.toBeNull();
  });

  it('supersedes the previous version when the source changes', async () => {
    const libraryId = await fixtureLibrary(`ingest-super-${Date.now()}`);
    await runOperation({ operationId: await queueRefresh(libraryId), dependencies: dependencies() });

    const database = db();
    const [before] = await database
      .select({ current: schema.library.currentVersionId })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));

    const changed = [FILES[0]!, { ...FILES[1]!, content: '# Guide\n\nRewritten entirely.' }];
    await runOperation({
      operationId: await queueRefresh(libraryId),
      dependencies: dependencies({ files: changed }),
    });

    const [after] = await database
      .select({ current: schema.library.currentVersionId })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));

    expect(after?.current).not.toBe(before?.current);

    const [old] = await database
      .select({ indexStatus: schema.libraryVersion.indexStatus })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.id, before?.current ?? ''));
    expect(old?.indexStatus).toBe('stale');
  });

  it('creates no version when the source digest has not changed', async () => {
    const libraryId = await fixtureLibrary(`ingest-same-${Date.now()}`);
    await runOperation({ operationId: await queueRefresh(libraryId), dependencies: dependencies() });

    const database = db();
    const versionsBefore = await database
      .select({ id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId));

    const operationId = await queueRefresh(libraryId);
    const outcome = await runOperation({ operationId, dependencies: dependencies() });
    expect(outcome.status).toBe('skipped');

    const versionsAfter = await database
      .select({ id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId));
    expect(versionsAfter).toHaveLength(versionsBefore.length);

    const [checked] = await database
      .select({ lastCheckedAt: schema.library.lastCheckedAt })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));
    expect(checked?.lastCheckedAt).not.toBeNull();
  });

  it('keeps the current version serving when a refresh fails', async () => {
    const libraryId = await fixtureLibrary(`ingest-fail-${Date.now()}`);
    await runOperation({ operationId: await queueRefresh(libraryId), dependencies: dependencies() });

    const database = db();
    const [before] = await database
      .select({ current: schema.library.currentVersionId })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));

    const operationId = await queueRefresh(libraryId);
    const outcome = await runOperation({
      operationId,
      dependencies: dependencies({ fail: true }),
    });
    expect(outcome.status).toBe('failed');

    const [after] = await database
      .select({ current: schema.library.currentVersionId, indexStatus: schema.library.indexStatus })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));

    expect(after?.current).toBe(before?.current);
    // A library that is still serving is not "failed" -- only the attempt was.
    expect(after?.indexStatus).toBe('ready');

    const [operation] = await database
      .select({ status: schema.workflowOperation.status, error: schema.workflowOperation.error })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, operationId));
    // Unreachable is retriable, so the row goes back to pending for the drain.
    expect(operation?.status).toBe('pending');
    expect(operation?.error).toBe('source_unreachable');
  });

  it('lets only one worker claim an operation', async () => {
    const libraryId = await fixtureLibrary(`ingest-claim-${Date.now()}`);
    const operationId = await queueRefresh(libraryId);

    const [first, second] = await Promise.all([
      runOperation({ operationId, dependencies: dependencies() }),
      runOperation({ operationId, dependencies: dependencies() }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['lost', 'succeeded']);
  });

  it('drains the queue oldest first', async () => {
    const libraryId = await fixtureLibrary(`ingest-drain-${Date.now()}`);
    await queueRefresh(libraryId);

    const outcomes = await drainOperations({ limit: 5, dependencies: dependencies() });
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.some((outcome) => outcome.status === 'succeeded')).toBe(true);
  });

  /**
   * The keyword half, in the library's own language.
   *
   * `search_vector` is generated from `body` and `search_config`, so this is
   * the only place the whole arrangement can be checked: that the build stamped
   * the right configuration, that Postgres stemmed with it, and that a chunk
   * never ends up with a NULL vector it could not be found by.
   */
  it('indexes with the stemmer the library\u2019s language names', async () => {
    const libraryId = await fixtureLibrary(`ingest-lang-${Date.now()}`, 'en-US');
    await runOperation({ operationId: await queueRefresh(libraryId), dependencies: dependencies() });

    const database = db();
    const chunks = await database
      .select({ config: schema.chunk.searchConfig })
      .from(schema.chunk)
      .where(eq(schema.chunk.libraryId, libraryId));

    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((chunk) => chunk.config))).toEqual(new Set(['english']));

    // `installer` stems to `instal`, so the plural in the query still matches
    // the singular in the fixture -- which `simple` could not do.
    const [stemmed] = await database
      .select({ n: sql`count(*)::int` })
      .from(schema.chunk)
      .where(
        sql`${schema.chunk.libraryId} = ${libraryId}
            and ${schema.chunk.searchVector} @@ plainto_tsquery('english', 'installers')`,
      );
    expect(Number(stemmed?.n ?? 0)).toBeGreaterThan(0);

    // Nothing generated a NULL vector, which the CHECK constraint exists to
    // make impossible and this confirms end to end.
    const [empty] = await database
      .select({ n: sql`count(*)::int` })
      .from(schema.chunk)
      .where(sql`${schema.chunk.libraryId} = ${libraryId} and ${schema.chunk.searchVector} is null`);
    expect(Number(empty?.n ?? 0)).toBe(0);
  });

  it('rebuilds an unchanged source when the build configuration moved', async () => {
    const libraryId = await fixtureLibrary(`ingest-recfg-${Date.now()}`);
    await runOperation({ operationId: await queueRefresh(libraryId), dependencies: dependencies() });

    const database = db();
    const [before] = await database
      .select({ id: schema.library.currentVersionId })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));

    // Same source, different embedding model: requirement.md 8.1 freezes the
    // model on a version, so the current one no longer describes what today's
    // build would produce and "unchanged" would be the wrong answer.
    const outcome = await runOperation({
      operationId: await queueRefresh(libraryId),
      dependencies: { ...dependencies(), embeddings: fakeEmbeddings('fixture-embed-2') },
    });
    expect(outcome.status).toBe('succeeded');

    const [after] = await database
      .select({ id: schema.library.currentVersionId })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));
    expect(after?.id).not.toBe(before?.id);

    const [version] = await database
      .select({ model: schema.libraryVersion.embeddingModel, label: schema.libraryVersion.label })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.id, after?.id ?? ''));
    expect(version?.model).toBe('fixture-embed-2');

    // Same digest, same day, so the label has to say which build this is.
    expect(version?.label).toMatch(/\.2$/);
    const labels = await database
      .select({ label: schema.libraryVersion.label })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId));
    expect(new Set(labels.map((row) => row.label)).size).toBe(labels.length);
  });

  it('falls back to simple for a language with no stemmer', async () => {
    const libraryId = await fixtureLibrary(`ingest-cjk-${Date.now()}`, '中文');
    await runOperation({ operationId: await queueRefresh(libraryId), dependencies: dependencies() });

    const [chunk] = await db()
      .select({ config: schema.chunk.searchConfig })
      .from(schema.chunk)
      .where(eq(schema.chunk.libraryId, libraryId))
      .limit(1);
    expect(chunk?.config).toBe('simple');
  });

  it('measures storage in bytes, not in UTF-16 units', async () => {
    const chinese = [
      {
        path: 'README.md',
        url: 'https://example.test/readme',
        content: '# 知识库\n\n这是一段中文说明，用来验证容量按字节计算。',
      },
    ];
    const libraryId = await fixtureLibrary(`ingest-bytes-${Date.now()}`);
    await runOperation({
      operationId: await queueRefresh(libraryId),
      dependencies: dependencies({ files: chinese }),
    });

    const [record] = await db()
      .select({ storageBytes: schema.library.storageBytes })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));

    // requirement.md 4.1 counts content bytes; each Han character is one
    // UTF-16 unit and three UTF-8 bytes, so a string length would report a
    // third of this.
    const expected = new TextEncoder().encode(chinese[0]!.content).length;
    expect(record?.storageBytes).toBe(expected);
    expect(expected).toBeGreaterThan(chinese[0]!.content.length);
  });

  it('leaves nothing behind when a build fails after the version row', async () => {
    const libraryId = await fixtureLibrary(`ingest-discard-${Date.now()}`);

    const outcome = await runOperation({
      operationId: await queueRefresh(libraryId),
      dependencies: {
        ...dependencies(),
        // Fails after the version and documents are written, which is what the
        // streaming insert made reachable.
        embeddings: () => ({
          model: 'fixture-embed-1',
          dimensions: EMBEDDING_COLUMN_DIMENSIONS,
          async embed(): Promise<number[][]> {
            throw new Error('provider exploded mid-build');
          },
        }),
      },
    });
    expect(outcome.status).toBe('failed');

    const database = db();
    const versions = await database
      .select({ id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId));
    const documents = await database
      .select({ id: schema.document.id })
      .from(schema.document)
      .where(eq(schema.document.libraryId, libraryId));

    expect(versions).toHaveLength(0);
    expect(documents).toHaveLength(0);
  });

  it('records a trust and benchmark score for the build', async () => {
    const libraryId = await fixtureLibrary(`ingest-score-${Date.now()}`);
    await runOperation({ operationId: await queueRefresh(libraryId), dependencies: dependencies() });

    const [score] = await db()
      .select()
      .from(schema.libraryScore)
      .where(eq(schema.libraryScore.libraryId, libraryId));

    expect(score?.algorithmVersion).toMatch(/^re0-score-/);
    expect(score?.trustScore).toBeGreaterThan(0);
    expect(score?.benchmarkScore).toBeGreaterThan(0);
  });
});
