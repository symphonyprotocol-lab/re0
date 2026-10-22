/**
 * The owner's side of the expert tag. expert-library-prd.md 4.1, 5.
 *
 * Two verbs and one read model. Both verbs re-check the workspace role and
 * look the library up by ownership, so a library this workspace does not own
 * answers `not_found` -- the same as one that does not exist (architecture.md
 * 5.2). The rules of what may happen are in `lib/domain/expert-library.ts`;
 * this module reads the facts those rules need and writes what they decide.
 */
import { and, eq } from 'drizzle-orm';
import {
  applicationBlocker,
  expertChecks,
  expertEarning,
  expertHitRate,
  ExpertLibraryRefused,
  normalizeExpertNote,
  parseExpertMaterials,
  reapplyAllowedAt,
  type ExpertApplicationStatus,
  type ExpertCheck,
  type ExpertEvalRules,
  type ExpertEvaluation,
  type ExpertLibraryError,
} from '@/lib/domain/expert-library';
import { uuidv7 } from '@/lib/domain/id';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import {
  applicationHistory,
  auditExpert,
  candidateOf,
  COOLDOWN_STATUSES,
  expertEvalRules,
  isUuid,
  lastCooldownDecisionAt,
  ownedLibrary,
  pendingApplicationOf,
  type ExpertApplicationRow,
} from './shared';

/** How many past applications the panel lists. */
const PANEL_HISTORY = 20;

