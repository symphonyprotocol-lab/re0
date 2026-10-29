/**
 * What is left of the public-review checklist (requirement.md 7.4) now that
 * no library is reviewed before it publishes (2026-10-23): the length of a
 * console probe, and the reading of notes the rules layer wrote into review
 * rows before then.
 */

/** A reviewer's probe is one question, trimmed, this long at most; the same bound a caller has. */
export const REVIEW_PROBE_MAX_LENGTH = 500;

/** The prefix the rules layer put before a reason code in `library_review.feedback`, until 2026-10-23. */
const RULES_NOTE_PREFIX = 'rules:';

/**
 * A review note as a reader sees it: a person's words as written, a
 * machine-written reason code through the dictionary. Shared by the
 * dashboard and the console, so an old row reads the same on both sides.
 */
export function describeReviewNote(note: string, reasons: Record<string, string>): string {
  if (!note.startsWith(RULES_NOTE_PREFIX)) return note;
  return reasons[note.slice(RULES_NOTE_PREFIX.length)] ?? note;
}
