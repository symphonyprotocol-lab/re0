/**
 * The shared agent workspace (docs/design/agent-workspace.md, phase 1):
 * files and folders by path that every MCP client of an account reaches
 * through `ws_*` tools (lib/http/mcp-workspace.ts) and the owner through
 * `/files`. Text only in this phase, at most WORKSPACE_TEXT_MAX bytes a file.
 *
 * Every change runs in one transaction that first locks the owner's
 * `agent_workspace_usage` row, so one account's writes are serialised: the usage
 * counters stay exact, the quota checks cannot race, and a Blob object is put
 * or deleted only under that lock (see `agent_workspace_blob`). A write:
 *   1. refuses above the console's debt limit and past the day's writes
 *      (counted on the usage row);
 *   2. checks `if_match` / `if_none_match` against the entry's `etag`;
 *   3. creates the missing folders above it;
 *   4. puts the content's object (once per distinct content of a workspace)
 *      and counts the version naming it;
 *   5. updates the file's latest version in place when the same key wrote it
 *      within WORKSPACE_COALESCE_MS (`saves` + 1), else adds a version;
 *   6. keeps the current text on the entry for reads and grep.
 * Nothing here spends credits: storage is billed daily from the usage row
 * (`chargeWorkspaceStorage`) above the free allowance.
 *
 * A scope is what a caller may reach: one workspace, a root that is its `/`
 * (every path in and out is relative to it) and read or write access. A
 * path outside the root cannot be named, so it is `not_found` like a path
 * that does not exist.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import {
  WORKSPACE_BYTES_MAX,
  WORKSPACE_COALESCE_MS,
  WORKSPACE_ENTRIES_MAX,
  WORKSPACE_GREP_HITS_MAX,
  WORKSPACE_GREP_SCAN_MAX,
  WORKSPACE_LIST_MAX,
  WORKSPACE_MOVE_MAX,
  WORKSPACE_READ_MAX,
  WORKSPACE_REVISION_DAYS,
  WORKSPACE_REVISIONS_KEPT,
  WORKSPACE_TEXT_MAX,
  WORKSPACE_TRASH_DAYS,
} from '@/lib/constants';
import {
  ancestors,
  billableBytes,
  byteLength,
  byteWindow,
  clientLabel,
  coalesces,
  descendantsPattern,
  escapeRegex,
  globToRegex,
  isStorableText,
  isWithin,
  lineCount,
  lineWindow,
  mediaTypeOf,
  nameOf,
  normalizePath,
  parentOf,
  relativeToRoot,
  restoredName,
  underRoot,
} from '@/lib/domain/workspace';
import { storageCostPico } from '@/lib/domain/infra-cost';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { deleteWorkspaceObjects, putWorkspaceObject, readWorkspaceObject, workspaceObjectPath } from '@/lib/infra/workspace-store';
import { infraCostRates } from '@/lib/services/infra-pricing';
import { effectiveCeiling } from '@/lib/services/rate-limit-settings';
import { chargeStorageCost } from '@/lib/services/storage-billing';

export type WorkspaceErrorCode =
  | 'not_found'
  | 'exists'
  | 'conflict'
  | 'is_a_directory'
  | 'not_a_directory'
  | 'too_large'
  | 'invalid_path'
  | 'invalid_input'
  | 'quota_exceeded'
  | 'insufficient_credits'
  | 'limit_reached'
  | 'workspace_not_allowed';

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceScope {
  userId: string;
  workspaceId: string;
  /** Absolute; the caller's `/`. */
  root: string;
  access: 'read' | 'write';
  /** The key behind an MCP call; null on the web. */
  apiKeyId: string | null;
  /** What the client called itself (`clientInfo.name`), or `web`. */
  client: string | null;
}

type Entry = typeof schema.workspaceEntry.$inferSelect;
type Revision = typeof schema.workspaceRevision.$inferSelect;

const MB = 1024 * 1024;

/* ------------------------------------------------------------------ scopes */

/** The account's `default` workspace, made on first use. */
export async function defaultWorkspace(userId: string, executor: Executor = db()): Promise<string> {
  const find = () =>
    executor
      .select({ id: schema.workspace.id })
      .from(schema.workspace)
      .where(and(eq(schema.workspace.ownerId, userId), isNull(schema.workspace.deletedAt), sql`lower(${schema.workspace.name}) = 'default'`))
      .limit(1);
  const [found] = await find();
  if (found) return found.id;
  await executor.insert(schema.workspace).values({ ownerId: userId, name: 'default' }).onConflictDoNothing();
  const [made] = await find();
  return made!.id;
}

/** The owner on the web: the default workspace, all of it, read and write. */
export async function webScope(userId: string): Promise<WorkspaceScope> {
  return { userId, workspaceId: await defaultWorkspace(userId), root: '/', access: 'write', apiKeyId: null, client: 'web' };
}

/** A caller's path made absolute under the scope's root, or `invalid_path`. */
export function resolvePath(scope: WorkspaceScope, raw: unknown, name = 'path'): string {
  const path = normalizePath(raw ?? '/');
  if (!path) {
    throw new WorkspaceError('invalid_path', `The ${name} is not a valid workspace path: use "/"-separated names without "." or ".." segments, control characters or backslashes, at most 1024 bytes.`, { [name]: typeof raw === 'string' ? raw.slice(0, 200) : null });
  }
  return underRoot(scope.root, path);
}

/** An absolute path as the scope's caller sees it. */
export function shown(scope: WorkspaceScope, path: string): string {
  return relativeToRoot(scope.root, path) ?? path;
}

function requireWriteAccess(scope: WorkspaceScope): void {
  if (scope.access !== 'write') throw new WorkspaceError('workspace_not_allowed', 'This API key may only read the workspace. Create a key with workspace write access in Settings → API to change files.');
}

/* ------------------------------------------------------------------ lookups */

const live = (scope: WorkspaceScope) => and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNull(schema.workspaceEntry.deletedAt));
const samePath = (path: string) => sql`lower(${schema.workspaceEntry.path}) = lower(${path})`;
const under = (folder: string) => sql`lower(${schema.workspaceEntry.path}) like ${descendantsPattern(folder)}`;

