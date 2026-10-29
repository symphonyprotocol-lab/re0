/**
 * Use case: an owner gives a library up. requirement.md 7.3.5.
 *
 * The library returns to having no owner and stops earning (7.3.6); the
 * verified claim that made this workspace the owner is closed as `revoked`
 * with the release named as the reason, so the record shows how ownership
 * ended rather than a claim that still says `verified` on an unowned library.
 *
 * Only a *claimed* library can be released. 7.3.5 describes abandoning
 * ownership as a claimed library returning to the unowned pool; a library
 * whose creator is its owner by construction -- an upload, a Notion
 * connection -- never made that round trip and has no claim to give
 * up. Releasing one would strand it for good: `owner_workspace_id` is the
 * tenancy key for manage, rebuild, delete, detail and files, and
 * `claimMethodsFor` offers those source types no way back in, so the library
 * would stay public and live with nobody able to touch it. It would also drop
 * out of `countWorkspaceLibraries`, making release-then-create a way around
 * the plan's library limit.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { auditClaim } from './shared';

export interface ReleaseOwnershipInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  now?: Date;
}

export interface ReleaseOwnershipResult {
  publicId: string;
}

export async function releaseOwnership(
  input: ReleaseOwnershipInput,
): Promise<ReleaseOwnershipResult> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only an owner or admin may release a library');
  }
  const now = input.now ?? new Date();

  const outcome = await db().transaction(async (tx) => {
    const [library] = await tx
      .select({ id: schema.library.id, publicId: schema.library.publicId })
      .from(schema.library)
      .where(
        and(
          eq(schema.library.id, input.libraryId),
          eq(schema.library.ownerWorkspaceId, input.workspaceId),
          isNull(schema.library.deletedAt),
        ),
      )
      .for('update');
    if (!library) throw new AppError('library_not_found', 'no such library');

    /*
     * The verified claim is what makes this a release rather than an orphaning,
     * so it is closed first and its absence refuses the whole thing. Same
     * `library_not_found` as a library this workspace does not own: from the
     * caller's side both mean "there is no ownership here you can give up".
     */
    const closed = await tx
      .update(schema.libraryClaim)
      .set({ status: 'revoked', rulingReason: 'released_by_owner' })
      .where(
        and(
          eq(schema.libraryClaim.libraryId, library.id),
          eq(schema.libraryClaim.claimantWorkspaceId, input.workspaceId),
          eq(schema.libraryClaim.status, 'verified'),
        ),
      )
      .returning({ id: schema.libraryClaim.id });
    if (closed.length === 0) {
      throw new AppError(
        'library_not_found',
        'this library was never claimed; its creator is its owner',
      );
    }

    await tx
      .update(schema.library)
      .set({ ownerWorkspaceId: null })
      .where(eq(schema.library.id, library.id));

    return { publicId: library.publicId, claimIds: closed.map((row) => row.id) };
  });

  await auditClaim({
    action: 'claim.release',
    claimId: outcome.claimIds[0] ?? input.libraryId,
    reason: 'released_by_owner',
    before: { ownerWorkspaceId: input.workspaceId, claimIds: outcome.claimIds },
    after: { ownerWorkspaceId: null, libraryId: input.libraryId, publicId: outcome.publicId, at: now.toISOString() },
    result: 'success',
  });

  return { publicId: outcome.publicId };
}
