/**
 * Deleting an asset: the first of the two halves architecture.md 8.4 draws.
 *
 * A delete is not one statement. The request makes the asset unreachable
 * and returns; the Delete Workflow (`lib/application/ingestion/purge-asset`)
 * then removes what it held. Splitting it this way is what lets the request
 * answer immediately whatever the size of the index, and what lets cleanup be
 * retried without the asset ever becoming reachable again in between.
 *
 * What "unreachable" means, in one transaction on the row:
 *
 * - `deleted_at` is set. Every list and lookup of live assets filters on
 *   it, so the asset is gone from the dashboard, the console, the catalogue
 *   and the routing index in the same commit;
 * - the lifecycle goes to `archived` and the index to `deleting`, so anything
 *   that reads state rather than the tombstone -- `isQueryable`, the catalogue
 *   predicate, the build's own guard -- refuses it too;
 * - the publication pointer is withdrawn. A query pins `current_version_id`
 *   at its start (architecture.md 8.3), and a null pointer is how a request
 *   that arrives after this commit finds nothing to pin;
 * - its redirects and sources are removed, and its queued operations are
 *   cancelled, so no alias resolves to it and no refresh rebuilds it;
 * - one Delete Operation is queued for the workflow.
 *
 * The `asset` row itself is never removed. `usage_event` is an append-only
 * fact that references it, and a deleted asset's billing history is still
 * history. The Asset ID is released:
 * `asset_public_id_uq` is partial over live rows, so the workspace that
 * deleted `/owner/repo` can add it again.
 *
 * This module is the mechanism. Who may delete what is decided by the two
 * callers: `deleteWorkspaceAsset` below for a workspace's own asset, and
 * `deletePlatformAsset` in `lib/application/administration` for one the
 * platform publishes, which also records the operator's reason.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { refreshChannelProfile } from '@/lib/application/channels/profile';
import { retireShowcaseForAsset } from '@/lib/application/showcase/retire';

/** `workflow_operation.operation_type` of the cleanup the workflow runs. */
export const DELETE_OPERATION = 'delete';

export interface DeleteAssetResult {
  assetId: string;
  publicId: string;
  /** The queued Delete Operation. Null only when the asset was already deleted and none is on record. */
  operationId: string | null;
  /** True when this call found the tombstone already written and changed nothing. */
  alreadyDeleted: boolean;
}

/**
 * Marks one asset deleted and queues its cleanup. Idempotent: a second call
 * on the same asset reports `alreadyDeleted` and returns the operation the
 * first one queued, so a retried request cannot queue the purge twice.
 *
 * The row is locked for the whole transaction. The cancel-then-queue pair
 * below has to be atomic with respect to a refresh being queued at the same
 * moment, or the refresh lands after the cancel and a deleted asset gets
 * rebuilt; `requestPlatformAssetRefresh` re-reads the row it is about, and
 * the lock makes it see the tombstone.
 */
