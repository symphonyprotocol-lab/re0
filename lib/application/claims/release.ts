/**
 * Use case: an owner gives an asset up. requirement.md 7.3.5.
 *
 * The asset returns to having no owner; the verified claim that made this
 * workspace the owner is closed as `revoked`
 * with the release named as the reason, so the record shows how ownership
 * ended rather than a claim that still says `verified` on an unowned asset.
 *
 * Only a *claimed* asset can be released. 7.3.5 describes abandoning
 * ownership as a claimed asset returning to the unowned pool; an asset
 * whose creator is its owner by construction -- an upload, a Notion
 * connection -- never made that round trip and has no claim to give
 * up. Releasing one would strand it for good: `owner_workspace_id` is the
 * tenancy key for manage, rebuild, delete, detail and files, and
 * `claimMethodsFor` offers those source types no way back in, so the asset
 * would stay public and live with nobody able to touch it. It would also drop
 * out of `countWorkspaceAssets`, making release-then-create a way around
 * the plan's asset limit.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { auditClaim } from './shared';

export interface ReleaseOwnershipInput {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  now?: Date;
}

export interface ReleaseOwnershipResult {
  publicId: string;
}

export async function releaseOwnership(
  input: ReleaseOwnershipInput,
): Promise<ReleaseOwnershipResult> {
  if (!canManageAssets(input.role)) {
    throw new AppError('access_denied', 'only an owner or admin may release an asset');
  }
  const now = input.now ?? new Date();

  const outcome = await db().transaction(async (tx) => {
    const [asset] = await tx
      .select({ id: schema.asset.id, publicId: schema.asset.publicId })
      .from(schema.asset)
      .where(
        and(
          eq(schema.asset.id, input.assetId),
          eq(schema.asset.ownerWorkspaceId, input.workspaceId),
          isNull(schema.asset.deletedAt),
        ),
      )
      .for('update');
    if (!asset) throw new AppError('library_not_found', 'no such asset');

    /*
     * The verified claim is what makes this a release rather than an orphaning,
     * so it is closed first and its absence refuses the whole thing. Same
     * `library_not_found` as an asset this workspace does not own: from the
     * caller's side both mean "there is no ownership here you can give up".
     */
    const closed = await tx
      .update(schema.assetClaim)
      .set({ status: 'revoked', rulingReason: 'released_by_owner' })
      .where(
        and(
          eq(schema.assetClaim.assetId, asset.id),
          eq(schema.assetClaim.claimantWorkspaceId, input.workspaceId),
          eq(schema.assetClaim.status, 'verified'),
        ),
      )
      .returning({ id: schema.assetClaim.id });
    if (closed.length === 0) {
      throw new AppError(
        'library_not_found',
        'this asset was never claimed; its creator is its owner',
      );
    }

    await tx
      .update(schema.asset)
      .set({ ownerWorkspaceId: null })
      .where(eq(schema.asset.id, asset.id));

    return { publicId: asset.publicId, claimIds: closed.map((row) => row.id) };
  });

  await auditClaim({
    action: 'claim.release',
    claimId: outcome.claimIds[0] ?? input.assetId,
    reason: 'released_by_owner',
    before: { ownerWorkspaceId: input.workspaceId, claimIds: outcome.claimIds },
    after: { ownerWorkspaceId: null, assetId: input.assetId, publicId: outcome.publicId, at: now.toISOString() },
    result: 'success',
  });

  return { publicId: outcome.publicId };
}
