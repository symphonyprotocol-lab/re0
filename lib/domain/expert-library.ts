/**
 * Expert-library rules, as pure functions. No Next.js, no driver, no fetch.
 * expert-library-prd.md 4.
 *
 * Upload eligibility and revenue eligibility are two doors. Public review
 * (requirement.md 7.4) answers whether a library may ship; the expert tag
 * answers whether it is worth paying for. The tag is applied for by the owner
 * and granted by an administrator, and a served call earns only while the
 * tag is on *and* the owner is on a paid plan (`isRevenueEligible` in
 * lib/domain/index.ts). Everything here decides whether a proposed move is
 * allowed at all, so the dashboard, the console and the tests answer the
 * same way.
 */
import type { LifecycleStatus, Visibility } from '@/lib/domain';
import { fingerprint } from './fingerprint';
import { isReviewVerdict, REVIEW_CHECK_NOTE_MAX_LENGTH, type ReviewChecklistItem } from './review';

export const EXPERT_APPLICATION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
  'revoked',
] as const;

export type ExpertApplicationStatus = (typeof EXPERT_APPLICATION_STATUSES)[number];

export function isExpertApplicationStatus(value: unknown): value is ExpertApplicationStatus {
  return (
    typeof value === 'string' &&
    (EXPERT_APPLICATION_STATUSES as readonly string[]).includes(value)
  );
}

/** The applicant's statement for the reviewer; optional, and this long at most. */
export const EXPERT_NOTE_MAX_LENGTH = 500;

/**
 * How long after a rejection or a revocation the same library may apply
 * again (prd 4.1). Long enough that a queue cannot be worn down by resubmitting
 * the same library every morning, short enough that one mistaken rejection
 * is not a ban.
 */
export const EXPERT_REAPPLY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ errors */

/**
 * Why an expert-library move was refused. Specific on purpose: the owner is
 * told which precondition is missing so they can fix it, and the reviewer is
 * told why an approval did not go through.
 */
export const EXPERT_LIBRARY_ERRORS = [
  /** The library is not this workspace's, or does not exist: one answer. */
  'not_found',
  /** Only a workspace owner or admin applies and withdraws. */
  'access_denied',
  'not_public',
  'not_published',
  /** The owner workspace is not on a paid plan right now. */
  'not_subscribed',
  /** The question set is too small, not evaluated on the current version, or answered too poorly (review-visibility-proposal.md 5.3). */
  'eval_not_ready',
  /** The structured materials are incomplete or unusable. */
  'invalid_materials',
  /** A decision came without the expert checklist, or with one that contradicts it (6.5). */
  'checklist_required',
  'checklist_mismatch',
  'already_pending',
  'already_tagged',
  /** A rejection or revocation is too recent. */
  'cooldown',
  'invalid_note',
  /** The console's verbs: the application is not in the state the verb needs. */
  'not_pending',
  'not_approved',
  /** Approval re-checks the library and it no longer qualifies. */
  'library_ineligible',
  'reason_required',
] as const;

export type ExpertLibraryError = (typeof EXPERT_LIBRARY_ERRORS)[number];

export function isExpertLibraryError(value: unknown): value is ExpertLibraryError {
  return typeof value === 'string' && (EXPERT_LIBRARY_ERRORS as readonly string[]).includes(value);
}

export class ExpertLibraryRefused extends Error {
  constructor(
    readonly code: ExpertLibraryError,
    message: string,
  ) {
    super(message);
    this.name = 'ExpertLibraryRefused';
  }
}

/* ------------------------------------------------------------- eligibility */

/**
 * What the library looks like right now, as both the application and the
 * approval read it. `ownerSubscribed` is the one definition in
 * lib/application/plans/in-force.ts, evaluated by the caller.
 */
export interface ExpertCandidate {
  visibility: Visibility;
  lifecycleStatus: LifecycleStatus;
  ownerSubscribed: boolean;
  expertTaggedAt: Date | null;
  /** `expertEvalReady`: the question set is big enough and the current version answers it well enough. */
  evalReady: boolean;
}

