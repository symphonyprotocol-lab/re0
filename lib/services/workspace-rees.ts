/**
 * Rees built on the agent workspace (docs/design/agent-workspace.md §2.3,
 * §2.4, §7.3): a Ree binds folders or files (`agent_ree_binding`), and every
 * indexed text file a binding covers is a `file` source of the Ree, its
 * passages copied from the file's index -- vectors and all, nothing embedded
 * again -- so retrieval, discovery, re-embedding and "参与回答" work on it as
 * on any source. One file bound into two Rees is embedded once.
 *
 * `syncRee` keeps the two in step: a covered file without a source gets one;
 * a source whose file has a newer index gets its passages replaced, in one
 * transaction (an answer reads the old passages or the new, never half); a
 * source whose file left the binding (moved out, deleted, excluded, unbound)
 * goes to the Ree's trash. In a published public Ree a new file (or one
 * back from the trash) waits for the owner (`awaiting_confirmation`, 待确认)
 * unless the binding says `auto_enable`, and a file the secret scan flags
 * never answers there. A file source the owner trashes is excluded from the
 * Ree's bindings (`agent_ree_file_exclusion`) until they restore it or bind
 * its path again. A file source keeps no copy of the text: its chunks are
 * the text (source-text.ts).
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { MCP_REE_CREATE_PER_DAY, WORKSPACE_INDEX_FILE_MAX } from '@/lib/constants';
import { indexableFile } from '@/lib/services/ree-file-guard';
import { activity } from '@/lib/domain/knowledge';
import { validateReeFields, type ReeFields } from '@/lib/domain/ree';
import { fileNameForTitle, globToRegex, nameOf, normalizePath, scanSecrets } from '@/lib/domain/workspace';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { BASE_SPACE } from '@/lib/services/embedding-space';
import { appendActivity } from '@/lib/services/knowledge';
import { afterKnowledgeReady } from '@/lib/services/profile';
import { createRee, ownedRee, ReeInputError, type Ree } from '@/lib/services/rees';
import { bindingsOf, digestOf, estimateIndex, PASSAGE_SWAP, queueBelow, type IndexEstimate } from '@/lib/services/workspace-index';
import { existing, liveEntry, requireWriteAccess, resolvePath, shown, webScope, within, WorkspaceError, writeFile, type WorkspaceScope } from '@/lib/services/workspace';

export class WorkspaceReeError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_input' | 'max_cost_exceeded' | 'limit_reached' | 'exists',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WorkspaceReeError';
  }
}

const reachable = (ree: Pick<Ree, 'isPublic' | 'isPublished' | 'moderatedAt' | 'deletedAt'>) => ree.isPublic && ree.isPublished && !ree.moderatedAt && !ree.deletedAt;

/* ------------------------------------------------------------------ sync */

/** Every Ree with a binding in the workspace, brought up to date. */
export async function syncWorkspaceRees(workspaceId: string): Promise<void> {
  const rees = await db().selectDistinct({ reeId: schema.reeBinding.reeId }).from(schema.reeBinding).where(eq(schema.reeBinding.workspaceId, workspaceId));
  await syncEach(rees.map((row) => row.reeId));
}

