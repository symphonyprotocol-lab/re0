/**
 * Moves a user library's lifecycle once a build has published a version.
 *
 * Ingestion does not decide who sees an asset: that is the channel it is in
 * (agent-first-proposal.md 6.2), kept apart from `lifecycle_status` and
 * `index_status`, and the build only ever writes the index. But a user
 * library still has to get *somewhere* once its first version is live: it
 * is queryable from now on, in a channel or not (public review before
 * publication ended on 2026-10-23). The rule is pure (`lifecycleAfterBuild`); this applies it,
 * guarded on the status it read so a suspension landing at the same moment
 * is not overwritten.
 */
import { and, eq } from 'drizzle-orm';
import { lifecycleAfterBuild } from '@/lib/domain/library';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { refreshChannelProfileOfAsset } from '@/lib/application/channels/profile';

export async function advanceLifecycleAfterBuild(libraryId: string): Promise<void> {
  const database = db();
  const [row] = await database
    .select({
      lifecycleStatus: schema.library.lifecycleStatus,
      isPlatformLibrary: schema.library.isPlatformLibrary,
    })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .limit(1);
  if (!row) return;

  const next = lifecycleAfterBuild(row);
  if (next) {
    await database
      .update(schema.library)
      .set({ lifecycleStatus: next })
      .where(
        and(eq(schema.library.id, libraryId), eq(schema.library.lifecycleStatus, row.lifecycleStatus)),
      );
  }

  /* The channel profile aggregates the member assets' profiles, which this
     build just rewrote (agent-first-proposal.md 3.7) -- after the status
     moved, so a first build counts its own asset. Best-effort: a stale
     profile costs routing quality for a while, never the build. */
  await refreshChannelProfileOfAsset(libraryId).catch(() => {});
}