/**
 * The checks an owner's application has to pass, in the order the dashboard
 * lists them (prd 4.1, 5; review-visibility-proposal.md 5.3). Returned as a
 * list rather than a single verdict so the panel can show every unmet
 * condition at once instead of one per visit.
 */
export const EXPERT_CHECKS = ['public', 'published', 'subscribed', 'eval_ready'] as const;

export type ExpertCheck = (typeof EXPERT_CHECKS)[number];

export function expertChecks(candidate: ExpertCandidate): Record<ExpertCheck, boolean> {
  return {
    public: candidate.visibility === 'public',
    published: candidate.lifecycleStatus === 'published',
    subscribed: candidate.ownerSubscribed,
    eval_ready: candidate.evalReady,
  };
}

/** True when every check in `expertChecks` passes. */
export function expertEligible(candidate: ExpertCandidate): boolean {
  return Object.values(expertChecks(candidate)).every(Boolean);
}

/* ------------------------------------------------------------- evaluation */

/** What the library's question set says about it, as the expert gate reads it. */
export interface ExpertEvaluation {
  /** Every question on the library, the owner's and the platform's. */
  questions: number;
  /** Of those, asked of the current version. */
  evaluatedOnCurrent: number;
  /** Of those, answered within the top results. */
  hitsOnCurrent: number;
}

export interface ExpertEvalRules {
  /** Questions a library needs before it may apply; 0 waives the gate. */
  minQuestions: number;
  /** Share of them, 0-100, the current version must answer. */
  minHitRate: number;
}

/** 0-100, or null until any question was asked of the current version. */
export function expertHitRate(evaluation: ExpertEvaluation): number | null {
  if (evaluation.evaluatedOnCurrent === 0) return null;
  return Math.round((evaluation.hitsOnCurrent / evaluation.evaluatedOnCurrent) * 100);
}

/**
 * The evaluation gate (review-visibility-proposal.md 5.3): enough
 * questions, every one of them asked of the version that would earn, and
 * enough of them answered. A platform that sets the minimum to zero has
 * waived the gate, and a library with no questions then passes it.
 */
export function expertEvalReady(evaluation: ExpertEvaluation, rules: ExpertEvalRules): boolean {
  if (evaluation.questions < rules.minQuestions) return false;
  if (evaluation.questions === 0) return rules.minQuestions === 0;
  if (evaluation.evaluatedOnCurrent < evaluation.questions) return false;
  const hitRate = expertHitRate(evaluation);
  return hitRate !== null && hitRate >= rules.minHitRate;
}

/* -------------------------------------------------------------- materials */

/** The applicant's structured statement (review-visibility-proposal.md 5.3); the note stays, optional. */
export const EXPERT_MATERIAL_LIMITS = { scope: 500, maintenance: 300, credentials: 500, note: EXPERT_NOTE_MAX_LENGTH } as const;

export interface ExpertMaterials {
  /** What the library covers and what it does not. */
  scope: string;
  /** How, and how often, it is kept current. */
  maintenance: string;
  /** Who the applicant is to speak for this content. */
  credentials: string;
  note: string;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The materials as the form posts them. `undefined` when a required field
 * is missing or any field is unusable -- the one case the caller refuses;
 * the three statements are required, the note is not.
 */
export function parseExpertMaterials(input: {
  scope?: unknown;
  maintenance?: unknown;
  credentials?: unknown;
  note?: unknown;
}): ExpertMaterials | undefined {
  const scope = cleanText(input.scope, EXPERT_MATERIAL_LIMITS.scope);
  const maintenance = cleanText(input.maintenance, EXPERT_MATERIAL_LIMITS.maintenance);
  const credentials = cleanText(input.credentials, EXPERT_MATERIAL_LIMITS.credentials);
  const note = cleanText(input.note, EXPERT_MATERIAL_LIMITS.note);
  if (scope === undefined || maintenance === undefined || credentials === undefined || note === undefined) return undefined;
  if (scope.length === 0 || maintenance.length === 0 || credentials.length === 0) return undefined;
  return { scope, maintenance, credentials, note };
}

/** A stored statement read back without trusting its shape; null for an application made before it existed. */
export function readExpertMaterials(stored: unknown): ExpertMaterials | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  if (!text(record.scope) && !text(record.maintenance) && !text(record.credentials)) return null;
  return { scope: text(record.scope), maintenance: text(record.maintenance), credentials: text(record.credentials), note: text(record.note) };
}

