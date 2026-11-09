/**
 * Private Blob beyond `blob.ts`'s reads (step 6, identity images): what an
 * uploaded object is, short-lived signed links an administrator's browser
 * opens directly, and listing / deleting by prefix for the retention purge.
 *
 * A signed link is a presigned GET scoped to one pathname that the Blob CDN
 * refuses (403) once `validUntil` passes; `useCache: false` reads origin,
 * so a deleted image is gone at once rather than served from cache.
 */
import { BlobNotFoundError, del, head, issueSignedToken, list, presignUrl } from '@vercel/blob';

function token(): string {
  const value = process.env.BLOB_READ_WRITE_TOKEN;
  if (!value) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  return value;
}

export async function blobInfo(pathname: string): Promise<{ size: number; contentType: string } | null> {
  try {
    const info = await head(pathname, { token: token() });
    return { size: info.size, contentType: info.contentType };
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

export async function signedReadUrl(pathname: string, ttlSeconds: number, now = Date.now()): Promise<{ url: string; expiresAt: Date }> {
  const validUntil = now + ttlSeconds * 1000;
  const signed = await issueSignedToken({ token: token(), pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(signed, { operation: 'get', pathname, validUntil, access: 'private', useCache: false });
  return { url: presignedUrl, expiresAt: new Date(validUntil) };
}

export async function listByPrefix(prefix: string, options: { cursor?: string; limit?: number } = {}) {
  const page = await list({ prefix, cursor: options.cursor, limit: options.limit, token: token() });
  return {
    blobs: page.blobs.map((blob) => ({ pathname: blob.pathname, uploadedAt: blob.uploadedAt })),
    cursor: page.hasMore ? page.cursor : null,
  };
}

/** Deleting what is already gone is not an error. */
export async function deleteBlobs(pathnames: readonly string[]): Promise<void> {
  if (!pathnames.length) return;
  await del([...pathnames], { token: token() });
}
