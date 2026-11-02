'use client';

import { put } from '@vercel/blob/client';

/**
 * Browser-side direct upload: ask the API for a token scoped to one
 * pathname, type and size, then send the bytes straight to Blob -- the file
 * never passes through a function (4.5 MB body limit).
 */
export async function uploadToBlob(
  file: Blob,
  ticketRequest:
    | { purpose: 'document' | 'audio'; fileName: string; size: number }
    | { purpose: 'avatar'; contentType: string; size: number },
  onProgress?: (percent: number) => void,
): Promise<{ pathname: string } | { error: string }> {
  const response = await fetch('/api/upload-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ticketRequest),
  });
  const ticket = (await response.json().catch(() => ({}))) as { pathname?: string; token?: string; contentType?: string; error?: string };
  if (!response.ok || !ticket.pathname || !ticket.token) return { error: ticket.error ?? 'upload' };
  try {
    await put(ticket.pathname, file, {
      access: 'private',
      token: ticket.token,
      contentType: ticket.contentType,
      /* Audio runs to 100 MB: parts upload in parallel and a dropped one is retried alone. */
      multipart: file.size > 8 * 1024 * 1024,
      onUploadProgress: onProgress ? (event) => onProgress(Math.round(event.percentage)) : undefined,
    });
    return { pathname: ticket.pathname };
  } catch {
    return { error: 'upload' };
  }
}

export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const { json, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { 'content-type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, status: response.status, data };
}
