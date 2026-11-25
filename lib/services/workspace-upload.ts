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
import { createHash, hkdfSync } from 'node:crypto';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  WORKSPACE_DOWNLOAD_INLINE_MAX,
  WORKSPACE_DOWNLOAD_TTL_MS,
  WORKSPACE_STITCH_BUDGET_MS,
  WORKSPACE_STITCH_LEASE_MS,
  WORKSPACE_TEXT_MAX,
  WORKSPACE_UPLOAD_KEEP_MS,
  WORKSPACE_UPLOAD_MAX,
  WORKSPACE_UPLOAD_PART,
  WORKSPACE_UPLOAD_PENDING_MAX,
  WORKSPACE_UPLOAD_REWRITES,
  WORKSPACE_UPLOAD_TTL_MS,
  WORKSPACE_UPLOADS_OPEN,
} from '@/lib/constants';
import { binaryByName, decodeText, mediaTypeOf, nameOf, partCount, partLength } from '@/lib/domain/workspace';
import { appBaseUrl } from '@/lib/http/cookies';
import { authSecret } from '@/lib/infra/crypto/secrets';
import { base64UrlDecode, base64UrlEncode, hmacSha256, randomToken, sha256, timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { db, schema } from '@/lib/infra/db';
import {
  abandonAssembly,
  assemblePart,
  deleteWorkspaceObjects,
  finishAssembly,
  openWorkspaceObject,
  putWorkspaceObject,
  readWorkspaceObject,
  signedObjectUrl,
  startAssembly,
  workspaceObjectPath,
  workspaceUploadPartPath,
  type Assembly,
} from '@/lib/infra/workspace-store';
import { ResumableSha256 } from '@/lib/domain/sha256';
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
      : /* Exits non-zero when a part fails, after removing the pieces. */
        `p="\${TMPDIR:-/tmp}/re0-${ticket!.id}-" && split -b ${WORKSPACE_UPLOAD_PART} ${quoted(local)} "$p" && ok=1 && n=1 && for f in "$p"*; do curl -fsS -X PUT -T "$f" ${quoted(`${url}?part=`)}"$n" || { ok=0; break; }; n=$((n+1)); done; rm -f "$p"*; [ "$ok" = 1 ]`;
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
        : `Send the file in ${parts} parts of exactly ${WORKSPACE_UPLOAD_PART} bytes (the last one smaller) as PUT url?part=1..${parts}, in any order; a part sent again replaces itself (up to ${WORKSPACE_UPLOAD_REWRITES} sends a part in all). Once all are in, the file is put together and saved: the response to the last part is the saved file, or {assembling: true} for a large file still being put together -- GET url shows when it is saved. curl shows a way to do it.`,
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

async function ticketByToken(token: string): Promise<Ticket> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new UploadError(404, 'not_found', 'No such upload.');
  const [ticket] = await db().select().from(schema.workspaceUpload).where(eq(schema.workspaceUpload.tokenHash, await sha256(token)));
  if (!ticket) throw new UploadError(404, 'not_found', 'No such upload.');
  return ticket;
}

/** The ticket a token names, still taking parts, or why not. */
async function openTicket(token: string, now: Date): Promise<Ticket> {
  const ticket = await ticketByToken(token);
  if (ticket.status === 'done') throw new UploadError(409, 'already_done', 'This upload is finished; ask for a new upload URL to send the file again.');
  if (ticket.status === 'assembling') throw new UploadError(409, 'assembling', 'Every part is in and the file is being put together; GET this URL to see when it is saved. Parts are no longer taken.');
  if (ticket.status !== 'open' || ticket.expiresAt <= now) throw new UploadError(410, 'expired', 'This upload URL has expired or failed; ask for a new one.');
  return ticket;
}

/**
 * Who the upload saves as, checked again now: an account disabled, or a key
 * revoked, expired, left without write access, or narrowed so the path is
 * outside its root, makes the upload fail, as a call with that key would.
 */
