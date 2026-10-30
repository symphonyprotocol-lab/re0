/**
 * API key rules, as pure functions. requirement.md 5.2 (API Key) and 12.
 *
 * A key names an environment and a set of scopes at creation and never
 * changes them: rotation mints a replacement with the same ones. The scopes a
 * user may grant are the three retrieval-side ones and `assets:write`, which
 * lets an A2A caller ask for `ingest`, `refresh` and `publish`
 * (agent-first-proposal.md 7.4) -- every one of which still waits for the
 * owner's confirmation in the Dashboard (proposal 5.2, 7.6). The management
 * scope is reserved -- recognised when enforcing, refused when granting -- so
 * a key that can mint keys cannot come out of a form or the public API today.
 */

/** What a key reads with: everything a key could do before writes existed. */
export const API_KEY_READ_SCOPES = ['knowledge:search', 'knowledge:read', 'usage:read'] as const;

/** A2A write skills: `ingest`, `refresh`, `publish`. Never granted by default. */
export const API_KEY_WRITE_SCOPE = 'assets:write' as const;

export const API_KEY_SCOPES = [...API_KEY_READ_SCOPES, API_KEY_WRITE_SCOPE] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Reserved. Lets a Bearer key manage keys the way a session does. Listed so
 * the UI can show it (disabled) and enforcement can name it; `parseScopes`
 * refuses it.
 */
export const API_KEY_MANAGEMENT_SCOPE = 'admin:keys' as const;

export type ApiKeyGrantableScope = ApiKeyScope;

export const API_KEY_ENVIRONMENTS = ['live', 'test'] as const;

export type ApiKeyEnvironment = (typeof API_KEY_ENVIRONMENTS)[number];

/**
 * Rows minted before scopes existed carry the single word `retrieval`. It
 * meant "everything a key could do", which is the three read scopes -- not
 * `assets:write`, which did not exist and is never granted by implication.
 */
const LEGACY_SCOPE = 'retrieval';

/** A key unused for this long is what the security tile counts. */
export const API_KEY_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value);
}

export function isApiKeyEnvironment(value: unknown): value is ApiKeyEnvironment {
  return (
    typeof value === 'string' && (API_KEY_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

/**
 * What a stored `scopes` column grants. Maps the legacy word to the full set,
 * keeps the management scope, and drops anything unknown -- a scope nobody
 * defined grants nothing.
 */
export function normaliseScopes(stored: readonly unknown[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const value of stored ?? []) {
    if (value === LEGACY_SCOPE) {
      for (const scope of API_KEY_READ_SCOPES) out.add(scope);
    } else if (isApiKeyScope(value) || value === API_KEY_MANAGEMENT_SCOPE) {
      out.add(value);
    }
  }
  return [...out];
}

/**
 * Scopes a caller asked to grant, from a form or a JSON body. Returns null
 * when the request names a scope that cannot be granted (unknown, or the
 * reserved management scope) or names none at all.
 */
export function parseScopes(input: unknown): ApiKeyScope[] | null {
  const values = Array.isArray(input) ? input : typeof input === 'string' ? [input] : [];
  const out: ApiKeyScope[] = [];
  for (const value of values) {
    if (!isApiKeyScope(value)) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : null;
}

export function hasScope(scopes: readonly string[], needed: ApiKeyScope | typeof API_KEY_MANAGEMENT_SCOPE): boolean {
  return scopes.includes(needed);
}

export function apiKeyPrefix(environment: ApiKeyEnvironment): `mm_${ApiKeyEnvironment}_` {
  return `mm_${environment}_`;
}

/** Prefix and last four, and nothing in between. architecture.md 5.1. */
export function maskApiKey(prefix: string, lastFour: string): string {
  return `${prefix}••••${lastFour}`;
}

/** Idle means: no use in the window, counted from creation when never used. */
export function isApiKeyIdle(
  key: { lastUsedAt: Date | string | null; createdAt: Date | string },
  now: Date,
): boolean {
  const reference = new Date(key.lastUsedAt ?? key.createdAt).getTime();
  return now.getTime() - reference >= API_KEY_IDLE_MS;
}
