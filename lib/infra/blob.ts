/**
 * Vercel Blob, private store. Browsers upload straight to it with a token
 * scoped to one pathname, type and size (`uploadTicket`), which keeps files
 * off the 4.5 MB function body limit; the server reads them back with the
 * read-write token.
 */
import { BlobNotFoundError, del, get, head } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';

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
  const result = await get(pathname, { access: 'private', token: token(), useCache: false });
  if (!result || result.statusCode !== 200) return null;
  return new Uint8Array(await new Response(result.stream).arrayBuffer());
}

/** Streamed, for serving avatars without buffering them. */
export async function streamBlob(
  pathname: string,
): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string | null } | null> {
  const result = await get(pathname, { access: 'private', token: token() });
  if (!result || result.statusCode !== 200) return null;
  return { stream: result.stream, contentType: result.blob.contentType ?? null };
}

export async function blobSize(pathname: string): Promise<number | null> {
  try {
    return (await head(pathname, { token: token() })).size;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

export async function deleteBlob(pathname: string): Promise<void> {
  await del(pathname, { token: token() });
}