async function liveEntry(executor: Executor, scope: WorkspaceScope, path: string, lock = false): Promise<Entry | null> {
  const query = executor.select().from(schema.workspaceEntry).where(and(live(scope), samePath(path))).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

/** A live entry the caller named, or `not_found`; the scope's root counts as an (empty) folder until something is written there. */
async function existing(executor: Executor, scope: WorkspaceScope, path: string, lock = false): Promise<Entry> {
  const entry = await liveEntry(executor, scope, path, lock);
  if (entry) return entry;
  throw new WorkspaceError('not_found', `Nothing at ${shown(scope, path)}.`, { path: shown(scope, path) });
}

function isRootOf(scope: WorkspaceScope, path: string): boolean {
  return path.toLowerCase() === scope.root.toLowerCase();
}

/* ------------------------------------------------------------------ the meter */

/**
 * The owner's usage row, locked for the transaction: the counters change as
 * the work goes, and `save` writes them back with the byte-milliseconds the
 * old values earned up to now.
 */
class Meter {
  blob: number;
  database: number;
  entries: number;
  private readonly start: { blob: number; database: number; entries: number };

  constructor(
    private readonly row: typeof schema.workspaceUsage.$inferSelect,
    private readonly now: Date,
  ) {
    this.blob = row.blobBytes;
    this.database = row.databaseBytes;
    this.entries = row.entries;
    this.start = { blob: row.blobBytes, database: row.databaseBytes, entries: row.entries };
  }

  async save(tx: Tx): Promise<void> {
    const changed = this.blob !== this.start.blob || this.database !== this.start.database || this.entries !== this.start.entries;
    if (!changed) return;
    const earned = await accrued(this.row, this.now);
    await tx
      .update(schema.workspaceUsage)
      .set({ blobBytes: this.blob, databaseBytes: this.database, entries: this.entries, blobByteMs: earned.blob.toString(), databaseByteMs: earned.database.toString(), measuredAt: this.now })
      .where(eq(schema.workspaceUsage.userId, this.row.userId));
  }
}

async function freeBytes(): Promise<bigint> {
  return BigInt(await effectiveCeiling('workspaceFreeMb')) * BigInt(MB);
}

/** The row's byte-milliseconds above the free allowance, carried up to `now` at its current sizes. */
async function accrued(row: typeof schema.workspaceUsage.$inferSelect, now: Date): Promise<{ blob: bigint; database: bigint }> {
  const ms = BigInt(Math.max(0, now.getTime() - row.measuredAt.getTime()));
  const billable = billableBytes(BigInt(row.blobBytes), BigInt(row.databaseBytes), await freeBytes());
  return { blob: BigInt(row.blobByteMs) + billable.blob * ms, database: BigInt(row.databaseByteMs) + billable.database * ms };
}

async function lockUsage(tx: Tx, userId: string): Promise<typeof schema.workspaceUsage.$inferSelect> {
  await tx.insert(schema.workspaceUsage).values({ userId }).onConflictDoNothing();
  const [row] = await tx.select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId)).for('update');
  return row!;
}

/** What the owner owes, in credits (open `credit_debt`). */
async function debtOf(userId: string): Promise<number> {
  const [row] = await db()
    .select({ owed: sql<string>`coalesce(sum(${schema.creditDebt.remaining}), 0)` })
    .from(schema.creditDebt)
    .where(and(eq(schema.creditDebt.userId, userId), sql`${schema.creditDebt.remaining} > 0`));
  return Number(row?.owed ?? 0);
}

/** One change, under the owner's usage lock, after the debt and daily-writes checks. */
async function mutate<T>(scope: WorkspaceScope, work: (tx: Tx, meter: Meter, now: Date) => Promise<T>, now = new Date()): Promise<T> {
  requireWriteAccess(scope);
  const limit = await effectiveCeiling('workspaceDebtLimit');
  const owed = await debtOf(scope.userId);
  if (owed > limit) {
    throw new WorkspaceError('insufficient_credits', `Writing is paused while the account owes ${owed} credits (more than ${limit}). Top up to pay the debt; reading and deleting files still work.`, { debt: owed, limit });
  }
  const perDay = await effectiveCeiling('workspaceWritesPerDay');
  return db().transaction(async (tx) => {
    const usage = await lockUsage(tx, scope.userId);
    /* Writes a day, on the locked row: exact under concurrency, and kept the whole day (rate buckets are cleared hourly). */
    const today = now.toISOString().slice(0, 10);
    const writes = usage.writesDay === today ? usage.writes : 0;
    if (writes >= perDay) {
      throw new WorkspaceError('limit_reached', `This workspace has had ${perDay} writes today, the daily limit. It resets at 00:00 UTC.`, { limit: perDay });
    }
    await tx.update(schema.workspaceUsage).set({ writesDay: today, writes: writes + 1 }).where(eq(schema.workspaceUsage.userId, scope.userId));
    const meter = new Meter(usage, now);
    const result = await work(tx, meter, now);
    await meter.save(tx);
    return result;
  });
}

/* ------------------------------------------------------------------ contents */

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const newEtag = () => randomBytes(9).toString('base64url');

/** One more version names `sha`: its object is put when the workspace does not hold it yet (or it was released). */
async function addRef(tx: Tx, meter: Meter, workspaceId: string, sha: string, bytes: Uint8Array, mediaType: string): Promise<void> {
  const [row] = await tx
    .select()
    .from(schema.workspaceBlob)
    .where(and(eq(schema.workspaceBlob.workspaceId, workspaceId), eq(schema.workspaceBlob.sha256, sha)))
    .for('update');
  if (row && row.refs > 0) {
    await tx.update(schema.workspaceBlob).set({ refs: row.refs + 1 }).where(and(eq(schema.workspaceBlob.workspaceId, workspaceId), eq(schema.workspaceBlob.sha256, sha)));
    return;
  }
  if (meter.blob + bytes.length > WORKSPACE_BYTES_MAX) {
    throw new WorkspaceError('quota_exceeded', `The account's workspace storage is full (${Math.round(WORKSPACE_BYTES_MAX / MB)} MB, every kept version counted). Delete files or empty the trash first.`);
  }
  /* Put again even for a released row: the purge may have deleted the object before its transaction failed. */
  await putWorkspaceObject(workspaceObjectPath(workspaceId, sha), bytes, `${mediaType}; charset=utf-8`);
  if (row) await tx.update(schema.workspaceBlob).set({ refs: 1, releasedAt: null }).where(and(eq(schema.workspaceBlob.workspaceId, workspaceId), eq(schema.workspaceBlob.sha256, sha)));
  else await tx.insert(schema.workspaceBlob).values({ workspaceId, sha256: sha, size: bytes.length, refs: 1 });
  meter.blob += bytes.length;
}

/** One version fewer names `sha`; at none it is released for the purge, and stops counting. */
async function dropRef(tx: Tx, meter: Meter, workspaceId: string, sha: string, now: Date): Promise<void> {
  const [row] = await tx
    .update(schema.workspaceBlob)
    .set({ refs: sql`${schema.workspaceBlob.refs} - 1`, releasedAt: sql`case when ${schema.workspaceBlob.refs} = 1 then ${now}::timestamptz else null end` })
    .where(and(eq(schema.workspaceBlob.workspaceId, workspaceId), eq(schema.workspaceBlob.sha256, sha), sql`${schema.workspaceBlob.refs} > 0`))
    .returning({ refs: schema.workspaceBlob.refs, size: schema.workspaceBlob.size });
  if (row && row.refs === 0) meter.blob -= row.size;
}

