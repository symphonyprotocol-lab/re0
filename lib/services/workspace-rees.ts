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
 * goes to the Ree's trash. In a published public Ree a new file waits for
 * the owner (`awaiting_confirmation`, 待确认) unless the binding says
 * `auto_enable`, and a file the secret scan flags never answers there.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { MCP_REE_CREATE_PER_DAY } from '@/lib/constants';
import { activity } from '@/lib/domain/knowledge';
import { validateReeFields, type ReeFields } from '@/lib/domain/ree';
import { fileNameForTitle, globToRegex, nameOf, normalizePath, scanSecrets } from '@/lib/domain/workspace';
import { db, schema, type Tx } from '@/lib/infra/db';
import { BASE_SPACE } from '@/lib/services/embedding-space';
import { appendActivity } from '@/lib/services/knowledge';
import { afterKnowledgeReady } from '@/lib/services/profile';
import { hitRateBucket } from '@/lib/services/rate-limit';
import { createRee, ownedRee, ReeInputError, type Ree } from '@/lib/services/rees';
import { bindingsOf, digestOf, estimateIndex, queueBelow, type IndexEstimate } from '@/lib/services/workspace-index';
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

/** Every Ree with a binding in the workspace, brought up to date (after an index run, a move, a delete, a restore). */
export async function syncWorkspaceRees(workspaceId: string): Promise<void> {
  const rees = await db().selectDistinct({ reeId: schema.reeBinding.reeId }).from(schema.reeBinding).where(eq(schema.reeBinding.workspaceId, workspaceId));
  for (const { reeId } of rees) {
    try {
      await syncRee(reeId);
    } catch (error) {
      console.warn(`workspace ree sync failed ree=${reeId}`, error instanceof Error ? error.message : error);
    }
  }
}

interface Member {
  id: string;
  path: string;
  text: string;
  size: number;
  indexedRevisionId: string | null;
  bindings: { id: string; autoEnable: boolean }[];
}

/** The live text files the Ree's bindings cover, with the bindings that cover each. */
async function membersOf(tx: Tx, reeId: string): Promise<{ members: Map<string, Member> }> {
  const bindings = await tx
    .select({ id: schema.reeBinding.id, workspaceId: schema.reeBinding.workspaceId, autoEnable: schema.reeBinding.autoEnable, exclude: schema.reeBinding.exclude, path: schema.workspaceEntry.path, lower: sql<string>`lower(${schema.workspaceEntry.path})` })
    .from(schema.reeBinding)
    .innerJoin(schema.workspaceEntry, and(eq(schema.workspaceEntry.id, schema.reeBinding.entryId), isNull(schema.workspaceEntry.deletedAt)))
    .where(eq(schema.reeBinding.reeId, reeId));
  const members = new Map<string, Member>();
  for (const binding of bindings) {
    const files = await tx
      .select({ id: schema.workspaceEntry.id, path: schema.workspaceEntry.path, lower: sql<string>`lower(${schema.workspaceEntry.path})`, text: schema.workspaceEntry.text, size: schema.workspaceEntry.size, indexedRevisionId: schema.workspaceEntry.indexedRevisionId })
      .from(schema.workspaceEntry)
      .where(and(eq(schema.workspaceEntry.workspaceId, binding.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), isNotNull(schema.workspaceEntry.text), within(binding.path)));
    const rules = { modes: new Map<string, string>(), bindings: [{ id: binding.id, ree_id: reeId, path: binding.path, lower: binding.lower, exclude: binding.exclude }] };
    for (const file of files) {
      if (bindingsOf(rules, file).length === 0) continue;
      const member = members.get(file.id) ?? { id: file.id, path: file.path, text: file.text ?? '', size: file.size, indexedRevisionId: file.indexedRevisionId, bindings: [] };
      member.bindings.push({ id: binding.id, autoEnable: binding.autoEnable });
      members.set(file.id, member);
    }
  }
  return { members };
}

