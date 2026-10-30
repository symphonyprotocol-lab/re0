/**
 * The owner's management verbs over their own asset, beside rebuild and
 * delete. requirement.md 5.2: pause, resume, resubmit, edit metadata and
 * configure the parse scope are Owner-side operations, each with a definite
 * result, and only the owner side may use them.
 *
 * Every verb here re-checks the role (`canManageAssets`) and looks the
 * asset up by ownership, so an asset this workspace does not own answers
 * `asset_not_found` -- the same as one that does not exist (architecture.md
 * 5.2). The rules of what may happen are in `lib/domain/asset.ts`; this
 * module reads the facts those rules need and writes what they decide.
 *
 * The lifecycle verbs write a `asset_review` row under `OWNER_REVIEW_STAGE`
 * so the dashboard and the console both see who stopped an asset and why:
 * an owner's pause is theirs to lift, a reviewer's suspension is not.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import type { LifecycleStatus } from '@/lib/domain';
import { listedInPublicChannel } from '@/lib/application/channels/visibility';
import { uuidv7 } from '@/lib/domain/id';
import {
  draftParseScope,
  editWorkspaceAsset,
  EMPTY_PARSE_SCOPE,
  isOwnerPause,
  isRefreshPolicy,
  OWNER_REVIEW_STAGE,
  ownerActionAvailable,
  ownerActionTarget,
  parseScopeApplies,
  planScopeSave,
  PlatformAssetRefused,
  withOwnerParseScope,
  type OwnerLifecycleAction,
  type ParseScope,
  type RefreshPolicy,
} from '@/lib/domain/asset';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import {
  parseRightsDeclaration,
  readRightsDeclaration,
  rightsAllowPublic,
  rightsPosted,
  type RightsDeclaration,
} from '@/lib/domain/rights';
import { canManageAssets, type WorkspaceRole } from './delete';
import { assetMaterials } from './materials';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The operation types that fetch a source, and so are withdrawn by a pause. */
const FETCHING_OPERATIONS = ['ingest', 'refresh'] as const;

interface OwnedAsset {
  id: string;
  publicId: string;
  lifecycleStatus: LifecycleStatus;
  currentVersionId: string | null;
}

type Reader = Pick<ReturnType<typeof db>, 'select'>;

/** The workspace's own live user asset, or `asset_not_found`. */
async function ownedAsset(
  reader: Reader,
  workspaceId: string,
  assetId: string,
  lock = false,
): Promise<OwnedAsset> {
  if (!UUID.test(assetId)) throw new AppError('asset_not_found', 'no such asset');
  const query = reader
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      lifecycleStatus: schema.asset.lifecycleStatus,
      currentVersionId: schema.asset.currentVersionId,
    })
    .from(schema.asset)
    .where(
      and(
        eq(schema.asset.id, assetId),
        eq(schema.asset.ownerWorkspaceId, workspaceId),
        eq(schema.asset.isPlatformAsset, false),
        isNull(schema.asset.deletedAt),
      ),
    );
  const [row] = lock ? await query.for('update') : await query.limit(1);
  if (!row) throw new AppError('asset_not_found', 'no such asset');
  return row;
}

/**
 * The newest review row, which is what says whether a stop was the owner's.
 *
 * `created_at` alone does not order these rows: an owner's pause and the
 * reviewer's decision that lands on top of it are two statements timed in
 * milliseconds, and two rows sharing one millisecond came back in whatever
 * order the planner chose -- half the time the owner's pause, which let the
 * owner resume an asset a reviewer had just suspended. A tie is therefore
 * broken towards the reviewer: their word is not undone from the dashboard
 * (`ownerActionAvailable`), so the ambiguous case must resolve to "not the
 * owner's pause", never to a licence. `id` orders the rest (uuidv7 is
 * timestamp-ordered) so the read is at least stable between calls.
 */
async function latestReview(
  reader: Reader,
  assetId: string,
): Promise<{ stage: string; outcome: string | null } | null> {
  const [review] = await reader
    .select({ stage: schema.assetReview.stage, outcome: schema.assetReview.outcome })
    .from(schema.assetReview)
    .where(eq(schema.assetReview.assetId, assetId))
    .orderBy(
      desc(schema.assetReview.createdAt),
      asc(sql`case when ${schema.assetReview.stage} = ${OWNER_REVIEW_STAGE} then 1 else 0 end`),
      desc(schema.assetReview.id),
    )
    .limit(1);
  return review ?? null;
}

function assertManager(role: WorkspaceRole, verb: string): void {
  if (!canManageAssets(role)) {
    throw new AppError('access_denied', `only a workspace owner or admin can ${verb} an asset`);
  }
}

/* --------------------------------------------------------------- lifecycle */

export interface OwnerLifecycleInput {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  action: OwnerLifecycleAction;
}

export interface OwnerLifecycleResult {
  publicId: string;
  /** Where the asset now is. */
  lifecycleStatus: LifecycleStatus;
  /** Pause only: how many queued fetches were withdrawn with it. */
  cancelledOperations: number;
}

