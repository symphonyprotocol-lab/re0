/**
 * Puts a library's test set to one of its versions. requirement.md 6.3.
 *
 * The questions go through `rankChunks` -- the recall, fusion and rerank a
 * caller's question gets -- and nothing else: no caller, no policy, no
 * reservation, no usage event, no cache. An evaluation is the platform reading
 * its own index, and it must neither be metered nor earn (architecture.md
 * 11.4), nor be answered from a cache entry a previous version wrote.
 *
 * Two entry points. `evaluateVersion` is called by the build on the version it
 * has just made ready, before the score row is written. `evaluateLibrary` is
 * the console's "run now": it re-asks the current version and appends a new
 * score row, re-blending the structural score the last build recorded, so
 * adding questions does not need a rebuild to count.
 */
import { asc, desc, eq, inArray } from 'drizzle-orm';
import {
  blendBenchmark,
  EVAL_MAX_QUESTIONS,
  hitRank,
  summarizeEvaluation,
  type EvaluationSummary,
} from '@/lib/domain/benchmark';
import { uuidv7 } from '@/lib/domain/id';
import { SCORE_ALGORITHM_VERSION } from '@/lib/domain/ingestion';
import { DEFAULT_RETRIEVAL_SETTINGS } from '@/lib/domain/retrieval-config';
import {
  defaultRetrievalDependencies,
  type RetrievalDependencies,
} from '@/lib/application/retrieval/query-docs';
import { rankChunks } from '@/lib/application/retrieval/rank';
import { db, schema } from '@/lib/infrastructure/postgres/client';

/** What a caller gets by default (contracts/schemas.ts), so ranks match theirs. */
const EVAL_MAX_TOKENS = 4000;

export type EvaluationDependencies = Pick<
  RetrievalDependencies,
  'embeddings' | 'rerank' | 'configured' | 'settings'
>;

/**
 * Null when the library has no questions, or when they could not be run.
 *
 * A failure is "not evaluated", never "every question missed": an embedding
 * provider that is down for a minute must not publish a Benchmark of twenty
 * for a library whose index is fine. The build that called this goes on either
 * way -- the score is derived data and a version is not.
 */
export async function evaluateVersion(
  database: ReturnType<typeof db>,
  target: { libraryId: string; versionId: string },
  dependencies: EvaluationDependencies = defaultRetrievalDependencies(),
): Promise<EvaluationSummary | null> {
  const questions = await database
    .select({
      id: schema.libraryEvalQuestion.id,
      question: schema.libraryEvalQuestion.question,
      expectedSource: schema.libraryEvalQuestion.expectedSource,
      expectedText: schema.libraryEvalQuestion.expectedText,
    })
    .from(schema.libraryEvalQuestion)
    .where(eq(schema.libraryEvalQuestion.libraryId, target.libraryId))
    .orderBy(asc(schema.libraryEvalQuestion.createdAt))
    .limit(EVAL_MAX_QUESTIONS);
  if (questions.length === 0) return null;

  const [version] = await database
    .select({
      id: schema.libraryVersion.id,
      searchConfig: schema.libraryVersion.searchConfig,
      embeddingModel: schema.libraryVersion.embeddingModel,
      embeddingDimensions: schema.libraryVersion.embeddingDimensions,
    })
    .from(schema.libraryVersion)
    .where(eq(schema.libraryVersion.id, target.versionId));
  if (!version) return null;

  const ranks: (number | null)[] = [];
  try {
    const settings = dependencies.settings
      ? await dependencies.settings()
      : DEFAULT_RETRIEVAL_SETTINGS;
    for (const question of questions) {
      const { chunks } = await rankChunks(
        database,
        {
          libraryId: target.libraryId,
          version,
          query: question.question,
          maxTokens: EVAL_MAX_TOKENS,
        },
        dependencies,
        settings,
      );
      ranks.push(
        hitRank(
          question,
          chunks.map((chunk) => ({
            text: chunk.text,
            sourceUrl: chunk.citation.sourceUrl,
            documentTitle: chunk.citation.documentTitle,
          })),
        ),
      );
    }
  } catch (error) {
    console.error(
      `benchmark evaluation of ${target.libraryId} abandoned: ${error instanceof Error ? error.message : 'unknown'}`,
    );
    return null;
  }

  /* One statement per outcome rather than one per question. */
  const evaluatedAt = new Date();
  const byRank = new Map<number | null, string[]>();
  questions.forEach((question, index) => {
    const rank = ranks[index] ?? null;
    byRank.set(rank, [...(byRank.get(rank) ?? []), question.id]);
  });
  for (const [rank, ids] of byRank) {
    await database
      .update(schema.libraryEvalQuestion)
      .set({ lastRank: rank, lastVersionId: version.id, lastEvaluatedAt: evaluatedAt })
      .where(inArray(schema.libraryEvalQuestion.id, ids));
  }

  return summarizeEvaluation(ranks);
}

/** What an evaluation adds to `library_score.breakdown`. */
export function evaluationBreakdown(
  structural: number,
  evaluation: EvaluationSummary | null,
): Record<string, number> {
  return {
    structural,
    ...(evaluation
      ? {
          evalQuestions: evaluation.questions,
          evalHits: evaluation.hits,
          evalHitRate: Math.round(evaluation.hitRate * 100),
          evalMrr: Math.round(evaluation.mrr * 100),
        }
      : {}),
  };
}

export interface LibraryEvaluation {
  evaluation: EvaluationSummary;
  benchmarkScore: number;
  previousBenchmarkScore: number;
}

/**
 * Re-asks the current version and appends a score row. Null when there is
 * nothing to do: no current version, no score yet, no questions, or a run
 * that could not complete.
 */
export async function evaluateLibrary(
  libraryId: string,
  dependencies: EvaluationDependencies = defaultRetrievalDependencies(),
): Promise<LibraryEvaluation | null> {
  const database = db();
  const [library] = await database
    .select({ currentVersionId: schema.library.currentVersionId })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId));
  if (!library?.currentVersionId) return null;

  const [previous] = await database
    .select({
      trustScore: schema.libraryScore.trustScore,
      benchmarkScore: schema.libraryScore.benchmarkScore,
      breakdown: schema.libraryScore.breakdown,
    })
    .from(schema.libraryScore)
    .where(eq(schema.libraryScore.libraryId, libraryId))
    .orderBy(desc(schema.libraryScore.computedAt))
    .limit(1);
  if (!previous) return null;

  const evaluation = await evaluateVersion(
    database,
    { libraryId, versionId: library.currentVersionId },
    dependencies,
  );
  if (!evaluation) return null;

  /*
   * A row written before the test set existed has no `structural`, and its
   * Benchmark was nothing but structural.
   */
  const structural = previous.breakdown.structural ?? previous.benchmarkScore;
  const benchmarkScore = blendBenchmark(structural, evaluation);

  /* The build's own facts ride along; only the evaluation keys are replaced. */
  const {
    evalQuestions: _questions,
    evalHits: _hits,
    evalHitRate: _hitRate,
    evalMrr: _mrr,
    ...facts
  } = previous.breakdown;

  await database.insert(schema.libraryScore).values({
    id: uuidv7(),
    libraryId,
    algorithmVersion: SCORE_ALGORITHM_VERSION,
    trustScore: previous.trustScore,
    benchmarkScore,
    breakdown: { ...facts, ...evaluationBreakdown(structural, evaluation) },
  });

  return { evaluation, benchmarkScore, previousBenchmarkScore: previous.benchmarkScore };
}
