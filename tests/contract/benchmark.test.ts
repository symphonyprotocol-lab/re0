/**
 * The test-set rules behind the Benchmark Score. requirement.md 6.3.
 *
 * What is pinned here is what the score now claims: that a question hits only
 * when its answer is where the question says it is, near the top; that a
 * handful of questions cannot swing the number; and that a library nobody has
 * written questions for scores exactly as it did before the test set existed.
 */
import { describe, expect, it } from 'vitest';
import {
  blendBenchmark,
  draftEvalQuestion,
  EVAL_LIMITS,
  EVAL_MIN_QUESTIONS,
  EVAL_TOP_K,
  hitRank,
  summarizeEvaluation,
  type EvalPassage,
} from '@/lib/domain/benchmark';
import { scoreLibrary, type ScoreInputs } from '@/lib/domain/ingestion';

const passage = (overrides: Partial<EvalPassage> = {}): EvalPassage => ({
  text: 'Run the installer, then restart the daemon.',
  sourceUrl: 'https://example.test/docs/guides/install',
  documentTitle: 'Installation',
  ...overrides,
});

describe('draftEvalQuestion', () => {
  it('needs a question and somewhere the answer is', () => {
    expect(draftEvalQuestion({ question: '  ', expectedText: 'x' })).toEqual({
      ok: false,
      refusal: 'question_required',
    });
    expect(draftEvalQuestion({ question: 'How do I install?', expectedSource: ' ' })).toEqual({
      ok: false,
      refusal: 'expectation_required',
    });
  });

  it('trims, and stores an empty expectation as absent', () => {
    expect(
      draftEvalQuestion({ question: ' How? ', expectedSource: ' guides/install ', expectedText: '' }),
    ).toEqual({
      ok: true,
      draft: { question: 'How?', expectedSource: 'guides/install', expectedText: null },
    });
  });

  it('refuses over-long input rather than truncating a question', () => {
    const drafted = draftEvalQuestion({
      question: 'q'.repeat(EVAL_LIMITS.question + 1),
      expectedText: 'x',
    });
    expect(drafted).toEqual({ ok: false, refusal: 'too_long' });
  });
});

describe('hitRank', () => {
  it('matches the source against the url or the document title, ignoring case', () => {
    const passages = [passage({ sourceUrl: 'https://example.test/other', documentTitle: 'Other' }), passage()];
    expect(hitRank({ expectedSource: 'Guides/Install', expectedText: null }, passages)).toBe(2);
    expect(hitRank({ expectedSource: 'installation', expectedText: null }, passages)).toBe(2);
  });

  it('matches text against the body across differing whitespace', () => {
    expect(
      hitRank({ expectedSource: null, expectedText: 'restart   the\ndaemon' }, [passage()]),
    ).toBe(1);
  });

  it('wants both expectations of the same passage', () => {
    const passages = [
      passage({ text: 'Unrelated.' }),
      passage({ sourceUrl: 'https://example.test/other', documentTitle: 'Other' }),
    ];
    // The source is right in the first and the text in the second: no one
    // passage is the answer, so this is a miss.
    expect(
      hitRank({ expectedSource: 'guides/install', expectedText: 'restart the daemon' }, passages),
    ).toBeNull();
  });

  it('does not count an answer below the top K', () => {
    const passages = [
      ...Array.from({ length: EVAL_TOP_K }, () => passage({ text: 'Filler.' })),
      passage(),
    ];
    expect(hitRank({ expectedSource: null, expectedText: 'restart the daemon' }, passages)).toBeNull();
  });

  it('is a miss with no expectation at all, never a free hit', () => {
    expect(hitRank({ expectedSource: null, expectedText: null }, [passage()])).toBeNull();
  });
});

describe('summarizeEvaluation', () => {
  it('counts hits and weighs rank into the reciprocal mean', () => {
    const summary = summarizeEvaluation([1, 2, null, null]);
    expect(summary).toMatchObject({ questions: 4, hits: 2, hitRate: 0.5 });
    expect(summary.mrr).toBeCloseTo((1 + 0.5) / 4);
  });

  it('is all zeroes for no questions', () => {
    expect(summarizeEvaluation([])).toEqual({ questions: 0, hits: 0, hitRate: 0, mrr: 0 });
  });
});

describe('blendBenchmark', () => {
  const evaluated = (hits: number, questions: number) =>
    summarizeEvaluation(Array.from({ length: questions }, (_, i) => (i < hits ? 1 : null)));

  it('leaves the structural score alone without a test set', () => {
    expect(blendBenchmark(72, null)).toBe(72);
    expect(blendBenchmark(72, undefined)).toBe(72);
  });

  it('ignores a test set too small to mean anything', () => {
    expect(blendBenchmark(72, evaluated(0, EVAL_MIN_QUESTIONS - 1))).toBe(72);
  });

  it('moves with the hit rate once there are enough questions', () => {
    expect(blendBenchmark(50, evaluated(10, 10))).toBe(80);
    expect(blendBenchmark(50, evaluated(5, 10))).toBe(50);
    expect(blendBenchmark(50, evaluated(0, 10))).toBe(20);
  });
});

describe('scoreLibrary with a test set', () => {
  const base: ScoreInputs = {
    verified: false,
    isPlatformLibrary: true,
    documents: 40,
    chunks: 800,
    duplicateRatio: 0,
    citedRatio: 1,
    flaggedChunks: 0,
    ageDays: 5,
    hasLicense: true,
  };

  it('reports the structural score, and equals it when unevaluated', () => {
    const scores = scoreLibrary(base);
    expect(scores.benchmark).toBe(scores.structural);
  });

  it('lets a small library that answers its questions outrank a large one that does not', () => {
    // The fault this exists to fix: size alone used to win.
    const small = scoreLibrary({
      ...base,
      documents: 3,
      chunks: 30,
      evaluation: summarizeEvaluation(Array(10).fill(1)),
    });
    const large = scoreLibrary({
      ...base,
      documents: 4_000,
      chunks: 90_000,
      evaluation: summarizeEvaluation(Array(10).fill(null)),
    });
    expect(small.structural).toBeLessThan(large.structural);
    expect(small.benchmark).toBeGreaterThan(large.benchmark);
  });

  it('does not let the test set touch Trust', () => {
    const evaluated = scoreLibrary({ ...base, evaluation: summarizeEvaluation(Array(10).fill(null)) });
    expect(evaluated.trust).toBe(scoreLibrary(base).trust);
  });
});
