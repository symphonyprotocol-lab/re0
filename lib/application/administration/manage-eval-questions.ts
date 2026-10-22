/**
 * A library's test set, as the console maintains it. requirement.md 6.3.
 *
 * The questions are the platform's own measuring instrument, not part of the
 * library's record: adding one changes nothing a caller can read until an
 * evaluation runs, and removing one deletes a row no version references. So
 * these are audited like every console mutation but do not demand a typed
 * reason the way a lifecycle or source change does (requirement.md 5.3) --
 * the question text in the audit entry is the reason.
 *
 * Any live library, platform or user-submitted: what is being measured is the
 * index, and whose library it is does not change how.
 */
import { asc, count, desc, eq, and, isNull } from 'drizzle-orm';
import { evaluateLibrary, type EvaluationDependencies } from '@/lib/application/ingestion/evaluate';
import {
  draftEvalQuestion,
  EVAL_MAX_QUESTIONS,
  EVAL_MIN_QUESTIONS,
  EVAL_TOP_K,
} from '@/lib/domain/benchmark';
import { uuidv7 } from '@/lib/domain/id';
import { PlatformLibraryRefused } from '@/lib/domain/library';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from './audit';
import type { PlatformActor } from './manage-platform-libraries';

const AUDIT_TARGET = 'library';

export interface EvalQuestionView {
  id: string;
  question: string;
  expectedSource: string | null;
  expectedText: string | null;
  /** `admin`: the platform's, scored. `owner`: the library owner's self-check, asked but not scored until adopted. */
  author: 'owner' | 'admin';
  /** Null until the question has been asked once. */
  lastEvaluatedAt: Date | null;
  /** 1-based; null with a `lastEvaluatedAt` is a miss. */
  lastRank: number | null;
  /** False when the last run was against a version that is no longer current. */
  lastRunIsCurrent: boolean;
}

export interface LibraryBenchmarkView {
  questions: EvalQuestionView[];
  limits: { min: number; max: number; topK: number };
  /** The newest score row, or null before the first build. */
  score: {
    benchmarkScore: number;
    /** The Benchmark before the test set; equals it when unevaluated. */
    structural: number;
    /** Null when that score was computed without a test set. */
    evaluation: { questions: number; hits: number; hitRate: number } | null;
    computedAt: Date;
  } | null;
}

export async function getLibraryBenchmark(libraryId: string): Promise<LibraryBenchmarkView | null> {
  if (!isUuid(libraryId)) return null;
  const database = db();
  const [library] = await database
    .select({ currentVersionId: schema.library.currentVersionId })
    .from(schema.library)
    .where(and(eq(schema.library.id, libraryId), isNull(schema.library.deletedAt)));
  if (!library) return null;

  const [rows, [score]] = await Promise.all([
    database
      .select()
      .from(schema.libraryEvalQuestion)
      .where(eq(schema.libraryEvalQuestion.libraryId, libraryId))
      .orderBy(asc(schema.libraryEvalQuestion.createdAt)),
    database
      .select({
        benchmarkScore: schema.libraryScore.benchmarkScore,
        breakdown: schema.libraryScore.breakdown,
        computedAt: schema.libraryScore.computedAt,
      })
      .from(schema.libraryScore)
      .where(eq(schema.libraryScore.libraryId, libraryId))
      .orderBy(desc(schema.libraryScore.computedAt))
      .limit(1),
  ]);

  return {
    questions: rows.map((row) => ({
      id: row.id,
      question: row.question,
      expectedSource: row.expectedSource,
      expectedText: row.expectedText,
      author: row.author === 'owner' ? 'owner' : 'admin',
      lastEvaluatedAt: row.lastEvaluatedAt,
      lastRank: row.lastRank,
      lastRunIsCurrent:
        row.lastVersionId !== null && row.lastVersionId === library.currentVersionId,
    })),
    limits: { min: EVAL_MIN_QUESTIONS, max: EVAL_MAX_QUESTIONS, topK: EVAL_TOP_K },
    score: score
      ? {
          benchmarkScore: score.benchmarkScore,
          structural: score.breakdown.structural ?? score.benchmarkScore,
          evaluation:
            typeof score.breakdown.evalQuestions === 'number'
              ? {
                  questions: score.breakdown.evalQuestions,
                  hits: score.breakdown.evalHits ?? 0,
                  hitRate: score.breakdown.evalHitRate ?? 0,
                }
              : null,
          computedAt: score.computedAt,
        }
      : null,
  };
}