/**
 * Pause or resume one of the workspace's assets.
 *
 * - pause: `published` -> `suspended`. The asset leaves retrieval at once
 *   and its queued fetches are cancelled, so nothing rebuilds it while it is
 *   stopped; a build already running finishes but `lifecycleAfterBuild`
 *   leaves a suspended asset where it is.
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
    const target = await ownedAsset(tx, input.workspaceId, input.assetId, true);
    const review = await latestReview(tx, target.id);
    const available = ownerActionAvailable(
      {
        lifecycleStatus: target.lifecycleStatus,
        pausedByOwner: isOwnerPause(review),
      },
      input.action,
    );
    if (!available) {
      throw new AppError(
        'invalid_request',
        `cannot ${input.action} a ${target.lifecycleStatus} asset`,
      );
    }

    const next = ownerActionTarget(input.action);
    const updated = await tx
      .update(schema.asset)
      .set({ lifecycleStatus: next })
      .where(
        and(
          eq(schema.asset.id, target.id),
          eq(schema.asset.lifecycleStatus, target.lifecycleStatus),
        ),
      )
      .returning({ id: schema.asset.id });
    if (updated.length === 0) {
      throw new AppError('invalid_request', 'the asset moved while you decided');
    }

    let cancelledOperations = 0;
    if (input.action === 'pause') {
      const cancelled = await tx
        .update(schema.workflowOperation)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(schema.workflowOperation.assetId, target.id),
            inArray(schema.workflowOperation.operationType, [...FETCHING_OPERATIONS]),
            eq(schema.workflowOperation.status, 'pending'),
          ),
        )
        .returning({ id: schema.workflowOperation.id });
      cancelledOperations = cancelled.length;
    }

    await tx.insert(schema.assetReview).values({
      id: uuidv7(),
      assetId: target.id,
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

export interface EditAssetMetadataInput {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  title: string;
  description?: string;
  language?: string;
  /** The signed-in user, recorded as who declared when a declaration is posted. */
  userId?: string | null;
  /** A rights declaration posted with the edit; replaces the one on the row. */
  rights?: { origin?: unknown; license?: unknown; generation?: unknown; note?: unknown };
}

export interface EditAssetMetadataResult {
  publicId: string;
  lifecycleStatus: LifecycleStatus;
}

/**
 * Edits title, description and language, and the rights declaration when
 * one is posted. Who may see the asset is not edited here: that is the
 * channel it sits in (agent-first-proposal.md 6.2, channels/move.ts). An
 * asset already in a public channel keeps a declaration that permits it --
 * the move checked one, and an edit is not a way around that. A field that
 * is too long is refused, never truncated.
 */
export async function editAssetMetadata(
  input: EditAssetMetadataInput,
): Promise<EditAssetMetadataResult> {
  assertManager(input.role, 'edit');
  const database = db();

  return database.transaction(async (tx) => {
    const target = await ownedAsset(tx, input.workspaceId, input.assetId, true);
    const [materials, [listed]] = await Promise.all([
      assetMaterials(tx, target.id),
      tx
        .select({ id: schema.asset.id })
        .from(schema.asset)
        .where(and(eq(schema.asset.id, target.id), listedInPublicChannel()))
        .limit(1),
    ]);

    /*
     * The rights declaration rides with the edit (review-visibility-
     * proposal.md 5.1): a posted one replaces what the row has.
     */
    let rights: RightsDeclaration | null = materials.rights;
    if (input.rights && rightsPosted(input.rights)) {
      rights = parseRightsDeclaration(input.rights, { userId: input.userId ?? null, now: new Date() });
      if (!rights) throw new PlatformAssetRefused('rights_invalid', 'the rights declaration is incomplete');
      if (listed && !rightsAllowPublic(rights)) {
        throw new PlatformAssetRefused('rights_generated', 'model-generated content is not accepted as public');
      }
    }
    /* A refused field throws `PlatformAssetRefused` with the field's own
       code; the action turns that into the line the form shows. */
    const edit = editWorkspaceAsset({
      title: input.title,
      description: input.description,
      language: input.language,
      current: { lifecycleStatus: target.lifecycleStatus },
    });

    await tx
      .update(schema.asset)
      .set({
        title: edit.title,
        description: edit.description,
        language: edit.language,
        ...(rights !== materials.rights ? { rightsDeclaration: rights } : {}),
      })
      .where(eq(schema.asset.id, target.id));

    return { publicId: target.publicId, lifecycleStatus: target.lifecycleStatus };
  });
}

/* ------------------------------------------------------------- parse scope */

export interface UpdateParseScopeInput {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
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
  /** True when the asset has a version and a rebuild would apply the new scope. */
  rebuildAdvised: boolean;
}

/**
 * Stores the owner's parse scope on the source under the names `re0.json`
 * uses (`folders`, `excludeFolders`, `excludeFiles`; requirement.md 7.2) plus
 * `indexDepth` for a website source, and the refresh cadence where the
 * source has something to re-fetch. The next build applies it
 * (`fetchSnapshot` filters the snapshot); this call queues none, because
 * the owner may still be editing and the rebuild button is beside the form.
 */
export async function updateParseScope(input: UpdateParseScopeInput): Promise<UpdateParseScopeResult> {
  assertManager(input.role, 'configure');
  const database = db();

  return database.transaction(async (tx) => {
    const target = await ownedAsset(tx, input.workspaceId, input.assetId, true);
    if (target.lifecycleStatus === 'archived') {
      throw new AppError('invalid_request', 'an archived asset is not edited');
    }
    const [source] = await tx
      .select({ id: schema.source.id, type: schema.source.type, config: schema.source.config })
      .from(schema.source)
      .where(eq(schema.source.assetId, target.id))
      .orderBy(schema.source.id)
      .limit(1);
    if (!source) throw new AppError('invalid_request', 'the asset has no source');

    /*
     * The two halves of the form are decided together, and before either is
     * read: the scope half applies to fewer sources than the cadence half, so
     * asking the scope first refused a Notion asset's perfectly valid
     * "set this to daily". Refusals carry the field's own code
     * (`PlatformAssetRefused`).
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
        throw new PlatformAssetRefused('invalid_refresh_policy', 'unknown refresh policy');
      }
      refreshPolicy = input.refreshPolicy;
    }

    /* `withOwnerParseScope` marks the row as the owner's override, so the
       next build stamps `re0.json` over it no more (lib/domain/asset.ts). */
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
