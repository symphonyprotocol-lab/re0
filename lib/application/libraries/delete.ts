/**
 * Deleting a library: the first of the two halves architecture.md 8.4 draws.
 *
 * A delete is not one statement. The request makes the library unreachable
 * and returns; the Delete Workflow (`lib/application/ingestion/purge-library`)
 * then removes what it held. Splitting it this way is what lets the request
 * answer immediately whatever the size of the index, and what lets cleanup be
 * retried without the library ever becoming reachable again in between.
 *
 * What "unreachable" means, in one transaction on the row:
 *
 * - `deleted_at` is set. Every list and lookup of live libraries filters on
 *   it, so the library is gone from the dashboard, the console, the catalogue
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
 * The `library` row itself is never removed. `usage_event`, `earning_event`
 * and `settlement` are append-only facts that reference it, and a deleted
 * library's billing history is still history. The Library ID is released:
 * `library_public_id_uq` is partial over live rows, so the workspace that
 * deleted `/owner/repo` can add it again.
 *
 * This module is the mechanism. Who may delete what is decided by the two
 * callers: `deleteWorkspaceLibrary` below for a workspace's own library, and
 * `deletePlatformLibrary` in `lib/application/administration` for one the
 * platform publishes, which also records the operator's reason.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { retireShowcaseForLibrary } from '@/lib/application/showcase/retire';

/** `workflow_operation.operation_type` of the cleanup the workflow runs. */
export const DELETE_OPERATION = 'delete';

export interface DeleteLibraryResult {
  libraryId: string;
  publicId: string;
  /** The queued Delete Operation. Null only when the library was already deleted and none is on record. */
  operationId: string | null;
  /** True when this call found the tombstone already written and changed nothing. */
  alreadyDeleted: boolean;
}

/**
 * Marks one library deleted and queues its cleanup. Idempotent: a second call
 * on the same library reports `alreadyDeleted` and returns the operation the
 * first one queued, so a retried request cannot queue the purge twice.
 *
 * The row is locked for the whole transaction. The cancel-then-queue pair
 * below has to be atomic with respect to a refresh being queued at the same
 * moment, or the refresh lands after the cancel and a deleted library gets
 * rebuilt; `requestPlatformLibraryRefresh` re-reads the row it is about, and
 * the lock makes it see the tombstone.
 */
export async function markLibraryDeleted(
  libraryId: string,
  now: Date = new Date(),
): Promise<DeleteLibraryResult> {
  const database = db();

  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: schema.library.id,
        publicId: schema.library.publicId,
        deletedAt: schema.library.deletedAt,
      })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId))
      .for('update');

    if (!row) throw new AppError('library_not_found', 'no such library');

    if (row.deletedAt) {
      const [open] = await tx
        .select({ id: schema.workflowOperation.id })
        .from(schema.workflowOperation)
        .where(
          and(
            eq(schema.workflowOperation.libraryId, row.id),
            eq(schema.workflowOperation.operationType, DELETE_OPERATION),
          ),
        )
        .orderBy(desc(schema.workflowOperation.createdAt))
        .limit(1);
      return {
        libraryId: row.id,
        publicId: row.publicId,
        operationId: open?.id ?? null,
        alreadyDeleted: true,
      };
    }

    await tx
      .update(schema.library)
      .set({
        deletedAt: now,
        lifecycleStatus: 'archived',
        indexStatus: 'deleting',
        currentVersionId: null,
      })
      .where(eq(schema.library.id, row.id));

    /* A redirect to a deleted library resolves to nothing; and the ids it
       held must be free for whoever creates them next. */
    await tx.delete(schema.libraryAlias).where(eq(schema.libraryAlias.libraryId, row.id));

    /* The library's showcase page goes with it (lib/application/showcase/retire.ts). */
    await retireShowcaseForLibrary(tx, row.id, now);

    /* Sources are fetch instructions. A deleted library is never fetched. */
    await tx.delete(schema.source).where(eq(schema.source.libraryId, row.id));

    /*
     * Queued work is withdrawn rather than left to fail. A build that is
     * already running cannot be stopped here; `buildVersion` and
     * `publishVersion` both refuse a deleted library, so it fails at its next
     * guard without moving the pointer back.
     */
    await tx
      .update(schema.workflowOperation)
      .set({ status: 'cancelled', updatedAt: now })
      .where(
        and(
          eq(schema.workflowOperation.libraryId, row.id),
          eq(schema.workflowOperation.status, 'pending'),
        ),
      );

    const operationId = uuidv7();
    await tx.insert(schema.workflowOperation).values({
      id: operationId,
      libraryId: row.id,
      operationType: DELETE_OPERATION,
      sourceDigest: null,
      status: 'pending',
    });

    return { libraryId: row.id, publicId: row.publicId, operationId, alreadyDeleted: false };
  });
}

export type WorkspaceRole = 'owner' | 'admin' | 'developer' | 'viewer';

/** requirement.md 3.3: owners manage libraries; admins may too. The rest read. */
export function canManageLibraries(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** Creating and deleting are the same right; both are managing a library. */
export const canDeleteLibraries = canManageLibraries;

/** requirement.md 3.3: keys are the owner's. A developer may use one, not mint one. */
export function canManageApiKeys(role: WorkspaceRole): boolean {
  return role === 'owner';
}

export interface DeleteWorkspaceLibraryInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
}

/**
 * A workspace deletes one of its own libraries. requirement.md 5.2: deletion
 * is an owner-side operation with a definite outcome.
 *
 * Ownership is a predicate of the lookup, not a check after it. A library the
 * workspace does not own -- someone else's, or the platform's -- answers
 * `library_not_found`, the same as one that does not exist: architecture.md
 * 5.2 forbids letting a caller learn that a private library exists by being
 * refused differently from a stranger.
 */
export async function deleteWorkspaceLibrary(
  input: DeleteWorkspaceLibraryInput,
): Promise<DeleteLibraryResult> {
  if (!canDeleteLibraries(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can delete a library');
  }
  if (!isUuid(input.libraryId)) throw new AppError('library_not_found', 'no such library');

  const [owned] = await db()
    .select({ id: schema.library.id })
    .from(schema.library)
    .where(
      and(
        eq(schema.library.id, input.libraryId),
        eq(schema.library.ownerWorkspaceId, input.workspaceId),
        eq(schema.library.isPlatformLibrary, false),
        isNull(schema.library.deletedAt),
      ),
    )
    .limit(1);

  if (!owned) throw new AppError('library_not_found', 'no such library');

  return markLibraryDeleted(owned.id);
}

/** Cheap guard so a junk id cannot reach Postgres as a bad uuid cast. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
