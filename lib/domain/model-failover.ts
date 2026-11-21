/**
 * Primary and backup models (docs: the model-failover design, 2026-11-21).
 * Each kind -- generation once per audience -- has an ordered list of
 * console entries; a request tries them in order and moves on when an error
 * says another model could succeed. A model that failed that way cools
 * down for a while, and requests skip it until then.
 *
 * Everything here is pure: what an error means, how long a model cools,
 * and the order a request tries the list in.
 */
import type { ModelKind } from '@/lib/constants';

/** What a failed attempt says about the model. `caller` and `aborted` are the request's own problem: never switch. */
export const FAILURE_CLASSES = ['quota', 'rate_limit', 'server', 'timeout', 'auth', 'model_missing', 'caller', 'aborted'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
/** The classes that make a request try the next entry. */
export type SwitchingClass = Exclude<FailureClass, 'caller' | 'aborted'>;
export const COOLING_REASONS = ['quota', 'rate_limit', 'server', 'timeout', 'auth', 'model_missing'] as const satisfies readonly SwitchingClass[];

export const CHAIN_AUDIENCES = ['free', 'plan', 'all'] as const;
export type ChainAudience = (typeof CHAIN_AUDIENCES)[number];
/** Kinds with a list of more than one entry. Speech keeps a single entry: a narration must not change voice. */
export const FAILOVER_KINDS = ['generation', 'embedding', 'transcription'] as const satisfies readonly ModelKind[];

export function chainAudience(kind: ModelKind, audience: 'free' | 'plan' = 'free'): ChainAudience {
  return kind === 'generation' ? audience : 'all';
}

export function hasFailover(kind: ModelKind): boolean {
  return (FAILOVER_KINDS as readonly string[]).includes(kind);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Cooling periods (design Q1: constants, not console settings). */
export const COOLING = {
  quota: { base: HOUR, max: 6 * HOUR },
  rateLimit: { base: 30 * SECOND, max: 5 * MINUTE },
  /** Server errors and timeouts: two in a row within the window before cooling at all. */
  transient: { base: MINUTE, max: 10 * MINUTE, window: MINUTE, threshold: 2 },
  /** Bad key, no access, no such model: until a probe succeeds or an administrator acts. */
  config: 6 * HOUR,
} as const;
/** How often the health cron probes a model cooling for quota, auth or a missing model. */
export const HEALTH_PROBE_EVERY_MS = 10 * MINUTE;
/** How long an instance trusts its read of `model_health`. */
export const HEALTH_CACHE_MS = 10 * SECOND;
/** With every entry cooling, a request still tries this many, soonest-recovering first (design Q6). */
export const LAST_RESORT_TRIES = 2;

export interface Failure {
  kind: FailureClass;
  /** HTTP status when the provider answered with one. */
  status: number | null;
  /** From Retry-After, capped; rate limits only. */
  retryAfterMs: number | null;
}

/** Wording that means "out of money", not "too fast": OpenAI's insufficient_quota, gateway credits, DashScope's Arrearage. */
const QUOTA_TEXT = /insufficient[_ ]?(quota|funds|balance|credits?)|billing|credit balance|out of credits|no credits|balance|arrear|payment required|余额|欠费|额度不足/i;

interface Facts {
  status: number | null;
  names: string[];
  codes: string[];
  text: string;
  headers: Record<string, string>;
}

function facts(error: unknown): Facts {
  const found: Facts = { status: null, names: [], codes: [], text: '', headers: {} };
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const item = current as Record<string, unknown>;
    const status = typeof item.statusCode === 'number' ? item.statusCode : typeof item.status === 'number' ? item.status : null;
    if (found.status === null && status !== null && status >= 100) found.status = status;
    if (typeof item.name === 'string') found.names.push(item.name);
    if (typeof item.code === 'string') found.codes.push(item.code);
    if (typeof item.type === 'string') found.codes.push(item.type);
    if (typeof item.message === 'string') found.text += ` ${item.message}`;
    if (typeof item.responseBody === 'string') found.text += ` ${item.responseBody.slice(0, 2000)}`;
    if (item.responseHeaders && typeof item.responseHeaders === 'object') {
      for (const [key, value] of Object.entries(item.responseHeaders as Record<string, unknown>)) {
        if (typeof value === 'string') found.headers[key.toLowerCase()] ??= value;
      }
    }
    current = item.cause;
  }
  return found;
}

/** Retry-After (seconds or an HTTP date) or retry-after-ms, at most five minutes; null without either. */
export function retryAfterMs(headers: Record<string, string>, now = Date.now()): number | null {
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, COOLING.rateLimit.max);
  const value = headers['retry-after']?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * SECOND, COOLING.rateLimit.max);
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? Math.min(at - now, COOLING.rateLimit.max) : null;
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