async function bumpEntries(meter: Meter, by: number): Promise<void> {
  if (by > 0 && meter.entries + by > WORKSPACE_ENTRIES_MAX) {
    throw new WorkspaceError('quota_exceeded', `The account's workspace holds ${WORKSPACE_ENTRIES_MAX} files and folders (the trash included), the most it can. Delete some or empty the trash first.`);
  }
  meter.entries += by;
}

/** The folder at `path` and every folder above it, made where missing; a file in the way is `not_a_directory`. */
async function ensureFolder(tx: Tx, meter: Meter, scope: WorkspaceScope, path: string, now: Date): Promise<void> {
  if (path === '/') return;
  for (const folder of [...ancestors(path), path]) {
    const found = await liveEntry(tx, scope, folder);
    if (found?.kind === 'folder') continue;
    if (found) throw new WorkspaceError('not_a_directory', `${shown(scope, folder)} is a file, so nothing can be put inside it.`, { path: shown(scope, folder) });
    await bumpEntries(meter, 1);
    await tx.insert(schema.workspaceEntry).values({ workspaceId: scope.workspaceId, path: folder, kind: 'folder', createdAt: now, updatedAt: now, updatedByKeyId: scope.apiKeyId, updatedClient: scope.client });
  }
}

interface Written {
  entry: Entry;
  changed: boolean;
  created: boolean;
}

/**
 * The file at `path` now holds `text` (its folder exists): a new version, or
 * the latest one updated in place when it coalesces; nothing at all when the
 * content is what the file already holds.
 */
async function putText(
  tx: Tx,
  meter: Meter,
  scope: WorkspaceScope,
  path: string,
  current: Entry,
  text: string,
  op: Revision['op'],
  now: Date,
  extra: Partial<typeof schema.workspaceEntry.$inferInsert> = {},
): Promise<Written> {
  if (!isStorableText(text)) throw new WorkspaceError('invalid_input', 'The content holds a NUL character; the workspace keeps text files only for now.', { reason: 'binary_content' });
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > WORKSPACE_TEXT_MAX) {
    throw new WorkspaceError('too_large', `The file would be ${bytes.length} bytes; a workspace file holds at most ${WORKSPACE_TEXT_MAX} bytes for now. Split it into several files.`, { size: bytes.length, max: WORKSPACE_TEXT_MAX });
  }
  const sha = sha256Of(bytes);
  if (current.sha256 === sha) {
    if (Object.keys(extra).length) {
      const [entry] = await tx.update(schema.workspaceEntry).set(extra).where(eq(schema.workspaceEntry.id, current.id)).returning();
      return { entry: entry!, changed: false, created: false };
    }
    return { entry: current, changed: false, created: false };
  }
  const mediaType = mediaTypeOf(path);
  await addRef(tx, meter, scope.workspaceId, sha, bytes, mediaType);
  let revisionId: string;
  const [latest] = await tx
    .select()
    .from(schema.workspaceRevision)
    .where(eq(schema.workspaceRevision.entryId, current.id))
    .orderBy(desc(schema.workspaceRevision.updatedAt), desc(schema.workspaceRevision.id))
    .limit(1)
    .for('update');
  if (latest && coalesces(latest, { apiKeyId: scope.apiKeyId, userId: scope.userId, op }, now, WORKSPACE_COALESCE_MS)) {
    await tx
      .update(schema.workspaceRevision)
      .set({ sha256: sha, size: bytes.length, op: latest.op === op ? op : 'write', clientName: scope.client, saves: latest.saves + 1, updatedAt: now })
      .where(eq(schema.workspaceRevision.id, latest.id));
    await dropRef(tx, meter, scope.workspaceId, latest.sha256, now);
    revisionId = latest.id;
  } else {
    const [made] = await tx
      .insert(schema.workspaceRevision)
      .values({ entryId: current.id, workspaceId: scope.workspaceId, sha256: sha, size: bytes.length, op, userId: scope.userId, apiKeyId: scope.apiKeyId, clientName: scope.client, createdAt: now, updatedAt: now })
      .returning({ id: schema.workspaceRevision.id });
    revisionId = made!.id;
  }
  const values = {
    size: bytes.length,
    sha256: sha,
    etag: newEtag(),
    text,
    lineCount: lineCount(text),
    mediaType,
    currentRevisionId: revisionId,
    updatedByKeyId: scope.apiKeyId,
    updatedClient: scope.client,
    updatedAt: now,
    ...extra,
  };
  meter.database += bytes.length - byteLength(current.text ?? '');
  const [entry] = await tx.update(schema.workspaceEntry).set(values).where(eq(schema.workspaceEntry.id, current.id)).returning();
  return { entry: entry!, changed: true, created: false };
}

/** A new file at `path` holding `text`, its version first. */
async function createFile(tx: Tx, meter: Meter, scope: WorkspaceScope, path: string, text: string, op: Revision['op'], now: Date, extra: Partial<typeof schema.workspaceEntry.$inferInsert> = {}): Promise<Written> {
  await bumpEntries(meter, 1);
  const [entry] = await tx
    .insert(schema.workspaceEntry)
    .values({ workspaceId: scope.workspaceId, path, kind: 'file', text: '', size: 0, lineCount: 0, createdAt: now, updatedAt: now, updatedByKeyId: scope.apiKeyId, updatedClient: scope.client })
    .returning();
  const written = await putText(tx, meter, scope, path, { ...entry!, sha256: null }, text, op, now, extra);
  return { ...written, created: true, changed: true };
}

/* ------------------------------------------------------------------ shapes */

export interface EntryView {
  path: string;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  etag: string | null;
  media_type: string | null;
  lines: number | null;
  updated_at: Date;
  updated_by: string | null;
}

function view(scope: WorkspaceScope, entry: Entry): EntryView {
  const path = shown(scope, entry.path);
  return {
    path,
    name: nameOf(path),
    kind: entry.kind,
    size: entry.size,
    etag: entry.kind === 'file' ? entry.etag : null,
    media_type: entry.kind === 'file' ? entry.mediaType : null,
    lines: entry.kind === 'file' ? entry.lineCount : null,
    updated_at: entry.updatedAt,
    updated_by: clientLabel(entry.updatedClient),
  };
}

/* ------------------------------------------------------------------ reading */

