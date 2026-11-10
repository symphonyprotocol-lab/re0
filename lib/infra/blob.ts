/**
 * Vercel Blob, private store. Browsers upload straight to it with a token
 * scoped to one pathname, type and size (`uploadTicket`), which keeps files
 * off the 4.5 MB function body limit; the server reads them back with the
 * read-write token.
 */
import { BlobNotFoundError, del, get, head, put } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { assertBlobPathname } from '@/lib/domain/blob-path';

/* Every pathname this module and `blob-access.ts` touch passes `assertBlobPathname`. */
export { assertBlobPathname };

function token(): string {
  const value = process.env.BLOB_READ_WRITE_TOKEN;
  if (!value) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  return value;
}

export interface UploadTicket {
  pathname: string;
  token: string;
}

export async function uploadTicket(
  pathname: string,
  options: { contentTypes: string[]; maxBytes: number; ttlSeconds?: number },
): Promise<UploadTicket> {
  assertBlobPathname(pathname);
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: token(),
    pathname,
    allowedContentTypes: options.contentTypes,
    maximumSizeInBytes: options.maxBytes,
    validUntil: Date.now() + (options.ttlSeconds ?? 15 * 60) * 1000,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return { pathname, token: clientToken };
}

export async function readBlob(pathname: string): Promise<Uint8Array | null> {
  assertBlobPathname(pathname);
  const result = await get(pathname, { access: 'private', token: token(), useCache: false });
  if (!result || result.statusCode !== 200) return null;
  return new Uint8Array(await new Response(result.stream).arrayBuffer());
}

export async function writeNarration(pathname: string, wav: Buffer): Promise<void> {
  assertBlobPathname(pathname);
  await put(pathname, wav, { access: 'private', contentType: 'audio/wav', addRandomSuffix: false, token: token() });
}

/** Streamed, for serving avatars without buffering them. */
export async function streamBlob(
  pathname: string,
): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | null } | null> {
  assertBlobPathname(pathname);
  const result = await get(pathname, { access: 'private', token: token() });
  if (!result || result.statusCode !== 200) return null;
  return { stream: result.stream, contentType: result.blob.contentType ?? null };
}

/**
 * A private blob with a byte range passed through (audio seeking): status
 * 206 and `content-range` when the store honoured the range, else 200.
 */
export async function streamBlobRange(
  pathname: string,
  range: string | null,
): Promise<{ body: ReadableStream<Uint8Array>; status: number; headers: Headers } | null> {
  assertBlobPathname(pathname);
  const safeRange = range && /^bytes=\d*-\d*$/.test(range) ? range : null;
  const result = await get(pathname, { access: 'private', token: token(), ...(safeRange ? { headers: { range: safeRange } } : {}) });
  if (!result || result.statusCode !== 200) return null;
  const headers = new Headers({ 'accept-ranges': 'bytes', 'content-type': result.blob.contentType ?? 'application/octet-stream' });
  for (const name of ['content-length', 'content-range']) {
    const value = result.headers.get(name);
    if (value) headers.set(name, value);
  }
  return { body: result.stream, status: result.headers.get('content-range') ? 206 : 200, headers };
}

export async function blobSize(pathname: string): Promise<number | null> {
  assertBlobPathname(pathname);
  try {
    return (await head(pathname, { token: token() })).size;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

export async function deleteBlob(pathname: string): Promise<void> {
  assertBlobPathname(pathname);
  await del(pathname, { token: token() });
}
