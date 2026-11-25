/**
 * Bytes in and out of the agent workspace (docs/design/agent-workspace.md
 * §3.1, §4.3, third phase): binary files and text too large to write
 * through MCP, for clients with a shell (`curl`).
 *
 * Upload: `ws_upload_url` (or the web) checks what the save will check --
 * write access, the path inside the key's root, a file and not a folder,
 * `if_match` / `if_none_match`, the debt and the quota -- and opens a ticket
 * (`agent_workspace_upload`) whose URL, `/api/files/upload/<token>`, is the
 * only credential: the token is random, kept here as a digest, and lives
 * WORKSPACE_UPLOAD_TTL_MS. A file up to WORKSPACE_UPLOAD_PART comes in one
 * PUT; a larger one, up to WORKSPACE_UPLOAD_MAX, in parts of exactly that
 * size (the last one smaller), `?part=1..n`, in any order. Each part is
 * checked against its exact length before its body is read, kept as its own
 * object (a part sent again replaces itself), and the request that brings
 * the last one stitches the file: the parts are read in order as one stream,
 * once to hash it and once to write it to `workspace/<ws>/<sha256>` --
 * Blob takes that write in parts of its own, so 100 MB is never held whole
 * -- then saved as a version like any write (debt, daily writes, quota and
 * `if_match` checked again, under the owner's lock), and the parts deleted.
 * A key revoked, narrowed or moved meanwhile makes the upload fail. An upload
 * not finished in time has its parts deleted by `reapUploads`; parts are
 * never counted in the workspace's usage, so an unfinished upload is never
 * billed.
 *
 * Download: `ws_download_url` (and the web) give a URL,
 * `/api/files/download/<token>`, signed with the server's secret for one
 * version of one file and WORKSPACE_DOWNLOAD_TTL_MS. The route checks the
 * signature, the expiry and that the version still belongs to a live file,
 * then streams the object as an attachment (`nosniff`, a sandboxing CSP,
 * never cached), its type from the file's extension.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  WORKSPACE_DOWNLOAD_TTL_MS,
  WORKSPACE_TEXT_MAX,
  WORKSPACE_UPLOAD_KEEP_MS,
  WORKSPACE_UPLOAD_MAX,
  WORKSPACE_UPLOAD_PART,
  WORKSPACE_UPLOAD_PENDING_MAX,
  WORKSPACE_UPLOAD_TTL_MS,
  WORKSPACE_UPLOADS_OPEN,
} from '@/lib/constants';
import { binaryByName, decodeText, mediaTypeOf, nameOf, partCount, partLength } from '@/lib/domain/workspace';
import { appBaseUrl } from '@/lib/http/cookies';
import { authSecret } from '@/lib/infra/crypto/secrets';
import { base64UrlDecode, base64UrlEncode, hmacSha256, randomToken, sha256, timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { db, schema } from '@/lib/infra/db';
import {
  deleteWorkspaceObjects,
  openWorkspaceObject,
  putWorkspaceObject,
  putWorkspaceStream,
  readWorkspaceObject,
  workspaceObjectPath,
  workspaceUploadPartPath,
} from '@/lib/infra/workspace-store';
import { checkUpload, existing, requireWriteAccess, resolvePath, saveUploaded, shown, within, WorkspaceError, type WorkspaceScope } from '@/lib/services/workspace';

type Ticket = typeof schema.workspaceUpload.$inferSelect;

/* ------------------------------------------------------------------ opening an upload */

export interface UploadInput {
  path: string;
  size: unknown;
  ifMatch?: string;
  ifNoneMatch?: string;
}

/** A shell-safe single-quoted string. */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * `ws_upload_url`: a ticket for `size` bytes at `path`, refused at once when
 * the save would be (see the header), and the curl command that sends it.
 */