/**
 * A glob against an entry: with a `/` in it, the path below the folder
 * searched (`docs/*.md`); without one, the entry's own name at any depth
 * (`*.md`), as ripgrep and most tools read it.
 */
function globMatches(path: SQL, base: number, glob: string): SQL {
  const regex = globToRegex(glob);
  return glob.includes('/') ? sql`substr(${path}, ${base + 1}) ~ ${regex}` : sql`regexp_replace(${path}, '^.*/', '') ~ ${regex}`;
}

export interface ListInput {
  path?: string;
  recursive?: boolean;
  pattern?: string;
  trash?: boolean;
  cursor?: string;
  limit?: number;
}

/** A folder's entries (or everything below it), by path; `trash` lists what was deleted there instead. */
export async function listEntries(scope: WorkspaceScope, input: ListInput) {
  const folder = resolvePath(scope, input.path ?? '/');
  if (!isRootOf(scope, folder) && folder !== '/') {
    const entry = await existing(db(), scope, folder);
    if (entry.kind !== 'folder') throw new WorkspaceError('not_a_directory', `${shown(scope, folder)} is a file; read it with ws_read.`, { path: shown(scope, folder) });
  }
  const limit = Math.min(Math.max(input.limit ?? 200, 1), WORKSPACE_LIST_MAX);
  const base = folder === '/' ? 1 : folder.length + 1;
  const conditions: SQL[] = [eq(schema.workspaceEntry.workspaceId, scope.workspaceId), under(folder)];
  conditions.push(input.trash ? isNotNull(schema.workspaceEntry.deletedAt) : isNull(schema.workspaceEntry.deletedAt));
  if (!input.recursive && !input.trash) conditions.push(sql`position('/' in substr(${schema.workspaceEntry.path}, ${base + 1})) = 0`);
  if (input.pattern) conditions.push(globMatches(sql`${schema.workspaceEntry.path}`, base, input.pattern));
  if (input.cursor) conditions.push(sql`lower(${schema.workspaceEntry.path}) > ${input.cursor.toLowerCase()}`);
  const rows = await db()
    .select()
    .from(schema.workspaceEntry)
    .where(and(...conditions))
    .orderBy(sql`lower(${schema.workspaceEntry.path})`, asc(schema.workspaceEntry.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  return {
    path: shown(scope, folder),
    entries: page.map((row): EntryView & { trash_id?: string; deleted_at?: Date | null } => (input.trash ? { ...view(scope, row), trash_id: row.id, deleted_at: row.deletedAt } : view(scope, row))),
    next_cursor: more ? page[page.length - 1]!.path.toLowerCase() : null,
  };
}

export async function statEntry(scope: WorkspaceScope, rawPath: unknown) {
  const path = resolvePath(scope, rawPath);
  if (path === '/' || isRootOf(scope, path)) {
    const entry = await liveEntry(db(), scope, path);
    if (!entry) return { path: '/', name: '/', kind: 'folder' as const, size: 0, etag: null, media_type: null, lines: null, updated_at: null, updated_by: null, versions: 0, children: 0 };
  }
  const entry = await existing(db(), scope, path);
  const [{ versions } = { versions: 0 }] = await db().select({ versions: sql<number>`count(*)::int` }).from(schema.workspaceRevision).where(eq(schema.workspaceRevision.entryId, entry.id));
  const [{ children } = { children: 0 }] =
    entry.kind === 'folder'
      ? await db().select({ children: sql<number>`count(*)::int` }).from(schema.workspaceEntry).where(and(live(scope), under(entry.path)))
      : [{ children: 0 }];
  return { ...view(scope, entry), versions, children, revision: entry.currentRevisionId, created_at: entry.createdAt };
}

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
  byteOffset?: number;
  byteLength?: number;
  revision?: string;
  lineNumbers?: boolean;
}

/** A file's text (or one of its versions'), a window of lines or bytes at a time. */
export async function readFile(scope: WorkspaceScope, input: ReadInput) {
  const path = resolvePath(scope, input.path);
  const entry = await existing(db(), scope, path);
  if (entry.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder; list it with ws_list.`, { path: shown(scope, path) });
  let text = entry.text ?? '';
  let revision = entry.currentRevisionId;
  if (input.revision && input.revision !== entry.currentRevisionId) {
    const found = await revisionOf(entry, input.revision);
    text = await revisionText(scope, found);
    revision = found.id;
  }
  const head = { path: shown(scope, path), etag: entry.etag, revision, media_type: entry.mediaType, size: byteLength(text), updated_at: entry.updatedAt, updated_by: clientLabel(entry.updatedClient) };
  if (input.byteOffset !== undefined || input.byteLength !== undefined) {
    const window = byteWindow(text, input.byteOffset ?? 0, Math.min(input.byteLength ?? WORKSPACE_READ_MAX, WORKSPACE_READ_MAX));
    return { ...head, content: window.content, byte_offset: input.byteOffset ?? 0, truncated: window.nextOffset !== null, next_byte_offset: window.nextOffset };
  }
  const window = lineWindow(text, { offset: input.offset, limit: input.limit, maxBytes: WORKSPACE_READ_MAX, numbered: input.lineNumbers });
  return { ...head, content: window.content, total_lines: window.totalLines, start_line: window.startLine, end_line: window.endLine, truncated: window.truncated, next_offset: window.nextOffset };
}

async function revisionOf(entry: Entry, id: string): Promise<Revision> {
  const [row] = /^[0-9a-f-]{36}$/i.test(id)
    ? await db().select().from(schema.workspaceRevision).where(and(eq(schema.workspaceRevision.id, id), eq(schema.workspaceRevision.entryId, entry.id)))
    : [];
  if (!row) throw new WorkspaceError('not_found', 'No such version of this file; ws_history lists them.', { revision: id });
  return row;
}

async function revisionText(scope: WorkspaceScope, revision: Revision): Promise<string> {
  const bytes = await readWorkspaceObject(workspaceObjectPath(scope.workspaceId, revision.sha256));
  if (!bytes) throw new Error(`workspace object missing: ${revision.sha256}`);
  return new TextDecoder().decode(bytes);
}

/** A file's whole text, or one version's: the web's download and file page (a file holds at most WORKSPACE_TEXT_MAX bytes). */
export async function fileText(scope: WorkspaceScope, rawPath: unknown, revision?: string) {
  const path = resolvePath(scope, rawPath);
  const entry = await existing(db(), scope, path);
  if (entry.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder.`, { path: shown(scope, path) });
  const text = revision && revision !== entry.currentRevisionId ? await revisionText(scope, await revisionOf(entry, revision)) : (entry.text ?? '');
  return { ...view(scope, entry), revision: revision ?? entry.currentRevisionId, text };
}

/** Every live folder's path (at most `limit`), for the web's folder tree. */
export async function folderPaths(scope: WorkspaceScope, limit = 2000): Promise<string[]> {
  const rows = await db()
    .select({ path: schema.workspaceEntry.path })
    .from(schema.workspaceEntry)
    .where(and(live(scope), eq(schema.workspaceEntry.kind, 'folder')))
    .orderBy(sql`lower(${schema.workspaceEntry.path})`)
    .limit(limit);
  return rows.map((row) => shown(scope, row.path));
}

/** What lives at a path: a file, a folder, the (possibly empty) root, or nothing. */
export async function kindAt(scope: WorkspaceScope, rawPath: unknown): Promise<'file' | 'folder' | null> {
  const path = normalizePath(rawPath);
  if (!path) return null;
  if (path === '/') return 'folder';
  const entry = await liveEntry(db(), scope, underRoot(scope.root, path));
  return entry?.kind ?? null;
}

/** A file's versions, newest first. */
export async function fileHistory(scope: WorkspaceScope, input: { path: string; cursor?: string; limit?: number }) {
  const path = resolvePath(scope, input.path);
  const entry = await existing(db(), scope, path);
  if (entry.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder; only files have versions.`, { path: shown(scope, path) });
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0);
  const rows = await db()
    .select()
    .from(schema.workspaceRevision)
    .where(eq(schema.workspaceRevision.entryId, entry.id))
    .orderBy(desc(schema.workspaceRevision.updatedAt), desc(schema.workspaceRevision.id))
    .limit(limit + 1)
    .offset(offset);
  return {
    path: shown(scope, path),
    etag: entry.etag,
    versions: rows.slice(0, limit).map((row) => ({
      revision: row.id,
      current: row.id === entry.currentRevisionId,
      op: row.op,
      size: row.size,
      saves: row.saves,
      written_by: clientLabel(row.clientName),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
    next_cursor: rows.length > limit ? String(offset + limit) : null,
  };
}

export interface GrepInput {
  pattern: string;
  literal?: boolean;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  context?: number;
  limit?: number;
}

const GREP_LINE_MAX = 400;

/**
 * Lines matching a pattern (a POSIX regular expression, or literal text)
 * in the text files below `path`, by path and line. Postgres runs the match,
 * under a statement timeout, so a pathological pattern costs the database a
 * few seconds and never this process. At most WORKSPACE_GREP_SCAN_MAX bytes
 * of files are searched (`partial` past that).
 */
export async function grepFiles(scope: WorkspaceScope, input: GrepInput) {
  if (!input.pattern) throw new WorkspaceError('invalid_input', 'Give a pattern to search for.', { reason: 'empty_pattern' });
  const folder = resolvePath(scope, input.path ?? '/');
  const limit = Math.min(Math.max(input.limit ?? 100, 1), WORKSPACE_GREP_HITS_MAX);
  const context = Math.min(Math.max(input.context ?? 0, 0), 5);
  const base = folder === '/' ? 1 : folder.length + 1;
  const scope_ = sql`e.workspace_id = ${scope.workspaceId} and e.deleted_at is null and e.kind = 'file' and e.text is not null and (lower(e.path) = lower(${folder}) or lower(e.path) like ${descendantsPattern(folder)})`;
  const glob = input.glob ? sql`and ${globMatches(sql`e.path`, base, input.glob)}` : sql``;
  const source = input.literal ? escapeRegex(input.pattern) : input.pattern;
  const match = input.ignoreCase ? sql`l.line ~* ${source}` : sql`l.line ~ ${source}`;
  let rows: { id: string; path: string; n: number; line: string; partial: boolean }[];
  try {
    rows = await db().transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const result = await tx.execute<{ id: string; path: string; n: string; line: string; partial: boolean }>(sql`
        with files as (
          select e.id, e.path, e.text, sum(e.size) over (order by lower(e.path), e.id) as running
          from ${schema.workspaceEntry} e
          where ${scope_} ${glob}
        ), scanned as (select * from files where running <= ${WORKSPACE_GREP_SCAN_MAX})
        select f.id, f.path, l.n, left(l.line, ${GREP_LINE_MAX}) as line, exists (select 1 from files where running > ${WORKSPACE_GREP_SCAN_MAX}) as partial
        from scanned f, regexp_split_to_table(f.text, E'\\n') with ordinality as l(line, n)
        where ${match}
        order by lower(f.path), l.n
        limit ${limit + 1}`);
      return result.rows.map((row) => ({ ...row, n: Number(row.n) }));
    });
  } catch (error) {
    const failed = (error ?? {}) as { code?: string; cause?: { code?: string } };
    const code = failed.code ?? failed.cause?.code;
    if (code === '2201B') throw new WorkspaceError('invalid_input', 'The pattern is not a valid regular expression; pass literal: true to search for the text as written.', { reason: 'invalid_pattern' });
    if (code === '57014') throw new WorkspaceError('invalid_input', 'The search took too long; narrow it with path or glob, or a simpler pattern.', { reason: 'timeout' });
    throw error;
  }
  const hits = rows.slice(0, limit);
  let texts = new Map<string, string[]>();
  if (context > 0 && hits.length) {
    const ids = [...new Set(hits.map((hit) => hit.id))];
    const files = await db().select({ id: schema.workspaceEntry.id, text: schema.workspaceEntry.text }).from(schema.workspaceEntry).where(inArray(schema.workspaceEntry.id, ids));
    texts = new Map(files.map((file) => [file.id, (file.text ?? '').split('\n')]));
  }
  return {
    pattern: input.pattern,
    matches: hits.map((hit) => {
      const lines = texts.get(hit.id);
      const around = (from: number, to: number) => (lines ? lines.slice(Math.max(0, from), Math.max(0, to)).map((line) => line.slice(0, GREP_LINE_MAX)) : undefined);
      return { path: shown(scope, hit.path), line: hit.n, text: hit.line, ...(context > 0 ? { before: around(hit.n - 1 - context, hit.n - 1), after: around(hit.n, hit.n + context) } : {}) };
    }),
    truncated: rows.length > limit,
    partial: Boolean(rows[0]?.partial),
  };
}

/* ------------------------------------------------------------------ writing */

function checkMatch(scope: WorkspaceScope, path: string, entry: Entry | null, ifMatch: string | undefined): void {
  if (ifMatch === undefined) return;
  if (!entry || entry.etag !== ifMatch) {
    throw new WorkspaceError('conflict', `${shown(scope, path)} changed since you read it (if_match ${ifMatch}). Read it again, merge your change and retry with the new etag.`, {
      path: shown(scope, path),
      current_etag: entry?.etag ?? null,
      updated_by: clientLabel(entry?.updatedClient ?? null),
      updated_at: entry?.updatedAt ?? null,
    });
  }
}

function result(scope: WorkspaceScope, written: Written) {
  return { path: shown(scope, written.entry.path), etag: written.entry.etag, revision: written.entry.currentRevisionId, size: written.entry.size, lines: written.entry.lineCount, created: written.created, changed: written.changed };
}

function noRootWrite(scope: WorkspaceScope, path: string): void {
  if (path === '/' || isRootOf(scope, path)) throw new WorkspaceError('is_a_directory', 'That is the root folder; name a file inside it.', { path: '/' });
}

/** Replaces (or creates) a file's whole content. */
export async function writeFile(scope: WorkspaceScope, input: { path: string; content: string; ifMatch?: string; ifNoneMatch?: string }) {
  const path = resolvePath(scope, input.path);
  noRootWrite(scope, path);
  return mutate(scope, async (tx, meter, now) => {
    const entry = await liveEntry(tx, scope, path, true);
    if (entry?.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder.`, { path: shown(scope, path) });
    if (input.ifNoneMatch === '*' && entry) throw new WorkspaceError('exists', `${shown(scope, path)} already exists (if_none_match "*").`, { path: shown(scope, path), current_etag: entry.etag });
    checkMatch(scope, path, entry, input.ifMatch);
    await ensureFolder(tx, meter, scope, parentOf(path), now);
    const written = entry ? await putText(tx, meter, scope, path, entry, input.content, 'write', now) : await createFile(tx, meter, scope, path, input.content, 'write', now);
    return result(scope, written);
  });
}

