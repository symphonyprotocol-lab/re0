/**
 * The rules layer of public review (lib/domain/auto-review.ts) and the
 * content sketch it checks duplicates with (lib/domain/fingerprint.ts).
 * review-visibility-proposal.md 6.1.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_RULES,
  describeReviewNote,
  drawnForSample,
  REVIEW_RULE_BOUNDS,
  ReviewRulesRefused,
  rulesNote,
  rulesReasonOf,
  rulesVerdict,
  validateReviewRules,
  type RulesFacts,
} from '@/lib/domain/auto-review';
import { contentSketch, fingerprint, sketchSimilarity } from '@/lib/domain/fingerprint';
import { parseRightsDeclaration } from '@/lib/domain/rights';

const rights = parseRightsDeclaration(
  { origin: 'own', license: 'open_source', generation: 'human' },
  { userId: 'u', now: new Date('2026-10-21T00:00:00Z') },
)!;

/** A submission that clears everything: what a reviewer would only confirm. */
const clean: RulesFacts = {
  hasReadyVersion: true,
  chunks: 120,
  quarantinedFiles: 0,
  flaggedFiles: 0,
  trustScore: 70,
  benchmarkScore: 65,
  sourceType: 'website',
  sourceVerified: true,
  hasLicense: false,
  rights,
  questions: 6,
  ownerHitRate: 83,
  duplicateSimilarity: 4,
  duplicateOf: null,
  priorPublicLibraries: 2,
};

describe('rulesVerdict', () => {
  it('publishes a submission that clears every condition, with a checklist of passes', () => {
    const verdict = rulesVerdict(clean, DEFAULT_REVIEW_RULES);
    expect(verdict.decision).toBe('publish');
    expect(verdict.reasons).toEqual(['auto_approved']);
    expect(Object.values(verdict.checklist).every((item) => item.verdict === 'pass')).toBe(true);
  });

  it('sends back on a hard gate, naming the failed check', () => {
    const quarantined = rulesVerdict({ ...clean, quarantinedFiles: 1 }, DEFAULT_REVIEW_RULES);
    expect(quarantined.decision).toBe('send_back');
    expect(quarantined.reasons).toEqual(['quarantined']);
    expect(quarantined.checklist.safety).toEqual({ verdict: 'fail', note: rulesNote('quarantined') });
    expect(quarantined.checklist.structure.verdict).toBe('unsure');

    const empty = rulesVerdict({ ...clean, chunks: 0 }, DEFAULT_REVIEW_RULES);
    expect(empty.reasons).toEqual(['no_index']);
    expect(empty.checklist.structure.verdict).toBe('fail');

    const copy = rulesVerdict({ ...clean, duplicateSimilarity: 60, duplicateOf: '/x/y' }, DEFAULT_REVIEW_RULES);
    expect(copy.reasons).toEqual(['duplicate']);
    expect(copy.checklist.source_firsthand.verdict).toBe('fail');

    const unlicensed = rulesVerdict({ ...clean, sourceType: 'github' }, DEFAULT_REVIEW_RULES);
    expect(unlicensed.reasons).toEqual(['no_license']);
    expect(rulesVerdict({ ...clean, sourceType: 'github', hasLicense: true }, DEFAULT_REVIEW_RULES).decision).toBe('publish');
    expect(
      rulesVerdict({ ...clean, sourceType: 'github', rights: { ...rights, license: 'granted' } }, DEFAULT_REVIEW_RULES).decision,
    ).toBe('publish');

    expect(rulesVerdict({ ...clean, rights: null }, DEFAULT_REVIEW_RULES).reasons).toEqual(['rights_missing']);
    expect(rulesVerdict({ ...clean, rights: { ...rights, generation: 'generated' } }, DEFAULT_REVIEW_RULES).reasons).toEqual([
      'rights_generated',
    ]);
    /* A small or absent question set is no longer a gate (2026-10-23). */
    expect(rulesVerdict({ ...clean, questions: 4 }, DEFAULT_REVIEW_RULES).decision).toBe('publish');
  });

  it('leaves a library that brought no questions to the model layer', () => {
    const verdict = rulesVerdict({ ...clean, questions: 0, ownerHitRate: null }, DEFAULT_REVIEW_RULES);
    expect(verdict.decision).toBe('hold');
    expect(verdict.reasons).toEqual(['no_questions']);
  });

  it('publishes a verified source on its question set alone, whatever the scores say', () => {
    const verified = { ...clean, flaggedFiles: 2, trustScore: 10, benchmarkScore: 5, priorPublicLibraries: 0 };
    expect(rulesVerdict(verified, DEFAULT_REVIEW_RULES).decision).toBe('publish');
    expect(rulesVerdict({ ...verified, ownerHitRate: null }, DEFAULT_REVIEW_RULES).reasons).toEqual(['hit_rate_unknown']);
    expect(rulesVerdict({ ...verified, ownerHitRate: 49 }, DEFAULT_REVIEW_RULES).reasons).toEqual(['hit_rate_low']);
  });

  it('publishes an unverified source only when the full list is met, and otherwise holds it saying which', () => {
    const unverified: RulesFacts = { ...clean, sourceVerified: false, sourceType: 'pdf' };
    expect(rulesVerdict(unverified, DEFAULT_REVIEW_RULES).decision).toBe('publish');
    expect(rulesVerdict(unverified, DEFAULT_REVIEW_RULES).reasons).toEqual(['auto_approved']);
    expect(rulesVerdict({ ...unverified, sourceType: 'notion' }, DEFAULT_REVIEW_RULES).decision).toBe('publish');
    const cases: [Partial<RulesFacts>, string][] = [
      [{ flaggedFiles: 2 }, 'flagged_files'],
      [{ trustScore: 39 }, 'trust_low'],
      [{ trustScore: null }, 'trust_low'],
      [{ benchmarkScore: 29 }, 'benchmark_low'],
      [{ priorPublicLibraries: 0 }, 'first_public_library'],
    ];
    for (const [change, reason] of cases) {
      const verdict = rulesVerdict({ ...unverified, ...change }, DEFAULT_REVIEW_RULES);
      expect(verdict.decision).toBe('hold');
      expect(verdict.reasons).toEqual([reason]);
    }
    expect(rulesVerdict({ ...unverified, ownerHitRate: 49 }, DEFAULT_REVIEW_RULES).reasons).toEqual(['hit_rate_low']);
    expect(rulesVerdict({ ...unverified, ownerHitRate: null }, DEFAULT_REVIEW_RULES).reasons).toEqual(['hit_rate_unknown']);
    const held = rulesVerdict({ ...unverified, flaggedFiles: 2 }, DEFAULT_REVIEW_RULES);
    expect(held.checklist.safety.verdict).toBe('unsure');
    expect(held.checklist.structure.verdict).toBe('pass');
  });

  it('holds everything when auto-publish is off, and still sends back on a gate', () => {
    const off = { ...DEFAULT_REVIEW_RULES, autoPublish: 0 };
    expect(rulesVerdict(clean, off).decision).toBe('hold');
    expect(rulesVerdict(clean, off).reasons).toEqual(['auto_publish_off']);
    expect(rulesVerdict({ ...clean, quarantinedFiles: 1 }, off).decision).toBe('send_back');
  });

  it('draws samples by the configured share', () => {
    expect(drawnForSample({ ...DEFAULT_REVIEW_RULES, sampleRate: 10 }, 0.05)).toBe(true);
    expect(drawnForSample({ ...DEFAULT_REVIEW_RULES, sampleRate: 10 }, 0.1)).toBe(false);
    expect(drawnForSample({ ...DEFAULT_REVIEW_RULES, sampleRate: 0 }, 0)).toBe(false);
  });
});

