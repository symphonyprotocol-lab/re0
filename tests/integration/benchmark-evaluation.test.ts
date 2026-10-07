/**
 * The Benchmark's test set, against a real database. requirement.md 6.3.
 *
 * The rules are covered in tests/contract/benchmark.test.ts. What needs rows:
 *
 * - a build asks the library's questions of the version it just wrote, and the
 *   score row records both the result and the structural score beneath it;
 * - a library with no questions, or whose questions could not be run, builds
 *   and scores exactly as it did before the test set existed;
 * - asking is not serving: an evaluation writes no usage event;
 * - the console can add and remove questions and re-evaluate without a
 *   rebuild, and a question id from another library is not found.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { desc, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { memoryObjectStore, runOperation } = await import('@/lib/application/ingestion');
const {
  addEvalQuestion,
  createPlatformLibrary,
  getLibraryBenchmark,
  removeEvalQuestion,
  runLibraryEvaluation,
} = await import('@/lib/application/administration');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { blendBenchmark, EVAL_MIN_QUESTIONS } = await import('@/lib/domain/benchmark');
const { PlatformLibraryRefused } = await import('@/lib/domain/library');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const created: string[] = [];
const store = memoryObjectStore();

/** One page per topic, each with a word no other page has. */
const TOPICS = ['zeppelin', 'quokka', 'marzipan', 'obelisk', 'tundra', 'gondola'];
const FILES = TOPICS.map((topic) => ({
  path: `docs/${topic}.md`,
  url: `https://example.test/docs/${topic}`,
  content: `# ${topic} guide\n\nThe ${topic} setting is configured with the ${topic}_mode flag.`,
}));

/**
 * Keyword retrieval only, so a hit depends on the index and not on what a fake
 * vector happens to be near. `broken` is a retrieval that cannot run at all.
 */
function retrieval(options: { broken?: boolean } = {}) {
  return () => ({
    embeddings: () => {
      throw new Error('no embedding model in this fixture');
    },
    rerank: () => {
      throw new Error('no reranker in this fixture');
    },
    configured: () => {
      if (options.broken) throw new Error('fixture: retrieval is down');
      return { embeddings: false, rerank: false };
    },
  });
}