export async function createUpload(scope: WorkspaceScope, input: UploadInput, now = new Date()) {
  requireWriteAccess(scope);
  const path = resolvePath(scope, input.path);
  const size = typeof input.size === 'number' ? input.size : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 0) throw new WorkspaceError('invalid_input', 'size is the file\'s length in bytes (wc -c < file).', { reason: 'invalid_size' });
  if (size > WORKSPACE_UPLOAD_MAX) {
    throw new WorkspaceError('too_large', `The file is ${size} bytes; an upload holds at most ${WORKSPACE_UPLOAD_MAX} bytes.`, { size, max: WORKSPACE_UPLOAD_MAX });
  }
  if (input.ifNoneMatch !== undefined && input.ifNoneMatch !== '*') throw new WorkspaceError('invalid_input', 'if_none_match takes only "*" (create, never replace).', { reason: 'invalid_if_none_match' });
  await checkUpload(scope, path, size, { ifMatch: input.ifMatch, ifNoneMatch: input.ifNoneMatch === '*' });
  /* Unfinished uploads are not billed, so they are few and small: never a free place to keep files. */
  const [open] = await db()
    .select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${schema.workspaceUpload.size}), 0)::bigint` })
    .from(schema.workspaceUpload)
    .where(and(eq(schema.workspaceUpload.userId, scope.userId), inArray(schema.workspaceUpload.status, ['open', 'assembling']), sql`${schema.workspaceUpload.expiresAt} > ${now.toISOString()}::timestamptz`));
  if ((open?.count ?? 0) >= WORKSPACE_UPLOADS_OPEN || Number(open?.bytes ?? 0) + size > WORKSPACE_UPLOAD_PENDING_MAX) {
    throw new WorkspaceError('limit_reached', `The account has ${open?.count ?? 0} unfinished uploads (${open?.bytes ?? 0} bytes); at most ${WORKSPACE_UPLOADS_OPEN}, ${WORKSPACE_UPLOAD_PENDING_MAX} bytes together. Finish them, or wait for them to expire.`, { reason: 'uploads_open' });
  }
  const token = randomToken(32);
  const parts = partCount(size, WORKSPACE_UPLOAD_PART);
  const expiresAt = new Date(now.getTime() + WORKSPACE_UPLOAD_TTL_MS);
  const [ticket] = await db()
    .insert(schema.workspaceUpload)
    .values({
      tokenHash: await sha256(token),
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      apiKeyId: scope.apiKeyId,
      client: scope.client,
      path,
      size,
      parts,
      ifMatch: input.ifMatch ?? null,
      ifNoneMatch: input.ifNoneMatch === '*',
      expiresAt,
      createdAt: now,
    })
    .returning({ id: schema.workspaceUpload.id });
  const url = `${appBaseUrl()}/api/files/upload/${token}`;
  const local = nameOf(path);
  const curl =
    parts === 1
      ? `curl -fsS -X PUT -T ${quoted(local)} ${quoted(url)}`
      : `split -b ${WORKSPACE_UPLOAD_PART} ${quoted(local)} "\${TMPDIR:-/tmp}/re0-${ticket!.id}-" && n=1 && for f in "\${TMPDIR:-/tmp}/re0-${ticket!.id}-"*; do curl -fsS -X PUT -T "$f" ${quoted(`${url}?part=`)}"$n" || break; n=$((n+1)); done; rm -f "\${TMPDIR:-/tmp}/re0-${ticket!.id}-"*`;
  return {
    path: shown(scope, path),
    url,
    method: 'PUT' as const,
    size,
    parts,
    part_size: WORKSPACE_UPLOAD_PART,
    expires_at: expiresAt,
    curl,
    note:
      parts === 1
        ? 'Send the file as the body of one PUT to url (curl -T). The response is the saved file (etag, sha256). The URL works once.'
        : `Send the file in ${parts} parts of exactly ${WORKSPACE_UPLOAD_PART} bytes (the last one smaller) as PUT url?part=1..${parts}, in any order; a part sent again replaces itself. The response to the last one is the saved file. curl shows a way to do it.`,
  };
}

/* ------------------------------------------------------------------ taking the bytes */

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** The ticket a token names, or why it cannot be used. */
async function ticketFor(token: string, now: Date): Promise<Ticket> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new UploadError(404, 'not_found', 'No such upload.');
  const [ticket] = await db().select().from(schema.workspaceUpload).where(eq(schema.workspaceUpload.tokenHash, await sha256(token)));
  if (!ticket) throw new UploadError(404, 'not_found', 'No such upload.');
  if (ticket.status === 'done') throw new UploadError(409, 'already_done', 'This upload is finished; ask for a new upload URL to send the file again.');
  if (ticket.status !== 'open' || ticket.expiresAt <= now) throw new UploadError(410, 'expired', 'This upload URL has expired or failed; ask for a new one.');
  return ticket;
}

/**
 * Who the upload saves as, checked again now: a key revoked, expired, left
 * without write access, or narrowed so the path is outside its root makes
 * the upload fail, as a call with that key would.
 */
async function ticketScope(ticket: Ticket, now: Date): Promise<WorkspaceScope> {
  if (!ticket.apiKeyId) return { userId: ticket.userId, workspaceId: ticket.workspaceId, root: '/', access: 'write', apiKeyId: null, client: ticket.client ?? 'web' };
  const [key] = await db().select().from(schema.apiKey).where(eq(schema.apiKey.id, ticket.apiKeyId));
  const usable = key && !key.revokedAt && (!key.expiresAt || key.expiresAt > now) && key.userId === ticket.userId && key.workspaceAccess === 'write' && (key.workspaceId === null || key.workspaceId === ticket.workspaceId);
  if (!usable) throw new UploadError(403, 'workspace_not_allowed', 'The key this upload was made with can no longer write files.');
  const root = key.workspaceId ? key.workspaceRoot : '/';
  const [inside] = await db().execute<{ yes: boolean }>(sql`select ${within(root, sql`${ticket.path}::text`)} as yes`).then((result) => result.rows);
  if (!inside?.yes) throw new UploadError(403, 'workspace_not_allowed', 'The key this upload was made with can no longer reach this path.');
  return { userId: ticket.userId, workspaceId: ticket.workspaceId, root, access: 'write', apiKeyId: key.id, client: ticket.client };
}

/** A request body read up to exactly `length` bytes: more, or fewer, is refused (`length_mismatch`). */
async function readExactly(body: ReadableStream<Uint8Array> | null, length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  let at = 0;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > length) {
        await reader.cancel().catch(() => undefined);
        throw new UploadError(400, 'length_mismatch', `This part must be exactly ${length} bytes; more were sent.`);
      }
      bytes.set(value, at);
      at += value.length;
    }
  }
  if (at !== length) throw new UploadError(400, 'length_mismatch', `This part must be exactly ${length} bytes; ${at} were sent.`);
  return bytes;
}

export interface PartRequest {
  part: string | null;
  contentLength: string | null;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * One PUT to an upload URL (see the header): the part's length is checked
 * before its body is read; the response is the saved file once the last
 * part is in, or how many parts have arrived.
 */
export async function receivePart(token: string, request: PartRequest, now = new Date()) {
  const ticket = await ticketFor(token, now);
  const n = request.part === null ? (ticket.parts === 1 ? 1 : 0) : /^[0-9]{1,4}$/.test(request.part) ? Number(request.part) : 0;
  if (n < 1 || n > ticket.parts) {
    throw new UploadError(400, 'invalid_part', ticket.parts === 1 ? 'This upload takes one PUT without ?part.' : `This upload takes parts ?part=1..${ticket.parts}.`);
  }
  const expected = partLength(ticket.size, WORKSPACE_UPLOAD_PART, n);
  if (request.contentLength !== null && Number(request.contentLength) !== expected) {
    throw new UploadError(400, 'length_mismatch', `Part ${n} must be exactly ${expected} bytes; Content-Length says ${request.contentLength}.`);
  }
  const bytes = await readExactly(request.body, expected);
  if (ticket.parts === 1) return finishSingle(ticket, bytes, now);
  await putWorkspaceObject(workspaceUploadPartPath(ticket.workspaceId, ticket.id, n), bytes, 'application/octet-stream');
  /* The set of parts received, kept sorted and without repeats: a part sent again counts once. */
  const [row] = await db()
    .update(schema.workspaceUpload)
    .set({ received: sql`array(select distinct p from unnest(array_append(${schema.workspaceUpload.received}, ${n}::int)) as p order by p)` })
    .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, 'open')))
    .returning({ received: schema.workspaceUpload.received });
  if (!row) throw new UploadError(410, 'expired', 'This upload ended while the part was arriving; ask for a new upload URL.');
  if (row.received.length < ticket.parts) return { done: false as const, part: n, received: row.received.length, parts: ticket.parts };
  /* Every part is in: one request (whichever claims it) stitches the file. */
  const [claimed] = await db()
    .update(schema.workspaceUpload)
    .set({ status: 'assembling' })
    .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, 'open')))
    .returning();
  if (!claimed) return { done: false as const, part: n, received: row.received.length, parts: ticket.parts, assembling: true };
  return finishParts(claimed, now);
}

async function finishSingle(ticket: Ticket, bytes: Uint8Array, now: Date) {
  const [claimed] = await db()
    .update(schema.workspaceUpload)
    .set({ status: 'assembling' })
    .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, 'open')))
    .returning();
  if (!claimed) throw new UploadError(409, 'already_done', 'This upload is already being saved.');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.length <= WORKSPACE_TEXT_MAX && !binaryByName(ticket.path) ? decodeText(bytes) : null;
  return settle(claimed, sha, text, now, async () => {
    await putWorkspaceObject(workspaceObjectPath(ticket.workspaceId, sha), bytes, text === null ? mediaTypeOf(ticket.path, { binary: true }) : `${mediaTypeOf(ticket.path)}; charset=utf-8`);
  });
}

/** The parts in order, as one stream, each object opened only when the one before it is read out. */
function partsStream(ticket: Ticket): ReadableStream<Uint8Array> {
  let n = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!current) {
          n += 1;
          if (n > ticket.parts) {
            controller.close();
            return;
          }
          const part = await openWorkspaceObject(workspaceUploadPartPath(ticket.workspaceId, ticket.id, n));
          if (!part) throw new Error(`upload part missing: ${ticket.id} ${n}`);
          current = part.stream.getReader();
        }
        const { done, value } = await current.read();
        if (done) {
          current = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    async cancel() {
      await current?.cancel().catch(() => undefined);
    },
  });
}

async function finishParts(ticket: Ticket, now: Date) {
  let hashed: { sha: string; text: string | null };
  try {
    hashed = await hashParts(ticket);
  } catch (error) {
    await db().update(schema.workspaceUpload).set({ status: 'failed', error: 'failed', completedAt: new Date() }).where(eq(schema.workspaceUpload.id, ticket.id));
    await deleteWorkspaceObjects(partPaths(ticket)).catch(() => undefined);
    throw error;
  }
  const { sha, text } = hashed;
  return settle(ticket, sha, text, now, async () => {
    /* Second pass: written as it is read; skipped when the workspace already holds these bytes. */
    const [held] = await db().select({ refs: schema.workspaceBlob.refs }).from(schema.workspaceBlob).where(and(eq(schema.workspaceBlob.workspaceId, ticket.workspaceId), eq(schema.workspaceBlob.sha256, sha)));
    if (held && held.refs > 0) return;
    await putWorkspaceStream(workspaceObjectPath(ticket.workspaceId, sha), partsStream(ticket), text === null ? mediaTypeOf(ticket.path, { binary: true }) : `${mediaTypeOf(ticket.path)}; charset=utf-8`);
  });
}

async function hashParts(ticket: Ticket): Promise<{ sha: string; text: string | null }> {
  /* First pass: the hash (and the text, for a file small enough to keep inline), never the whole file in memory. */
  const hash = createHash('sha256');
  const small = ticket.size <= WORKSPACE_TEXT_MAX && !binaryByName(ticket.path) ? new Uint8Array(ticket.size) : null;
  let at = 0;
  const reader = partsStream(ticket).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    small?.set(value, at);
    at += value.length;
  }
  if (at !== ticket.size) throw new Error(`upload ${ticket.id} stitched to ${at} bytes, not ${ticket.size}`);
  return { sha: hash.digest('hex'), text: small ? decodeText(small) : null };
}

const partPaths = (ticket: Pick<Ticket, 'workspaceId' | 'id' | 'parts'>) => Array.from({ length: ticket.parts }, (_, i) => workspaceUploadPartPath(ticket.workspaceId, ticket.id, i + 1));

/**
 * The stitched file saved as a version (or the upload failed), its parts
 * deleted either way. A save that is refused leaves no object behind unless
 * another version already names those bytes.
 */
async function settle(ticket: Ticket, sha: string, text: string | null, now: Date, put: () => Promise<void>) {
  try {
    const scope = await ticketScope(ticket, now);
    await put();
    let saved;
    try {
      saved = await saveUploaded(scope, { path: ticket.path, sha, size: ticket.size, text, ifMatch: ticket.ifMatch, ifNoneMatch: ticket.ifNoneMatch });
    } catch (error) {
      const [held] = await db().select({ refs: schema.workspaceBlob.refs }).from(schema.workspaceBlob).where(and(eq(schema.workspaceBlob.workspaceId, ticket.workspaceId), eq(schema.workspaceBlob.sha256, sha)));
      if (!held || held.refs === 0) await deleteWorkspaceObjects([workspaceObjectPath(ticket.workspaceId, sha)]).catch(() => undefined);
      throw error;
    }
    await db().update(schema.workspaceUpload).set({ status: 'done', sha256: sha, revisionId: saved.revision, completedAt: new Date() }).where(eq(schema.workspaceUpload.id, ticket.id));
    return { done: true as const, ...saved };
  } catch (error) {
    const code = error instanceof WorkspaceError || error instanceof UploadError ? error.code : 'failed';
    await db().update(schema.workspaceUpload).set({ status: 'failed', error: code, completedAt: new Date() }).where(eq(schema.workspaceUpload.id, ticket.id));
    throw error;
  } finally {
    if (ticket.parts > 1) await deleteWorkspaceObjects(partPaths(ticket)).catch((error) => console.warn(`upload parts not deleted id=${ticket.id}`, error instanceof Error ? error.message : error));
  }
}

/* ------------------------------------------------------------------ cleaning up */

/**
 * Uploads past their expiry, unfinished or failed in the middle of
 * stitching: their parts deleted (they were never counted, so never
 * billed). Records are forgotten after WORKSPACE_UPLOAD_KEEP_MS. Answers how
 * many it ended and forgot.
 */
export async function reapUploads(now = new Date(), limit = 100): Promise<{ ended: number; forgotten: number }> {
  const stale = await db()
    .select()
    .from(schema.workspaceUpload)
    .where(and(inArray(schema.workspaceUpload.status, ['open', 'assembling']), lt(schema.workspaceUpload.expiresAt, now)))
    .limit(limit);
  let ended = 0;
  for (const ticket of stale) {
    const [claimed] = await db()
      .update(schema.workspaceUpload)
      .set({ status: 'failed', error: 'expired', completedAt: now })
      .where(and(eq(schema.workspaceUpload.id, ticket.id), inArray(schema.workspaceUpload.status, ['open', 'assembling'])))
      .returning({ id: schema.workspaceUpload.id });
    if (!claimed) continue;
    if (ticket.parts > 1) await deleteWorkspaceObjects(partPaths(ticket));
    ended += 1;
  }
  const gone = await db()
    .delete(schema.workspaceUpload)
    .where(and(lt(schema.workspaceUpload.createdAt, new Date(now.getTime() - WORKSPACE_UPLOAD_KEEP_MS)), or(inArray(schema.workspaceUpload.status, ['done', 'failed']), lt(schema.workspaceUpload.expiresAt, now))))
    .returning({ id: schema.workspaceUpload.id });
  return { ended, forgotten: gone.length };
}

/* ------------------------------------------------------------------ downloads */

interface DownloadClaim {
  w: string;
  e: string;
  r: string;
  x: number;
}

const signed = (payload: string) => hmacSha256(authSecret(), `re0:workspace-download:v1:${payload}`);

/** One version of the file at `path` (the current one by default), inside the scope's root. */
export async function versionAt(scope: WorkspaceScope, rawPath: unknown, revision?: string) {
  const path = resolvePath(scope, rawPath);
  const entry = await existing(db(), scope, path);
  if (entry.kind === 'folder') throw new WorkspaceError('is_a_directory', `${shown(scope, path)} is a folder; ask for one file at a time.`, { path: shown(scope, path) });
  if (!revision || revision === entry.currentRevisionId) return { entryId: entry.id, path: entry.path, revision: entry.currentRevisionId!, sha: entry.sha256!, size: entry.size };
  const [found] = /^[0-9a-f-]{36}$/i.test(revision)
    ? await db().select().from(schema.workspaceRevision).where(and(eq(schema.workspaceRevision.id, revision), eq(schema.workspaceRevision.entryId, entry.id)))
    : [];
  if (!found) throw new WorkspaceError('not_found', 'No such version of this file; ws_history lists them.', { revision });
  return { entryId: entry.id, path: entry.path, revision: found.id, sha: found.sha256, size: found.size };
}

/** `ws_download_url`: a URL for one version of a file (the current one by default), valid WORKSPACE_DOWNLOAD_TTL_MS. */
export async function downloadUrl(scope: WorkspaceScope, input: { path: string; revision?: string }, now = new Date()) {
  const version = await versionAt(scope, input.path, input.revision);
  const path = version.path;
  const { revision, size } = version;
  const expires = now.getTime() + WORKSPACE_DOWNLOAD_TTL_MS;
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ w: scope.workspaceId, e: version.entryId, r: revision, x: expires } satisfies DownloadClaim)));
  const url = `${appBaseUrl()}/api/files/download/${payload}.${await signed(payload)}`;
  return { path: shown(scope, path), url, size, revision, expires_at: new Date(expires), curl: `curl -fsS -o ${quoted(nameOf(path))} ${quoted(url)}` };
}

/** What a download URL names, checked: the signature, the expiry, and a version that still belongs to a live file. */
export async function openDownload(token: string, now = new Date()) {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || payload.length > 400) throw new UploadError(404, 'not_found', 'No such download.');
  if (!timingSafeEqual(await signed(payload), signature)) throw new UploadError(404, 'not_found', 'No such download.');
  let claim: DownloadClaim;
  try {
    claim = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as DownloadClaim;
  } catch {
    throw new UploadError(404, 'not_found', 'No such download.');
  }
  if (!(claim.x > now.getTime())) throw new UploadError(410, 'expired', 'This download URL has expired; ask for a new one.');
  const [row] = await db()
    .select({ path: schema.workspaceEntry.path, sha: schema.workspaceRevision.sha256, size: schema.workspaceRevision.size })
    .from(schema.workspaceRevision)
    .innerJoin(schema.workspaceEntry, and(eq(schema.workspaceEntry.id, schema.workspaceRevision.entryId), isNull(schema.workspaceEntry.deletedAt)))
    .where(and(eq(schema.workspaceRevision.id, claim.r), eq(schema.workspaceRevision.entryId, claim.e), eq(schema.workspaceEntry.workspaceId, claim.w)));
  if (!row) throw new UploadError(404, 'not_found', 'This file or version is no longer there.');
  return streamVersion(claim.w, row);
}

/** One version's bytes as a download response: an attachment, typed from the name, never sniffed, never run, never cached. */
export async function streamVersion(workspaceId: string, version: { path: string; sha: string; size: number }): Promise<Response> {
  const object = await openWorkspaceObject(workspaceObjectPath(workspaceId, version.sha));
  if (!object) throw new UploadError(404, 'not_found', 'The file\'s bytes are missing.');
  const name = nameOf(version.path);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const type = mediaTypeOf(version.path, { binary: true });
  return new Response(object.stream, {
    headers: {
      'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
      'content-length': String(version.size),
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
}

/** A version's bytes for the index (PDF and Word text), at most `max` bytes; null when larger or missing. */
export async function versionBytes(workspaceId: string, sha: string, size: number, max: number): Promise<Uint8Array | null> {
  if (size > max) return null;
  return readWorkspaceObject(workspaceObjectPath(workspaceId, sha));
}
