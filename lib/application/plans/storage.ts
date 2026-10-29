/**
 * Workspace storage: how much a workspace may hold, and how much it does.
 *
 * agent-first-proposal.md 8.1 bounds a workspace's content as a whole rather
 * than library by library: 500 MB on the `base` tier, 2 GB on `extended`.
 * The tier lives on the user (`user.storage_tier`) because what raises it --
 * buying Additional Calls, later subscribing to a channel -- is something a
 * user does, and it applies to that user's personal workspace. A workspace
 * reads the tier through its owners; today a workspace has exactly one.
 *
 * Usage is the sum of `library.storage_bytes` over the workspace's live
 * libraries, measured the way a build measures itself (requirement.md 4.1:
 * decompressed, pre-normalisation content bytes). A deleted library is a
 * tombstone and holds nothing.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { isStorageTier, storageCapacityBytes, type StorageTier } from '@/lib/domain/plans';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';
import type { Tx } from './quota';

export interface WorkspaceStorage {
  tier: StorageTier;
  capacityBytes: number;
  /** Bytes held by live libraries, less the one excluded. */
  usedBytes: number;
  /** `capacityBytes - usedBytes`, floored at zero. */
  remainingBytes: number;
}

type Executor = Tx | Database;

/**
 * The tier a workspace is on: `extended` as soon as any owner is. A workspace
 * with no owner row at all -- a platform fixture, a test -- is on `base`.
 */
export async function workspaceStorageTier(workspaceId: string, executor: Executor = db()): Promise<StorageTier> {
  const owners = await executor
    .select({ tier: schema.user.storageTier })
    .from(schema.workspaceMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId))
    .where(and(eq(schema.workspaceMember.workspaceId, workspaceId), eq(schema.workspaceMember.role, 'owner')));
  return owners.some((owner) => isStorageTier(owner.tier) && owner.tier === 'extended') ? 'extended' : 'base';
}

/**
 * Capacity against usage. `excludeLibraryId` leaves one library out of the
 * sum: a rebuild replaces that library's content rather than adding to it,
 * so what it may grow into is the capacity less everything *else*.
 */
export async function workspaceStorage(
  workspaceId: string,
  options: { excludeLibraryId?: string; executor?: Executor } = {},
): Promise<WorkspaceStorage> {
  const executor = options.executor ?? db();
  const tier = await workspaceStorageTier(workspaceId, executor);
  const [used] = await executor
    .select({ bytes: sql<string>`coalesce(sum(${schema.library.storageBytes}), 0)::bigint` })
    .from(schema.library)
    .where(
      and(
        eq(schema.library.ownerWorkspaceId, workspaceId),
        isNull(schema.library.deletedAt),
        ...(options.excludeLibraryId ? [ne(schema.library.id, options.excludeLibraryId)] : []),
      ),
    );
  const capacityBytes = storageCapacityBytes(tier);
  const usedBytes = Number(used?.bytes ?? 0);
  return { tier, capacityBytes, usedBytes, remainingBytes: Math.max(0, capacityBytes - usedBytes) };
}

/**
 * Moves every owner of the workspace to `extended`, for good. Called inside
 * the transaction that grants a bought pack, so the purchase and the raise
 * land together or not at all. Idempotent: an owner already there stays.
 */
export async function extendStorageTier(tx: Tx, workspaceId: string): Promise<void> {
  const owners = tx
    .select({ userId: schema.workspaceMember.userId })
    .from(schema.workspaceMember)
    .where(and(eq(schema.workspaceMember.workspaceId, workspaceId), eq(schema.workspaceMember.role, 'owner')));
  await tx
    .update(schema.user)
    .set({ storageTier: 'extended', updatedAt: new Date() })
    .where(and(sql`${schema.user.id} in ${owners}`, ne(schema.user.storageTier, 'extended')));
}
