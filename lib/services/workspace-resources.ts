/**
 * The agent workspace as MCP resources (docs/design/agent-workspace-p4.md
 * §3): `re0://ws/{+path}`, the path below the caller's root exactly as the
 * `ws_*` tools show it, so `ws_read {path: "/notes.md"}` and
 * `re0://ws/notes.md` are the same file. A client lists the most recently
 * changed files (RESOURCE_PAGE at a time, RESOURCE_PAGES pages at most),
 * completes a path from what is typed, and reads a whole file: text up to
 * WORKSPACE_TEXT_MAX, or a small image as bytes. Anything else is refused
 * with a pointer to `ws_read` or `ws_download_url`.
 *
 * Every query goes through the same scope as the tools (`live`, `within` the
 * root, `resolvePath`), so a key limited to a folder neither lists, reads nor
 * completes anything outside it. No subscriptions (§3.3).
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { WORKSPACE_TEXT_MAX } from '@/lib/constants';
import { binaryByName, nameOf } from '@/lib/domain/workspace';
import { db, schema } from '@/lib/infra/db';
import { readWorkspaceObject, workspaceObjectPath } from '@/lib/infra/workspace-store';
import { existing, live, resolvePath, shown, within, WorkspaceError, type WorkspaceScope } from '@/lib/services/workspace';

export const RESOURCE_SCHEME = 're0://ws/';
export const RESOURCE_TEMPLATE = 're0://ws/{+path}';
/** Files per `resources/list` page, and how many pages a client may walk: past that, ws_list and ws_grep find the rest. */
export const RESOURCE_PAGE = 100;
export const RESOURCE_PAGES = 10;
/** Paths one `completion/complete` offers. */
export const RESOURCE_COMPLETIONS = 20;
/** The largest image read as bytes: base64 makes it about 1.4 MB, well inside a function's 4.5 MB response. */
export const RESOURCE_IMAGE_MAX = 1024 * 1024;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A file's URI from its path as the caller sees it (`/a/b.md` → `re0://ws/a/b.md`), each segment percent-encoded. */
export function resourceUri(path: string): string {
  return RESOURCE_SCHEME + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

/** The path a URI names (below the caller's root), or null when it is not one of ours. */
export function resourcePath(uri: string): string | null {
  if (!uri.startsWith(RESOURCE_SCHEME)) return null;
  const rest = uri.slice(RESOURCE_SCHEME.length);
  if (!rest || /[?#]/.test(rest)) return null;
  try {
    return `/${rest.split('/').map(decodeURIComponent).join('/')}`;
  } catch {
    return null;
  }
}

interface Cursor {
  /** The last row's `updated_at` as Postgres wrote it (microseconds kept), its id, and the page it ended. */
  t: string;
  i: string;
  p: number;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof value.t === 'string' && value.t.length <= 64 && typeof value.i === 'string' && /^[0-9a-f-]{36}$/i.test(value.i) && Number.isInteger(value.p) && value.p! >= 1) {
      return value as Cursor;
    }
  } catch {
    /* falls through */
  }
  throw new WorkspaceError('invalid_input', 'That cursor is not one resources/list gave; start again without one.', { reason: 'cursor' });
}

export interface WorkspaceResource {
  uri: string;
  name: string;
  title: string;
  mimeType: string;
  size: number;
  annotations: { lastModified: string };
}

/** The scope's files, most recently changed first, a page at a time. */
export async function listResources(scope: WorkspaceScope, rawCursor?: string): Promise<{ resources: WorkspaceResource[]; nextCursor?: string }> {
  const after = rawCursor ? decodeCursor(rawCursor) : null;
  if (after && after.p >= RESOURCE_PAGES) return { resources: [] };
  const entry = schema.workspaceEntry;
  const conditions: SQL[] = [live(scope)!, within(scope.root), eq(entry.kind, 'file')];
  if (after) conditions.push(sql`(${entry.updatedAt}, ${entry.id}) < (${after.t}::timestamptz, ${after.i}::uuid)`);
  const rows = await db()
    .select({ row: entry, at: sql<string>`${entry.updatedAt}::text` })
    .from(entry)
    .where(and(...conditions))
    .orderBy(desc(entry.updatedAt), desc(entry.id))
    .limit(RESOURCE_PAGE + 1);
  const page = rows.slice(0, RESOURCE_PAGE);
  const number = (after?.p ?? 0) + 1;
  const resources = page.map(({ row }) => {
    const path = shown(scope, row.path);
    return { uri: resourceUri(path), name: nameOf(path), title: path, mimeType: row.mediaType ?? 'text/plain', size: row.size, annotations: { lastModified: row.updatedAt.toISOString() } };
  });
  const last = page[page.length - 1];
  return rows.length > RESOURCE_PAGE && number < RESOURCE_PAGES && last ? { resources, nextCursor: encodeCursor({ t: last.at, i: last.row.id, p: number }) } : { resources };
}

export type ResourceContents = { uri: string; mimeType: string; text: string } | { uri: string; mimeType: string; blob: string };

/** One file, whole: its text, or a small image's bytes; anything else refused with where to get it instead. */
export async function readResource(scope: WorkspaceScope, uri: string): Promise<ResourceContents> {
  const named = resourcePath(uri);
  if (named === null) throw new WorkspaceError('not_found', `${uri} is not a workspace resource: they look like ${RESOURCE_TEMPLATE}.`, { uri });
  const path = resolvePath(scope, named);
  const entry = await existing(db(), scope, path);
  const shownPath = shown(scope, path);
  if (entry.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shownPath} is a folder; list it with ws_list.`, { path: shownPath });
  const canonical = resourceUri(shownPath);
  const mimeType = entry.mediaType ?? 'text/plain';
  if (entry.text !== null) return { uri: canonical, mimeType, text: entry.text };
  if (IMAGE_TYPES.has(mimeType) && entry.size <= RESOURCE_IMAGE_MAX && entry.sha256) {
    const bytes = await readWorkspaceObject(workspaceObjectPath(scope.workspaceId, entry.sha256));
    if (!bytes) throw new Error(`workspace object missing: ${entry.sha256}`);
    return { uri: canonical, mimeType, blob: Buffer.from(bytes).toString('base64') };
  }
  const image = IMAGE_TYPES.has(mimeType);
  throw new WorkspaceError(
    'too_large',
    image
      ? `${shownPath} is an image of ${entry.size} bytes, more than the ${RESOURCE_IMAGE_MAX} a resource read returns. In a client with a shell, get it with ws_download_url and curl.`
      : entry.size > WORKSPACE_TEXT_MAX && !binaryByName(entry.path)
        ? `${shownPath} is ${entry.size} bytes, more than the ${WORKSPACE_TEXT_MAX} a resource read returns. In a client with a shell, get it with ws_download_url and curl; ws_search finds its text once it is indexed.`
        : `${shownPath} is a binary file (${mimeType}, ${entry.size} bytes) that a resource read does not return. In a client with a shell, get it with ws_download_url and curl; ws_search finds its text once it is indexed (PDF, Word).`,
    { path: shownPath, media_type: mimeType, size: entry.size },
  );
}

/** A path as the template's `path` takes it: below the root, without the leading slash. */
function templateValue(scope: WorkspaceScope, path: string, folder: boolean): string {
  return shown(scope, path).replace(/^\/+/, '') + (folder ? '/' : '');
}

/** Paths starting with what was typed (case-insensitively, as paths are unique), folders ending in `/`, sorted. */
export async function completePaths(scope: WorkspaceScope, typed: string): Promise<{ values: string[]; hasMore: boolean }> {
  const value = typed.replace(/^\/+/, '');
  /* Control characters and backslashes are never in a path; nothing can match. */
  if (value.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(value)) return { values: [], hasMore: false };
  const base = scope.root === '/' ? '' : scope.root;
  const pattern = `${base}/${value}`.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
  const entry = schema.workspaceEntry;
  const rows = await db()
    .select({ path: entry.path, kind: entry.kind })
    .from(entry)
    .where(and(live(scope), within(scope.root), sql`lower(${entry.path}) <> lower(${scope.root})`, sql`lower(${entry.path}) like lower(${pattern})`))
    .orderBy(sql`lower(${entry.path})`)
    .limit(RESOURCE_COMPLETIONS + 1);
  return { values: rows.slice(0, RESOURCE_COMPLETIONS).map((row) => templateValue(scope, row.path, row.kind === 'folder')), hasMore: rows.length > RESOURCE_COMPLETIONS };
}