/** Adds text to the end of a file (made when missing), atomically; `clientToken` makes a retry a no-op. */
export async function appendFile(scope: WorkspaceScope, input: { path: string; content: string; clientToken?: string }) {
  const path = resolvePath(scope, input.path);
  noRootWrite(scope, path);
  return mutate(scope, async (tx, meter, now) => {
    const entry = await liveEntry(tx, scope, path, true);
    if (entry?.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder.`, { path: shown(scope, path) });
    if (entry && input.clientToken && entry.appendToken === input.clientToken) return { ...result(scope, { entry, changed: false, created: false }), repeated: true };
    await ensureFolder(tx, meter, scope, parentOf(path), now);
    const extra = input.clientToken ? { appendToken: input.clientToken } : {};
    const written = entry
      ? await putText(tx, meter, scope, path, entry, (entry.text ?? '') + input.content, 'append', now, extra)
      : await createFile(tx, meter, scope, path, input.content, 'append', now, extra);
    return result(scope, written);
  });
}

/** Replaces `oldString` with `newString` in a file: once and uniquely, or every time with `replaceAll`. */
export async function editFile(scope: WorkspaceScope, input: { path: string; oldString: string; newString: string; replaceAll?: boolean; ifMatch?: string }) {
  const path = resolvePath(scope, input.path);
  if (!input.oldString) throw new WorkspaceError('invalid_input', 'old_string is empty; use ws_write or ws_append to add text.', { reason: 'empty_old_string' });
  return mutate(scope, async (tx, meter, now) => {
    const entry = await existing(tx, scope, path, true);
    if (entry.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder.`, { path: shown(scope, path) });
    checkMatch(scope, path, entry, input.ifMatch);
    const text = entry.text ?? '';
    const count = text.split(input.oldString).length - 1;
    if (count === 0) throw new WorkspaceError('invalid_input', `old_string does not occur in ${shown(scope, path)}. Read the file again; it may have changed.`, { reason: 'no_match', etag: entry.etag });
    if (count > 1 && !input.replaceAll) {
      throw new WorkspaceError('invalid_input', `old_string occurs ${count} times in ${shown(scope, path)}. Include more surrounding text to make it unique, or set replace_all.`, { reason: 'ambiguous_match', occurrences: count });
    }
    const next = input.replaceAll ? text.split(input.oldString).join(input.newString) : text.replace(input.oldString, () => input.newString);
    const written = await putText(tx, meter, scope, path, entry, next, 'edit', now);
    return { ...result(scope, written), replacements: input.replaceAll ? count : 1 };
  });
}

