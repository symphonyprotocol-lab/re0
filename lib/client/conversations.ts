/**
 * The browser's calls to the conversation API. Each answers the parsed body
 * or throws an `ApiError` carrying the `{error}` code, so a page can show
 * its own message for it.
 */
import type { BatchAction } from '@/lib/domain/conversation';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

async function call<T>(url: string, method: string, payload?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? 'generic', response.status);
  return data;
}

export const conversationApi = {
  create: (reeIds: string[], title?: string) => call<{ id: string }>('/api/chats', 'POST', { reeIds, ...(title ? { title } : {}) }),
  update: (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean; trashed?: boolean }) => call<unknown>(`/api/chats/${id}`, 'PATCH', patch),
  batch: (action: BatchAction, ids: string[]) => call<{ changed: number }>('/api/chats/batch', 'POST', { action, ids }),
  ids: (query: URLSearchParams) => call<{ ids: string[] }>(`/api/chats?${query}&ids=1`, 'GET'),
  addRee: (id: string, reeId: string) => call<{ result: 'added' | 'present' }>(`/api/chats/${id}/rees/${reeId}`, 'POST'),
  setRees: (id: string, reeIds: string[]) => call<{ reeIds: string[] }>(`/api/chats/${id}/rees`, 'PUT', { reeIds }),
  vote: (messageId: string, vote: 'up' | 'down' | null) => call<{ vote: 'up' | 'down' | null }>(`/api/messages/${messageId}/feedback`, 'POST', { vote }),
};

/** A question typed on `/talk`, carried to the new conversation's page, which sends it. */
export interface PendingQuestion {
  question: string;
  scope: string | null;
}

const pendingKey = (id: string) => `re0:pending:${id}`;

export function stashPending(id: string, pending: PendingQuestion): void {
  try {
    sessionStorage.setItem(pendingKey(id), JSON.stringify(pending));
  } catch {
    /* storage off: the page opens without sending */
  }
}

export function takePending(id: string): PendingQuestion | null {
  try {
    const raw = sessionStorage.getItem(pendingKey(id));
    if (!raw) return null;
    sessionStorage.removeItem(pendingKey(id));
    return JSON.parse(raw) as PendingQuestion;
  } catch {
    return null;
  }
}