/** The Rees that hold these files or whose bindings cover them, brought up to date (after an index run). */
export async function syncReesForEntries(workspaceId: string, entryIds: readonly string[]): Promise<void> {
  if (entryIds.length === 0) return;
  const ids = sql.join(entryIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await db().execute<{ ree_id: string }>(sql`
    select k.ree_id from ${schema.knowledge} k where k.workspace_entry_id in (${ids})
    union
    select b.ree_id from ${schema.reeBinding} b
      join ${schema.workspaceEntry} be on be.id = b.entry_id and be.deleted_at is null
      join ${schema.workspaceEntry} f on f.id in (${ids})
    where b.workspace_id = ${workspaceId}
      and (be.path = '/' or lower(f.path) = lower(be.path) or starts_with(lower(f.path), lower(be.path) || '/'))`);
  await syncEach(rows.rows.map((row) => row.ree_id));
}

/** The Rees with a source from this entry or anything below it, brought up to date (after a move, a delete, a restore). */
export async function syncReesBelow(workspaceId: string, entryId: string): Promise<void> {
  const rows = await db().execute<{ ree_id: string }>(sql`
    select distinct k.ree_id from ${schema.knowledge} k
    join ${schema.workspaceEntry} f on f.id = k.workspace_entry_id
    join ${schema.workspaceEntry} top on top.id = ${entryId}::uuid
    where f.workspace_id = ${workspaceId} and (f.id = top.id or starts_with(lower(f.path), lower(top.path) || '/'))`);
  await syncEach(rows.rows.map((row) => row.ree_id));
}

async function syncEach(reeIds: readonly string[]): Promise<void> {
  for (const reeId of new Set(reeIds)) {
    try {
      await syncRee(reeId);
    } catch (error) {
      console.warn(`workspace ree sync failed ree=${reeId}`, error instanceof Error ? error.message : error);
    }
  }
}

/** The name a file's passages cite it by (the first passage's locator): it changes when a renamed file is indexed again. */
const indexedName = sql<string | null>`(select p.locator ->> 'path' from ${schema.workspacePassage} p where p.entry_id = ${sql.raw('"agent_workspace_entry"."id"')} and p.ordinal = 0)`;

interface Member {
  id: string;
  indexedName: string | null;
  indexedRevisionId: string | null;
  bindings: { id: string; autoEnable: boolean }[];
}

/**
 * The live text files the Ree's bindings cover, with the bindings that cover
 * each -- ids and versions only, no text -- less the files the owner took
 * out of the Ree (`agent_ree_file_exclusion`).
 */
async function membersOf(executor: Executor, reeId: string): Promise<Map<string, Member>> {
  const bindings = await executor
    .select({ id: schema.reeBinding.id, workspaceId: schema.reeBinding.workspaceId, autoEnable: schema.reeBinding.autoEnable, exclude: schema.reeBinding.exclude, path: schema.workspaceEntry.path, lower: sql<string>`lower(${schema.workspaceEntry.path})` })
    .from(schema.reeBinding)
    .innerJoin(schema.workspaceEntry, and(eq(schema.workspaceEntry.id, schema.reeBinding.entryId), isNull(schema.workspaceEntry.deletedAt)))
    .where(eq(schema.reeBinding.reeId, reeId));
  const excluded = new Set((await executor.select({ entryId: schema.reeFileExclusion.entryId }).from(schema.reeFileExclusion).where(eq(schema.reeFileExclusion.reeId, reeId))).map((row) => row.entryId));
  const members = new Map<string, Member>();
  for (const binding of bindings) {
    const files = await executor
      .select({ id: schema.workspaceEntry.id, path: schema.workspaceEntry.path, lower: sql<string>`lower(${schema.workspaceEntry.path})`, indexedRevisionId: schema.workspaceEntry.indexedRevisionId, indexedName })
      .from(schema.workspaceEntry)
      .where(and(eq(schema.workspaceEntry.workspaceId, binding.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), indexableFile('"agent_workspace_entry"', WORKSPACE_INDEX_FILE_MAX), within(binding.path)));
    const rules = { modes: new Map<string, string>(), bindings: [{ id: binding.id, ree_id: reeId, path: binding.path, lower: binding.lower, exclude: binding.exclude }] };
    for (const file of files) {
      if (excluded.has(file.id) || bindingsOf(rules, file).length === 0) continue;
      const member = members.get(file.id) ?? { id: file.id, indexedName: file.indexedName, indexedRevisionId: file.indexedRevisionId, bindings: [] };
      member.bindings.push({ id: binding.id, autoEnable: binding.autoEnable });
      members.set(file.id, member);
    }
  }
  return members;
}

/** Changed files a sync brings in per transaction: each reads only its own files' indexed passages. */
const SYNC_BATCH = 50;

type SyncCounts = { added: number; updated: number; removed: number; waiting: number };

/**
 * The Ree's `file` sources made to match its bindings and the files'
 * indexes (see the header). Only files whose index changed are read, a
 * batch per transaction; each is scanned for secrets in the version its
 * passages index -- the text the Ree will answer from -- never the file's
 * newer text. A source the owner trashed is not a member (its file is
 * excluded), so only sources this sync trashed itself come back. Answers
 * what changed.
 */
export async function syncRee(reeId: string, now = new Date()): Promise<SyncCounts> {
  const counts: SyncCounts = { added: 0, updated: 0, removed: 0, waiting: 0 };
  const [ree] = await db().select().from(schema.ree).where(eq(schema.ree.id, reeId));
  if (!ree || ree.deletedAt || ree.moderatedAt) return counts;
  const members = await membersOf(db(), reeId);
  const sources = await db()
    .select({ entryId: schema.knowledge.workspaceEntryId, revisionId: schema.knowledge.workspaceRevisionId, deletedAt: schema.knowledge.deletedAt, fileName: schema.knowledge.fileName })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'file')));
  const byEntry = new Map(sources.map((source) => [source.entryId!, source]));
  const changed: Member[] = [];
  for (const member of members.values()) {
    if (!member.indexedRevisionId) counts.waiting += 1;
    else {
      const source = byEntry.get(member.id);
      /* A new index, back from the trash, or re-indexed under a new name (the source and its citations carry the file's name). */
      if (!source || source.deletedAt || source.revisionId !== member.indexedRevisionId || (member.indexedName !== null && source.fileName !== member.indexedName)) changed.push(member);
    }
  }
  for (let at = 0; at < changed.length; at += SYNC_BATCH) {
    const done = await db().transaction((tx) => syncBatch(tx, reeId, changed.slice(at, at + SYNC_BATCH), now));
    counts.added += done.added;
    counts.updated += done.updated;
  }
  /* Sources whose file left every binding go to the trash, restorable for 30 days; membership is read again under the Ree's lock. */
  if (sources.some((source) => !source.deletedAt && !members.has(source.entryId!))) {
    counts.removed = await db().transaction(async (tx) => {
      const [locked] = await tx.select({ id: schema.ree.id }).from(schema.ree).where(and(eq(schema.ree.id, reeId), isNull(schema.ree.deletedAt))).for('update');
      if (!locked) return 0;
      const current = await membersOf(tx, reeId);
      const live = await tx
        .select({ id: schema.knowledge.id, entryId: schema.knowledge.workspaceEntryId })
        .from(schema.knowledge)
        .where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'file'), isNull(schema.knowledge.deletedAt)));
      const gone = live.filter((source) => !current.has(source.entryId!)).map((source) => source.id);
      if (gone.length) {
        await tx.update(schema.knowledge).set({ deletedAt: now, updatedAt: now, activity: appendActivity([activity('trashed', undefined, now)]) }).where(inArray(schema.knowledge.id, gone));
      }
      return gone.length;
    });
  }
  /* Covered files not indexed yet are looked at now: a binding indexes whatever it covers. */
  const unindexed = [...members.values()].filter((member) => !member.indexedRevisionId).map((member) => member.id);
  for (let at = 0; at < unindexed.length; at += 1_000) {
    /* Not one the index already found it could not read (a scan, an encrypted PDF): that waits for a new version. */
    await db().update(schema.workspaceEntry).set({ indexDueAt: now }).where(and(inArray(schema.workspaceEntry.id, unindexed.slice(at, at + 1_000)), isNull(schema.workspaceEntry.indexDueAt), isNull(schema.workspaceEntry.indexError)));
  }
  /* The profile (a metered run the owner pays) follows a change of which files there are, not every edit an agent saves. */
  if (ree.isPublic && (counts.added || counts.removed)) await afterKnowledgeReady(reeId);
  return counts;
}

