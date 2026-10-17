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
}

/**
 * The checks an owner's application has to pass, in the order the dashboard
 * lists them (prd 4.1, 5). Returned as a list rather than a single verdict so
 * the panel can show every unmet condition at once instead of one per visit.
 */
export const EXPERT_CHECKS = ['public', 'published', 'subscribed'] as const;

export type ExpertCheck = (typeof EXPERT_CHECKS)[number];

export function expertChecks(candidate: ExpertCandidate): Record<ExpertCheck, boolean> {
  return {
    public: candidate.visibility === 'public',
    published: candidate.lifecycleStatus === 'published',
    subscribed: candidate.ownerSubscribed,
  };
}

/** True when every check in `expertChecks` passes. */
export function expertEligible(candidate: ExpertCandidate): boolean {
  return Object.values(expertChecks(candidate)).every(Boolean);
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
  return candidate.expertTaggedAt !== null && expertEligible(candidate);
}
