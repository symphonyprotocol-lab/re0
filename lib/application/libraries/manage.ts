/**
 * The owner's management verbs over their own library, beside rebuild and
 * delete. requirement.md 5.2: pause, resume, resubmit, edit metadata and
 * configure the parse scope are Owner-side operations, each with a definite
 * result, and only the owner side may use them.
 *
 * Every verb here re-checks the role (`canManageLibraries`) and looks the
 * library up by ownership, so a library this workspace does not own answers
 * `library_not_found` -- the same as one that does not exist (architecture.md
 * 5.2). The rules of what may happen are in `lib/domain/library.ts`; this
 * module reads the facts those rules need and writes what they decide.
 *
 * The lifecycle verbs write a `library_review` row under `OWNER_REVIEW_STAGE`
 * so the dashboard and the console both see who stopped a library and why:
 * an owner's pause is theirs to lift, a reviewer's suspension is not.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import type { LifecycleStatus, Visibility } from '@/lib/domain';
import { uuidv7 } from '@/lib/domain/id';
import {
  draftParseScope,
  editWorkspaceLibrary,
  EMPTY_PARSE_SCOPE,
  isOwnerPause,
  isRefreshPolicy,
  OWNER_REVIEW_STAGE,
  ownerActionAvailable,
  ownerActionTarget,
  parseScopeApplies,
  planScopeSave,
  PlatformLibraryRefused,
  withOwnerParseScope,
  type OwnerLifecycleAction,
  type ParseScope,
  type RefreshPolicy,
} from '@/lib/domain/library';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import {
  parseRightsDeclaration,
  readRightsDeclaration,
  rightsAllowPublic,
  rightsPosted,
  type RightsDeclaration,
} from '@/lib/domain/rights';
import { canManageLibraries, type WorkspaceRole } from './delete';
import { libraryMaterials } from './materials';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The operation types that fetch a source, and so are withdrawn by a pause. */
const FETCHING_OPERATIONS = ['ingest', 'refresh'] as const;

interface OwnedLibrary {
  id: string;
  publicId: string;
  visibility: Visibility;
  lifecycleStatus: LifecycleStatus;
  currentVersionId: string | null;
}

type Reader = Pick<ReturnType<typeof db>, 'select'>;

/** The workspace's own live user library, or `library_not_found`. */
async function ownedLibrary(
  reader: Reader,
  workspaceId: string,
  libraryId: string,
  lock = false,
): Promise<OwnedLibrary> {
  if (!UUID.test(libraryId)) throw new AppError('library_not_found', 'no such library');
  const query = reader
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      visibility: schema.library.visibility,
      lifecycleStatus: schema.library.lifecycleStatus,
      currentVersionId: schema.library.currentVersionId,
    })
    .from(schema.library)
    .where(
      and(
        eq(schema.library.id, libraryId),
        eq(schema.library.ownerWorkspaceId, workspaceId),
        eq(schema.library.isPlatformLibrary, false),
        isNull(schema.library.deletedAt),
      ),
    );
  const [row] = lock ? await query.for('update') : await query.limit(1);
  if (!row) throw new AppError('library_not_found', 'no such library');
  return row;
}

/** Whether the library's current version is indexed. */
async function hasReadyVersion(reader: Reader, currentVersionId: string | null): Promise<boolean> {
  if (!currentVersionId) return false;
  const [ready] = await reader
    .select({ id: schema.libraryVersion.id })
    .from(schema.libraryVersion)
    .where(
      and(
        eq(schema.libraryVersion.id, currentVersionId),
        eq(schema.libraryVersion.indexStatus, 'ready'),
      ),
    )
    .limit(1);
  return ready !== undefined;
}

/**
 * The newest review row, which is what says whether a stop was the owner's.
 *
 * `created_at` alone does not order these rows: an owner's pause and the
 * reviewer's decision that lands on top of it are two statements timed in
 * milliseconds, and two rows sharing one millisecond came back in whatever
 * order the planner chose -- half the time the owner's pause, which let the
 * owner resume a library a reviewer had just suspended. A tie is therefore
 * broken towards the reviewer: their word is not undone from the dashboard
 * (`ownerActionAvailable`), so the ambiguous case must resolve to "not the
 * owner's pause", never to a licence. `id` orders the rest (uuidv7 is
 * timestamp-ordered) so the read is at least stable between calls.
 */
async function latestReview(
  reader: Reader,
  libraryId: string,
): Promise<{ stage: string; outcome: string | null } | null> {
  const [review] = await reader
    .select({ stage: schema.libraryReview.stage, outcome: schema.libraryReview.outcome })
    .from(schema.libraryReview)
    .where(eq(schema.libraryReview.libraryId, libraryId))
    .orderBy(
      desc(schema.libraryReview.createdAt),
      asc(sql`case when ${schema.libraryReview.stage} = ${OWNER_REVIEW_STAGE} then 1 else 0 end`),
      desc(schema.libraryReview.id),
    )
    .limit(1);
  return review ?? null;
}