/** One batch of changed files brought into the Ree, under its lock, each from the version its index holds now. */
async function syncBatch(tx: Tx, reeId: string, batch: readonly Member[], now: Date): Promise<{ added: number; updated: number }> {
  const done = { added: 0, updated: 0 };
  const [ree] = await tx.select().from(schema.ree).where(eq(schema.ree.id, reeId)).for('update');
  if (!ree || ree.deletedAt || ree.moderatedAt) return done;
  const published = reachable(ree);
  const ids = batch.map((member) => member.id);
  /* Shared locks on the files: an index swap waits for this batch, so the version read is the version whose passages are copied. */
  const files = await tx
    .select({ id: schema.workspaceEntry.id, path: schema.workspaceEntry.path, size: schema.workspaceEntry.size, indexedRevisionId: schema.workspaceEntry.indexedRevisionId, indexedName })
    .from(schema.workspaceEntry)
    .where(and(inArray(schema.workspaceEntry.id, ids), isNull(schema.workspaceEntry.deletedAt)))
    .for('share');
  const texts = await tx.execute<{ entry_id: string; text: string }>(sql`
    select p.entry_id, string_agg(p.content, E'\n' order by p.ordinal) as text
    from ${schema.workspacePassage} p
    where p.entry_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) and p.ordinal < ${PASSAGE_SWAP}
    group by p.entry_id`);
  const textOf = new Map(texts.rows.map((row) => [row.entry_id, row.text]));
  const sources = await tx
    .select({ id: schema.knowledge.id, entryId: schema.knowledge.workspaceEntryId, revisionId: schema.knowledge.workspaceRevisionId, deletedAt: schema.knowledge.deletedAt, enabled: schema.knowledge.enabled, fileName: schema.knowledge.fileName })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'file'), inArray(schema.knowledge.workspaceEntryId, ids)));
  const byEntry = new Map(sources.map((source) => [source.entryId!, source]));
  const bindingsOfMember = new Map(batch.map((member) => [member.id, member.bindings]));
  for (const file of files) {
    if (!file.indexedRevisionId) continue;
    const source = byEntry.get(file.id);
    const name = file.indexedName ?? nameOf(file.path);
    if (source && !source.deletedAt && source.revisionId === file.indexedRevisionId && source.fileName === name) continue;
    const secret = scanSecrets(textOf.get(file.id) ?? '');
    const autoEnable = (bindingsOfMember.get(file.id) ?? []).some((binding) => binding.autoEnable);
    /* New -- or back from the trash -- in a published Ree: it waits for the owner unless a covering binding says otherwise; a secret always waits. */
    const waits = published && (Boolean(secret) || !autoEnable);
    if (!source) {
      const [made] = await tx
        .insert(schema.knowledge)
        .values({
          reeId,
          kind: 'file',
          title: name,
          originalTitle: name,
          source: null,
          fileName: name,
          fileSize: file.size,
          status: 'ready',
          enabled: !waits,
          awaitingConfirmation: waits,
          secretFound: secret,
          /* The text is the passages, stored once as this source's chunks (see source-text.ts). */
          content: null,
          workspaceEntryId: file.id,
          workspaceRevisionId: file.indexedRevisionId,
          activity: [activity('ready', undefined, now)],
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.knowledge.id });
      await copyPassages(tx, made!.id, reeId, file.id);
      done.added += 1;
      continue;
    }
    const restored = Boolean(source.deletedAt);
    const quarantine = published && (restored ? waits : Boolean(secret) && source.enabled);
    await tx
      .update(schema.knowledge)
      .set({
        title: name,
        fileName: name,
        fileSize: file.size,
        content: null,
        secretFound: secret,
        workspaceRevisionId: file.indexedRevisionId,
        deletedAt: null,
        updatedAt: now,
        ...(quarantine ? { enabled: false, awaitingConfirmation: true } : {}),
        activity: appendActivity([activity(restored ? 'restored' : 'ready', undefined, now)]),
      })
      .where(eq(schema.knowledge.id, source.id));
    await copyPassages(tx, source.id, reeId, file.id);
    done.updated += 1;
  }
  return done;
}

