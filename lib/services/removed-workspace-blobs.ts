/**
 * The agent workspace's Blob objects (file contents under
 * `workspace/<workspace id>/<sha256>` and upload parts under
 * `workspace/<workspace id>/upload/…`), after migration 0101 took the
 * workspace out on 2026-11-26. Nothing names them any more.
 *
 * Only the prefixes of the workspaces listed in `removed_workspace` are
 * deleted, and 0101 lists only this database's own workspaces, in the same
 * transaction as its guard: a database that refused the drop, has not run
 * it, or never had a workspace lists none and deletes nothing, even when it
 * shares the Blob store with another environment. A workspace's row goes
 * once its prefix lists empty, so the job ends by itself.
 *
 * Run by the daily `/api/cron/purge-uploads`, after the orphan reaper, with
 * its own budget (REMOVED_WORKSPACE_PURGE_BATCH objects a run) and the
 * route's deadline. Remove it, with the table, once `removed_workspace` is empty.
 */
import { asc, eq } from 'drizzle-orm';
import { REMOVED_WORKSPACE_PURGE_BATCH } from '@/lib/constants';
import { deleteBlobs, listByPrefix } from '@/lib/infra/blob-access';
import { db, schema } from '@/lib/infra/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RemovedWorkspacePurge {
  /** Objects deleted in this run. */
  deleted: number;
  /** Workspaces whose prefix is now empty (their rows are gone). */
  finished: number;
  /** Workspaces still listed, for the next run. */
  left: number;
}

export async function purgeRemovedWorkspaceBlobs({ budget = REMOVED_WORKSPACE_PURGE_BATCH, deadline = Date.now() + 240_000 }: { budget?: number; deadline?: number } = {}): Promise<RemovedWorkspacePurge> {
  const table = schema.removedWorkspace;
  const rows = await db().select({ id: table.workspaceId }).from(table).orderBy(asc(table.removedAt), asc(table.workspaceId));
  let deleted = 0;
  let finished = 0;
  const spent = () => deleted >= budget || Date.now() > deadline;
  for (const { id } of rows) {
    if (spent()) break;
    if (!UUID.test(id)) continue;
    const prefix = `workspace/${id}/`;
    let cursor: string | undefined;
    let empty = false;
    do {
      const page = await listByPrefix(prefix, { cursor, limit: Math.min(1000, budget - deleted) });
      const pathnames = page.blobs.map((blob) => blob.pathname).filter((pathname) => pathname.startsWith(prefix));
      await deleteBlobs(pathnames);
      deleted += pathnames.length;
      cursor = page.cursor ?? undefined;
      empty = !cursor;
    } while (cursor && !spent());
    if (empty) {
      await db().delete(table).where(eq(table.workspaceId, id));
      finished += 1;
    }
  }
  return { deleted, finished, left: rows.length - finished };
}
