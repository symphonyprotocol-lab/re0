/**
 * Where the agent workspace keeps every version's bytes: the private Blob
 * store, one object per distinct content of a workspace at
 * `workspace/<workspace id>/<sha256>` (lib/services/workspace.ts counts who
 * names each one). The object is immutable once written, so putting the same
 * content again is harmless.
 *
 * Off Vercel, `WORKSPACE_BLOB_DIR` keeps them in a local folder instead, so a
 * `next dev` against the local database never writes into a Blob store that
 * other environments share.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { completeMultipartUpload, copy, createMultipartUpload, del, getDownloadUrl, head, issueSignedToken, presignUrl, put, uploadPart } from '@vercel/blob';
import { assertBlobPathname, readBlob, streamBlob } from '@/lib/infra/blob';
import { deleteBlobs } from '@/lib/infra/blob-access';

export function workspaceObjectPath(workspaceId: string, sha256: string): string {
  return assertBlobPathname(`workspace/${workspaceId.toLowerCase()}/${sha256}`);
}

/** One part of an unfinished upload: kept apart from contents (the orphan sweep matches only `<workspace>/<sha256>`), deleted once the upload ends. */
export function workspaceUploadPartPath(workspaceId: string, uploadId: string, part: number): string {
  return assertBlobPathname(`workspace/${workspaceId.toLowerCase()}/upload/${uploadId.toLowerCase()}/${part}`);
}

function localDir(): string | null {
  const dir = process.env.WORKSPACE_BLOB_DIR;
  return dir && !process.env.VERCEL && process.env.NODE_ENV !== 'production' ? dir : null;
}

export async function putWorkspaceObject(pathname: string, bytes: Uint8Array, contentType: string): Promise<void> {
  assertBlobPathname(pathname);
  const dir = localDir();
  if (dir) {
    const file = join(dir, pathname);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, bytes);
    return;
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  await put(pathname, Buffer.from(bytes), { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true, token });
}

export async function readWorkspaceObject(pathname: string): Promise<Uint8Array | null> {
  const dir = localDir();
  if (!dir) return readBlob(pathname);
  assertBlobPathname(pathname);
  try {
    return new Uint8Array(await readFile(join(dir, pathname)));
  } catch {
    return null;
  }
}

/** An object as a stream, for downloads and for putting an upload together without holding it whole; null when it is not there. */
export async function openWorkspaceObject(pathname: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null } | null> {
  const dir = localDir();
  if (!dir) {
    const found = await streamBlob(pathname);
    return found ? { stream: found.stream, size: null } : null;
  }
  assertBlobPathname(pathname);
  const file = join(dir, pathname);
  try {
    const { size } = await stat(file);
    return { stream: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, size };
  } catch {
    return null;
  }
}

/** An object written from a stream (a put-together upload, up to WORKSPACE_UPLOAD_MAX): Blob takes it in parts, so it is never held whole. */
export async function putWorkspaceStream(pathname: string, stream: ReadableStream<Uint8Array>, contentType: string): Promise<void> {
  assertBlobPathname(pathname);
  const dir = localDir();
  if (dir) {
    const file = join(dir, pathname);
    await mkdir(join(file, '..'), { recursive: true });
    await pipeline(Readable.fromWeb(stream as never), createWriteStream(file));
    return;
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  await put(pathname, stream, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true, multipart: true, token });
}

/** Whether an object is in the store (checked under the owner's lock before a version names bytes put earlier). */
export async function hasWorkspaceObject(pathname: string): Promise<boolean> {
  assertBlobPathname(pathname);
  const dir = localDir();
  if (dir) return stat(join(dir, pathname)).then(() => true, () => false);
  try {
    await head(pathname, { token: blobToken() });
    return true;
  } catch {
    return false;
  }
}

function blobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  return token;
}

/* ------------------------------------------------------------------ stitching an upload, a step at a time */