async function ticketScope(ticket: Ticket, now: Date): Promise<WorkspaceScope> {
  const [owner] = await db().select({ disabledAt: schema.user.disabledAt }).from(schema.user).where(eq(schema.user.id, ticket.userId));
  if (!owner || owner.disabledAt) throw new UploadError(403, 'workspace_not_allowed', 'This account can no longer write files.');
  if (!ticket.apiKeyId) return { userId: ticket.userId, workspaceId: ticket.workspaceId, root: '/', access: 'write', apiKeyId: null, client: ticket.client ?? 'web' };
  const root = await keyRoot(ticket.apiKeyId, ticket.userId, ticket.workspaceId, ticket.path, 'write', now);
  if (root === null) throw new UploadError(403, 'workspace_not_allowed', 'The key this upload was made with can no longer write this file.');
  return { userId: ticket.userId, workspaceId: ticket.workspaceId, root, access: 'write', apiKeyId: ticket.apiKeyId, client: ticket.client };
}

/** A key's root when it may still `access` `path` in the workspace now, or null. */
async function keyRoot(keyId: string, userId: string, workspaceId: string, path: string, access: 'read' | 'write', now: Date): Promise<string | null> {
  const [key] = await db().select().from(schema.apiKey).where(eq(schema.apiKey.id, keyId));
  const allowed = access === 'write' ? key?.workspaceAccess === 'write' : key?.workspaceAccess === 'write' || key?.workspaceAccess === 'read';
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= now) || key.userId !== userId || !allowed || (key.workspaceId !== null && key.workspaceId !== workspaceId)) return null;
  const root = key.workspaceId ? key.workspaceRoot : '/';
  const [inside] = await db().execute<{ yes: boolean }>(sql`select ${within(root, sql`${path}::text`)} as yes`).then((result) => result.rows);
  return inside?.yes ? root : null;
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
 * and the PUT counted against the ticket's cap before its body is read; the
 * response is the saved file once the last part is in (or, for a large
 * file not stitched within this request, that it is being put together).
 */
export async function receivePart(token: string, request: PartRequest, now = new Date()) {
  const ticket = await openTicket(token, now);
  const n = request.part === null ? (ticket.parts === 1 ? 1 : 0) : /^[0-9]{1,4}$/.test(request.part) ? Number(request.part) : 0;
  if (n < 1 || n > ticket.parts) {
    throw new UploadError(400, 'invalid_part', ticket.parts === 1 ? 'This upload takes one PUT without ?part.' : `This upload takes parts ?part=1..${ticket.parts}.`);
  }
  const expected = partLength(ticket.size, WORKSPACE_UPLOAD_PART, n);
  if (request.contentLength !== null && Number(request.contentLength) !== expected) {
    throw new UploadError(400, 'length_mismatch', `Part ${n} must be exactly ${expected} bytes; Content-Length says ${request.contentLength}.`);
  }
  const [counted] = await db()
    .update(schema.workspaceUpload)
    .set({ writes: sql`${schema.workspaceUpload.writes} + 1` })
    .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, 'open'), sql`${schema.workspaceUpload.writes} < ${ticket.parts * WORKSPACE_UPLOAD_REWRITES}`))
    .returning({ writes: schema.workspaceUpload.writes });
  if (!counted) throw new UploadError(429, 'too_many_writes', `This upload has taken ${ticket.parts * WORKSPACE_UPLOAD_REWRITES} PUTs, the most it may; ask for a new upload URL.`);
  const bytes = await readExactly(request.body, expected);
  if (ticket.parts === 1) return finishSingle(ticket, bytes, now);
  await putWorkspaceObject(workspaceUploadPartPath(ticket.workspaceId, ticket.id, n), bytes, 'application/octet-stream');
  /* The set of parts received, kept sorted and without repeats: a part sent again counts once. Only while the ticket still takes parts. */
  const [row] = await db()
    .update(schema.workspaceUpload)
    .set({ received: sql`array(select distinct p from unnest(array_append(${schema.workspaceUpload.received}, ${n}::int)) as p order by p)` })
    .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, 'open')))
    .returning({ received: schema.workspaceUpload.received });
  if (!row) throw new UploadError(409, 'assembling', 'Every part was already in; this one was not taken. GET this URL to see when the file is saved.');
  if (row.received.length < ticket.parts) return { done: false as const, part: n, received: row.received.length, parts: ticket.parts };
  /* Every part is in: the ticket stops taking parts, and this request starts putting the file together. */
  const [claimed] = await db()
    .update(schema.workspaceUpload)
    .set({ status: 'assembling' })
    .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, 'open')))
    .returning({ id: schema.workspaceUpload.id });
  if (!claimed) return { done: false as const, part: n, received: row.received.length, parts: ticket.parts, assembling: true };
  return stitch(ticket.id, now, WORKSPACE_STITCH_BUDGET_MS);
}