function assertManager(role: WorkspaceRole, verb: string): void {
  if (!canManageLibraries(role)) {
    throw new AppError('access_denied', `only a workspace owner or admin can ${verb} a library`);
  }
}

/* --------------------------------------------------------------- lifecycle */

export interface OwnerLifecycleInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  action: OwnerLifecycleAction;
}

export interface OwnerLifecycleResult {
  publicId: string;
  /** Where the library now is. */
  lifecycleStatus: LifecycleStatus;
  /** Pause only: how many queued fetches were withdrawn with it. */
  cancelledOperations: number;
}

/**
 * Pause or resume one of the workspace's libraries.
 *
 * - pause: `published` -> `suspended`. The library leaves retrieval at once
 *   and its queued fetches are cancelled, so nothing rebuilds it while it is
 *   stopped; a build already running finishes but `lifecycleAfterBuild`
 *   leaves a suspended library where it is.
 * - resume: `suspended` -> `published`, only when the newest review row is
 *   the owner's own pause. A suspension by the platform is not lifted here.
 *
 * The status update is guarded on the status it was read at, so two clicks
 * at once cannot both succeed.
 */
export async function applyOwnerLifecycleAction(
  input: OwnerLifecycleInput,
): Promise<OwnerLifecycleResult> {
  assertManager(input.role, input.action);
  const database = db();
  const now = new Date();

  return database.transaction(async (tx) => {
    const target = await ownedLibrary(tx, input.workspaceId, input.libraryId, true);
    const review = await latestReview(tx, target.id);
    const available = ownerActionAvailable(
      {
        lifecycleStatus: target.lifecycleStatus,
        visibility: target.visibility,
        pausedByOwner: isOwnerPause(review),
      },
      input.action,
    );
    if (!available) {
      throw new AppError(
        'invalid_request',
        `cannot ${input.action} a ${target.visibility} ${target.lifecycleStatus} library`,
      );
    }

    const next = ownerActionTarget(input.action);
    const updated = await tx
      .update(schema.library)
      .set({ lifecycleStatus: next })
      .where(
        and(
          eq(schema.library.id, target.id),
          eq(schema.library.lifecycleStatus, target.lifecycleStatus),
        ),
      )
      .returning({ id: schema.library.id });
    if (updated.length === 0) {
      throw new AppError('invalid_request', 'the library moved while you decided');
    }

    let cancelledOperations = 0;
    if (input.action === 'pause') {
      const cancelled = await tx
        .update(schema.workflowOperation)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(schema.workflowOperation.libraryId, target.id),
            inArray(schema.workflowOperation.operationType, [...FETCHING_OPERATIONS]),
            eq(schema.workflowOperation.status, 'pending'),
          ),
        )
        .returning({ id: schema.workflowOperation.id });
      cancelledOperations = cancelled.length;
    }

    await tx.insert(schema.libraryReview).values({
      id: uuidv7(),
      libraryId: target.id,
      versionId: target.currentVersionId,
      stage: OWNER_REVIEW_STAGE,
      outcome: input.action,
      feedback: [],
      appealOf: null,
      reviewerId: null,
      createdAt: now,
      /* The owner's own pause and its lifting are decided the moment they are made. */
      decidedAt: now,
    });

    return { publicId: target.publicId, lifecycleStatus: next, cancelledOperations };
  });
}

/* ---------------------------------------------------------------- metadata */

export interface EditLibraryMetadataInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  title: string;
  description?: string;
  language?: string;
  visibility: string;
  /** The signed-in user, recorded as who declared when a declaration is posted. */
  userId?: string | null;
  /** A rights declaration posted with the edit; needed when going public without one on the row. */
  rights?: { origin?: unknown; license?: unknown; generation?: unknown; note?: unknown };
}

export interface EditLibraryMetadataResult {
  publicId: string;
  visibility: Visibility;
  /** Where the library is after the edit; a visibility change may move it. */
  lifecycleStatus: LifecycleStatus;
  /** True when the visibility change put the library into the review queue. */
}

/**
 * Edits title, description, language and visibility. What a visibility
 * change does to the lifecycle is `visibilityTransition`'s decision; going
 * public needs a rights declaration that permits it, and nothing waits on
 * a reviewer afterwards (2026-10-23). A field that is too long is refused,
 * never truncated.
 */