export async function makeFolder(scope: WorkspaceScope, input: { path: string }) {
  const path = resolvePath(scope, input.path);
  return mutate(scope, async (tx, meter, now) => {
    const entry = await liveEntry(tx, scope, path);
    if (entry?.kind === 'file') throw new WorkspaceError('exists', `${shown(scope, path)} is already a file.`, { path: shown(scope, path) });
    await ensureFolder(tx, meter, scope, path, now);
    return { path: shown(scope, path), created: !entry && path !== '/' };
  });
}

/** Moves or renames a file or folder (everything inside a folder goes with it). */
export async function moveEntry(scope: WorkspaceScope, input: { from: string; to: string; overwrite?: boolean; ifMatch?: string }) {
  const from = resolvePath(scope, input.from, 'from');
  const to = resolvePath(scope, input.to, 'to');
  noRootWrite(scope, from);
  noRootWrite(scope, to);
  return mutate(scope, async (tx, meter, now) => {
    const source = await existing(tx, scope, from, true);
    checkMatch(scope, from, source, input.ifMatch);
    const sameEntry = from.toLowerCase() === to.toLowerCase();
    if (!sameEntry && source.kind === 'folder' && isWithin(to, source.path)) {
      throw new WorkspaceError('invalid_input', 'A folder cannot be moved into itself.', { reason: 'into_itself' });
    }
    if (!sameEntry) {
      const target = await liveEntry(tx, scope, to, true);
      if (target) {
        if (!input.overwrite || target.kind === 'folder' || source.kind === 'folder') {
          throw new WorkspaceError('exists', `${shown(scope, to)} already exists${input.overwrite ? ' and only a file can replace a file' : '; pass overwrite: true to replace a file'}.`, { path: shown(scope, to) });
        }
        /* The replaced file goes to the trash, as a delete would send it. */
        await tx.update(schema.workspaceEntry).set({ deletedAt: now }).where(eq(schema.workspaceEntry.id, target.id));
      }
    }
    await ensureFolder(tx, meter, scope, parentOf(to), now);
    let moved = 1;
    if (source.kind === 'folder') {
      const [{ count } = { count: 0 }] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.workspaceEntry).where(and(live(scope), under(source.path)));
      if (count + 1 > WORKSPACE_MOVE_MAX) throw new WorkspaceError('too_large', `The folder holds ${count} entries; one move takes at most ${WORKSPACE_MOVE_MAX}. Move its subfolders one at a time.`, { entries: count });
      await tx
        .update(schema.workspaceEntry)
        .set({ path: sql`${to} || substr(${schema.workspaceEntry.path}, ${source.path.length + 1})`, updatedAt: now })
        .where(and(live(scope), under(source.path)));
      moved += count;
    }
    await tx.update(schema.workspaceEntry).set({ path: to, updatedAt: now, updatedByKeyId: scope.apiKeyId, updatedClient: scope.client }).where(eq(schema.workspaceEntry.id, source.id));
    return { from: shown(scope, from), to: shown(scope, to), kind: source.kind, moved };
  });
}