/* --------------------------------------------------------------- checklist */

/**
 * What the reviewer judges before granting the tag (review-visibility-
 * proposal.md 6.5): the statements, the sampled questions and the
 * library's record in use. Same shape as the public checklist
 * (lib/domain/review.ts), so the forms and the storage are one pattern.
 */
export const EXPERT_REVIEW_CHECKS = ['scope_clear', 'maintenance_credible', 'credentials_match', 'sample_ok', 'usage_ok'] as const;

export type ExpertReviewCheck = (typeof EXPERT_REVIEW_CHECKS)[number];

export type ExpertChecklist = Record<ExpertReviewCheck, ReviewChecklistItem>;

export function parseExpertChecklist(input: unknown): ExpertChecklist | null {
  const read =
    typeof FormData !== 'undefined' && input instanceof FormData
      ? (key: string) => input.get(key)
      : input && typeof input === 'object'
        ? (key: string) => (input as Record<string, unknown>)[key]
        : null;
  if (!read) return null;
  const checklist = {} as ExpertChecklist;
  for (const check of EXPERT_REVIEW_CHECKS) {
    const verdict = read(`check.${check}`);
    if (!isReviewVerdict(verdict)) return null;
    const note = cleanText(read(`note.${check}`), REVIEW_CHECK_NOTE_MAX_LENGTH);
    if (note === undefined) return null;
    checklist[check] = { verdict, note };
  }
  return checklist;
}

export function readExpertChecklist(stored: unknown): ExpertChecklist | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as Record<string, unknown>;
  const checklist = {} as ExpertChecklist;
  for (const check of EXPERT_REVIEW_CHECKS) {
    const item = record[check];
    if (!item || typeof item !== 'object') return null;
    const { verdict, note } = item as { verdict?: unknown; note?: unknown };
    if (!isReviewVerdict(verdict)) return null;
    checklist[check] = { verdict, note: typeof note === 'string' ? note : '' };
  }
  return checklist;
}

/** An approval cannot carry a failed check; a rejection has to name one. `unsure` blocks neither. */
export function expertChecklistAllows(decision: 'approve' | 'reject', checklist: ExpertChecklist): boolean {
  const failing = EXPERT_REVIEW_CHECKS.filter((check) => checklist[check].verdict === 'fail').length;
  return decision === 'approve' ? failing === 0 : failing > 0;
}

/* ---------------------------------------------------------------- sampling */

export const EXPERT_SAMPLE_SIZE = 4;

/**
 * Which questions the reviewer re-asks (review-visibility-proposal.md 6.5):
 * `n` distinct indexes drawn by a seed, so the same application shows the
 * same draw on every visit and two reviewers see the same questions.
 */
