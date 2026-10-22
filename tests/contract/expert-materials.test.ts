/**
 * The expert application's materials, evaluation gate, checklist and
 * sampled questions (lib/domain/expert-library.ts).
 * review-visibility-proposal.md 5.3 and 6.5.
 */
import { describe, expect, it } from 'vitest';
import {
  applicationBlocker,
  approvalChecks,
  EXPERT_MATERIAL_LIMITS,
  EXPERT_REVIEW_CHECKS,
  expertChecklistAllows,
  expertEarning,
  expertEvalReady,
  expertHitRate,
  parseExpertChecklist,
  parseExpertMaterials,
  readExpertChecklist,
  readExpertMaterials,
  sampleExpertQuestions,
  type ExpertCandidate,
} from '@/lib/domain/expert-library';

const candidate: ExpertCandidate = {
  visibility: 'public',
  lifecycleStatus: 'published',
  ownerSubscribed: true,
  expertTaggedAt: null,
  evalReady: true,
};
const now = new Date('2026-10-21T00:00:00Z');

describe('materials', () => {
  const full = { scope: ' the 2.x API ', maintenance: 'monthly', credentials: 'the docs team', note: '' };

  it('requires the three statements and keeps the note optional', () => {
    expect(parseExpertMaterials(full)).toEqual({ scope: 'the 2.x API', maintenance: 'monthly', credentials: 'the docs team', note: '' });
    expect(parseExpertMaterials({ ...full, note: 'extra' })?.note).toBe('extra');
    expect(parseExpertMaterials({ ...full, credentials: '  ' })).toBeUndefined();
    expect(parseExpertMaterials({ ...full, scope: undefined })).toBeUndefined();
    expect(parseExpertMaterials({ ...full, maintenance: 'x'.repeat(EXPERT_MATERIAL_LIMITS.maintenance + 1) })).toBeUndefined();
    expect(parseExpertMaterials({ ...full, scope: 'a\u0000b' })).toBeUndefined();
  });

  it('reads a stored statement back and nothing from an older application', () => {
    const parsed = parseExpertMaterials(full)!;
    expect(readExpertMaterials(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(readExpertMaterials(null)).toBeNull();
    expect(readExpertMaterials({})).toBeNull();
  });
});

describe('evaluation gate', () => {
  const rules = { minQuestions: 10, minHitRate: 70 };

  it('needs enough questions, all asked of the current version, and enough answered', () => {
    expect(expertEvalReady({ questions: 10, evaluatedOnCurrent: 10, hitsOnCurrent: 7 }, rules)).toBe(true);
    expect(expertEvalReady({ questions: 9, evaluatedOnCurrent: 9, hitsOnCurrent: 9 }, rules)).toBe(false);
    expect(expertEvalReady({ questions: 10, evaluatedOnCurrent: 8, hitsOnCurrent: 8 }, rules)).toBe(false);
    expect(expertEvalReady({ questions: 10, evaluatedOnCurrent: 10, hitsOnCurrent: 6 }, rules)).toBe(false);
    expect(expertHitRate({ questions: 10, evaluatedOnCurrent: 10, hitsOnCurrent: 6 })).toBe(60);
    expect(expertHitRate({ questions: 10, evaluatedOnCurrent: 0, hitsOnCurrent: 0 })).toBeNull();
  });

  it('is waived by a zero floor, and then passes an empty set', () => {
    expect(expertEvalReady({ questions: 0, evaluatedOnCurrent: 0, hitsOnCurrent: 0 }, { minQuestions: 0, minHitRate: 70 })).toBe(true);
    expect(expertEvalReady({ questions: 0, evaluatedOnCurrent: 0, hitsOnCurrent: 0 }, rules)).toBe(false);
    expect(expertEvalReady({ questions: 3, evaluatedOnCurrent: 3, hitsOnCurrent: 1 }, { minQuestions: 0, minHitRate: 70 })).toBe(false);
  });

  it('blocks an application and an approval, but not the earning of a granted tag', () => {
    const notReady = { ...candidate, evalReady: false };
    expect(applicationBlocker({ candidate: notReady, hasPending: false, lastDecidedAt: null, now })).toBe('eval_not_ready');
    expect(applicationBlocker({ candidate, hasPending: false, lastDecidedAt: null, now })).toBeNull();
    expect(
      approvalChecks({ candidate: notReady, ownerWorkspaceId: 'w', applicantWorkspaceId: 'w', hasReadyVersion: true }).eval_ready,
    ).toBe(false);
    expect(expertEarning({ ...notReady, expertTaggedAt: now })).toBe(true);
  });
});

describe('expert checklist', () => {
  const allPass = Object.fromEntries(EXPERT_REVIEW_CHECKS.map((check) => [`check.${check}`, 'pass']));

  it('parses every item from a form shape and refuses a missing one', () => {
    const parsed = parseExpertChecklist({ ...allPass, 'check.sample_ok': 'fail', 'note.sample_ok': ' 2 of 4 missed ' })!;
    expect(parsed.sample_ok).toEqual({ verdict: 'fail', note: '2 of 4 missed' });
    const partial = { ...allPass };
    delete partial['check.usage_ok'];
    expect(parseExpertChecklist(partial)).toBeNull();
    expect(parseExpertChecklist({ ...allPass, 'check.usage_ok': 'maybe' })).toBeNull();
    expect(parseExpertChecklist(null)).toBeNull();
    expect(readExpertChecklist(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(readExpertChecklist({ scope_clear: { verdict: 'pass', note: '' } })).toBeNull();
  });

  it('lets an approval through only without a failure, and a rejection only with one', () => {
    const passing = parseExpertChecklist(allPass)!;
    const failing = parseExpertChecklist({ ...allPass, 'check.credentials_match': 'fail' })!;
    const unsure = parseExpertChecklist({ ...allPass, 'check.usage_ok': 'unsure' })!;
    expect(expertChecklistAllows('approve', passing)).toBe(true);
    expect(expertChecklistAllows('approve', unsure)).toBe(true);
    expect(expertChecklistAllows('approve', failing)).toBe(false);
    expect(expertChecklistAllows('reject', failing)).toBe(true);
    expect(expertChecklistAllows('reject', passing)).toBe(false);
  });
});

describe('sampled questions', () => {
  it('draws the same distinct questions for the same application, and all of a small set', () => {
    const first = sampleExpertQuestions(30, 'application-1');
    expect(first).toEqual(sampleExpertQuestions(30, 'application-1'));
    expect(first).toHaveLength(4);
    expect(new Set(first).size).toBe(4);
    expect(first.every((at) => at >= 0 && at < 30)).toBe(true);
    expect(sampleExpertQuestions(30, 'application-2')).not.toEqual(first);
    expect(sampleExpertQuestions(3, 'x')).toEqual([0, 1, 2]);
    expect(sampleExpertQuestions(0, 'x')).toEqual([]);
  });
});
