/**
 * The agent workspace's pure rules (docs/design/agent-workspace.md §3):
 * paths, a key's root, globs, text, line windows, version coalescing and the
 * free storage allowance. No database here; lib/services/workspace.ts uses
 * them.
 *
 * A path is absolute inside the workspace: `/` and NFC segments joined by
 * `/`, no empty, `.` or `..` segment, no control character or backslash, at
 * most WORKSPACE_PATH_MAX bytes (WORKSPACE_SEGMENT_MAX per segment). Case is
 * kept but two live entries may not differ by case alone, so a file synced to
 * macOS or Windows never collides. A key sees its root as `/` (a chroot):
 * every path a tool takes or returns is relative to it, so nothing outside
 * the root can even be named.
 */
import { WORKSPACE_PATH_MAX, WORKSPACE_SEGMENT_MAX } from '@/lib/constants';

export type WorkspaceAccess = 'none' | 'read' | 'write';
export const WORKSPACE_ACCESS = ['none', 'read', 'write'] as const satisfies readonly WorkspaceAccess[];

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).length;

/**
 * A caller's path in canonical form, or null when it cannot be one. A
 * missing leading `/` is added and repeated or trailing slashes dropped,
 * since agents write `notes/a.md` and `notes//a.md/` for the same file.
 */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFC').trim();
  if (!text || /[\u0000-\u001f\u007f\\]/.test(text)) return null;
  const segments = text.split('/').filter((segment) => segment !== '');
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.trim() !== segment || byteLength(segment) > WORKSPACE_SEGMENT_MAX) return null;
  }
  const path = `/${segments.join('/')}`;
  return byteLength(path) > WORKSPACE_PATH_MAX ? null : path;
}

/** The key's root joined with a path it named: `/projects/a` + `/notes.md` = `/projects/a/notes.md`. */
export function underRoot(root: string, path: string): string {
  if (root === '/') return path;
  return path === '/' ? root : `${root}${path}`;
}