/** A store-side multipart upload, kept in the ticket between steps (locally: the pieces are files beside the target). */
export interface Assembly {
  uploadId: string;
  key: string;
  parts: { partNumber: number; etag: string }[];
}

/** Starts writing `pathname` in parts (each but the last at least 5 MB on Blob). */
export async function startAssembly(pathname: string, contentType: string): Promise<Assembly> {
  assertBlobPathname(pathname);
  if (localDir()) return { uploadId: 'local', key: 'local', parts: [] };
  const started = await createMultipartUpload(pathname, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true, token: blobToken() });
  return { uploadId: started.uploadId, key: started.key, parts: [] };
}

/** One part of it; sending the same part number again replaces it. */
export async function assemblePart(pathname: string, assembly: Assembly, partNumber: number, bytes: Uint8Array): Promise<{ partNumber: number; etag: string }> {
  const dir = localDir();
  if (dir) {
    const file = join(dir, `${pathname}.${partNumber}`);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, bytes);
    return { partNumber, etag: `local-${partNumber}` };
  }
  const part = await uploadPart(pathname, Buffer.from(bytes), { access: 'private', key: assembly.key, uploadId: assembly.uploadId, partNumber, token: blobToken() });
  return { partNumber: part.partNumber, etag: part.etag };
}

/**
 * The parts made one object, which is then put at `target` (the content's
 * own name, known only once the whole file is hashed) and the stitched one
 * deleted. On Blob the copy is done by the store, so nothing passes through
 * here.
 */
export async function finishAssembly(pathname: string, assembly: Assembly, target: string, contentType: string): Promise<void> {
  assertBlobPathname(target);
  const dir = localDir();
  const parts = [...assembly.parts].sort((a, b) => a.partNumber - b.partNumber);
  if (dir) {
    const file = join(dir, target);
    await mkdir(join(file, '..'), { recursive: true });
    const out = createWriteStream(file);
    for (const part of parts) await pipeline(createReadStream(join(dir, `${pathname}.${part.partNumber}`)), out, { end: false });
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    for (const part of parts) await rm(join(dir, `${pathname}.${part.partNumber}`), { force: true });
    return;
  }
  const token = blobToken();
  await completeMultipartUpload(pathname, parts, { access: 'private', key: assembly.key, uploadId: assembly.uploadId, contentType, addRandomSuffix: false, allowOverwrite: true, token });
  await copy(pathname, target, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true, token });
  await del(pathname, { token });
}

/** What a stitching that was given up left: its pieces (locally) or its object, if it got that far. */
export async function abandonAssembly(pathname: string, assembly: Assembly | null): Promise<void> {
  const dir = localDir();
  if (dir) {
    for (const part of assembly?.parts ?? []) await rm(join(dir, `${pathname}.${part.partNumber}`), { force: true });
    await rm(join(dir, pathname), { force: true });
    return;
  }
  await del(pathname, { token: blobToken() }).catch(() => undefined);
}

/* ------------------------------------------------------------------ downloads too large to pass through a function */

/**
 * A short-lived URL the store itself serves the object from, marked as a
 * download -- for files too large for a function's 4.5 MB response. Null off
 * Vercel (the local folder has no such URL: the route streams instead).
 */
export async function signedObjectUrl(pathname: string, validForMs: number): Promise<string | null> {
  assertBlobPathname(pathname);
  if (localDir()) return null;
  const validUntil = Date.now() + validForMs;
  const signed = await issueSignedToken({ pathname, operations: ['get'], validUntil, token: blobToken() });
  const { presignedUrl } = await presignUrl(signed, { operation: 'get', pathname, validUntil, useCache: false, access: 'private' });
  return getDownloadUrl(presignedUrl);
}

export async function deleteWorkspaceObjects(pathnames: readonly string[]): Promise<void> {
  if (pathnames.length === 0) return;
  const dir = localDir();
  if (!dir) return deleteBlobs(pathnames);
  for (const pathname of pathnames) await rm(join(dir, assertBlobPathname(pathname)), { force: true });
}