/** A copy of one file under another path; the content is shared, not stored twice. */
export async function copyFile(scope: WorkspaceScope, input: { from: string; to: string }) {
  const from = resolvePath(scope, input.from, 'from');
  const to = resolvePath(scope, input.to, 'to');
  noRootWrite(scope, to);
  return mutate(scope, async (tx, meter, now) => {
    const source = await existing(tx, scope, from);
    if (source.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, from)} is a folder; ws_copy copies one file at a time.`, { path: shown(scope, from) });
    if (await liveEntry(tx, scope, to, true)) throw new WorkspaceError('exists', `${shown(scope, to)} already exists.`, { path: shown(scope, to) });
    await ensureFolder(tx, meter, scope, parentOf(to), now);
    const written = await createFile(tx, meter, scope, to, source.text ?? '', 'copy', now);
    return result(scope, written);
  });
}

/** Sends a file, or a folder and everything in it, to the trash for WORKSPACE_TRASH_DAYS. */
export async function trashEntry(scope: WorkspaceScope, input: { path: string; ifMatch?: string }) {
  const path = resolvePath(scope, input.path);
  noRootWrite(scope, path);
  return mutate(scope, async (tx, _meter, now) => {
    const entry = await existing(tx, scope, path, true);
    checkMatch(scope, path, entry, input.ifMatch);
    const inside = entry.kind === 'folder'
      ? await tx.update(schema.workspaceEntry).set({ deletedAt: now }).where(and(live(scope), under(entry.path))).returning({ id: schema.workspaceEntry.id })
      : [];
    await tx.update(schema.workspaceEntry).set({ deletedAt: now }).where(eq(schema.workspaceEntry.id, entry.id));
    return { path: shown(scope, path), trash_id: entry.id, deleted: inside.length + 1, purge_after_days: WORKSPACE_TRASH_DAYS };
  });
}

/**
 * Takes something back out of the trash (by `trashId`, or the latest
 * deleted at `path`) with everything deleted with it; a taken path gets a
 * " (restored)" name. With `revision`, instead, a live file gets that
 * version's content back as a new version.
 */
export async function restoreEntry(scope: WorkspaceScope, input: { path?: string; trashId?: string; revision?: string }) {
  if (input.revision) {
    if (!input.path) throw new WorkspaceError('invalid_input', 'Name the file whose version to restore (path).', { reason: 'path_required' });
    const path = resolvePath(scope, input.path);
    return mutate(scope, async (tx, meter, now) => {
      const entry = await existing(tx, scope, path, true);
      if (entry.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder.`, { path: shown(scope, path) });
      const version = await revisionOf(entry, input.revision!);
      const text = await revisionText(scope, version);
      const written = await putText(tx, meter, scope, path, entry, text, 'restore', now);
      return { ...result(scope, written), restored_revision: version.id };
    });
  }
  return mutate(scope, async (tx, meter, now) => {
    let target: Entry | undefined;
    if (input.trashId) {
      if (/^[0-9a-f-]{36}$/i.test(input.trashId)) {
        [target] = await tx.select().from(schema.workspaceEntry).where(and(eq(schema.workspaceEntry.id, input.trashId), eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNotNull(schema.workspaceEntry.deletedAt))).for('update');
      }
    } else if (input.path) {
      const path = resolvePath(scope, input.path);
      [target] = await tx
        .select()
        .from(schema.workspaceEntry)
        .where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNotNull(schema.workspaceEntry.deletedAt), samePath(path)))
        .orderBy(desc(schema.workspaceEntry.deletedAt))
        .limit(1)
        .for('update');
    } else {
      throw new WorkspaceError('invalid_input', 'Name what to restore: path or trash_id (from ws_list with trash: true), and revision for an older version.', { reason: 'nothing_named' });
    }
    if (!target || relativeToRoot(scope.root, target.path) === null) throw new WorkspaceError('not_found', 'Nothing like that in the trash.', {});
    const deletedAt = target.deletedAt!;
    let destination = target.path;
    if (await liveEntry(tx, scope, destination)) {
      const siblings = await tx.select({ path: schema.workspaceEntry.path }).from(schema.workspaceEntry).where(and(live(scope), under(parentOf(destination))));
      const taken = new Set(siblings.map((row) => row.path.toLowerCase()));
      destination = restoredName(destination, (candidate) => taken.has(candidate.toLowerCase()));
    }
    await ensureFolder(tx, meter, scope, parentOf(destination), now);
    let restored = 1;
    if (target.kind === 'folder') {
      const rows = await tx
        .update(schema.workspaceEntry)
        .set({ deletedAt: null, path: sql`${destination} || substr(${schema.workspaceEntry.path}, ${target.path.length + 1})` })
        .where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), eq(schema.workspaceEntry.deletedAt, deletedAt), under(target.path)))
        .returning({ id: schema.workspaceEntry.id });
      restored += rows.length;
    }
    await tx.update(schema.workspaceEntry).set({ deletedAt: null, path: destination, updatedAt: now }).where(eq(schema.workspaceEntry.id, target.id));
    return { path: shown(scope, destination), restored, renamed: destination !== target.path };
  });
}

/* ------------------------------------------------------------------ the web's own */

/** Deletes trashed entries for good (the owner on the web; the purge after 30 days). */
async function destroy(tx: Tx, meter: Meter, workspaceId: string, ids: readonly string[], now: Date): Promise<number> {
  if (ids.length === 0) return 0;
  const revisions = await tx.select({ sha: schema.workspaceRevision.sha256 }).from(schema.workspaceRevision).where(inArray(schema.workspaceRevision.entryId, [...ids]));
  for (const revision of revisions) await dropRef(tx, meter, workspaceId, revision.sha, now);
  const gone = await tx.delete(schema.workspaceEntry).where(inArray(schema.workspaceEntry.id, [...ids])).returning({ text: schema.workspaceEntry.text });
  meter.entries -= gone.length;
  meter.database -= gone.reduce((sum, row) => sum + byteLength(row.text ?? ''), 0);
  return gone.length;
}

