/**
 * The owner asks for a rebuild. architecture.md 8.4: the request queues a
 * refresh and returns; the drain (or the action's own follow-up run) builds
 * it. A pending build is reused rather than doubled -- it has not read the
 * source yet, so it will see whatever the owner changed -- and a running one
 * gets a fresh row behind it. The worker's digest check makes an unchanged
 * rebuild cheap: it updates `last_checked_at` and stops.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { uuidv7 } from '@/lib/domain/id';
import { requiresDomainVerification } from '@/lib/domain/domain-verification';
import { assertBuildAffordable } from '@/lib/application/plans/build-quota';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { canManageAssets, type WorkspaceRole } from './delete';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RebuildResult {
  operationId: string;
  /** False when a pending build was already waiting and was reused. */
  created: boolean;
}

export async function requestAssetRebuild(input: {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
}): Promise<RebuildResult> {
  if (!canManageAssets(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can rebuild an asset');
  }
  if (!UUID.test(input.assetId)) throw new AppError('asset_not_found', 'no such asset');

  /* asset-build-billing.md 4.1: refused before it is queued when the
     balance cannot cover the base fee. The source type decides whether the
     crawl limit joins the quote. */
  const [source] = await db()
    .select({ type: schema.source.type })
    .from(schema.source)
    .where(eq(schema.source.assetId, input.assetId))
    .limit(1);
  await assertBuildAffordable({
    workspaceId: input.workspaceId,
    fetchesPages: source ? requiresDomainVerification(source.type) : false,
  });

  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: schema.asset.id, lifecycleStatus: schema.asset.lifecycleStatus })
      .from(schema.asset)
      .where(
        and(
          eq(schema.asset.id, input.assetId),
          eq(schema.asset.ownerWorkspaceId, input.workspaceId),
          eq(schema.asset.isPlatformAsset, false),
          isNull(schema.asset.deletedAt),
        ),
      )
      .for('update');
    if (!locked) throw new AppError('asset_not_found', 'no such asset');
    if (locked.lifecycleStatus === 'archived') {
      throw new AppError('invalid_request', 'an archived asset is not rebuilt');
    }

    const [open] = await tx
      .select({ id: schema.workflowOperation.id, status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(
        and(
          eq(schema.workflowOperation.assetId, locked.id),
          inArray(schema.workflowOperation.operationType, ['ingest', 'refresh']),
          inArray(schema.workflowOperation.status, ['pending', 'running']),
        ),
      )
      .orderBy(desc(schema.workflowOperation.createdAt))
      .limit(1);
    if (open?.status === 'pending') return { operationId: open.id, created: false };

    const operationId = uuidv7();
    await tx.insert(schema.workflowOperation).values({
      id: operationId,
      assetId: locked.id,
      operationType: 'refresh',
      sourceDigest: null,
      status: 'pending',
    });
    return { operationId, created: true };
  });
}
