/**
 * Anonymous chat with free Rees (beyond 4): what the browser and the server
 * agree on. The server side is lib/services/anonymous-chat.ts.
 */
import { ANONYMOUS_HISTORY_CHARS, ANONYMOUS_HISTORY_TURNS } from '@/lib/constants';
import type { AnonymousQuota } from '@/lib/domain/chat-message';

/** The browser fingerprint (lib/client/fingerprint.ts) travels in this header, never in the URL. */
export const FINGERPRINT_HEADER = 'x-re0-fingerprint';
/** The long-lived, httpOnly anonymous id; clearing the fingerprint alone does not reset the count. */
export const ANONYMOUS_ID_COOKIE = 're0_anon';
export const ANONYMOUS_ID_MAX_AGE_SECONDS = 400 * 86_400;
/** The 429 body's `error` once a visitor has used today's rounds. */
export const ANONYMOUS_QUOTA_EXCEEDED = 'anonymous_quota_exceeded';

export interface AnonymousQuotaExceededBody extends AnonymousQuota {
  error: typeof ANONYMOUS_QUOTA_EXCEEDED;
}

/** The day a round counts against: the UTC date, `YYYY-MM-DD`. The one place that decides it. */
export function anonymousDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A fingerprint the server will key on: hex or URL-safe characters, of a plausible length. */
export function validFingerprint(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/** An anonymous id the server issued (a UUID); anything else is replaced. */
export function validAnonymousId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export interface AnonymousTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The earlier turns the browser sent, as context for the next answer only
 * (they are never evidence): well-formed turns, the latest
 * `ANONYMOUS_HISTORY_TURNS`, and from those only the newest that fit
 * `ANONYMOUS_HISTORY_CHARS` together. A conversation starts on a question,
 * so a leading answer cut loose by the caps is dropped.
 */
export function anonymousHistory(value: unknown): AnonymousTurn[] {
  if (!Array.isArray(value)) return [];
  const turns = value
    .slice(-ANONYMOUS_HISTORY_TURNS)
    .flatMap((turn): AnonymousTurn[] => {
      if (!turn || typeof turn !== 'object') return [];
      const { role, content } = turn as { role?: unknown; content?: unknown };
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) return [];
      return [{ role, content: content.trim() }];
    });
  const kept: AnonymousTurn[] = [];
  let length = 0;
  for (const turn of turns.reverse()) {
    if (length + turn.content.length > ANONYMOUS_HISTORY_CHARS) break;
    length += turn.content.length;
    kept.unshift(turn);
  }
  while (kept[0]?.role === 'assistant') kept.shift();
  return kept;
}