/** The Ree's `file` sources made to match its bindings and the files' indexes (see the header). Answers what changed. */
export async function syncRee(reeId: string, now = new Date()): Promise<{ added: number; updated: number; removed: number; waiting: number }> {
  const result = await db().transaction(async (tx) => {
    const [ree] = await tx.select().from(schema.ree).where(eq(schema.ree.id, reeId)).for('update');
    if (!ree || ree.deletedAt) return null;
    const { members } = await membersOf(tx, reeId);
    const sources = await tx
      .select({ id: schema.knowledge.id, entryId: schema.knowledge.workspaceEntryId, revisionId: schema.knowledge.workspaceRevisionId, deletedAt: schema.knowledge.deletedAt, enabled: schema.knowledge.enabled })
      .from(schema.knowledge)
      .where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'file')));
    const byEntry = new Map(sources.map((source) => [source.entryId!, source]));
    const counts = { added: 0, updated: 0, removed: 0, waiting: 0 };
    const published = reachable(ree);
    for (const member of members.values()) {
      if (!member.indexedRevisionId) {
        counts.waiting += 1;
        continue;
      }
      const secret = scanSecrets(member.text);
      const source = byEntry.get(member.id);
      const name = nameOf(member.path);
      if (source && !source.deletedAt && source.revisionId === member.indexedRevisionId) continue;
      if (!source) {
        /* New in a published Ree: waits for the owner unless a covering binding says otherwise; a secret always waits. */
        const waits = published && (Boolean(secret) || !member.bindings.some((binding) => binding.autoEnable));
        const [made] = await tx
          .insert(schema.knowledge)
          .values({
            reeId,
            kind: 'file',
            title: name,
            originalTitle: name,
            source: null,
            fileName: name,
            fileSize: member.size,
            status: 'ready',
            enabled: !waits,
            awaitingConfirmation: waits,
            secretFound: secret,
            content: member.text,
            workspaceEntryId: member.id,
            workspaceRevisionId: member.indexedRevisionId,
            activity: [activity('ready', undefined, now)],
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: schema.knowledge.id });
        await copyPassages(tx, made!.id, reeId, member.id);
        counts.added += 1;
        continue;
      }
      /* A newer index, or back from the trash: passages replaced, the secret scan run again. */
      const quarantine = published && Boolean(secret) && source.enabled;
      await tx
        .update(schema.knowledge)
        .set({
          title: name,
          fileName: name,
          fileSize: member.size,
          content: member.text,
          secretFound: secret,
          workspaceRevisionId: member.indexedRevisionId,
          deletedAt: null,
          updatedAt: now,
          ...(quarantine ? { enabled: false, awaitingConfirmation: true } : {}),
          activity: appendActivity([activity(source.deletedAt ? 'restored' : 'ready', undefined, now)]),
        })
        .where(eq(schema.knowledge.id, source.id));
      await copyPassages(tx, source.id, reeId, member.id);
      counts.updated += 1;
    }
    /* Sources whose file left every binding go to the trash, restorable for 30 days. */
    const gone = sources.filter((source) => !source.deletedAt && !members.has(source.entryId!));
    if (gone.length) {
      await tx
        .update(schema.knowledge)
        .set({ deletedAt: now, updatedAt: now, activity: appendActivity([activity('trashed', undefined, now)]) })
        .where(inArray(schema.knowledge.id, gone.map((source) => source.id)));
      counts.removed = gone.length;
    }
    /* Covered files not indexed yet are looked at now: a binding indexes whatever it covers. */
    const unindexed = [...members.values()].filter((member) => !member.indexedRevisionId && member.text !== null).map((member) => member.id);
    if (unindexed.length) await tx.update(schema.workspaceEntry).set({ indexDueAt: now }).where(and(inArray(schema.workspaceEntry.id, unindexed), isNull(schema.workspaceEntry.indexDueAt)));
    return { counts, public: ree.isPublic };
  });
  if (!result) return { added: 0, updated: 0, removed: 0, waiting: 0 };
  /* The profile (a metered run the owner pays) follows a change of which files there are, not every edit an agent saves. */
  if (result.public && (result.counts.added || result.counts.removed)) await afterKnowledgeReady(reeId);
  return result.counts;
}

/** A source's passages replaced by its file's index: vectors copied inside the database, in their space. */
async function copyPassages(tx: Tx, knowledgeId: string, reeId: string, entryId: string): Promise<void> {
  await tx.delete(schema.chunk).where(eq(schema.chunk.knowledgeId, knowledgeId));
  await tx.execute(sql`
    insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding, embedding_space, locator)
    select ${knowledgeId}::uuid, ${reeId}::uuid, p.ordinal, p.content, p.embedding, p.embedding_space, p.locator
    from ${schema.workspacePassage} p
    where p.entry_id = ${entryId}::uuid`);
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
  if (!(await hitRateBucket(`workspace:ree-create:${scope.userId}`, MCP_REE_CREATE_PER_DAY, 86_400))) {
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
    let path = normalizePath(`${folder}/${fileNameForTitle(source.title)}`);
    if (!path) continue;
    for (let n = 2; await liveEntry(db(), scope, path); n += 1) path = normalizePath(`${folder}/${fileNameForTitle(`${source.title} ${n}`)}`)!;
    const written = await writeFile(scope, { path, content: source.content ?? '', ifNoneMatch: '*' });
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
        .set({ kind: 'file', source: null, fileName: nameOf(path!), workspaceEntryId: entry.id, workspaceRevisionId: written.revision, secretFound: scanSecrets(source.content ?? ''), updatedAt: now, activity: appendActivity([activity('moved', { folder: path! }, now)]) })
        .where(eq(schema.knowledge.id, source.id));
    });
    moved += 1;
  }
  if (moved) {
    const folderEntry = await liveEntry(db(), scope, base);
    if (folderEntry) {
      await db()
        .insert(schema.reeBinding)
        .values({ reeId: ree.id, workspaceId: scope.workspaceId, entryId: folderEntry.id, createdBy: ownerId, createdAt: now })
        .onConflictDoNothing();
    }
  }
  const [{ left } = { left: 0 }] = await db()
    .select({ left: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, ree.id), sql`${schema.knowledge.kind} <> 'file'`, isNull(schema.knowledge.deletedAt)));
  if (moved) await syncRee(ree.id, now);
  return { moved, folder: base, left };
}