/** `GET` on an upload URL: where the upload stands, and the saved file once it is. */
export async function uploadStatus(token: string) {
  const ticket = await ticketByToken(token);
  return {
    status: ticket.status === 'failed' && ticket.error === 'expired' ? 'expired' : ticket.status,
    received: ticket.received.length,
    parts: ticket.parts,
    stitched: ticket.stitched,
    ...(ticket.status === 'done' ? { sha256: ticket.sha256, revision: ticket.revisionId } : {}),
    ...(ticket.status === 'failed' ? { error: ticket.error } : {}),
  };
}

async function finishSingle(ticket: Ticket, bytes: Uint8Array, now: Date) {
  const [claimed] = await db()
    .update(schema.workspaceUpload)
    .set({ status: 'assembling', leaseUntil: new Date(now.getTime() + WORKSPACE_STITCH_LEASE_MS) })
    .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, 'open')))
    .returning();
  if (!claimed) throw new UploadError(409, 'assembling', 'This upload is already being saved.');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.length <= WORKSPACE_TEXT_MAX && !binaryByName(ticket.path) ? decodeText(bytes) : null;
  await putWorkspaceObject(workspaceObjectPath(ticket.workspaceId, sha), bytes, text === null ? mediaTypeOf(ticket.path, { binary: true }) : `${mediaTypeOf(ticket.path)}; charset=utf-8`);
  return settle(claimed, sha, text, now);
}

const assembledPath = (ticket: Pick<Ticket, 'workspaceId' | 'id'>) => workspaceUploadPartPath(ticket.workspaceId, ticket.id, 0).replace(/\/0$/, '/assembled');

/**
 * Puts a large upload together, a step at a time, for at most `budgetMs`:
 * each step reads the next two parts (8 MB, the store's smallest part being
 * 5 MB), adds them to the hash and to the store's multipart upload, and
 * saves how far it got with the hash's state -- so a step lost to a timeout
 * or a crash is done again by whoever takes the lease next (the next request,
 * or the cron), never twice and never half. The file is never held whole.
 */