describe('validateReviewRules', () => {
  it('accepts every key within bounds and refuses the rest', () => {
    expect(validateReviewRules(DEFAULT_REVIEW_RULES)).toEqual(DEFAULT_REVIEW_RULES);
    expect(() => validateReviewRules({ ...DEFAULT_REVIEW_RULES, trustMin: 101 })).toThrow(ReviewRulesRefused);
    expect(() => validateReviewRules({ ...DEFAULT_REVIEW_RULES, autoPublish: 2 })).toThrow(ReviewRulesRefused);
    expect(() => validateReviewRules({ ...DEFAULT_REVIEW_RULES, sampleRate: undefined })).toThrow(ReviewRulesRefused);
    expect(() => validateReviewRules({ ...DEFAULT_REVIEW_RULES, duplicateMax: 1.5 })).toThrow(ReviewRulesRefused);
    expect(REVIEW_RULE_BOUNDS.duplicateMax.min).toBeGreaterThan(0);
  });
});

describe('review notes', () => {
  it('carries a reason through a note and back, and reads a person’s words as written', () => {
    expect(rulesReasonOf(rulesNote('duplicate'))).toBe('duplicate');
    expect(rulesReasonOf('rules:nonsense')).toBeNull();
    expect(rulesReasonOf('add a licence')).toBeNull();
    expect(describeReviewNote(rulesNote('duplicate'), { duplicate: 'copies a published library' })).toBe('copies a published library');
    expect(describeReviewNote('add a licence', { duplicate: 'x' })).toBe('add a licence');
  });
});

describe('content sketch', () => {
  const corpus = Array.from({ length: 300 }, (_, at) => `Paragraph ${at}: the quick brown fox number ${at} jumps.`);

  it('hashes deterministically and ignores case, punctuation and whitespace runs', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    expect(contentSketch(['Hello,  World!'])).toEqual(contentSketch(['hello world']));
    expect(contentSketch([])).toEqual([]);
  });

  it('scores a copy near 100, a half overlap near 50, and unrelated text near 0', () => {
    const a = contentSketch(corpus);
    expect(sketchSimilarity(a, contentSketch([...corpus]))).toBe(100);
    const half = contentSketch([...corpus.slice(0, 150), ...corpus.slice(0, 150).map((line) => `${line} other`)]);
    const overlap = sketchSimilarity(a, half);
    expect(overlap).toBeGreaterThan(20);
    expect(overlap).toBeLessThan(50);
    const other = contentSketch(corpus.map((line) => `${line} entirely different ending`));
    expect(sketchSimilarity(a, other)).toBe(0);
    expect(sketchSimilarity(a, [])).toBe(0);
  });
});
