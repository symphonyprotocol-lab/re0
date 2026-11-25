/**
 * The edges of a Ree's workspace files that other modules touch, kept apart
 * from workspace-rees.ts so rees.ts, admin-rees.ts and the knowledge page's
 * actions can call them without importing the workspace:
 * - publication (docs/design/agent-workspace.md §7.3): when a Ree becomes
 *   reachable by others (published), every workspace file of it that the
 *   secret scan flagged stops answering and waits for the owner, in the
 *   publishing transaction, so no public answer or citation can quote it
 *   even once;
 * - the owner trashing or restoring a file source (`agent_ree_file_exclusion`);
 * - which files the index worker needs to look at (`mayNeedIndex`), and
 *   queueing them when a Ree is deleted, taken down or restored.
 */
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Executor, type Tx } from '@/lib/infra/db';

export async function quarantineFlaggedFiles(tx: Tx, reeId: string, now = new Date()): Promise<number> {
  const rows = await tx
    .update(schema.knowledge)
    .set({ enabled: false, awaitingConfirmation: true, updatedAt: now })
    .where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'file'), isNotNull(schema.knowledge.secretFound), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)))
    .returning({ id: schema.knowledge.id });
  return rows.length;
}

/**
 * The owner took these `file` sources out of the Ree (trashed them on the
 * knowledge page): their files are excluded from its bindings, so no sync
 * restores or re-adds them.
 */
export async function excludeTrashedFiles(tx: Tx, reeId: string, knowledgeIds: readonly string[]): Promise<void> {
  if (knowledgeIds.length === 0) return;
  await tx.execute(sql`
    insert into ${schema.reeFileExclusion} (ree_id, entry_id)
    select k.ree_id, k.workspace_entry_id from ${schema.knowledge} k
    where k.ree_id = ${reeId}::uuid and k.kind = 'file' and k.workspace_entry_id is not null
      and k.id in (${sql.join(knowledgeIds.map((id) => sql`${id}::uuid`), sql`, `)})
    on conflict do nothing`);
}

/** The owner restored these sources: their files are members again (the next sync brings them up to date). */
export async function includeRestoredFiles(tx: Tx, reeId: string, knowledgeIds: readonly string[]): Promise<number> {
  if (knowledgeIds.length === 0) return 0;
  const files = await tx.select({ id: schema.knowledge.id }).from(schema.knowledge).where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'file'), inArray(schema.knowledge.id, [...knowledgeIds])));
  if (files.length === 0) return 0;
  await tx.execute(sql`
    delete from ${schema.reeFileExclusion} x
    using ${schema.knowledge} k
    where x.ree_id = ${reeId}::uuid and k.ree_id = x.ree_id and k.workspace_entry_id = x.entry_id
      and k.id in (${sql.join(knowledgeIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  return files.length;
}

/* ------------------------------------------------------------------ the index queue */

/** `path` (SQL text) is `folder` (SQL text) or below it, compared as Postgres lowers both. */
export const atOrBelow = (path: SQL, folder: SQL) => sql`(${folder} = '/' or lower(${path}) = lower(${folder}) or starts_with(lower(${path}), lower(${folder}) || '/'))`;

/**
 * Whether the file at `path` (SQL text) may need the index: the nearest of
 * itself and its folders with an index mode says `on`, or a live Ree's
 * binding covers it. Exclusions are left to the index worker, which drops
 * what it does not need; this only keeps files nobody indexes out of its
 * queue.
 */
export const mayNeedIndex = (workspaceId: string, path: SQL) => sql`(
  coalesce((select m.index_mode = 'on' from ${schema.workspaceEntry} m
    where m.workspace_id = ${workspaceId} and m.deleted_at is null and m.index_mode <> 'inherit' and ${atOrBelow(path, sql`m.path`)}
    order by char_length(m.path) desc limit 1), false)
  or exists (select 1 from ${schema.reeBinding} b
    join ${schema.workspaceEntry} be on be.id = b.entry_id and be.deleted_at is null
    join ${schema.ree} r on r.id = b.ree_id and r.deleted_at is null and r.moderated_at is null
    where b.workspace_id = ${workspaceId} and ${atOrBelow(path, sql`be.path`)}))`;

/** The text files at or below `folder` that may need the index or had one, queued for the index worker now. Answers how many. */
export async function queueIndexWithin(executor: Executor, workspaceId: string, folder: string, now: Date): Promise<number> {
  const rows = await executor.execute<{ id: string }>(sql`
    update ${schema.workspaceEntry} f set index_due_at = ${now.toISOString()}::timestamptz
    where f.workspace_id = ${workspaceId} and f.deleted_at is null and f.kind = 'file' and ${atOrBelow(sql`f.path`, sql`${folder}::text`)}
      and (f.indexed_revision_id is not null or ${mayNeedIndex(workspaceId, sql`f.path`)})
    returning f.id`);
  return rows.rows.length;
}

/**
 * The files a Ree's bindings cover, queued for the index worker: the Ree was
 * deleted (its bindings with it) or taken down, so what only it kept indexed
 * is dropped, or it was restored, so its files come back. Bindings are read
 * before the caller removes them.
 */
export async function queueReeBindings(executor: Executor, reeId: string, now: Date, options: { unbind?: boolean } = {}): Promise<void> {
  const bound = await executor
    .select({ workspaceId: schema.reeBinding.workspaceId, path: schema.workspaceEntry.path })
    .from(schema.reeBinding)
    .innerJoin(schema.workspaceEntry, and(eq(schema.workspaceEntry.id, schema.reeBinding.entryId), isNull(schema.workspaceEntry.deletedAt)))
    .where(eq(schema.reeBinding.reeId, reeId));
  if (options.unbind) await executor.delete(schema.reeBinding).where(eq(schema.reeBinding.reeId, reeId));
  for (const row of bound) await queueIndexWithin(executor, row.workspaceId, row.path, now);
}