export async function stitch(ticketId: string, now: Date, budgetMs: number) {
  const started = Date.now();
  const lease = () => new Date(Math.max(now.getTime(), Date.now()) + WORKSPACE_STITCH_LEASE_MS);
  const [taken] = await db()
    .update(schema.workspaceUpload)
    .set({ leaseUntil: lease() })
    .where(and(eq(schema.workspaceUpload.id, ticketId), eq(schema.workspaceUpload.status, 'assembling'), or(isNull(schema.workspaceUpload.leaseUntil), lt(schema.workspaceUpload.leaseUntil, now))))
    .returning();
  if (!taken) return { done: false as const, assembling: true };
  let ticket = taken;
  const type = mediaTypeOf(ticket.path, { binary: true });
  try {
    while (ticket.stitched < ticket.parts) {
      if (Date.now() - started > budgetMs) {
        /* Out of time here: the lease is let go, and the cron (or a GET) carries on. */
        await db().update(schema.workspaceUpload).set({ leaseUntil: null }).where(eq(schema.workspaceUpload.id, ticket.id));
        return { done: false as const, assembling: true, stitched: ticket.stitched, parts: ticket.parts };
      }
      const assembly = (ticket.assembly as Assembly | null) ?? (await startAssembly(assembledPath(ticket), type));
      const group = [ticket.stitched + 1, ticket.stitched + 2].filter((n) => n <= ticket.parts);
      const pieces: Uint8Array[] = [];
      for (const n of group) {
        const piece = await readWorkspaceObject(workspaceUploadPartPath(ticket.workspaceId, ticket.id, n));
        if (!piece || piece.length !== partLength(ticket.size, WORKSPACE_UPLOAD_PART, n)) throw new Error(`upload part missing or changed: ${ticket.id} ${n}`);
        pieces.push(piece);
      }
      const bytes = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces);
      const hash = new ResumableSha256(ticket.hashState).update(bytes);
      const partNumber = (ticket.stitched + 2) / 2;
      const part = await assemblePart(assembledPath(ticket), assembly, Math.ceil(partNumber), bytes);
      const next: Assembly = { ...assembly, parts: [...assembly.parts.filter((p) => p.partNumber !== part.partNumber), part] };
      const [saved] = await db()
        .update(schema.workspaceUpload)
        .set({ stitched: ticket.stitched + group.length, hashState: hash.save(), assembly: next, leaseUntil: lease() })
        .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, 'assembling'), eq(schema.workspaceUpload.stitched, ticket.stitched)))
        .returning();
      if (!saved) return { done: false as const, assembling: true };
      ticket = saved;
    }
    const sha = new ResumableSha256(ticket.hashState).hex();
    /* The stitched object put under the content's name; skipped when the workspace already holds these bytes. */
    const [held] = await db().select({ refs: schema.workspaceBlob.refs }).from(schema.workspaceBlob).where(and(eq(schema.workspaceBlob.workspaceId, ticket.workspaceId), eq(schema.workspaceBlob.sha256, sha)));
    if (held && held.refs > 0) await abandonAssembly(assembledPath(ticket), ticket.assembly as Assembly);
    else await finishAssembly(assembledPath(ticket), ticket.assembly as Assembly, workspaceObjectPath(ticket.workspaceId, sha), type);
    return settle(ticket, sha, null, now);
  } catch (error) {
    if (error instanceof UploadError || error instanceof WorkspaceError) throw error;
    await fail(ticket, 'failed');
    throw error;
  }
}

const partPaths = (ticket: Pick<Ticket, 'workspaceId' | 'id' | 'parts'>) => Array.from({ length: ticket.parts }, (_, i) => workspaceUploadPartPath(ticket.workspaceId, ticket.id, i + 1));

/** An upload ended without a save: marked failed, its parts and any half-stitched object deleted. */
async function fail(ticket: Ticket, error: string): Promise<void> {
  await db().update(schema.workspaceUpload).set({ status: 'failed', error, completedAt: new Date(), leaseUntil: null }).where(eq(schema.workspaceUpload.id, ticket.id));
  if (ticket.parts > 1) {
    await deleteWorkspaceObjects(partPaths(ticket)).catch((reason) => console.warn(`upload parts not deleted id=${ticket.id}`, reason instanceof Error ? reason.message : reason));
    await abandonAssembly(assembledPath(ticket), ticket.assembly as Assembly | null).catch(() => undefined);
  }
}

/**
 * The stitched file saved as a version (or the upload failed), its parts
 * deleted either way. A save that is refused leaves the object for the
 * orphan sweep (a day on), never deleted here: another upload of the same
 * bytes may be saving it at this moment. The save itself checks, under the
 * owner's lock, that the object is still there.
 */
