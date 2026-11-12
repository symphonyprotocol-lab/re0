/**
 * Anonymous chat with free Rees (beyond 4): what the browser and the server
 * agree on. The server side is lib/services/anonymous-chat.ts.
 */
import { ANONYMOUS_ATTEMPTS_FACTOR_MAX, ANONYMOUS_HISTORY_CHARS, ANONYMOUS_HISTORY_TURNS, ANONYMOUS_LIMIT_MAX, ANONYMOUS_VISITOR_ROUNDS_MAX } from '@/lib/constants';
import type { AnonymousQuota } from '@/lib/domain/chat-message';

/** The browser fingerprint (lib/client/fingerprint.ts) travels in this header, never in the URL. */
export const FINGERPRINT_HEADER = 'x-re0-fingerprint';
/** The long-lived, httpOnly anonymous id; clearing the fingerprint alone does not reset the count. */
export const ANONYMOUS_ID_COOKIE = 're0_anon';
export const ANONYMOUS_ID_MAX_AGE_SECONDS = 400 * 86_400;
/** The 429 body's `error` once a visitor has used today's rounds (or attempts). */
export const ANONYMOUS_QUOTA_EXCEEDED = 'anonymous_quota_exceeded';
/** ...once their network (client address) has, whatever the visitor has left. */
export const ANONYMOUS_NETWORK_LIMIT = 'anonymous_network_limit';
/** ...once the Ree's or the platform's daily anonymous answers are used up. */
export const ANONYMOUS_CAPACITY_REACHED = 'anonymous_capacity_reached';

/** Which limit refused a question: the visitor's own, their network's, the Ree's or the platform's. */
export type AnonymousScope = 'visitor' | 'network' | 'ree' | 'platform';

export type AnonymousRefusalCode = typeof ANONYMOUS_QUOTA_EXCEEDED | typeof ANONYMOUS_NETWORK_LIMIT | typeof ANONYMOUS_CAPACITY_REACHED;

export function refusalCodeOf(scope: AnonymousScope): AnonymousRefusalCode {
  return scope === 'visitor' ? ANONYMOUS_QUOTA_EXCEEDED : scope === 'network' ? ANONYMOUS_NETWORK_LIMIT : ANONYMOUS_CAPACITY_REACHED;
}

export interface AnonymousRefusalBody extends AnonymousQuota {
  error: AnonymousRefusalCode;
  scope: AnonymousScope;
}

/**
 * The client address as the per-address key counts it: an IPv4 address as
 * is, an IPv6 address by its /64 (one subscriber's prefix; rotating within
 * it changes nothing), an IPv4-mapped IPv6 address as its IPv4 address.
 * Anything that does not parse is kept as given.
 */
export function ipBucket(ip: string): string {
  let value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(':')) return value;
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value) ?? /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1]!;
  const halves = value.split('::');
  if (halves.length > 2) return value;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return value;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The daily caps an administrator sets (anonymous-chat-settings.ts): per
 * browser, per Ree, over the platform, per client address, and the factor
 * every key's attempts cap is of its rounds. `revision` guards a save
 * against one made since the form was loaded; `default` before any save.
 */
export interface AnonymousChatLimits {
  visitorRoundsPerDay: number;
  reeRoundsPerDay: number;
  platformRoundsPerDay: number;
  ipRoundsPerDay: number;
  attemptsFactor: number;
  revision: string;
}

export const ANONYMOUS_LIMIT_FIELDS = ['visitorRoundsPerDay', 'reeRoundsPerDay', 'platformRoundsPerDay', 'ipRoundsPerDay', 'attemptsFactor'] as const;
export type AnonymousLimitField = (typeof ANONYMOUS_LIMIT_FIELDS)[number];

/** The largest value each setting takes; every one is a whole number from 1. The factor is whole too, so attempt caps stay whole. */
export const ANONYMOUS_LIMIT_BOUNDS: Record<AnonymousLimitField, number> = {
  visitorRoundsPerDay: ANONYMOUS_VISITOR_ROUNDS_MAX,
  reeRoundsPerDay: ANONYMOUS_LIMIT_MAX,
  platformRoundsPerDay: ANONYMOUS_LIMIT_MAX,
  ipRoundsPerDay: ANONYMOUS_LIMIT_MAX,
  attemptsFactor: ANONYMOUS_ATTEMPTS_FACTOR_MAX,
};

/** A value an administrator may set for `field`: a whole number from 1 to its bound. */
export function validAnonymousLimit(field: AnonymousLimitField, value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= ANONYMOUS_LIMIT_BOUNDS[field];
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
  /* Malformed entries take no place among the turns kept; a bounded tail is all that is read. */
  const turns = value
    .slice(-ANONYMOUS_HISTORY_TURNS * 4)
    .flatMap((turn): AnonymousTurn[] => {
      if (!turn || typeof turn !== 'object') return [];
      const { role, content } = turn as { role?: unknown; content?: unknown };
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) return [];
      return [{ role, content: content.trim() }];
    })
    .slice(-ANONYMOUS_HISTORY_TURNS);
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