export async function addEvalQuestion(input: {
  actor: PlatformActor;
  libraryId: string;
  question: string;
  expectedSource?: string | null;
  expectedText?: string | null;
}): Promise<{ questionId: string }> {
  const drafted = draftEvalQuestion(input);
  if (!drafted.ok) {
    throw new PlatformLibraryRefused('eval_question_invalid', drafted.refusal);
  }
  const database = db();
  const target = await loadLibrary(database, input.libraryId);

  const [existing] = await database
    .select({ total: count() })
    .from(schema.libraryEvalQuestion)
    .where(eq(schema.libraryEvalQuestion.libraryId, target.id));
  if ((existing?.total ?? 0) >= EVAL_MAX_QUESTIONS) {
    throw new PlatformLibraryRefused('eval_question_limit', 'the test set is full');
  }

  const questionId = uuidv7();
  await database.insert(schema.libraryEvalQuestion).values({
    id: questionId,
    libraryId: target.id,
    author: 'admin',
    ...drafted.draft,
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'library.eval_question_add',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    afterValue: { publicId: target.publicId, questionId, ...drafted.draft },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { questionId };
}

/**
 * Adopt an owner's question into the scored set (review-visibility-
 * proposal.md 5.2): the one way an owner's question starts moving the
 * Benchmark, and a reviewer's decision, so it is audited like the rest.
 * Idempotent on a question already the platform's.
 */
export async function adoptEvalQuestion(input: {
  actor: PlatformActor;
  libraryId: string;
  questionId: string;
}): Promise<void> {
  const database = db();
  const target = await loadLibrary(database, input.libraryId);
  if (!isUuid(input.questionId)) throw new PlatformLibraryRefused('not_found', 'no such question');
  const [adopted] = await database
    .update(schema.libraryEvalQuestion)
    .set({ author: 'admin' })
    .where(
      and(
        eq(schema.libraryEvalQuestion.id, input.questionId),
        eq(schema.libraryEvalQuestion.libraryId, target.id),
      ),
    )
    .returning({ id: schema.libraryEvalQuestion.id, question: schema.libraryEvalQuestion.question });
  if (!adopted) throw new PlatformLibraryRefused('not_found', 'no such question');

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'library.eval_question_adopt',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    afterValue: { publicId: target.publicId, questionId: adopted.id, question: adopted.question },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}

export async function removeEvalQuestion(input: {
  actor: PlatformActor;
  libraryId: string;
  questionId: string;
}): Promise<void> {
  const database = db();
  const target = await loadLibrary(database, input.libraryId);
  if (!isUuid(input.questionId)) {
    throw new PlatformLibraryRefused('not_found', 'no such question');
  }

  /* Scoped to the library, so a question id from another library is not found. */
  const [removed] = await database
    .delete(schema.libraryEvalQuestion)
    .where(
      and(
        eq(schema.libraryEvalQuestion.id, input.questionId),
        eq(schema.libraryEvalQuestion.libraryId, target.id),
      ),
    )
    .returning({
      question: schema.libraryEvalQuestion.question,
      expectedSource: schema.libraryEvalQuestion.expectedSource,
      expectedText: schema.libraryEvalQuestion.expectedText,
    });
  if (!removed) throw new PlatformLibraryRefused('not_found', 'no such question');

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'library.eval_question_remove',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    beforeValue: { publicId: target.publicId, questionId: input.questionId, ...removed },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}

export interface EvaluationRunResult {
  questions: number;
  hits: number;
  benchmarkScore: number;
  previousBenchmarkScore: number;
}

/**
 * Asks the current version its test set now and appends a score row.
 *
 * Runs inline: it is at most `EVAL_MAX_QUESTIONS` retrievals over one version,
 * seconds rather than a crawl, so the number the console reports is the real
 * one.
 */
export async function runLibraryEvaluation(input: {
  actor: PlatformActor;
  libraryId: string;
  dependencies?: EvaluationDependencies;
}): Promise<EvaluationRunResult> {
  const database = db();
  const target = await loadLibrary(database, input.libraryId);
  if (!target.currentVersionId) {
    throw new PlatformLibraryRefused('no_version', 'nothing has been built to evaluate');
  }

  const outcome = await evaluateLibrary(target.id, input.dependencies);
  /* No questions, or the retrieval could not be run; the log says which. */
  if (!outcome) {
    throw new PlatformLibraryRefused('eval_unavailable', 'the test set could not be run');
  }

  const result: EvaluationRunResult = {
    questions: outcome.evaluation.questions,
    hits: outcome.evaluation.hits,
    benchmarkScore: outcome.benchmarkScore,
    previousBenchmarkScore: outcome.previousBenchmarkScore,
  };

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'library.benchmark_evaluate',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    beforeValue: { publicId: target.publicId, benchmarkScore: result.previousBenchmarkScore },
    afterValue: { publicId: target.publicId, versionId: target.currentVersionId, ...result },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return result;
}

async function loadLibrary(database: ReturnType<typeof db>, libraryId: string) {
  if (!isUuid(libraryId)) throw new PlatformLibraryRefused('not_found', 'no such library');
  const [row] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      currentVersionId: schema.library.currentVersionId,
      deletedAt: schema.library.deletedAt,
    })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .limit(1);
  if (!row || row.deletedAt) throw new PlatformLibraryRefused('not_found', 'no such library');
  return row;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