function dependencies(options: { broken?: boolean } = {}) {
  return {
    async fetchSnapshot() {
      return {
        files: FILES,
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
    retrieval: retrieval(options),
  };
}

async function fixtureLibrary(slug: string): Promise<string> {
  const { libraryId } = await createPlatformLibrary({
    actor,
    title: `Benchmark fixture ${slug}`,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: 'https://example.test/docs',
    refreshPolicy: 'manual',
    reason: 'integration test fixture',
  });
  created.push(libraryId);
  return libraryId;
}

async function build(libraryId: string, options: { broken?: boolean } = {}) {
  const operationId = uuidv7();
  await db().insert(schema.workflowOperation).values({
    id: operationId,
    libraryId,
    operationType: 'refresh',
    sourceDigest: null,
    sourceId: null,
    status: 'pending',
  });
  await runOperation({ operationId, dependencies: dependencies(options) });
}

/** Four questions the fixture answers and two it cannot. */
async function seedQuestions(libraryId: string) {
  for (const topic of TOPICS.slice(0, 4)) {
    await addEvalQuestion({
      actor,
      libraryId,
      question: `How is the ${topic} setting configured?`,
      expectedSource: `docs/${topic}`,
      expectedText: `${topic}_mode`,
    });
  }
  await addEvalQuestion({
    actor,
    libraryId,
    question: 'How is the zeppelin setting configured?',
    expectedText: 'a phrase no page contains',
  });
  await addEvalQuestion({
    actor,
    libraryId,
    question: 'How is the quokka setting configured?',
    expectedSource: 'docs/nowhere',
  });
}

async function newestScore(libraryId: string) {
  const [score] = await db()
    .select()
    .from(schema.libraryScore)
    .where(eq(schema.libraryScore.libraryId, libraryId))
    .orderBy(desc(schema.libraryScore.computedAt))
    .limit(1);
  return score!;
}

describeWithDb('benchmark evaluation', () => {
  afterAll(async () => {
    const database = db();
    if (created.length === 0) return;
    await database
      .update(schema.library)
      .set({ currentVersionId: null })
      .where(inArray(schema.library.id, created));
    await database
      .delete(schema.libraryEvalQuestion)
      .where(inArray(schema.libraryEvalQuestion.libraryId, created));
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
    await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, created));
  });

  it('scores a library without questions on structure alone', async () => {
    const libraryId = await fixtureLibrary(`bench-none-${Date.now()}`);
    await build(libraryId);

    const score = await newestScore(libraryId);
    expect(score.algorithmVersion).toBe('re0-score-2');
    expect(score.breakdown.structural).toBe(score.benchmarkScore);
    expect(score.breakdown.evalQuestions).toBeUndefined();
  });

  it('asks the test set of the new version and blends the hit rate in', async () => {
    const libraryId = await fixtureLibrary(`bench-build-${Date.now()}`);
    await seedQuestions(libraryId);
    await build(libraryId);

    const score = await newestScore(libraryId);
    expect(score.breakdown).toMatchObject({ evalQuestions: 6, evalHits: 4, evalHitRate: 67 });
    expect(score.benchmarkScore).toBe(
      blendBenchmark(score.breakdown.structural!, { questions: 6, hits: 4, hitRate: 4 / 6, mrr: 0 }),
    );
    expect(score.benchmarkScore).not.toBe(score.breakdown.structural);

    const [library] = await db()
      .select({ currentVersionId: schema.library.currentVersionId })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));
    const view = await getLibraryBenchmark(libraryId);
    expect(view?.questions.map((question) => question.lastRank !== null)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(view?.questions.every((question) => question.lastRunIsCurrent)).toBe(true);
    expect(view?.score?.evaluation).toEqual({ questions: 6, hits: 4, hitRate: 67 });
    expect(library?.currentVersionId).toBeTruthy();
  });

  it('is not a served call: an evaluation writes no usage event', async () => {
    const libraryId = await fixtureLibrary(`bench-usage-${Date.now()}`);
    await seedQuestions(libraryId);
    await build(libraryId);
    await runLibraryEvaluation({ actor, libraryId, dependencies: retrieval()() });

    const events = await db()
      .select({ id: schema.usageEvent.id })
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.libraryId, libraryId));
    expect(events).toEqual([]);
  });

  it('builds and scores structurally when the questions cannot be run', async () => {
    const libraryId = await fixtureLibrary(`bench-broken-${Date.now()}`);
    await seedQuestions(libraryId);
    await build(libraryId, { broken: true });

    const [library] = await db()
      .select({ currentVersionId: schema.library.currentVersionId })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));
    expect(library?.currentVersionId).toBeTruthy();

    const score = await newestScore(libraryId);
    // "Not evaluated", never "every question missed".
    expect(score.breakdown.evalQuestions).toBeUndefined();
    expect(score.benchmarkScore).toBe(score.breakdown.structural);
    const view = await getLibraryBenchmark(libraryId);
    expect(view?.questions.every((question) => question.lastEvaluatedAt === null)).toBe(true);
  });

  it('re-evaluates from the console without a rebuild, and audits it', async () => {
    const libraryId = await fixtureLibrary(`bench-console-${Date.now()}`);
    await build(libraryId);
    const before = await newestScore(libraryId);

    await expect(
      runLibraryEvaluation({ actor, libraryId, dependencies: retrieval()() }),
    ).rejects.toMatchObject({ code: 'eval_unavailable' });

    for (const topic of TOPICS.slice(0, EVAL_MIN_QUESTIONS)) {
      await addEvalQuestion({
        actor,
        libraryId,
        question: `How is the ${topic} setting configured?`,
        expectedText: `${topic}_mode`,
      });
    }
    const result = await runLibraryEvaluation({ actor, libraryId, dependencies: retrieval()() });
    expect(result).toMatchObject({
      questions: EVAL_MIN_QUESTIONS,
      hits: EVAL_MIN_QUESTIONS,
      previousBenchmarkScore: before.benchmarkScore,
    });

    const after = await newestScore(libraryId);
    expect(after.id).not.toBe(before.id);
    expect(after.trustScore).toBe(before.trustScore);
    expect(after.breakdown.structural).toBe(before.benchmarkScore);
    expect(after.breakdown.documents).toBe(before.breakdown.documents);
    expect(after.benchmarkScore).toBe(result.benchmarkScore);
    expect(after.benchmarkScore).toBeGreaterThan(before.benchmarkScore);

    const audited = await db()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, libraryId));
    expect(audited.map((row) => row.action)).toEqual(
      expect.arrayContaining(['library.eval_question_add', 'library.benchmark_evaluate']),
    );
  });

  it('refuses a malformed question and one from another library', async () => {
    const libraryId = await fixtureLibrary(`bench-guard-${Date.now()}`);
    const otherId = await fixtureLibrary(`bench-guard-other-${Date.now()}`);

    await expect(
      addEvalQuestion({ actor, libraryId, question: 'Where?', expectedSource: '', expectedText: '' }),
    ).rejects.toBeInstanceOf(PlatformLibraryRefused);

    const { questionId } = await addEvalQuestion({
      actor,
      libraryId,
      question: 'Where?',
      expectedText: 'here',
    });
    await expect(
      removeEvalQuestion({ actor, libraryId: otherId, questionId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await getLibraryBenchmark(libraryId))?.questions).toHaveLength(1);

    await removeEvalQuestion({ actor, libraryId, questionId });
    expect((await getLibraryBenchmark(libraryId))?.questions).toHaveLength(0);
  });
});