async function settle(ticket: Ticket, sha: string, text: string | null, now: Date) {
  try {
    const scope = await ticketScope(ticket, now);
    const saved = await saveUploaded(scope, { path: ticket.path, sha, size: ticket.size, text, ifMatch: ticket.ifMatch, ifNoneMatch: ticket.ifNoneMatch });
    await db().update(schema.workspaceUpload).set({ status: 'done', sha256: sha, revisionId: saved.revision, completedAt: new Date(), leaseUntil: null }).where(eq(schema.workspaceUpload.id, ticket.id));
    if (ticket.parts > 1) await deleteWorkspaceObjects(partPaths(ticket)).catch(() => undefined);
    return { done: true as const, ...saved };
  } catch (error) {
    await fail(ticket, error instanceof WorkspaceError || error instanceof UploadError ? error.code : 'failed');
    throw error;
  }
}

/* ------------------------------------------------------------------ the cron: carrying on, cleaning up */

/** Large uploads being put together whose lease ran out (a request out of time, or gone): the cron carries each on. */
export async function continueStitching(now = new Date(), budgetMs = 120_000): Promise<number> {
  const started = Date.now();
  const waiting = await db()
    .select({ id: schema.workspaceUpload.id })
    .from(schema.workspaceUpload)
    .where(and(eq(schema.workspaceUpload.status, 'assembling'), or(isNull(schema.workspaceUpload.leaseUntil), lt(schema.workspaceUpload.leaseUntil, now))))
    .limit(10);
  let finished = 0;
  for (const { id } of waiting) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) break;
    try {
      if ((await stitch(id, now, left)).done) finished += 1;
    } catch (error) {
      console.warn(`upload not stitched id=${id}`, error instanceof Error ? error.message : error);
    }
  }
  return finished;
}

/**
 * Uploads that will not finish: unfinished past their expiry, or put
 * together with no progress for an hour (judged by the stitching lease, not
 * the expiry, so a last part that came in just in time is never cut off).
 * Their parts are deleted -- they were never counted, so never billed.
 * Records are forgotten after WORKSPACE_UPLOAD_KEEP_MS.
 */
export async function reapUploads(now = new Date(), limit = 100): Promise<{ ended: number; forgotten: number }> {
  const stalled = new Date(now.getTime() - 60 * 60_000);
  const stale = await db()
    .select()
    .from(schema.workspaceUpload)
    .where(
      or(
        and(eq(schema.workspaceUpload.status, 'open'), lt(schema.workspaceUpload.expiresAt, now)),
        and(eq(schema.workspaceUpload.status, 'assembling'), lt(schema.workspaceUpload.leaseUntil, stalled)),
      ),
    )
    .limit(limit);
  let ended = 0;
  for (const ticket of stale) {
    const [claimed] = await db()
      .update(schema.workspaceUpload)
      .set({ status: 'failed', error: ticket.status === 'open' ? 'expired' : 'stalled', completedAt: now })
      .where(and(eq(schema.workspaceUpload.id, ticket.id), eq(schema.workspaceUpload.status, ticket.status), ticket.status === 'assembling' ? lt(schema.workspaceUpload.leaseUntil, stalled) : sql`true`))
      .returning({ id: schema.workspaceUpload.id });
    if (!claimed) continue;
    if (ticket.parts > 1) {
      await deleteWorkspaceObjects(partPaths(ticket));
      await abandonAssembly(assembledPath(ticket), ticket.assembly as Assembly | null).catch(() => undefined);
    }
    ended += 1;
  }
  const gone = await db()
    .delete(schema.workspaceUpload)
    .where(and(lt(schema.workspaceUpload.createdAt, new Date(now.getTime() - WORKSPACE_UPLOAD_KEEP_MS)), inArray(schema.workspaceUpload.status, ['done', 'failed'])))
    .returning({ id: schema.workspaceUpload.id });
  return { ended, forgotten: gone.length };
}

