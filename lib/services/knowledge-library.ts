/**
 * Managing a Ree's knowledge (rebuild-proposal.md 8.2, prototype
 * knowledge.js): folders, the "参与回答" switch, renaming, moving, batch
 * actions, the trash and its 30-day purge.
 *
 * Every action takes ids and applies to the rows of this Ree only; a batch
 * is one transaction, so it lands whole or not at all. Each change writes a
 * line in the row's processing record.
 */
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { KNOWLEDGE_BATCH_MAX, TRASH_RETENTION_DAYS } from '@/lib/constants';
import { activity, cleanFolderName, cleanTitle } from '@/lib/domain/knowledge';
import { deleteBlob } from '@/lib/infra/blob';
import { db, schema, type Tx } from '@/lib/infra/db';
import { appendActivity, checkReprocess, KnowledgeInputError, reprocessInTx } from '@/lib/services/knowledge';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > KNOWLEDGE_BATCH_MAX) return null;
  const ids = [...new Set(raw.map(String))];
  return ids.every((id) => UUID.test(id)) ? ids : null;
}

/* ----------------------------------------------------------------- folders */

export class FolderError extends Error {
  constructor(readonly code: 'invalid_folder_name' | 'folder_exists' | 'not_found') {
    super(code);
    this.name = 'FolderError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string }; code?: string }) ?? {};
  return cause.code === '23505' || cause.cause?.code === '23505';
}

async function nameTaken(tx: Tx, reeId: string, name: string, except: string | null): Promise<boolean> {
  const conditions = [eq(schema.knowledgeFolder.reeId, reeId), sql`lower(${schema.knowledgeFolder.name}) = lower(${name})`];
  if (except) conditions.push(ne(schema.knowledgeFolder.id, except));
  const [row] = await tx.select({ id: schema.knowledgeFolder.id }).from(schema.knowledgeFolder).where(and(...conditions)).limit(1);
  return Boolean(row);
}

export async function createFolderInTx(tx: Tx, reeId: string, raw: unknown): Promise<{ id: string; name: string }> {
  const name = cleanFolderName(raw);
  if (!name) throw new FolderError('invalid_folder_name');
  if (await nameTaken(tx, reeId, name, null)) throw new FolderError('folder_exists');
  try {
    const [row] = await tx.insert(schema.knowledgeFolder).values({ reeId, name }).returning({ id: schema.knowledgeFolder.id, name: schema.knowledgeFolder.name });
    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new FolderError('folder_exists');
    throw error;
  }
}

export async function createFolder(reeId: string, raw: unknown): Promise<{ id: string; name: string }> {
  return db().transaction((tx) => createFolderInTx(tx, reeId, raw));
}

export async function renameFolder(reeId: string, folderId: string, raw: unknown): Promise<{ id: string; name: string }> {
  if (!UUID.test(folderId)) throw new FolderError('not_found');
  const name = cleanFolderName(raw);
  if (!name) throw new FolderError('invalid_folder_name');
  return db().transaction(async (tx) => {
    if (await nameTaken(tx, reeId, name, folderId)) throw new FolderError('folder_exists');
    try {
      const [row] = await tx
        .update(schema.knowledgeFolder)
        .set({ name })
        .where(and(eq(schema.knowledgeFolder.id, folderId), eq(schema.knowledgeFolder.reeId, reeId)))
        .returning({ id: schema.knowledgeFolder.id, name: schema.knowledgeFolder.name });
      if (!row) throw new FolderError('not_found');
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new FolderError('folder_exists');
      throw error;
    }
  });
}

/** Its sources -- trash included -- go back to "未分组" (the foreign key's `on delete set null`), unchanged otherwise. */
export async function deleteFolder(reeId: string, folderId: string): Promise<boolean> {
  if (!UUID.test(folderId)) return false;
  const rows = await db()
    .delete(schema.knowledgeFolder)
    .where(and(eq(schema.knowledgeFolder.id, folderId), eq(schema.knowledgeFolder.reeId, reeId)))
    .returning({ id: schema.knowledgeFolder.id });
  return rows.length > 0;
}

export async function listFolders(reeId: string) {
  return db()
    .select({ id: schema.knowledgeFolder.id, name: schema.knowledgeFolder.name, createdAt: schema.knowledgeFolder.createdAt })
    .from(schema.knowledgeFolder)
    .where(eq(schema.knowledgeFolder.reeId, reeId))
    .orderBy(schema.knowledgeFolder.createdAt);
}

/* ----------------------------------------------------------------- actions */

export const BATCH_ACTIONS = ['move', 'reprocess', 'pause', 'resume', 'trash', 'restore'] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];

