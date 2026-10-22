/**
 * The public-review checklist, as pure rules. requirement.md 7.4 and
 * review-visibility-proposal.md 4.3.
 *
 * A review used to be a verb and a sentence. The sentence told the owner
 * nothing about which of 7.4's five checks failed, and told the next
 * reviewer nothing about what the last one looked at. The checklist is the
 * five checks, each with a verdict and a note, recorded with the decision:
 * the owner reads which one failed, and the audit log keeps what was
 * judged. The verdicts also constrain the verb -- an approval cannot carry
 * a failed check, and a send-back has to name one -- so the form cannot say
 * one thing and the decision another.
 */
import type { UserReviewAction } from './library';

/** requirement.md 7.4, items 1 to 5, in its order. */
export const REVIEW_CHECKS = [
  'source_firsthand',
  'structure',
  'completeness',
  'safety',
  'score_threshold',
] as const;

export type ReviewCheck = (typeof REVIEW_CHECKS)[number];

export function isReviewCheck(value: unknown): value is ReviewCheck {
  return typeof value === 'string' && (REVIEW_CHECKS as readonly string[]).includes(value);
}

/** `unsure` is a verdict too: the reviewer looked and could not tell, which is not the same as not looking. */
export const REVIEW_VERDICTS = ['pass', 'fail', 'unsure'] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return typeof value === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(value);
}

export const REVIEW_CHECK_NOTE_MAX_LENGTH = 300;

/** A reviewer's probe is one question, trimmed, this long at most; the same bound a caller has. */
export const REVIEW_PROBE_MAX_LENGTH = 500;

export interface ReviewChecklistItem {
  verdict: ReviewVerdict;
  /** Why, in the reviewer's words; empty when the verdict speaks for itself. */
  note: string;
}

export type ReviewChecklist = Record<ReviewCheck, ReviewChecklistItem>;

/**
 * Only a public library is reviewed against the checklist. The same verbs
 * on a private library are a safety pause and its lifting
 * (lib/domain/library.ts `reviewActionAvailable`), decided on a reason
 * alone: there is no content a reviewer is meant to have read.
 */
export function checklistRequired(visibility: 'public' | 'private'): boolean {
  return visibility === 'public';
}

/**
 * The checklist as a form posts it: `check.<id>` for the verdict and
 * `note.<id>` for the note, or the same shape as an object. Null when a
 * check is missing or a verdict is not one of the three -- a decision with
 * half a checklist is refused, not recorded.
 */
export function parseReviewChecklist(input: unknown): ReviewChecklist | null {
  const read = readers(input);
  if (!read) return null;
  const checklist = {} as ReviewChecklist;
  for (const check of REVIEW_CHECKS) {
    const verdict = read(`check.${check}`);
    if (!isReviewVerdict(verdict)) return null;
    const note = read(`note.${check}`);
    const text = typeof note === 'string' ? note.trim() : '';
    if (text.length > REVIEW_CHECK_NOTE_MAX_LENGTH) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
    checklist[check] = { verdict, note: text };
  }
  return checklist;
}

function readers(input: unknown): ((key: string) => unknown) | null {
  if (typeof FormData !== 'undefined' && input instanceof FormData) {
    return (key) => input.get(key);
  }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    return (key) => record[key];
  }
  return null;
}

/**
 * A stored checklist read back without trusting its shape: a row written
 * before the checklist existed, or by a later shape, shows as none rather
 * than breaking the page.
 */
export function readReviewChecklist(stored: unknown): ReviewChecklist | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as Record<string, unknown>;
  const checklist = {} as ReviewChecklist;
  for (const check of REVIEW_CHECKS) {
    const item = record[check];
    if (!item || typeof item !== 'object') return null;
    const { verdict, note } = item as { verdict?: unknown; note?: unknown };
    if (!isReviewVerdict(verdict)) return null;
    checklist[check] = { verdict, note: typeof note === 'string' ? note : '' };
  }
  return checklist;
}

export function failingChecks(checklist: ReviewChecklist): ReviewCheck[] {
  return REVIEW_CHECKS.filter((check) => checklist[check].verdict === 'fail');
}

/**
 * Whether the verdicts agree with the verb. An approval with a failed check
 * is a contradiction; a send-back or a rejection without one gives the
 * owner nothing to fix. `unsure` blocks neither: a reviewer may approve
 * with a doubt noted, or send back on a failure while unsure elsewhere.
 */
export function checklistAllows(action: UserReviewAction, checklist: ReviewChecklist): boolean {
  const failing = failingChecks(checklist).length;
  return action === 'approve' ? failing === 0 : failing > 0;
}

/**
 * The owner's feedback lines, derived from the checklist: the failed
 * checks' notes, then the unsure ones' -- the things they can act on first.
 * The reviewer's own reason is kept beside these, not replaced by them.
 */
export function checklistFeedback(checklist: ReviewChecklist): { check: ReviewCheck; verdict: ReviewVerdict; note: string }[] {
  const lines: { check: ReviewCheck; verdict: ReviewVerdict; note: string }[] = [];
  for (const verdict of ['fail', 'unsure'] as const) {
    for (const check of REVIEW_CHECKS) {
      const item = checklist[check];
      if (item.verdict === verdict) lines.push({ check, verdict, note: item.note });
    }
  }
  return lines;
}