/** A source's passages replaced by its file's index: vectors copied inside the database, in their space. */
async function copyPassages(tx: Tx, knowledgeId: string, reeId: string, entryId: string): Promise<void> {
  await tx.delete(schema.chunk).where(eq(schema.chunk.knowledgeId, knowledgeId));
  await tx.execute(sql`
    insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding, embedding_space, locator)
    select ${knowledgeId}::uuid, ${reeId}::uuid, p.ordinal, p.content, p.embedding, p.embedding_space, p.locator
    from ${schema.workspacePassage} p
    where p.entry_id = ${entryId}::uuid and p.ordinal < ${PASSAGE_SWAP}`);
}

/* ------------------------------------------------------------------ binding */

export interface BindingView {
  id: string;
  path: string;
  kind: 'file' | 'folder';
  exclude: string[];
  autoEnable: boolean;
  files: number;
}

/** The Ree's bindings, as the owner sees them (paths from the workspace root). */
export async function bindingsOfRee(ownerId: string, reeId: string): Promise<BindingView[]> {
  const rows = await db()
    .select({ id: schema.reeBinding.id, path: schema.workspaceEntry.path, kind: schema.workspaceEntry.kind, exclude: schema.reeBinding.exclude, autoEnable: schema.reeBinding.autoEnable, workspaceId: schema.reeBinding.workspaceId, deletedAt: schema.workspaceEntry.deletedAt })
    .from(schema.reeBinding)
    .innerJoin(schema.workspaceEntry, eq(schema.workspaceEntry.id, schema.reeBinding.entryId))
    .innerJoin(schema.ree, and(eq(schema.ree.id, schema.reeBinding.reeId), eq(schema.ree.ownerId, ownerId)))
    .where(eq(schema.reeBinding.reeId, reeId))
    .orderBy(schema.workspaceEntry.path);
  const out: BindingView[] = [];
  for (const row of rows) {
    const [{ files } = { files: 0 }] =
      row.kind === 'folder'
        ? await db().select({ files: sql<number>`count(*)::int` }).from(schema.workspaceEntry).where(and(eq(schema.workspaceEntry.workspaceId, row.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), within(row.path)))
        : [{ files: row.deletedAt ? 0 : 1 }];
    out.push({ id: row.id, path: row.path, kind: row.kind, exclude: row.exclude, autoEnable: row.autoEnable, files });
  }
  return out;
}