export type BatchInput =
  | { action: 'move'; ids: string[]; folderId: string | null; newFolderName?: string }
  | { action: Exclude<BatchAction, 'move'>; ids: string[] };

export interface BatchResult {
  /** Rows the action changed; rows already in the target state are counted out. */
  changed: number;
  /** Rows to process after the response (reprocess). */
  process: string[];
  folder?: { id: string; name: string } | null;
}

async function rowsOf(tx: Tx, reeId: string, ids: string[], trash: boolean) {
  const rows = await tx
    .select({ id: schema.knowledge.id, status: schema.knowledge.status, enabled: schema.knowledge.enabled, folderId: schema.knowledge.folderId })
    .from(schema.knowledge)
    .where(
      and(
        inArray(schema.knowledge.id, ids),
        eq(schema.knowledge.reeId, reeId),
        trash ? isNotNull(schema.knowledge.deletedAt) : isNull(schema.knowledge.deletedAt),
      ),
    )
    .for('update');
  /* "部分来源已不在知识库中，请重新选择": a stale selection is refused, not half-applied. */
  if (rows.length !== ids.length) throw new KnowledgeInputError('not_found');
  return rows;
}

const busy = (row: { status: string }) => row.status === 'pending' || row.status === 'processing';

export async function runBatch(ownerId: string, reeId: string, input: BatchInput, now = new Date()): Promise<BatchResult> {
  const ids = input.ids;
  if (input.action === 'reprocess') {
    const rows = await db()
      .select({ id: schema.knowledge.id, kind: schema.knowledge.kind, source: schema.knowledge.source })
      .from(schema.knowledge)
      .where(and(inArray(schema.knowledge.id, ids), eq(schema.knowledge.reeId, reeId), isNull(schema.knowledge.deletedAt)));
    if (rows.length !== ids.length) throw new KnowledgeInputError('not_found');
    await checkReprocess(ownerId, rows);
    await db().transaction((tx) => reprocessInTx(tx, ownerId, reeId, ids, now));
    return { changed: ids.length, process: ids };
  }

  return db().transaction(async (tx) => {
    const touch = async (changed: string[], set: Partial<typeof schema.knowledge.$inferInsert>, entry: ReturnType<typeof activity>) => {
      if (changed.length === 0) return;
      await tx
        .update(schema.knowledge)
        .set({ ...set, updatedAt: now, activity: appendActivity([entry]) })
        .where(inArray(schema.knowledge.id, changed));
    };
    switch (input.action) {
      case 'move': {
        const rows = await rowsOf(tx, reeId, ids, false);
        let folder: { id: string; name: string } | null = null;
        if (input.newFolderName !== undefined) folder = await createFolderInTx(tx, reeId, input.newFolderName);
        else if (input.folderId) {
          const [found] = await tx
            .select({ id: schema.knowledgeFolder.id, name: schema.knowledgeFolder.name })
            .from(schema.knowledgeFolder)
            .where(and(eq(schema.knowledgeFolder.id, input.folderId), eq(schema.knowledgeFolder.reeId, reeId)))
            .limit(1);
          if (!found) throw new KnowledgeInputError('invalid_folder');
          folder = found;
        }
        const target = folder?.id ?? null;
        const changed = rows.filter((row) => row.folderId !== target).map((row) => row.id);
        await touch(changed, { folderId: target }, activity('moved', { folder: folder?.name ?? '' }, now));
        return { changed: changed.length, process: [], folder };
      }
      case 'pause':
      case 'resume': {
        const value = input.action === 'resume';
        const rows = await rowsOf(tx, reeId, ids, false);
        const changed = rows.filter((row) => row.enabled !== value).map((row) => row.id);
        await touch(changed, { enabled: value }, activity(value ? 'enabled' : 'paused', undefined, now));
        return { changed: changed.length, process: [] };
      }
      case 'trash': {
        const rows = await rowsOf(tx, reeId, ids, false);
        /* A source being processed holds credits; it finishes before it can go. */
        if (rows.some(busy)) throw new KnowledgeInputError('busy');
        await touch(ids, { deletedAt: now }, activity('trashed', undefined, now));
        return { changed: ids.length, process: [] };
      }
      case 'restore': {
        await rowsOf(tx, reeId, ids, true);
        await touch(ids, { deletedAt: null }, activity('restored', undefined, now));
        return { changed: ids.length, process: [] };
      }
    }
    throw new KnowledgeInputError('not_found');
  });
}