/** A workspace path as the key sees it, or null when it is outside the key's root. */
export function relativeToRoot(root: string, path: string): string | null {
  if (root === '/') return path;
  if (path.toLowerCase() === root.toLowerCase()) return '/';
  if (path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return path.slice(root.length);
  return null;
}

/** `/a/b/c.md` → `['/a', '/a/b']`: the folders above an entry, outermost first. */
export function ancestors(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  return segments.slice(0, -1).map((_, index) => `/${segments.slice(0, index + 1).join('/')}`);
}

export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

export function nameOf(path: string): string {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

/** Whether `path` is `folder` or inside it, ignoring case as uniqueness does. */
export function isWithin(path: string, folder: string): boolean {
  if (folder === '/') return true;
  const p = path.toLowerCase();
  const f = folder.toLowerCase();
  return p === f || p.startsWith(`${f}/`);
}

/** A LIKE pattern for everything under `folder` (escaped, lowercased). */
export function descendantsPattern(folder: string): string {
  const base = folder === '/' ? '' : folder.toLowerCase();
  return `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
}

/**
 * A glob as a Postgres/JS regular expression source, anchored: `**` any run
 * of characters, `*` any run without `/`, `?` one character but `/`. Matched
 * against the path below the listed folder (`docs/a.md`, no leading slash).
 */
export function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      // `**` then `/` also matches nothing, so `**` + `/a.md` finds `a.md` at the top.
      if (glob[i + 1] === '/') {
        i += 1;
        out += '(.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, (m) => `\\${m}`);
  }
  return `^${out}$`;
}

/** A literal as a Postgres ARE: every character that means something escaped. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
}

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/jsonl',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  sql: 'application/sql',
  sh: 'text/x-shellscript',
};

/** From the extension, never from what a client claims; plain text otherwise. */
export function mediaTypeOf(path: string): string {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return MEDIA_TYPES[ext] ?? 'text/plain';
}

/** Text the workspace can keep: no NUL (Postgres text cannot hold it). JS strings are always valid UTF-8 once encoded. */
export function isStorableText(text: string): boolean {
  return !text.includes('\u0000');
}

export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

export interface LineWindow {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset: number | null;
}

/**
 * Lines `offset` (1-based) onwards, at most `limit` of them and at most
 * `maxBytes` of text; a window cut short says where the next one starts.
 * With `numbered`, each line carries its number and a tab, as `cat -n` does.
 */
export function lineWindow(text: string, options: { offset?: number; limit?: number; maxBytes: number; numbered?: boolean }): LineWindow {
  const lines = text === '' ? [] : text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const totalLines = lines.length;
  const start = Math.max(1, options.offset ?? 1);
  const last = options.limit ? Math.min(totalLines, start + options.limit - 1) : totalLines;
  const out: string[] = [];
  let bytes = 0;
  let line = start;
  for (; line <= last; line += 1) {
    const raw = lines[line - 1]!;
    const shown = options.numbered ? `${String(line).padStart(6, ' ')}\t${raw}` : raw;
    const size = byteLength(shown) + 1;
    if (bytes + size > options.maxBytes && out.length > 0) break;
    out.push(shown);
    bytes += size;
  }
  const endLine = out.length ? line - 1 : Math.min(start - 1, totalLines);
  /* More lines follow what was returned: the next window starts there. */
  const truncated = endLine < totalLines;
  const joined = out.join('\n');
  /* A read to the end keeps the file's final newline, so a read-modify-write round trip is byte-exact. */
  const content = !truncated && text.endsWith('\n') && out.length > 0 ? `${joined}\n` : joined;
  return { content, startLine: out.length ? start : 0, endLine: out.length ? endLine : 0, totalLines, truncated, nextOffset: truncated ? endLine + 1 : null };
}

/** Bytes `offset` onwards of the UTF-8 text, at most `length`, cut back to a whole character. */
export function byteWindow(text: string, offset: number, length: number): { content: string; nextOffset: number | null; size: number } {
  const bytes = encoder.encode(text);
  let start = Math.max(0, Math.min(offset, bytes.length));
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  let end = Math.min(bytes.length, start + length);
  while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { content: new TextDecoder().decode(bytes.subarray(start, end)), nextOffset: end < bytes.length ? end : null, size: bytes.length };
}

/**
 * Whether a write joins the file's latest version instead of making a new
 * one: the same key (or, from the web, the same user with no key) wrote it
 * less than `windowMs` ago. A restore always makes its own version.
 */
export function coalesces(
  latest: { apiKeyId: string | null; userId: string; updatedAt: Date; op: string } | null,
  writer: { apiKeyId: string | null; userId: string; op: string },
  now: Date,
  windowMs: number,
): boolean {
  if (!latest || writer.op === 'restore' || latest.op === 'restore' || writer.op === 'copy') return false;
  if (latest.userId !== writer.userId || latest.apiKeyId !== writer.apiKeyId) return false;
  return now.getTime() - latest.updatedAt.getTime() < windowMs;
}

/**
 * Bytes billed after the free allowance: it covers Blob bytes first (the
 * cheaper store, so the larger share of most workspaces), then database bytes.
 */
export function billableBytes(blob: bigint, database: bigint, free: bigint): { blob: bigint; database: bigint } {
  const blobBilled = blob > free ? blob - free : 0n;
  const left = free > blob ? free - blob : 0n;
  return { blob: blobBilled, database: database > left ? database - left : 0n };
}

/** `foo.md` → `foo (restored).md`; then ` (restored 2)`… until `taken` says no. */
export function restoredName(path: string, taken: (candidate: string) => boolean): string {
  const parent = parentOf(path);
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n += 1) {
    const candidate = `${parent === '/' ? '' : parent}/${stem} (restored${n === 1 ? '' : ` ${n}`})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Display names for MCP clients' `clientInfo.name`; anything else is shown as sent. */
const CLIENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'claude.ai',
  'claude desktop': 'Claude Desktop',
  'codex-mcp-client': 'Codex',
  codex: 'Codex',
  cursor: 'Cursor',
  'cursor-vscode': 'Cursor',
  windsurf: 'Windsurf',
  'mcp-remote': 'mcp-remote',
};

/** What a client called itself, cleaned for storing: at most 40 printable characters, or null. */
export function cleanClientName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[^\p{L}\p{N} ._\-/@()]/gu, '').trim().slice(0, 40);
  return text || null;
}

export function clientLabel(name: string | null): string | null {
  if (!name) return null;
  return CLIENT_NAMES[name.toLowerCase()] ?? name;
}