export async function markAssetDeleted(
  assetId: string,
  now: Date = new Date(),
): Promise<DeleteAssetResult> {
  const database = db();
  let formerChannel: string | null = null;

  const result = await database.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: schema.asset.id,
        publicId: schema.asset.publicId,
        deletedAt: schema.asset.deletedAt,
      })
      .from(schema.asset)
      .where(eq(schema.asset.id, assetId))
      .for('update');

    if (!row) throw new AppError('library_not_found', 'no such asset');

    if (row.deletedAt) {
      const [open] = await tx
        .select({ id: schema.workflowOperation.id })
        .from(schema.workflowOperation)
        .where(
          and(
            eq(schema.workflowOperation.assetId, row.id),
            eq(schema.workflowOperation.operationType, DELETE_OPERATION),
          ),
        )
        .orderBy(desc(schema.workflowOperation.createdAt))
        .limit(1);
      return {
        assetId: row.id,
        publicId: row.publicId,
        operationId: open?.id ?? null,
        alreadyDeleted: true,
      };
    }

    /* Out of its channel at once: a tombstone is shown nowhere
       (agent-first-proposal.md 6.1), and the row stays for billing history,
       so the cascade on purge would come too late. */
    const [left] = await tx
      .delete(schema.channelAsset)
      .where(eq(schema.channelAsset.assetId, row.id))
      .returning({ channelId: schema.channelAsset.channelId });
    formerChannel = left?.channelId ?? null;

    await tx
      .update(schema.asset)
      .set({
        deletedAt: now,
        lifecycleStatus: 'archived',
        indexStatus: 'deleting',
        currentVersionId: null,
      })
      .where(eq(schema.asset.id, row.id));

    /* A redirect to a deleted asset resolves to nothing; and the ids it
       held must be free for whoever creates them next. */
    await tx.delete(schema.assetAlias).where(eq(schema.assetAlias.assetId, row.id));

    /* The asset's showcase page goes with it (lib/application/showcase/retire.ts). */
    await retireShowcaseForAsset(tx, row.id, now);

    /* Sources are fetch instructions. A deleted asset is never fetched. */
    await tx.delete(schema.source).where(eq(schema.source.assetId, row.id));

    /*
     * Queued work is withdrawn rather than left to fail. A build that is
     * already running cannot be stopped here; `buildVersion` and
     * `publishVersion` both refuse a deleted asset, so it fails at its next
     * guard without moving the pointer back.
     */
    await tx
      .update(schema.workflowOperation)
      .set({ status: 'cancelled', updatedAt: now })
      .where(
        and(
          eq(schema.workflowOperation.assetId, row.id),
          eq(schema.workflowOperation.status, 'pending'),
        ),
      );

    const operationId = uuidv7();
    await tx.insert(schema.workflowOperation).values({
      id: operationId,
      assetId: row.id,
      operationType: DELETE_OPERATION,
      sourceDigest: null,
      status: 'pending',
    });

    return { assetId: row.id, publicId: row.publicId, operationId, alreadyDeleted: false };
  });

  /* The channel's profile drops what the deleted asset contributed (agent-first-proposal.md 3.7). */
  if (formerChannel) await refreshChannelProfile(formerChannel).catch(() => {});
  return result;
}

export type WorkspaceRole = 'owner' | 'admin' | 'developer' | 'viewer';

/** requirement.md 3.3: owners manage assets; admins may too. The rest read. */
export function canManageAssets(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Creating and deleting are the same right; both are managing an asset. */
export const canDeleteAssets = canManageAssets;

/** requirement.md 3.3: keys are the owner's. A developer may use one, not mint one. */
export function canManageApiKeys(role: WorkspaceRole): boolean {
  return role === 'owner';
}

export interface DeleteWorkspaceAssetInput {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
}

/**
 * A workspace deletes one of its own assets. requirement.md 5.2: deletion
 * is an owner-side operation with a definite outcome.
 *
 * Ownership is a predicate of the lookup, not a check after it. An asset the
 * workspace does not own -- someone else's, or the platform's -- answers
 * `library_not_found`, the same as one that does not exist: architecture.md
 * 5.2 forbids letting a caller learn that a private asset exists by being
 * refused differently from a stranger.
 */
export async function deleteWorkspaceAsset(
  input: DeleteWorkspaceAssetInput,
): Promise<DeleteAssetResult> {
  if (!canDeleteAssets(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can delete an asset');
  }
  if (!isUuid(input.assetId)) throw new AppError('library_not_found', 'no such asset');

  const [owned] = await db()
    .select({ id: schema.asset.id })
    .from(schema.asset)
    .where(
      and(
        eq(schema.asset.id, input.assetId),
        eq(schema.asset.ownerWorkspaceId, input.workspaceId),
        eq(schema.asset.isPlatformAsset, false),
        isNull(schema.asset.deletedAt),
      ),
    )
    .limit(1);

  if (!owned) throw new AppError('library_not_found', 'no such asset');

  return markAssetDeleted(owned.id);
}

/** Cheap guard so a junk id cannot reach Postgres as a bad uuid cast. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