/** The owner empties part of the trash: these entries (and what was deleted with a folder among them). */
export async function purgeTrashed(scope: WorkspaceScope, trashIds: readonly string[]) {
  const ids = trashIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  return mutate(scope, async (tx, meter, now) => {
    const rows = ids.length
      ? await tx.select().from(schema.workspaceEntry).where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNotNull(schema.workspaceEntry.deletedAt), inArray(schema.workspaceEntry.id, ids))).for('update')
      : [];
    const all = new Set(rows.map((row) => row.id));
    for (const row of rows.filter((row) => row.kind === 'folder')) {
      const inside = await tx
        .select({ id: schema.workspaceEntry.id })
        .from(schema.workspaceEntry)
        .where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), eq(schema.workspaceEntry.deletedAt, row.deletedAt!), under(row.path)));
      for (const item of inside) all.add(item.id);
    }
    return { purged: await destroy(tx, meter, scope.workspaceId, [...all], now) };
  });
}

/** The account's storage as the web shows it. */
export async function workspaceUsageOf(userId: string) {
  const [row] = await db().select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId));
  const free = Number(await freeBytes());
  const used = (row?.blobBytes ?? 0) + (row?.databaseBytes ?? 0);
  return { usedBytes: used, blobBytes: row?.blobBytes ?? 0, databaseBytes: row?.databaseBytes ?? 0, entries: row?.entries ?? 0, freeBytes: free, maxBytes: WORKSPACE_BYTES_MAX, maxEntries: WORKSPACE_ENTRIES_MAX };
}

/* ------------------------------------------------------------------ crons */

/**
 * The daily purge (`/api/cron/purge-trash`): trashed entries older than
 * WORKSPACE_TRASH_DAYS; versions older than WORKSPACE_REVISION_DAYS beyond a
 * file's latest WORKSPACE_REVISIONS_KEPT (never the current one); and the
 * objects no version names any more. One owner at a time, under their usage
 * lock, a bounded batch each.
 */
export async function purgeWorkspaces(now = new Date(), limit = 500): Promise<{ entries: number; revisions: number; objects: number }> {
  const trashCutoff = new Date(now.getTime() - WORKSPACE_TRASH_DAYS * 86_400_000);
  const revisionCutoff = new Date(now.getTime() - WORKSPACE_REVISION_DAYS * 86_400_000);
  const owners = await db().execute<{ owner_id: string }>(sql`
    select distinct w.owner_id from ${schema.workspace} w
    where exists (select 1 from ${schema.workspaceEntry} e where e.workspace_id = w.id and e.deleted_at < ${trashCutoff})
       or exists (select 1 from ${schema.workspaceRevision} r where r.workspace_id = w.id and r.updated_at < ${revisionCutoff})
       or exists (select 1 from ${schema.workspaceBlob} b where b.workspace_id = w.id and b.refs = 0)
    limit ${limit}`);
  const totals = { entries: 0, revisions: 0, objects: 0 };
  for (const { owner_id: userId } of owners.rows) {
    const gone: string[] = [];
    try {
      await db().transaction(async (tx) => {
        const meter = new Meter(await lockUsage(tx, userId), now);
        const workspaces = await tx.select({ id: schema.workspace.id }).from(schema.workspace).where(eq(schema.workspace.ownerId, userId));
        for (const { id: workspaceId } of workspaces) {
          const old = await tx
            .select({ id: schema.workspaceEntry.id })
            .from(schema.workspaceEntry)
            .where(and(eq(schema.workspaceEntry.workspaceId, workspaceId), lt(schema.workspaceEntry.deletedAt, trashCutoff)))
            .limit(limit);
          totals.entries += await destroy(tx, meter, workspaceId, old.map((row) => row.id), now);
          const stale = await tx.execute<{ id: string; sha256: string }>(sql`
            select r.id, r.sha256 from (
              select r.*, row_number() over (partition by r.entry_id order by r.updated_at desc, r.id desc) as rank
              from ${schema.workspaceRevision} r where r.workspace_id = ${workspaceId}
            ) r join ${schema.workspaceEntry} e on e.id = r.entry_id
            where r.updated_at < ${revisionCutoff} and r.rank > ${WORKSPACE_REVISIONS_KEPT} and r.id is distinct from e.current_revision_id
            limit ${limit}`);
          for (const row of stale.rows) await dropRef(tx, meter, workspaceId, row.sha256, now);
          if (stale.rows.length) {
            await tx.delete(schema.workspaceRevision).where(inArray(schema.workspaceRevision.id, stale.rows.map((row) => row.id)));
            totals.revisions += stale.rows.length;
          }
          const released = await tx
            .delete(schema.workspaceBlob)
            .where(and(eq(schema.workspaceBlob.workspaceId, workspaceId), eq(schema.workspaceBlob.refs, 0)))
            .returning({ sha: schema.workspaceBlob.sha256 });
          gone.push(...released.map((row) => workspaceObjectPath(workspaceId, row.sha)));
        }
        /* Still under the lock: a write that would name one of these again waits, then puts its object anew. */
        await deleteWorkspaceObjects(gone);
        await meter.save(tx);
      });
      totals.objects += gone.length;
    } catch (error) {
      console.warn(`workspace purge failed user=${userId}`, error instanceof Error ? error.message : error);
    }
  }
  return totals;
}

/**
 * The daily storage charge (`/api/cron/charge-storage`): each account's
 * byte-milliseconds above the free allowance since the last charge, priced
 * at today's storage rates and charged as knowledge storage is
 * (`chargeStorageCost`), then counted again from zero.
 */
export async function chargeWorkspaceStorage(now = new Date(), limit = 1000): Promise<{ userId: string; credits: number }[]> {
  const cutoff = new Date(now.getTime() - 3_600_000);
  const rows = await db().select({ userId: schema.workspaceUsage.userId }).from(schema.workspaceUsage).where(lt(schema.workspaceUsage.measuredAt, cutoff)).limit(limit);
  const charged: { userId: string; credits: number }[] = [];
  for (const { userId } of rows) {
    try {
      const credits = await db().transaction(async (tx) => {
        const row = await lockUsage(tx, userId);
        const earned = await accrued(row, now);
        const rates = await infraCostRates(tx, now);
        const cost = storageCostPico(earned.blob, earned.database, rates);
        await tx.update(schema.workspaceUsage).set({ blobByteMs: '0', databaseByteMs: '0', measuredAt: now }).where(eq(schema.workspaceUsage.userId, userId));
        return cost > 0n ? chargeStorageCost(tx, userId, cost, now, 'Workspace storage') : 0;
      });
      if (credits > 0) charged.push({ userId, credits });
    } catch (error) {
      console.warn(`workspace storage billing failed user=${userId}`, error instanceof Error ? error.message : error);
    }
  }
  return charged;
}
