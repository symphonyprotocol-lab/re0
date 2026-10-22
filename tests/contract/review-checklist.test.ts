/**
 * The public-review checklist (lib/domain/review.ts): requirement.md 7.4's
 * five checks as a form posts them, what a decision may carry, and what the
 * owner is shown.
 */
import { describe, expect, it } from 'vitest';
import {
  checklistAllows,
  checklistFeedback,
  checklistRequired,
  failingChecks,
  parseReviewChecklist,
  readReviewChecklist,
  REVIEW_CHECK_NOTE_MAX_LENGTH,
  REVIEW_CHECKS,
  type ReviewChecklist,
} from '@/lib/domain/review';

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

function allPassing(): Record<string, string> {
  return Object.fromEntries(REVIEW_CHECKS.map((check) => [`check.${check}`, 'pass']));
}

describe('parseReviewChecklist', () => {
  it('reads every check from a form, trimming notes', () => {
    const parsed = parseReviewChecklist(form({ ...allPassing(), 'check.safety': 'unsure', 'note.safety': '  two flagged pages  ' }));
    expect(parsed).not.toBeNull();
    expect(parsed!.safety).toEqual({ verdict: 'unsure', note: 'two flagged pages' });
    expect(parsed!.source_firsthand).toEqual({ verdict: 'pass', note: '' });
  });

  it('reads the same shape from an object', () => {
    const parsed = parseReviewChecklist({ ...allPassing(), 'check.structure': 'fail', 'note.structure': 'broken links' });
    expect(parsed?.structure).toEqual({ verdict: 'fail', note: 'broken links' });
  });

  it('refuses a missing check, an unknown verdict, and an oversized note', () => {
    const missing = { ...allPassing() };
    delete missing['check.completeness'];
    expect(parseReviewChecklist(form(missing))).toBeNull();
    expect(parseReviewChecklist(form({ ...allPassing(), 'check.safety': 'maybe' }))).toBeNull();
    expect(
      parseReviewChecklist(form({ ...allPassing(), 'note.safety': 'x'.repeat(REVIEW_CHECK_NOTE_MAX_LENGTH + 1) })),
    ).toBeNull();
    expect(parseReviewChecklist(null)).toBeNull();
    expect(parseReviewChecklist('pass')).toBeNull();
  });
});

describe('checklistAllows', () => {
  const passing = parseReviewChecklist(allPassing())!;
  const failing = parseReviewChecklist({ ...allPassing(), 'check.source_firsthand': 'fail' })!;
  const unsure = parseReviewChecklist({ ...allPassing(), 'check.completeness': 'unsure' })!;

  it('lets an approval through only without a failed check', () => {
    expect(checklistAllows('approve', passing)).toBe(true);
    expect(checklistAllows('approve', unsure)).toBe(true);
    expect(checklistAllows('approve', failing)).toBe(false);
  });

  it('needs a failed check to send back or reject', () => {
    expect(checklistAllows('request_changes', failing)).toBe(true);
    expect(checklistAllows('reject', failing)).toBe(true);
    expect(checklistAllows('request_changes', passing)).toBe(false);
    expect(checklistAllows('reject', unsure)).toBe(false);
  });

  it('is required for a public library only', () => {
    expect(checklistRequired('public')).toBe(true);
    expect(checklistRequired('private')).toBe(false);
  });
});

describe('feedback and storage', () => {
  it('lists failed checks before unsure ones, in 7.4 order', () => {
    const checklist = parseReviewChecklist({
      ...allPassing(),
      'check.safety': 'fail',
      'note.safety': 'a key in chapter 2',
      'check.source_firsthand': 'unsure',
      'check.structure': 'fail',
    })!;
    expect(failingChecks(checklist)).toEqual(['structure', 'safety']);
    expect(checklistFeedback(checklist).map((line) => [line.check, line.verdict])).toEqual([
      ['structure', 'fail'],
      ['safety', 'fail'],
      ['source_firsthand', 'unsure'],
    ]);
    expect(checklistFeedback(checklist)[1]?.note).toBe('a key in chapter 2');
  });

  it('reads a stored checklist back, and nothing from an older or broken row', () => {
    const checklist = parseReviewChecklist(allPassing())!;
    const stored: unknown = JSON.parse(JSON.stringify(checklist));
    expect(readReviewChecklist(stored)).toEqual(checklist satisfies ReviewChecklist);
    expect(readReviewChecklist(null)).toBeNull();
    expect(readReviewChecklist({ safety: { verdict: 'pass', note: '' } })).toBeNull();
    expect(readReviewChecklist({ ...checklist, safety: { verdict: 'no', note: '' } })).toBeNull();
  });
});