/* ------------------------------------------------------------------ downloads */

interface DownloadClaim {
  w: string;
  e: string;
  r: string;
  /** The user, and the key it was given to (null on the web): a download stops working when either can no longer read the file. */
  u: string;
  k: string | null;
  x: number;
}

/** The signing key, derived from the server's secret for this use alone (HKDF). */
let signingKey: string | null = null;
function downloadKey(): string {
  signingKey ??= Buffer.from(hkdfSync('sha256', authSecret(), 're0:workspace', 're0:workspace-download:v1', 32)).toString('base64url');
  return signingKey;
}
const signed = (payload: string) => hmacSha256(downloadKey(), payload);

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

/** `ws_download_url`: a URL for one version of a file (the current one by default), valid WORKSPACE_DOWNLOAD_TTL_MS, for the caller's key alone. */
export async function downloadUrl(scope: WorkspaceScope, input: { path: string; revision?: string }, now = new Date()) {
  const version = await versionAt(scope, input.path, input.revision);
  const expires = now.getTime() + WORKSPACE_DOWNLOAD_TTL_MS;
  const claim: DownloadClaim = { w: scope.workspaceId, e: version.entryId, r: version.revision, u: scope.userId, k: scope.apiKeyId, x: expires };
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claim)));
  const url = `${appBaseUrl()}/api/files/download/${payload}.${await signed(payload)}`;
  return { path: shown(scope, version.path), url, size: version.size, revision: version.revision, expires_at: new Date(expires), curl: `curl -fsSL -o ${quoted(nameOf(version.path))} ${quoted(url)}` };
}

/**
 * What a download URL names, checked: the signature, the expiry, an account
 * not disabled, a key that can still read the file (not revoked, not
 * narrowed away from it), and a version that still belongs to a live file.
 */
export async function openDownload(token: string, now = new Date()): Promise<Response> {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || payload.length > 600) throw new UploadError(404, 'not_found', 'No such download.');
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
  const [owner] = await db().select({ disabledAt: schema.user.disabledAt }).from(schema.user).where(eq(schema.user.id, claim.u));
  if (!owner || owner.disabledAt) throw new UploadError(403, 'workspace_not_allowed', 'This account can no longer read files.');
  if (claim.k && (await keyRoot(claim.k, claim.u, claim.w, row.path, 'read', now)) === null) {
    throw new UploadError(403, 'workspace_not_allowed', 'The key this download was given to can no longer read this file.');
  }
  return serveVersion(claim.w, row);
}

/** RFC 5987 `filename*`: encodeURIComponent leaves ' ( ) * ! as they are, which that syntax does not allow. */
const extValue = (name: string) => encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * One version's bytes as a download. Up to WORKSPACE_DOWNLOAD_INLINE_MAX
 * they come through here: an attachment, typed from the name, never sniffed,
 * never run, never cached. Larger ones cannot pass through a function's
 * 4.5 MB response: the answer is a redirect to a URL the store serves the
 * object from itself, signed for this object alone for a minute, marked as a
 * download. Off Vercel (a local folder) everything comes through here.
 */
export async function serveVersion(workspaceId: string, version: { path: string; sha: string; size: number }): Promise<Response> {
  const pathname = workspaceObjectPath(workspaceId, version.sha);
  if (version.size > WORKSPACE_DOWNLOAD_INLINE_MAX) {
    const url = await signedObjectUrl(pathname, 60_000);
    if (url) return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
  }
  const object = await openWorkspaceObject(pathname);
  if (!object) throw new UploadError(404, 'not_found', 'The file\'s bytes are missing.');
  const name = nameOf(version.path);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const type = mediaTypeOf(version.path, { binary: true });
  return new Response(object.stream, {
    headers: {
      'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
      'content-length': String(version.size),
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${extValue(name)}`,
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
