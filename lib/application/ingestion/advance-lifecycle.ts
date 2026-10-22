/**
 * Moves a user library's lifecycle once a build has published a version.
 *
 * Ingestion does not decide review or visibility: requirement.md 6.2 keeps
 * `lifecycle_status`, `visibility` and `index_status` apart, and the build
 * only ever writes the index. But a private user library still has to get
 * *somewhere* once its first version is live: it is queryable from now on.
 * A public one is not the build's to move -- it waits, indexed, for its
 * owner to bring the materials and submit it (review-visibility-proposal.md
 * 5; libraries/manage.ts `applyOwnerLifecycleAction`), and the review
 * layers run from that submission. The rule is pure (`lifecycleAfterBuild`);
 * this applies it, guarded on the status it read so a reviewer deciding at
 * the same moment is not overwritten.
 */
import { and, eq } from 'drizzle-orm';
import { lifecycleAfterBuild } from '@/lib/domain/library';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export async function advanceLifecycleAfterBuild(libraryId: string): Promise<void> {
  const database = db();
  const [row] = await database
    .select({
      lifecycleStatus: schema.library.lifecycleStatus,
      visibility: schema.library.visibility,
      isPlatformLibrary: schema.library.isPlatformLibrary,
    })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .limit(1);
  if (!row) return;

  const next = lifecycleAfterBuild(row);
  if (!next) return;

  await database
    .update(schema.library)
    .set({ lifecycleStatus: next })
    .where(
      and(eq(schema.library.id, libraryId), eq(schema.library.lifecycleStatus, row.lifecycleStatus)),
    );
}
