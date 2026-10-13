/**
 * A library's test set, and what it does to the Benchmark Score.
 * requirement.md 6.3.
 *
 * Until this existed the Benchmark was made of what a build can count --
 * documents, chunks, citations, duplicates -- and none of that says whether a
 * question finds its answer. The count terms also grow with the corpus, so the
 * score rewarded size. A test set is the only input that measures retrieval
 * itself: questions somebody wrote down together with where the answer is, put
 * to the library through the same recall, fusion and rerank a caller's
 * question goes through (retrieval/rank.ts).
 *
 * Pure rules only. Running the questions is ingestion/evaluate.ts.
 */

/** A question hits when its answer is among this many returned passages. */
export const EVAL_TOP_K = 5;

/**
 * Below this many questions a hit rate is an anecdote, and the score stays
 * structural: one lucky question must not be worth sixty points.
 */
export const EVAL_MIN_QUESTIONS = 5;

/** Per library. Each question costs one query embedding on every build. */
export const EVAL_MAX_QUESTIONS = 50;

export const EVAL_LIMITS = { question: 500, expectation: 300 } as const;

/** How much of an evaluated Benchmark is the hit rate; the rest is structural. */
export const EVAL_WEIGHT = 0.6;

/**
 * Where the answer is. At least one is set, and every one that is set must
 * hold of the same passage.
 *
 * `expectedSource` is matched against the passage's citation -- its source URL
 * and document title -- so `guides/install` or `Installation` both name a
 * page without pinning a host that a version label may change.
 * `expectedText` is matched against the passage body, for an answer that is a
 * specific string: a field name, a version number, a flag.
 */
export interface EvalExpectation {
  expectedSource: string | null;
  expectedText: string | null;
}

export interface EvalPassage {
  text: string;
  sourceUrl: string;
  documentTitle: string;
}

export interface EvalQuestionDraft extends EvalExpectation {
  question: string;
}

export type EvalDraftRefusal = 'question_required' | 'expectation_required' | 'too_long';

/** Validates what an operator typed. Returns the refusal instead of throwing. */
export function draftEvalQuestion(input: {
  question: string;
  expectedSource?: string | null;
  expectedText?: string | null;
}): { ok: true; draft: EvalQuestionDraft } | { ok: false; refusal: EvalDraftRefusal } {
  const question = input.question.trim();
  const expectedSource = input.expectedSource?.trim() || null;
  const expectedText = input.expectedText?.trim() || null;

  if (question.length === 0) return { ok: false, refusal: 'question_required' };
  if (!expectedSource && !expectedText) return { ok: false, refusal: 'expectation_required' };
  if (
    question.length > EVAL_LIMITS.question ||
    (expectedSource?.length ?? 0) > EVAL_LIMITS.expectation ||
    (expectedText?.length ?? 0) > EVAL_LIMITS.expectation
  ) {
    return { ok: false, refusal: 'too_long' };
  }
  return { ok: true, draft: { question, expectedSource, expectedText } };
}

/** Case and runs of whitespace are not part of an answer. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The 1-based rank of the first passage that satisfies the expectation, among
 * the first `EVAL_TOP_K`. Null is a miss.
 */
export function hitRank(expectation: EvalExpectation, passages: EvalPassage[]): number | null {
  const source = expectation.expectedSource ? normalize(expectation.expectedSource) : null;
  const text = expectation.expectedText ? normalize(expectation.expectedText) : null;
  if (!source && !text) return null;

  const head = passages.slice(0, EVAL_TOP_K);
  for (let index = 0; index < head.length; index += 1) {
    const passage = head[index]!;
    const sourceHolds =
      source === null ||
      normalize(passage.sourceUrl).includes(source) ||
      normalize(passage.documentTitle).includes(source);
    const textHolds = text === null || normalize(passage.text).includes(text);
    if (sourceHolds && textHolds) return index + 1;
  }
  return null;
}

export interface EvaluationSummary {
  questions: number;
  hits: number;
  /** 0-1. */
  hitRate: number;
  /** Mean reciprocal rank, 0-1: a hit at rank 1 is worth more than one at 5. */
  mrr: number;
}

export function summarizeEvaluation(ranks: (number | null)[]): EvaluationSummary {
  const hits = ranks.filter((rank): rank is number => rank !== null);
  return {
    questions: ranks.length,
    hits: hits.length,
    hitRate: ranks.length === 0 ? 0 : hits.length / ranks.length,
    mrr: ranks.length === 0 ? 0 : hits.reduce((total, rank) => total + 1 / rank, 0) / ranks.length,
  };
}

/** Whether a summary is enough questions to move the score. */
export function evaluationCounts(evaluation: EvaluationSummary | null | undefined): boolean {
  return !!evaluation && evaluation.questions >= EVAL_MIN_QUESTIONS;
}

/**
 * The Benchmark, given the structural score and a test-set result.
 *
 * Without a usable test set the structural score stands unchanged: a library
 * nobody has written questions for is not thereby worse, and re-scoring every
 * existing library downward on the day this shipped would have been a penalty
 * for something no owner had been asked to do.
 */
export function blendBenchmark(
  structural: number,
  evaluation: EvaluationSummary | null | undefined,
): number {
  if (!evaluation || !evaluationCounts(evaluation)) return structural;
  const blended = (1 - EVAL_WEIGHT) * structural + EVAL_WEIGHT * evaluation.hitRate * 100;
  return Math.max(0, Math.min(100, Math.round(blended)));
}