async function ownReeOrNotFound(ownerId: string, reeId: string): Promise<Ree> {
  const ree = await ownedRee(db(), ownerId, reeId);
  if (!ree) throw new WorkspaceReeError('not_found', 'No such Ree of yours.');
  return ree;
}

function cleanExclude(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 20 || raw.some((glob) => typeof glob !== 'string' || !glob.trim() || glob.length > 200)) {
    throw new WorkspaceReeError('invalid_input', 'exclude takes up to 20 globs (like **/*.log or drafts/**).', { reason: 'invalid_exclude' });
  }
  const globs = (raw as string[]).map((glob) => glob.trim());
  for (const glob of globs) {
    try {
      new RegExp(globToRegex(glob));
    } catch {
      throw new WorkspaceReeError('invalid_input', `${glob} is not a glob the workspace can read.`, { reason: 'invalid_exclude' });
    }
  }
  return globs;
}

/**
 * `bind_ree_paths`: adds and removes the Ree's bindings (workspace paths,
 * from the scope's root), and sets `exclude` / `auto_enable` on what it adds
 * (or on every binding when nothing is added). Covered files are indexed and
 * come in as their index lands; removed ones go to the Ree's trash.
 */
export async function bindPaths(
  scope: WorkspaceScope,
  reeId: string,
  input: { add?: string[]; remove?: string[]; exclude?: unknown; autoEnable?: boolean },
  now = new Date(),
): Promise<{ bindings: BindingView[] }> {
  requireWriteAccess(scope);
  const ree = await ownReeOrNotFound(scope.userId, reeId);
  const exclude = cleanExclude(input.exclude);
  const add = (input.add ?? []).map((raw) => resolvePath(scope, raw));
  const remove = (input.remove ?? []).map((raw) => resolvePath(scope, raw));
  const added: string[] = [];
  await db().transaction(async (tx) => {
    for (const path of add) {
      const entry = await existing(tx, scope, path);
      const change = { ...(exclude ? { exclude } : {}), ...(input.autoEnable === undefined ? {} : { autoEnable: input.autoEnable }) };
      const insert = tx
        .insert(schema.reeBinding)
        .values({ reeId: ree.id, workspaceId: scope.workspaceId, entryId: entry.id, exclude: exclude ?? [], autoEnable: input.autoEnable ?? false, createdBy: scope.userId, createdAt: now });
      /* Binding what is already bound changes only what was asked. */
      if (Object.keys(change).length) await insert.onConflictDoUpdate({ target: [schema.reeBinding.reeId, schema.reeBinding.entryId], set: change });
      else await insert.onConflictDoNothing();
      /* Binding a path again brings back the files at or below it the owner had taken out of this Ree. */
      await tx.execute(sql`
        delete from ${schema.reeFileExclusion} x using ${schema.workspaceEntry} e
        where x.ree_id = ${ree.id}::uuid and e.id = x.entry_id and e.workspace_id = ${scope.workspaceId}::uuid and ${within(entry.path, sql`e.path`)}`);
      added.push(entry.path);
    }
    for (const path of remove) {
      const entry = await liveEntry(tx, scope, path);
      if (entry) await tx.delete(schema.reeBinding).where(and(eq(schema.reeBinding.reeId, ree.id), eq(schema.reeBinding.entryId, entry.id)));
    }
    if (!add.length && (exclude || input.autoEnable !== undefined)) {
      await tx
        .update(schema.reeBinding)
        .set({ ...(exclude ? { exclude } : {}), ...(input.autoEnable === undefined ? {} : { autoEnable: input.autoEnable }) })
        .where(eq(schema.reeBinding.reeId, ree.id));
    }
    await queueBelow(tx, scope.workspaceId, added, now);
  });
  await syncRee(ree.id, now);
  return { bindings: (await bindingsOfRee(scope.userId, ree.id)).map((binding) => ({ ...binding, path: shown(scope, binding.path) })) };
}

