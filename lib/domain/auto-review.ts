/**
 * The rules layer of public review, as pure rules.
 * review-visibility-proposal.md 6.1; requirement.md 7.4.
 *
 * Three doors. A submission that fails a hard gate is sent back to its
 * owner with the failed checks named, since no reviewer would decide
 * otherwise. One that clears every auto-publish condition is published,
 * since a reviewer would only confirm what the facts already say. Anything
 * else is held for a person -- it is not refused, and it is not trusted
 * yet. The thresholds are configuration (`ReviewRules`), kept with a
 * history like retrieval's; the facts are what the build and the owner
 * already recorded, so this layer never reads content.
 */
import type { RightsDeclaration } from './rights';
import { rightsAllowPublic } from './rights';
import { REVIEW_CHECKS, type ReviewCheck, type ReviewChecklist } from './review';

/* ------------------------------------------------------------------ rules */

export const REVIEW_RULE_KEYS = [
  'trustMin',
  'benchmarkMin',
  'ownerHitRateMin',
  'duplicateMax',
  'sampleRate',
  'autoPublish',
  'expertMinQuestions',
  'expertHitRateMin',
] as const;

export type ReviewRuleKey = (typeof REVIEW_RULE_KEYS)[number];

export type ReviewRules = Record<ReviewRuleKey, number>;

export interface ReviewRuleBounds {
  min: number;
  max: number;
  default: number;
}

export const REVIEW_RULE_BOUNDS: Record<ReviewRuleKey, ReviewRuleBounds> = {
  /** Trust Score an unverified source needs to publish from the rules layer. Defaults loosened on 2026-10-22 (50, 40, 60 before). */
  trustMin: { min: 0, max: 100, default: 40 },
  /** Benchmark Score, likewise. */
  benchmarkMin: { min: 0, max: 100, default: 30 },
  /** Share of the owner's questions the current version answers, 0-100. */
  ownerHitRateMin: { min: 0, max: 100, default: 50 },
  /** Similarity to a published library at which a submission is a duplicate, 0-100. */
  duplicateMax: { min: 1, max: 100, default: 60 },
  /** Share of auto-published libraries drawn for a person's later look, 0-100. */
  sampleRate: { min: 0, max: 100, default: 10 },
  /** 0 lets the rules layer publish nothing (everything reaches the model layer); 1 publishes what clears the conditions. */
  autoPublish: { min: 0, max: 1, default: 1 },
  /** Questions a library needs before applying for the expert tag; 0 waives the gate (lib/domain/expert-library.ts). */
  expertMinQuestions: { min: 0, max: 50, default: 10 },
  /** Share of them, 0-100, the current version must answer for the application to open. */
  expertHitRateMin: { min: 0, max: 100, default: 70 },
};

export const DEFAULT_REVIEW_RULES: ReviewRules = Object.fromEntries(
  REVIEW_RULE_KEYS.map((key) => [key, REVIEW_RULE_BOUNDS[key].default]),
) as ReviewRules;

export class ReviewRulesRefused extends Error {
  constructor(
    readonly code: 'out_of_range',
    readonly field: ReviewRuleKey,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewRulesRefused';
  }
}

/** Every key, each an integer within its bounds; a missing one is refused, never defaulted. */
export function validateReviewRules(values: Partial<Record<ReviewRuleKey, number>>): ReviewRules {
  const rules = {} as ReviewRules;
  for (const key of REVIEW_RULE_KEYS) {
    const value = values[key];
    const bounds = REVIEW_RULE_BOUNDS[key];
    if (value === undefined || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new ReviewRulesRefused('out_of_range', key, `${key} must be an integer in ${bounds.min}..${bounds.max}`);
    }
    rules[key] = value;
  }
  return rules;
}

/* ------------------------------------------------------------------ facts */