export function sampleExpertQuestions(total: number, seed: string, n = EXPERT_SAMPLE_SIZE): number[] {
  if (total <= 0) return [];
  if (total <= n) return Array.from({ length: total }, (_, at) => at);
  let state = BigInt(`0x${fingerprint(seed)}`) || 1n;
  const picked = new Set<number>();
  while (picked.size < n) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    picked.add(Number((state >> 33n) % BigInt(total)));
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * Why an application may not be opened right now, or null when it may.
 *
 * Checked in the order the owner can act on them: the library's own state
 * first (they can change it), then the subscription (they can buy one), then
 * the queue (they can only wait). `lastDecidedAt` is the newest rejection or
 * revocation on this library, for the cooldown.
 */
export function applicationBlocker(input: {
  candidate: ExpertCandidate;
  hasPending: boolean;
  lastDecidedAt: Date | null;
  now: Date;
}): ExpertLibraryError | null {
  const checks = expertChecks(input.candidate);
  if (input.candidate.expertTaggedAt !== null) return 'already_tagged';
  if (!checks.public) return 'not_public';
  if (!checks.published) return 'not_published';
  if (!checks.subscribed) return 'not_subscribed';
  if (!checks.eval_ready) return 'eval_not_ready';
  if (input.hasPending) return 'already_pending';
  if (
    input.lastDecidedAt !== null &&
    input.now.getTime() - input.lastDecidedAt.getTime() < EXPERT_REAPPLY_COOLDOWN_MS
  ) {
    return 'cooldown';
  }
  return null;
}

/** When the cooldown ends, for the panel; null when none applies. */
export function reapplyAllowedAt(lastDecidedAt: Date | null): Date | null {
  return lastDecidedAt ? new Date(lastDecidedAt.getTime() + EXPERT_REAPPLY_COOLDOWN_MS) : null;
}

/**
 * The applicant's note, trimmed and bounded, or null for none. `undefined`
 * means the note was unusable, which is the one case the caller refuses.
 */
export function normalizeExpertNote(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > EXPERT_NOTE_MAX_LENGTH) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/* ------------------------------------------------------------- decisions */

/** The console's verbs over an application (prd 4.5). */
export const EXPERT_DECISIONS = ['approve', 'reject', 'revoke'] as const;

export type ExpertDecision = (typeof EXPERT_DECISIONS)[number];

export function isExpertDecision(value: unknown): value is ExpertDecision {
  return typeof value === 'string' && (EXPERT_DECISIONS as readonly string[]).includes(value);
}

/**
 * Where a verb takes an application, or null when the verb does not apply
 * from its state. Approve and reject act on a pending application; revoke
 * acts on an approved one.
 */
export function nextExpertStatus(
  current: ExpertApplicationStatus,
  decision: ExpertDecision,
): ExpertApplicationStatus | null {
  switch (decision) {
    case 'approve':
      return current === 'pending' ? 'approved' : null;
    case 'reject':
      return current === 'pending' ? 'rejected' : null;
    case 'revoke':
      return current === 'approved' ? 'revoked' : null;
  }
}

/**
 * The checks an approval re-runs at decision time (prd 4.2): the owner's
 * three, plus that the library still belongs to whoever applied and that its
 * current version is indexed -- the same requirement public approval has,
 * so the console never tags a library with an empty index.
 */
export const APPROVAL_CHECKS = [
  'public',
  'published',
  'owner_unchanged',
  'subscribed',
  'ready_version',
  'eval_ready',
] as const;

export type ApprovalCheck = (typeof APPROVAL_CHECKS)[number];

export function approvalChecks(input: {
  candidate: ExpertCandidate;
  ownerWorkspaceId: string | null;
  applicantWorkspaceId: string;
  hasReadyVersion: boolean;
}): Record<ApprovalCheck, boolean> {
  const owner = expertChecks(input.candidate);
  return {
    public: owner.public,
    published: owner.published,
    owner_unchanged: input.ownerWorkspaceId === input.applicantWorkspaceId,
    subscribed: owner.subscribed,
    ready_version: input.hasReadyVersion,
    eval_ready: owner.eval_ready,
  };
}

export function approvalAllowed(checks: Record<ApprovalCheck, boolean>): boolean {
  return Object.values(checks).every(Boolean);
}

/**
 * Whether a tagged library's calls earn right now, as the dashboard explains
 * it (prd 4.3): the tag stays through a private spell or a lapsed
 * subscription, and earning resumes by itself when the condition does.
 */
export function expertEarning(candidate: ExpertCandidate): boolean {
  /* The evaluation gate is an application's, not a tag's: a granted tag earns
     on the three conditions prd 4.3 names, whatever the question set does later. */
  const checks = expertChecks(candidate);
  return candidate.expertTaggedAt !== null && checks.public && checks.published && checks.subscribed;
}