export async function editLibraryMetadata(
  input: EditLibraryMetadataInput,
): Promise<EditLibraryMetadataResult> {
  assertManager(input.role, 'edit');
  const database = db();

  return database.transaction(async (tx) => {
    const target = await ownedLibrary(tx, input.workspaceId, input.libraryId, true);
    const [ready, materials] = await Promise.all([
      hasReadyVersion(tx, target.currentVersionId),
      libraryMaterials(tx, target.id),
    ]);

    /*
     * The rights declaration rides with the edit (review-visibility-
     * proposal.md 5.1): a posted one replaces what the row has, and going
     * public needs one that permits a public library. The materials are
     * judged with the declaration as it will be after this edit.
     */
    let rights: RightsDeclaration | null = materials.rights;
    if (input.rights && rightsPosted(input.rights)) {
      rights = parseRightsDeclaration(input.rights, { userId: input.userId ?? null, now: new Date() });
      if (!rights) throw new PlatformLibraryRefused('rights_invalid', 'the rights declaration is incomplete');
    }
    if (input.visibility === 'public') {
      if (!rights) throw new PlatformLibraryRefused('rights_required', 'a public library declares its rights');
      if (!rightsAllowPublic(rights)) {
        throw new PlatformLibraryRefused('rights_generated', 'model-generated content is not accepted as public');
      }
    }
    /* A refused field throws `PlatformLibraryRefused` with the field's own
       code; the action turns that into the line the form shows. */
    const edit = editWorkspaceLibrary({
      title: input.title,
      description: input.description,
      language: input.language,
      visibility: input.visibility,
      current: {
        visibility: target.visibility,
        lifecycleStatus: target.lifecycleStatus,
        hasReadyVersion: ready,
      },
    });

    const next = edit.lifecycleStatus ?? target.lifecycleStatus;
    await tx
      .update(schema.library)
      .set({
        title: edit.title,
        description: edit.description,
        language: edit.language,
        visibility: edit.visibility,
        lifecycleStatus: next,
        ...(rights !== materials.rights ? { rightsDeclaration: rights } : {}),
      })
      .where(eq(schema.library.id, target.id));

    return { publicId: target.publicId, visibility: edit.visibility, lifecycleStatus: next };
  });
}

/* ------------------------------------------------------------- parse scope */

export interface UpdateParseScopeInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  /** One path or glob per line, as typed. */
  folders?: string;
  excludeFolders?: string;
  excludeFiles?: string;
  indexDepth?: unknown;
  /** Absent leaves the cadence alone; refused for a source with nothing to re-fetch. */
  refreshPolicy?: string;
}

export interface UpdateParseScopeResult {
  publicId: string;
  scope: ParseScope;
  refreshPolicy: RefreshPolicy | null;
  /** True when the library has a version and a rebuild would apply the new scope. */
  rebuildAdvised: boolean;
}

/**
 * Stores the owner's parse scope on the source under the names `re0.json`
 * uses (`folders`, `excludeFolders`, `excludeFiles`; requirement.md 7.2) plus
 * `indexDepth` for a website or `llms.txt` source, and the refresh cadence where the
 * source has something to re-fetch. The next build applies it
 * (`fetchSnapshot` filters the snapshot); this call queues none, because
 * the owner may still be editing and the rebuild button is beside the form.
 */
export async function updateParseScope(input: UpdateParseScopeInput): Promise<UpdateParseScopeResult> {
  assertManager(input.role, 'configure');
  const database = db();

  return database.transaction(async (tx) => {
    const target = await ownedLibrary(tx, input.workspaceId, input.libraryId, true);
    if (target.lifecycleStatus === 'archived') {
      throw new AppError('invalid_request', 'an archived library is not edited');
    }
    const [source] = await tx
      .select({ id: schema.source.id, type: schema.source.type, config: schema.source.config })
      .from(schema.source)
      .where(eq(schema.source.libraryId, target.id))
      .orderBy(schema.source.id)
      .limit(1);
    if (!source) throw new AppError('invalid_request', 'the library has no source');

    /*
     * The two halves of the form are decided together, and before either is
     * read: the scope half applies to fewer sources than the cadence half, so
     * asking the scope first refused an OpenAPI or Notion library's perfectly
     * valid "set this to daily". Refusals carry the field's own code
     * (`PlatformLibraryRefused`).
     */
    const plan = planScopeSave({
      sourceType: source.type,
      cadencePosted: input.refreshPolicy !== undefined && input.refreshPolicy !== '',
    });

    const scope: ParseScope = plan.scope
      ? draftParseScope({
          sourceType: source.type,
          folders: input.folders,
          excludeFolders: input.excludeFolders,
          excludeFiles: input.excludeFiles,
          indexDepth: input.indexDepth,
        })
      : EMPTY_PARSE_SCOPE;

    let refreshPolicy: RefreshPolicy | null = null;
    if (plan.cadence) {
      if (!isRefreshPolicy(input.refreshPolicy)) {
        throw new PlatformLibraryRefused('invalid_refresh_policy', 'unknown refresh policy');
      }
      refreshPolicy = input.refreshPolicy;
    }

    /* `withOwnerParseScope` marks the row as the owner's override, so the
       next build stamps `re0.json` over it no more (lib/domain/library.ts). */
    await tx
      .update(schema.source)
      .set({
        ...(plan.scope ? { config: withOwnerParseScope(source.config, scope, source.type) } : {}),
        ...(refreshPolicy ? { refreshPolicy: { cadence: refreshPolicy } } : {}),
      })
      .where(eq(schema.source.id, source.id));

    return {
      publicId: target.publicId,
      scope,
      refreshPolicy,
      rebuildAdvised: target.currentVersionId !== null && parseScopeApplies(source.type),
    };
  });
}
