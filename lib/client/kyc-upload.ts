'use client';

import { put } from '@vercel/blob/client';

/**
 * An identity image straight to private Blob (8.4 step 6): a token scoped to
 * one pathname under the user, the type and 10 MB from
 * `/api/billing/kyc/upload`, then the bytes go to Blob, never through a
 * function. Answers the pathname to submit, or an error code.
 */
export async function uploadKycImage(file: File, onProgress?: (percent: number) => void): Promise<{ pathname: string } | { error: string }> {
  const response = await fetch('/api/billing/kyc/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contentType: file.type, size: file.size }),
  });
  const ticket = (await response.json().catch(() => ({}))) as { pathname?: string; token?: string; contentType?: string; error?: string };
  if (!response.ok || !ticket.pathname || !ticket.token) return { error: ticket.error ?? 'upload' };
  try {
    await put(ticket.pathname, file, {
      access: 'private',
      token: ticket.token,
      contentType: ticket.contentType,
      onUploadProgress: onProgress ? (event) => onProgress(Math.round(event.percentage)) : undefined,
    });
    return { pathname: ticket.pathname };
  } catch {
    return { error: 'upload' };
  }
}