/** Source types whose control was proved at creation: a domain challenge, or a repository the account owns. */
export const VERIFIED_SOURCE_TYPES = ['website', 'llms_txt', 'openapi', 'github'] as const;

export interface RulesFacts {
  hasReadyVersion: boolean;
  chunks: number;
  quarantinedFiles: number;
  flaggedFiles: number;
  trustScore: number | null;
  benchmarkScore: number | null;
  sourceType: string | null;
  /** The source's control was proved at creation (`VERIFIED_SOURCE_TYPES`). */
  sourceVerified: boolean;
  /** The source carries a licence file (github) or the declaration grants one. */
  hasLicense: boolean;
  rights: RightsDeclaration | null;
  questions: number;
  /** Share of the owner's questions the current version answers, 0-100; null when none was evaluated on it. */
  ownerHitRate: number | null;
  /** Best similarity to a published library, 0-100 (lib/domain/fingerprint.ts). */
  duplicateSimilarity: number;
  /** The public id of that library, when the similarity is over the line. */
  duplicateOf: string | null;
  /** The workspace's other public libraries that have been published. */
  priorPublicLibraries: number;
}

/* ---------------------------------------------------------------- verdict */

export type RulesDecision = 'publish' | 'send_back' | 'hold';

/**
 * Why the layer decided as it did. Hard gates name a failed check; the
 * rest say which auto-publish condition was not met, for the reviewer
 * who gets the held submission. Shown through a dictionary, never raw.
 */
export const RULES_REASONS = [
  'quarantined',
  'no_index',
  'duplicate',
  'no_license',
  'rights_missing',
  'rights_generated',
  /* Written by send-backs before 2026-10-23, when a public submission needed 5 self-check questions; kept so those rows still read. */
  'too_few_questions',
  'auto_publish_off',
  /* The owner brought no self-check questions, so the rules have nothing to publish on; the model layer looks. */
  'no_questions',
  /* Written by holds before 2026-10-22, when an unverified source always waited for the model layer; kept so those rows still read. */
  'source_unverified',
  'flagged_files',
  'trust_low',
  'benchmark_low',
  'hit_rate_unknown',
  'hit_rate_low',
  'first_public_library',
  'auto_approved',
  /* The model layer's (lib/domain/model-review.ts). `model_unavailable` is
     the queued operation's error while it waits for a retry, and the note of
     holds written before 2026-10-22; the other two send the owner back. */
  'model_unavailable',
  'model_no_answer',
  'model_low_confidence',
  'model_approved',
  'model_send_back',
] as const;

export type RulesReason = (typeof RULES_REASONS)[number];

export function isRulesReason(value: unknown): value is RulesReason {
  return typeof value === 'string' && (RULES_REASONS as readonly string[]).includes(value);
}

/** The prefix under which a reason is written into a review row's notes and feedback, for a dictionary to translate. */
export const RULES_NOTE_PREFIX = 'rules:';

export function rulesNote(reason: RulesReason): string {
  return `${RULES_NOTE_PREFIX}${reason}`;
}

/** The reason a note carries, or null for a person's own words. */
export function rulesReasonOf(note: string): RulesReason | null {
  if (!note.startsWith(RULES_NOTE_PREFIX)) return null;
  const reason = note.slice(RULES_NOTE_PREFIX.length);
  return isRulesReason(reason) ? reason : null;
}

/**
 * A review note as a reader sees it: a person's words as written, the
 * rules layer's reason through the dictionary. Shared by the dashboard
 * and the console, so a reason reads the same on both sides.
 */
export function describeReviewNote(note: string, reasons: Record<string, string>): string {
  const reason = rulesReasonOf(note);
  return reason ? (reasons[reason] ?? note) : note;
}

export interface RulesVerdict {
  decision: RulesDecision;
  /** The 7.4 checklist as this layer could fill it: failed gates, passes it can vouch for, `unsure` for the rest. */
  checklist: ReviewChecklist;
  reasons: RulesReason[];
}