/** The web's binding switches: one binding's `auto_enable`, or the binding removed. */
export async function updateBinding(ownerId: string, reeId: string, bindingId: string, change: { autoEnable?: boolean; remove?: boolean }): Promise<void> {
  const ree = await ownReeOrNotFound(ownerId, reeId);
  if (!/^[0-9a-f-]{36}$/i.test(bindingId)) throw new WorkspaceReeError('not_found', 'No such binding.');
  if (change.remove) await db().delete(schema.reeBinding).where(and(eq(schema.reeBinding.id, bindingId), eq(schema.reeBinding.reeId, ree.id)));
  else if (change.autoEnable !== undefined) await db().update(schema.reeBinding).set({ autoEnable: change.autoEnable }).where(and(eq(schema.reeBinding.id, bindingId), eq(schema.reeBinding.reeId, ree.id)));
  await syncRee(ree.id);
}

/* ------------------------------------------------------------------ a Ree from a folder */

export interface FolderReeInput extends Partial<ReeFields> {
  path: string;
  exclude?: unknown;
  maxCost?: number;
  color?: unknown;
}

/**
 * `create_ree_from_folder`: a new private Ree whose knowledge is the folder
 * (a binding on it), after quoting what indexing its files would cost and
 * refusing above `maxCost`. The Ree answers as its files' index lands.
 */
export async function createReeFromFolder(scope: WorkspaceScope, input: FolderReeInput): Promise<{ ree: Ree; estimate: IndexEstimate; bindings: BindingView[] }> {
  requireWriteAccess(scope);
  const folder = resolvePath(scope, input.path);
  const entry = await existing(db(), scope, folder);
  if (entry.kind !== 'folder') throw new WorkspaceError('not_a_directory', `${shown(scope, folder)} is a file; bind_ree_paths binds single files to an existing Ree.`, { path: shown(scope, folder) });
  const fields: ReeFields = {
    name: input.name ?? '',
    description: input.description ?? '',
    category: input.category ?? 'other',
    tags: input.tags ?? [],
    systemPrompt: input.systemPrompt ?? '',
    sampleQuestions: input.sampleQuestions ?? [],
    queryFee: input.queryFee ?? 0,
  } as ReeFields;
  const invalid = validateReeFields(fields, 3);
  if (invalid) throw new ReeInputError(invalid.error, invalid.step);
  const exclude = cleanExclude(input.exclude) ?? [];
  const estimate = await estimateIndex(scope, input.path);
  if (input.maxCost !== undefined && (estimate.credits === null || estimate.credits > input.maxCost)) {
    throw new WorkspaceReeError('max_cost_exceeded', `Indexing this folder could cost up to ${estimate.credits ?? 'an unknown number of'} credits, above your max_cost of ${input.maxCost}. Nothing was created.`, { estimate });
  }
  /* Counted from the Rees themselves (rate buckets live an hour): at most this many new Rees a day, however they were made. */
  const [{ today } = { today: 0 }] = await db()
    .select({ today: sql<number>`count(*)::int` })
    .from(schema.ree)
    .where(and(eq(schema.ree.ownerId, scope.userId), sql`${schema.ree.createdAt} >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`));
  if (today >= MCP_REE_CREATE_PER_DAY) {
    throw new WorkspaceReeError('limit_reached', `At most ${MCP_REE_CREATE_PER_DAY} Rees a day can be created from folders.`, { reason: 'ree_daily_limit' });
  }
  /* Always private first: publishing is the owner's separate step, after which new files wait for confirmation. */
  const { ree } = await createRee(scope.userId, { ...fields, isPublic: false, color: input.color ?? 'default' });
  const { bindings } = await bindPaths(scope, ree.id, { add: [input.path], exclude });
  return { ree, estimate, bindings };
}

/* ------------------------------------------------------------------ the confirmation queue */