/** The display name only; the original name and the source stay (prototype "修改名称"). */
export async function renameKnowledge(reeId: string, knowledgeId: string, raw: unknown, now = new Date()): Promise<string> {
  if (!UUID.test(knowledgeId)) throw new KnowledgeInputError('not_found');
  const title = cleanTitle(raw);
  if (!title) throw new KnowledgeInputError('invalid_title');
  const rows = await db()
    .update(schema.knowledge)
    .set({ title, updatedAt: now, activity: appendActivity([activity('renamed', { title }, now)]) })
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
    .returning({ id: schema.knowledge.id });
  if (rows.length === 0) throw new KnowledgeInputError('not_found');
  return title;
}

/* ------------------------------------------------------------------- purge */

/**
 * Removes knowledge that has been in the trash for 30 days: the rows, their
 * passages (cascade) and their uploaded files. Idempotent -- a second run
 * finds nothing older -- and bounded per run; Vercel Cron calls it daily.
 * Citations already given keep their snapshots (`message.citations`).
 */
export async function purgeTrash(now = new Date(), limit = 500): Promise<{ purged: number; files: number }> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db()
    .delete(schema.knowledge)
    .where(
      inArray(
        schema.knowledge.id,
        db()
          .select({ id: schema.knowledge.id })
          .from(schema.knowledge)
          .where(and(isNotNull(schema.knowledge.deletedAt), lt(schema.knowledge.deletedAt, cutoff)))
          .limit(limit),
      ),
    )
    .returning({ kind: schema.knowledge.kind, source: schema.knowledge.source });
  const uploads = [
    ...new Set(rows.filter((row) => (row.kind === 'document' || row.kind === 'audio') && row.source?.startsWith('knowledge/')).map((row) => row.source!)),
  ];
  /* The same upload can back more than one source (a submit sent twice); a file still in use stays. */
  const inUse =
    uploads.length === 0
      ? new Set<string | null>()
      : new Set(
          (
            await db()
              .select({ source: schema.knowledge.source })
              .from(schema.knowledge)
              .where(and(inArray(schema.knowledge.kind, ['document', 'audio']), inArray(schema.knowledge.source, uploads)))
          ).map((row) => row.source),
        );
  let files = 0;
  for (const source of uploads) {
    if (inUse.has(source)) continue;
    try {
      await deleteBlob(source);
      files += 1;
    } catch (error) {
      /* The row is gone either way; an orphaned file is only storage. */
      console.warn(`purge: could not delete ${source}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  return { purged: rows.length, files };
}