export interface ExpertApplicationView {
  id: string;
  status: ExpertApplicationStatus;
  note: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** What the library's expert panel on the dashboard shows (prd 5). */
export interface ExpertPanelView {
  /** When the tag was granted; null for a library that is not an expert library. */
  taggedAt: Date | null;
  /** The owner's preconditions, each as it stands now. */
  checks: Record<ExpertCheck, boolean>;
  /** The question set against the current version, and the thresholds it is judged by (review-visibility-proposal.md 5.3). */
  evaluation: ExpertEvaluation & { hitRate: number | null; rules: ExpertEvalRules };
  /** Tagged and every condition met: calls to it are earning right now. */
  earning: boolean;
  /** Why a new application cannot be opened, or null when it can. */
  blocker: ExpertLibraryError | null;
  /** When a cooldown ends, when that is the blocker. */
  reapplyAllowedAt: Date | null;
  pending: ExpertApplicationView | null;
  /** The newest application of any status; what the status line reads from. */
  latest: ExpertApplicationView | null;
  history: ExpertApplicationView[];
}

function view(row: ExpertApplicationRow): ExpertApplicationView {
  return {
    id: row.id,
    status: row.status,
    note: row.note,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

/** The panel for one of the workspace's libraries, or null when it is not theirs. */
export async function expertPanel(input: {
  workspaceId: string;
  libraryId: string;
  now?: Date;
}): Promise<ExpertPanelView | null> {
  if (!isUuid(input.libraryId)) return null;
  const database = db();
  const now = input.now ?? new Date();
  const evalRules = await expertEvalRules();
  const candidate = await candidateOf(database, ownedLibrary(input.workspaceId, input.libraryId), false, evalRules);
  if (!candidate) return null;

  /*
   * The open application and the newest rejection or revocation are both in
   * the history the panel shows anyway, so they are read from it rather than
   * queried again. Only a library with more applications than the panel
   * lists -- where the cooldown decision could sit past the cut -- asks the
   * database the two questions directly.
   */
  const history = await applicationHistory(database, candidate.id, PANEL_HISTORY);
  const complete = history.length < PANEL_HISTORY;
  const [pending, lastDecidedAt] = complete
    ? [
        history.find((row) => row.status === 'pending') ?? null,
        history.find((row) => COOLDOWN_STATUSES.includes(row.status))?.decidedAt ?? null,
      ]
    : await Promise.all([
        pendingApplicationOf(database, candidate.id),
        lastCooldownDecisionAt(database, candidate.id),
      ]);

  const blocker = applicationBlocker({
    candidate,
    hasPending: pending !== null,
    lastDecidedAt,
    now,
  });
  return {
    taggedAt: candidate.expertTaggedAt,
    checks: expertChecks(candidate),
    evaluation: { ...candidate.evaluation, hitRate: expertHitRate(candidate.evaluation), rules: evalRules },
    earning: expertEarning(candidate),
    blocker,
    reapplyAllowedAt: blocker === 'cooldown' ? reapplyAllowedAt(lastDecidedAt) : null,
    pending: pending ? view(pending) : null,
    latest: history[0] ? view(history[0]) : null,
    history: history.map(view),
  };
}

function assertManager(role: WorkspaceRole, verb: string): void {
  if (!canManageLibraries(role)) {
    throw new ExpertLibraryRefused(
      'access_denied',
      `only a workspace owner or admin can ${verb} an expert-library application`,
    );
  }
}

export interface ApplyForExpertTagInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  /** The applicant's statement for the reviewer; optional. Kept for callers that predate the materials. */
  note?: unknown;
  /**
   * The structured statement (lib/domain/expert-library.ts `ExpertMaterials`):
   * scope, maintenance and credentials, each required, and the note. Absent
   * only for a caller that predates it; the dashboard always posts it.
   */
  materials?: { scope?: unknown; maintenance?: unknown; credentials?: unknown; note?: unknown };
  /** Who applied, for the audit values. */
  userId?: string | null;
  now?: Date;
}

export interface ApplyForExpertTagResult {
  applicationId: string;
}

/**
 * Open an application. The preconditions are read under the library's row
 * lock and judged by `applicationBlocker`; the partial unique index on
 * pending applications is the backstop against two clicks at once.
 */
export async function applyForExpertTag(
  input: ApplyForExpertTagInput,
): Promise<ApplyForExpertTagResult> {
  assertManager(input.role, 'open');
  const materials = input.materials ? parseExpertMaterials(input.materials) : null;
  if (input.materials && materials === undefined) {
    throw new ExpertLibraryRefused('invalid_materials', 'scope, maintenance and credentials are required, within their limits');
  }
  const note = normalizeExpertNote(materials ? materials.note : input.note);
  if (note === undefined) {
    throw new ExpertLibraryRefused('invalid_note', 'the note is too long or contains control characters');
  }
  if (!isUuid(input.libraryId)) throw new ExpertLibraryRefused('not_found', 'no such library');
  const now = input.now ?? new Date();
  /* Read before the transaction: configuration, not something the lock has to cover. */
  const evalRules = await expertEvalRules();

  const outcome = await db().transaction(async (tx) => {
    const candidate = await candidateOf(tx, ownedLibrary(input.workspaceId, input.libraryId), true, evalRules);
    if (!candidate) throw new ExpertLibraryRefused('not_found', 'no such library');

    const [pending, lastDecidedAt] = await Promise.all([
      pendingApplicationOf(tx, candidate.id),
      lastCooldownDecisionAt(tx, candidate.id),
    ]);
    const blocker = applicationBlocker({
      candidate,
      hasPending: pending !== null,
      lastDecidedAt,
      now,
    });
    if (blocker) throw new ExpertLibraryRefused(blocker, `cannot apply: ${blocker}`);

    const applicationId = uuidv7();
    await tx.insert(schema.expertApplication).values({
      id: applicationId,
      libraryId: candidate.id,
      workspaceId: input.workspaceId,
      status: 'pending',
      note,
      materials: materials ?? null,
      createdAt: now,
    });
    return { applicationId, publicId: candidate.publicId };
  });

  await auditExpert({
    action: 'expert_library.apply',
    applicationId: outcome.applicationId,
    after: {
      status: 'pending',
      libraryId: input.libraryId,
      publicId: outcome.publicId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
    },
  });

  return { applicationId: outcome.applicationId };
}

export interface WithdrawExpertApplicationInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  userId?: string | null;
  now?: Date;
}

export interface WithdrawExpertApplicationResult {
  applicationId: string;
}

/** Close the library's pending application. Nothing else changes. */
export async function withdrawExpertApplication(
  input: WithdrawExpertApplicationInput,
): Promise<WithdrawExpertApplicationResult> {
  assertManager(input.role, 'withdraw');
  if (!isUuid(input.libraryId)) throw new ExpertLibraryRefused('not_found', 'no such library');
  const now = input.now ?? new Date();
  const evalRules = await expertEvalRules();

  const outcome = await db().transaction(async (tx) => {
    const candidate = await candidateOf(tx, ownedLibrary(input.workspaceId, input.libraryId), true, evalRules);
    if (!candidate) throw new ExpertLibraryRefused('not_found', 'no such library');
    const pending = await pendingApplicationOf(tx, candidate.id);
    if (!pending) throw new ExpertLibraryRefused('not_pending', 'no pending application');

    const updated = await tx
      .update(schema.expertApplication)
      .set({ status: 'withdrawn', decidedAt: now })
      .where(
        and(
          eq(schema.expertApplication.id, pending.id),
          eq(schema.expertApplication.status, 'pending'),
        ),
      )
      .returning({ id: schema.expertApplication.id });
    if (updated.length === 0) {
      throw new ExpertLibraryRefused('not_pending', 'the application was decided meanwhile');
    }
    return { applicationId: pending.id, publicId: candidate.publicId };
  });

  await auditExpert({
    action: 'expert_library.withdraw',
    applicationId: outcome.applicationId,
    before: { status: 'pending' },
    after: {
      status: 'withdrawn',
      libraryId: input.libraryId,
      publicId: outcome.publicId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
    },
  });

  return { applicationId: outcome.applicationId };
}