/** Files waiting for the owner (待确认) in the Ree, newest first. */
export async function awaitingFiles(ownerId: string, reeId: string) {
  await ownReeOrNotFound(ownerId, reeId);
  return db()
    .select({ id: schema.knowledge.id, title: schema.knowledge.title, entryId: schema.knowledge.workspaceEntryId, secretFound: schema.knowledge.secretFound, updatedAt: schema.knowledge.updatedAt, path: schema.workspaceEntry.path, updatedClient: schema.workspaceEntry.updatedClient, chunks: sql<number>`(select count(*)::int from ${schema.chunk} c where c.knowledge_id = ${schema.knowledge.id})` })
    .from(schema.knowledge)
    .leftJoin(schema.workspaceEntry, eq(schema.workspaceEntry.id, schema.knowledge.workspaceEntryId))
    .where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'file'), eq(schema.knowledge.awaitingConfirmation, true), isNull(schema.knowledge.deletedAt)))
    .orderBy(sql`${schema.knowledge.updatedAt} desc`);
}

/** The owner confirms (the file answers from now on) or dismisses (it stays off) waiting files; a flagged file cannot be confirmed. */
export async function decideAwaiting(ownerId: string, reeId: string, ids: readonly string[], decision: 'confirm' | 'dismiss', now = new Date()): Promise<{ changed: number; refused: number }> {
  const ree = await ownReeOrNotFound(ownerId, reeId);
  const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!valid.length) return { changed: 0, refused: 0 };
  return db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.knowledge.id, secretFound: schema.knowledge.secretFound })
      .from(schema.knowledge)
      .where(and(inArray(schema.knowledge.id, valid), eq(schema.knowledge.reeId, ree.id), eq(schema.knowledge.awaitingConfirmation, true), isNull(schema.knowledge.deletedAt)))
      .for('update');
    const flagged = decision === 'confirm' ? rows.filter((row) => row.secretFound && ree.isPublic) : [];
    const ok = rows.filter((row) => !flagged.includes(row)).map((row) => row.id);
    if (ok.length) {
      await tx
        .update(schema.knowledge)
        .set({ awaitingConfirmation: false, enabled: decision === 'confirm', updatedAt: now, activity: appendActivity([activity(decision === 'confirm' ? 'enabled' : 'paused', undefined, now)]) })
        .where(inArray(schema.knowledge.id, ok));
    }
    return { changed: ok.length, refused: flagged.length };
  });
}

/* ------------------------------------------------------------------ moving a Ree's text into the workspace */

/**
 * "移到工作区" (§2.4, the owner's choice, one Ree at a time): each pasted
 * text source becomes `/Rees/<slug>/[<folder>/]<title>.md` in the owner's
 * workspace and a `file` source bound through `/Rees/<slug>`, keeping its
 * passages and their vectors: the file's index is filled from them, so
 * nothing is embedded or charged. Documents, audio, pages, sites and
 * repositories stay as they are (binary files come to the workspace later).
 */
