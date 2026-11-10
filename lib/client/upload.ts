'use client';

import { put } from '@vercel/blob/client';

/** What `api()` answers when the request never got a response: offline, DNS, a dropped connection. */
export const NETWORK_ERROR = 'network';
/** What `api()` and `uploadToBlob()` answer when the caller aborted the request. */
export const ABORTED = 'aborted';

function aborted(error: unknown, signal: AbortSignal | null | undefined): boolean {
  return Boolean(signal?.aborted) || (error instanceof DOMException && error.name === 'AbortError');
}

/**
 * Browser-side direct upload: ask the API for a token scoped to one
 * pathname, type and size, then send the bytes straight to Blob -- the file
 * never passes through a function (4.5 MB body limit). `signal` stops both
 * the ticket request and the transfer; an aborted upload answers `aborted`.
 */
export async function uploadToBlob(
  file: Blob,
  ticketRequest:
    | { purpose: 'document' | 'audio'; fileName: string; size: number }
    | { purpose: 'avatar'; contentType: string; size: number }
    | { purpose: 'ree-cover'; reeId: string; contentType: string; size: number },
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<{ pathname: string } | { error: string }> {
  const response = await api<{ pathname?: string; token?: string; contentType?: string; error?: string }>('/api/upload-token', { method: 'POST', json: ticketRequest, signal });
  const ticket = response.data;
  if (signal?.aborted) return { error: ABORTED };
  if (!response.ok || !ticket.pathname || !ticket.token) return { error: ticket.error ?? 'upload' };
  try {
    await put(ticket.pathname, file, {
      access: 'private',
      token: ticket.token,
      contentType: ticket.contentType,
      /* Audio runs to 100 MB: parts upload in parallel and a dropped one is retried alone. */
      multipart: file.size > 8 * 1024 * 1024,
      abortSignal: signal,
      onUploadProgress: onProgress ? (event) => onProgress(Math.round(event.percentage)) : undefined,
    });
    if (signal?.aborted) return { error: ABORTED };
    return { pathname: ticket.pathname };
  } catch (error) {
    return { error: aborted(error, signal) ? ABORTED : 'upload' };
  }
}

/**
 * A JSON call to the app's API. It never throws: a request that got no
 * response answers `{ ok: false, status: 0, data: { error: 'network' } }`
 * (or `'aborted'` when `signal` stopped it), so every caller's busy state is
 * released and its error path runs -- a money button never spins forever.
 * A network error does not say the server did nothing: the request may have
 * been applied before the connection dropped.
 */
export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const { json, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: json !== undefined ? { 'content-type': 'application/json', ...(rest.headers ?? {}) } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (error) {
    return { ok: false, status: 0, data: { error: aborted(error, rest.signal) ? ABORTED : NETWORK_ERROR } as T };
  }
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, status: response.status, data };
}