const GATE_CHECK: Partial<Record<RulesReason, ReviewCheck>> = {
  quarantined: 'safety',
  no_index: 'structure',
  duplicate: 'source_firsthand',
  no_license: 'source_firsthand',
  rights_missing: 'source_firsthand',
  rights_generated: 'source_firsthand',
};

function blank(): ReviewChecklist {
  return Object.fromEntries(REVIEW_CHECKS.map((check) => [check, { verdict: 'unsure', note: '' }])) as ReviewChecklist;
}

export function rulesVerdict(facts: RulesFacts, rules: ReviewRules): RulesVerdict {
  const checklist = blank();
  const reasons: RulesReason[] = [];

  /* Hard gates: any one sends the submission back. */
  if (facts.quarantinedFiles > 0) reasons.push('quarantined');
  if (!facts.hasReadyVersion || facts.chunks === 0) reasons.push('no_index');
  if (facts.duplicateSimilarity >= rules.duplicateMax) reasons.push('duplicate');
  if (facts.sourceType === 'github' && !facts.hasLicense && facts.rights?.license !== 'granted') reasons.push('no_license');
  if (!facts.rights) reasons.push('rights_missing');
  else if (!rightsAllowPublic(facts.rights)) reasons.push('rights_generated');

  if (reasons.length > 0) {
    for (const reason of reasons) {
      const check = GATE_CHECK[reason];
      if (check) checklist[check] = { verdict: 'fail', note: rulesNote(reason) };
    }
    return { decision: 'send_back', checklist, reasons };
  }

  /*
   * Auto-publish conditions, or a person looks.
   *
   * A verified source -- a site whose host the owner proved, a repository
   * the account owns (`VERIFIED_SOURCE_TYPES`) -- is first-hand by
   * construction and public already, so for it the only question left is
   * whether the library answers what its owner says it answers: the
   * self-check set has to have been asked of this version and to pass.
   * The set is optional since 2026-10-23, so a library that brought none
   * has nothing for the rules to publish on and goes to the model layer.
   * An unverified source (an upload, a Notion page) proves nothing about
   * who owns the content, so it clears the full list instead: nothing
   * flagged, Trust and Benchmark over their lines, and an owner who has
   * published before. When it does, it publishes here too, without the
   * model layer (6.1, 2026-10-22). The platform's switch stops both.
   */
  if (rules.autoPublish !== 1) reasons.push('auto_publish_off');
  if (facts.questions === 0) reasons.push('no_questions');
  else if (facts.ownerHitRate === null) reasons.push('hit_rate_unknown');
  else if (facts.ownerHitRate < rules.ownerHitRateMin) reasons.push('hit_rate_low');
  if (!facts.sourceVerified) {
    if (facts.flaggedFiles > 0) reasons.push('flagged_files');
    if (facts.trustScore === null || facts.trustScore < rules.trustMin) reasons.push('trust_low');
    if (facts.benchmarkScore === null || facts.benchmarkScore < rules.benchmarkMin) reasons.push('benchmark_low');
    if (facts.priorPublicLibraries < 1) reasons.push('first_public_library');
  }

  if (reasons.length > 0) {
    /* What the gates did settle is recorded as passed; the rest stays for the reviewer. */
    checklist.safety = { verdict: facts.flaggedFiles > 0 ? 'unsure' : 'pass', note: '' };
    checklist.structure = { verdict: 'pass', note: '' };
    return { decision: 'hold', checklist, reasons };
  }

  for (const check of REVIEW_CHECKS) checklist[check] = { verdict: 'pass', note: rulesNote('auto_approved') };
  return { decision: 'publish', checklist, reasons: ['auto_approved'] };
}

/** Whether an auto-published library is drawn for a person's later look, given a draw in [0, 1). */
export function drawnForSample(rules: ReviewRules, draw: number): boolean {
  return draw * 100 < rules.sampleRate;
}
