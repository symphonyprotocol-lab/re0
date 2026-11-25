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
import { put } from '@vercel/blob';
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

export async function deleteWorkspaceObjects(pathnames: readonly string[]): Promise<void> {
  if (pathnames.length === 0) return;
  const dir = localDir();
  if (!dir) return deleteBlobs(pathnames);
  for (const pathname of pathnames) await rm(join(dir, assertBlobPathname(pathname)), { force: true });
}