/**
 * What a failed attempt means. `callerAborted`: the request's own signal
 * fired (the asker left, or the whole request ran out of time); `timedOut`:
 * this layer's per-attempt timer did.
 */
export function classifyModelFailure(error: unknown, flags: { callerAborted?: boolean; timedOut?: boolean } = {}, now = Date.now()): Failure {
  const seen = facts(error);
  const failure = (kind: FailureClass, retry: number | null = null): Failure => ({ kind, status: seen.status, retryAfterMs: retry });
  if (flags.callerAborted) return failure('aborted');
  if (flags.timedOut) return failure('timeout');
  const { status, names, codes, text } = seen;
  const quotaWords = QUOTA_TEXT.test(text) || codes.some((code) => QUOTA_TEXT.test(code));
  if (status === 402) return failure('quota');
  if (status === 429) return quotaWords ? failure('quota') : failure('rate_limit', retryAfterMs(seen.headers, now));
  if (names.includes('GatewayRateLimitError')) return failure('rate_limit', retryAfterMs(seen.headers, now));
  /* Some providers refuse an account in arrears with a 400 or 403. */
  if ((status === 400 || status === 403) && quotaWords) return failure('quota');
  if (status === 401 || status === 403 || names.includes('GatewayAuthenticationError') || names.includes('GatewayForbiddenError')) return failure('auth');
  if (status === 404 || names.includes('GatewayModelNotFoundError') || names.includes('GatewayNotFoundError')) return failure('model_missing');
  if (status === 408) return failure('timeout');
  if (status !== null && status >= 500) return failure('server');
  if (status !== null && status >= 400) return failure('caller');
  if (names.includes('GatewayInvalidRequestError')) return failure('caller');
  /* An administrator's base URL that resolves to a link-local or metadata address: a configuration problem. */
  if (names.includes('PrivateAddressError') || codes.includes('EPRIVATEADDRESS')) return failure('auth');
  if (names.some((name) => name === 'TimeoutError')) return failure('timeout');
  if (codes.some((code) => NETWORK_CODES.has(code)) || /fetch failed|socket hang up|network/i.test(text)) return failure('server');
  if (names.includes('AbortError')) return failure('timeout');
  /* Unparseable answers, gateway internals and anything unknown: the provider's side. */
  return failure('server');
}

export function switches(failure: Failure): failure is Failure & { kind: SwitchingClass } {
  return failure.kind !== 'caller' && failure.kind !== 'aborted';
}

/* ------------------------------------------------------------- health */

export interface Health {
  state: 'ok' | 'cooling';
  reason: SwitchingClass | null;
  coolingUntil: Date | null;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
}

export const HEALTHY: Health = { state: 'ok', reason: null, coolingUntil: null, consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: null, lastErrorCode: null };

export function isCooling(health: Health | undefined, now: Date): boolean {
  return Boolean(health && health.state === 'cooling' && health.coolingUntil && health.coolingUntil.getTime() > now.getTime());
}

/** The classes a probe or an administrator must clear: a request succeeding elsewhere says nothing about them. */
export function needsProbe(reason: SwitchingClass | null): boolean {
  return reason === 'quota' || reason === 'auth' || reason === 'model_missing';
}

/** The stored error code: the class and the status, never the provider's text. */
export function failureCode(failure: Failure): string {
  return failure.status ? `${failure.kind}:${failure.status}` : failure.kind;
}

/**
 * The health after a switching failure. Repeats of the same reason double
 * the period up to its cap; a server error or timeout cools only on the
 * second in a row within a minute.
 */
