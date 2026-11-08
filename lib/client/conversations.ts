/**
 * The browser's calls to the conversation API. Each answers the parsed body
 * or throws an `ApiError` carrying the `{error}` code, so a page can show
 * its own message for it.
 */
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessageChunk } from 'ai';
import { synthesisOf, type InsufficientCreditsBody, type ReeUIMessage, type SynthesisPart } from '@/lib/domain/chat-message';
import type { BatchAction } from '@/lib/domain/conversation';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    /** The whole error body, e.g. the balance and the need of a 402. */
    readonly body: Record<string, unknown> = {},
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
  voteSynthesis: (synthesisId: string, vote: 'up' | 'down' | null) => call<{ vote: 'up' | 'down' | null }>(`/api/syntheses/${synthesisId}/feedback`, 'POST', { vote }),
};

/** A question typed on `/talk`, carried to the new conversation's page, which sends it. */
export interface PendingQuestion {
  question: string;
  scope: string | null;
  /** "核对引用" as it was set on `/talk`. */
  verify?: boolean;
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

/**
 * "综合这 N 个回答": streams the synthesis of one question, handing the part
 * so far -- the lettered Rees, the raw text -- to `onUpdate` as it arrives,
 * and answers the finished part (`done` or `failed`). A refusal before the
 * stream -- 402, 409 -- throws an `ApiError` with the body (an
 * `InsufficientCreditsBody` for a 402).
 */
export async function streamSynthesis(conversationId: string, requestId: string, onUpdate: (part: SynthesisPart) => void): Promise<SynthesisPart> {
  const response = await fetch(`/api/chats/${conversationId}/messages/${requestId}/synthesis`, { method: 'POST' });
  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as Partial<InsufficientCreditsBody> & { error?: string };
    throw new ApiError(data.error ?? 'generic', response.status, data);
  }
  const chunks = parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema }).pipeThrough(
    new TransformStream<{ success: true; value: UIMessageChunk } | { success: false; error: unknown }, UIMessageChunk>({
      transform: (result, controller) => {
        if (result.success) controller.enqueue(result.value);
      },
    }),
  );
  let latest = null as SynthesisPart | null;
  for await (const message of readUIMessageStream<ReeUIMessage>({ stream: chunks })) {
    const part = synthesisOf(message);
    if (!part) continue;
    /* While it streams the text arrives as a text part; once done, the part carries the cleaned text. */
    const text = message.parts.find((entry) => entry.type === 'text')?.text ?? '';
    latest = part.state === 'streaming' ? { ...part, content: text } : part;
    onUpdate(latest);
  }
  if (!latest || latest.state === 'streaming') throw new ApiError('synthesis_failed', 500);
  return latest;
}