export async function moveReeToWorkspace(ownerId: string, reeId: string, now = new Date()): Promise<{ moved: number; folder: string; left: number }> {
  const ree = await ownReeOrNotFound(ownerId, reeId);
  const scope = await webScope(ownerId);
  const base = `/Rees/${ree.slug}`;
  const sources = await db()
    .select({ id: schema.knowledge.id, title: schema.knowledge.title, content: schema.knowledge.content, folder: schema.knowledgeFolder.name, status: schema.knowledge.status })
    .from(schema.knowledge)
    .leftJoin(schema.knowledgeFolder, eq(schema.knowledgeFolder.id, schema.knowledge.folderId))
    .where(and(eq(schema.knowledge.reeId, ree.id), eq(schema.knowledge.kind, 'text'), isNull(schema.knowledge.deletedAt), eq(schema.knowledge.status, 'ready')));
  let moved = 0;
  for (const source of sources) {
    const folder = source.folder ? `${base}/${fileNameForTitle(source.folder).replace(/\.md$/, '')}` : base;
    const content = source.content ?? '';
    let path = normalizePath(`${folder}/${fileNameForTitle(source.title)}`);
    if (!path) continue;
    /*
     * A run that stopped after writing the file and before turning the source
     * into it left the file there: it is taken as it is (same text, no source
     * uses it yet) rather than written again under a new name.
     */
    let revision: string | null = null;
    for (let n = 2; ; n += 1) {
      const there = await liveEntry(db(), scope, path);
      if (!there) break;
      if (there.kind === 'file' && there.text === content && !(await usedBySource(there.id))) {
        revision = there.currentRevisionId;
        break;
      }
      path = normalizePath(`${folder}/${fileNameForTitle(`${source.title} ${n}`)}`)!;
    }
    const written = revision ? { revision } : await writeFile(scope, { path, content, ifNoneMatch: '*' });
    await db().transaction(async (tx) => {
      const entry = (await liveEntry(tx, scope, path!))!;
      /* The file's index is the source's own passages: same text, same vectors, nothing to embed. */
      const chunks = await tx
        .select({ ordinal: schema.chunk.ordinal, content: schema.chunk.content, locator: schema.chunk.locator, embedding: schema.chunk.embedding, space: schema.chunk.embeddingSpace })
        .from(schema.chunk)
        .where(and(eq(schema.chunk.knowledgeId, source.id), isNotNull(schema.chunk.embedding)));
      await tx.delete(schema.workspacePassage).where(eq(schema.workspacePassage.entryId, entry.id));
      for (let at = 0; at < chunks.length; at += 200) {
        await tx.insert(schema.workspacePassage).values(
          chunks.slice(at, at + 200).map((chunk) => ({
            entryId: entry.id,
            ordinal: chunk.ordinal,
            workspaceId: scope.workspaceId,
            revisionId: written.revision!,
            content: chunk.content,
            locator: chunk.locator,
            contentDigest: digestOf(chunk.content),
            embedding: chunk.embedding!,
            embeddingSpace: chunk.space ?? BASE_SPACE,
          })),
        );
      }
      await tx.update(schema.workspaceEntry).set({ indexedRevisionId: written.revision, indexDueAt: null, indexError: null }).where(eq(schema.workspaceEntry.id, entry.id));
      await tx
        .update(schema.knowledge)
        .set({ kind: 'file', source: null, content: null, fileName: nameOf(path!), workspaceEntryId: entry.id, workspaceRevisionId: written.revision, secretFound: scanSecrets(content), updatedAt: now, activity: appendActivity([activity('moved', { folder: path! }, now)]) })
        .where(eq(schema.knowledge.id, source.id));
    });
    moved += 1;
  }
  /* Bound even when this run moved nothing new: a run that stopped before binding is finished by the next. */
  const folderEntry = await liveEntry(db(), scope, base);
  if (folderEntry) {
    await db()
      .insert(schema.reeBinding)
      .values({ reeId: ree.id, workspaceId: scope.workspaceId, entryId: folderEntry.id, createdBy: ownerId, createdAt: now })
      .onConflictDoNothing();
  }
  const [{ left } = { left: 0 }] = await db()
    .select({ left: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, ree.id), sql`${schema.knowledge.kind} <> 'file'`, isNull(schema.knowledge.deletedAt)));
  if (folderEntry) await syncRee(ree.id, now);
  return { moved, folder: base, left };
}

/** Whether any Ree's source is this workspace file. */
async function usedBySource(entryId: string): Promise<boolean> {
  const [row] = await db().select({ id: schema.knowledge.id }).from(schema.knowledge).where(eq(schema.knowledge.workspaceEntryId, entryId)).limit(1);
  return Boolean(row);
}

/** The owner's Rees a workspace file answers in (its live `file` sources), for the file page. */
export async function reesUsingEntry(ownerId: string, entryId: string) {
  return db()
    .select({ id: schema.ree.id, name: schema.ree.name, awaiting: schema.knowledge.awaitingConfirmation, enabled: schema.knowledge.enabled })
    .from(schema.knowledge)
    .innerJoin(schema.ree, and(eq(schema.ree.id, schema.knowledge.reeId), eq(schema.ree.ownerId, ownerId), isNull(schema.ree.deletedAt)))
    .where(and(eq(schema.knowledge.workspaceEntryId, entryId), isNull(schema.knowledge.deletedAt)));
}

/** What the knowledge page's workspace card shows: the bindings, the files waiting, and whether there is pasted text to move. */
export async function reeWorkspaceCard(ownerId: string, reeId: string) {
  const ree = await ownReeOrNotFound(ownerId, reeId);
  const [bindings, waiting, [{ texts } = { texts: 0 }]] = await Promise.all([
    bindingsOfRee(ownerId, reeId),
    awaitingFiles(ownerId, reeId),
    db().select({ texts: sql<number>`count(*)::int` }).from(schema.knowledge).where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'text'), isNull(schema.knowledge.deletedAt))),
  ]);
  return { published: reachable(ree), bindings, waiting, texts };
}