export function afterFailure(previous: Health, failure: Failure & { kind: SwitchingClass }, now: Date): Health {
  const recent = previous.lastFailureAt !== null && now.getTime() - previous.lastFailureAt.getTime() <= COOLING.transient.window;
  const sameReason = previous.reason === failure.kind || (previous.reason !== null && transient(previous.reason) && transient(failure.kind));
  const streak = sameReason && (previous.state === 'cooling' || recent) ? previous.consecutiveFailures + 1 : 1;
  const base = { ...previous, reason: failure.kind, consecutiveFailures: streak, lastFailureAt: now, lastErrorCode: failureCode(failure) };
  let period: number | null;
  switch (failure.kind) {
    case 'quota':
      period = Math.min(COOLING.quota.base * 2 ** (streak - 1), COOLING.quota.max);
      break;
    case 'rate_limit':
      period = failure.retryAfterMs ?? Math.min(COOLING.rateLimit.base * 2 ** (streak - 1), COOLING.rateLimit.max);
      break;
    case 'server':
    case 'timeout':
      period = streak >= COOLING.transient.threshold
        ? Math.min(COOLING.transient.base * 2 ** (streak - COOLING.transient.threshold), COOLING.transient.max)
        : null;
      break;
    default:
      period = COOLING.config;
  }
  if (period === null) return { ...base, state: previous.state, coolingUntil: previous.coolingUntil };
  const until = new Date(now.getTime() + period);
  /* Never shorten a period another instance (or an earlier failure) set. */
  const coolingUntil = previous.coolingUntil && previous.coolingUntil > until && previous.state === 'cooling' ? previous.coolingUntil : until;
  return { ...base, state: 'cooling', coolingUntil };
}

function transient(reason: SwitchingClass): boolean {
  return reason === 'server' || reason === 'timeout';
}

/**
 * Whether a successful request clears the health. A probe or an
 * administrator always does; an ordinary request only when the period is
 * over or the reason passes by itself -- an instance whose request finished
 * after another instance saw the quota run out must not undo that.
 */
export function successClears(health: Health, now: Date, source: 'request' | 'probe' | 'manual'): boolean {
  if (health.state === 'ok') return health.consecutiveFailures > 0;
  if (source !== 'request') return true;
  return !isCooling(health, now) || !needsProbe(health.reason);
}

/* ------------------------------------------------------------- order */

export interface ChainEntry<T> {
  configId: string;
  position: number;
  value: T;
}

/**
 * The entries a request tries, in order: every entry not cooling, by
 * position; with all of them cooling, the soonest-recovering few anyway --
 * cooling means "rather not", and a wrong guess must not take the site down.
 */
export function attemptOrder<T>(entries: readonly ChainEntry<T>[], health: ReadonlyMap<string, Health>, now: Date): ChainEntry<T>[] {
  const sorted = [...entries].sort((a, b) => a.position - b.position);
  const ready = sorted.filter((entry) => !isCooling(health.get(entry.configId), now));
  if (ready.length > 0) return ready;
  return sorted
    .map((entry, index) => ({ entry, index, until: health.get(entry.configId)?.coolingUntil?.getTime() ?? 0 }))
    .sort((a, b) => a.until - b.until || a.index - b.index)
    .slice(0, LAST_RESORT_TRIES)
    .map(({ entry }) => entry);
}

/** Plan's list, then Free's entries it does not already have (design Q3: a Plan member is never left without an answer). */
export function planWithFree<T>(plan: readonly ChainEntry<T>[], free: readonly ChainEntry<T>[]): ChainEntry<T>[] {
  const seen = new Set(plan.map((entry) => entry.configId));
  const last = plan.reduce((max, entry) => Math.max(max, entry.position), -1);
  return [...plan, ...free.filter((entry) => !seen.has(entry.configId)).map((entry) => ({ ...entry, position: last + 1 + entry.position }))];
}

/* ----------------------------------------------------- embedding space */

/** The model name an embedding backup must share: the part after the gateway's `provider/`. */
export function embeddingModelName(model: string): string {
  return model.split('/').pop()!.trim().toLowerCase();
}

export const EMBEDDING_SAME_SPACE_MIN_COSINE = 0.9999;

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Whether a candidate's vectors can sit beside the primary's: same name, same width, (nearly) the same vector for the same text. */
export function sameEmbeddingSpace(primary: { model: string; vector: readonly number[] }, candidate: { model: string; vector: readonly number[] }): boolean {
  return embeddingModelName(primary.model) === embeddingModelName(candidate.model)
    && primary.vector.length === candidate.vector.length
    && cosine(primary.vector, candidate.vector) >= EMBEDDING_SAME_SPACE_MIN_COSINE;
}
