/**
 * Authentication rules, as pure functions. No Next.js, no driver, no fetch.
 *
 * Everything here is a decision the security sections of the docs make:
 * architecture.md 5.1 (identity), 15.3 (application security) and
 * requirement.md 3.2 (accounts).
 */

import { fill } from '@/lib/i18n/format';

export type IdentityProvider = 'github' | 'google';

export const IDENTITY_PROVIDERS: readonly IdentityProvider[] = ['github', 'google'];

export function isIdentityProvider(value: unknown): value is IdentityProvider {
  return typeof value === 'string' && IDENTITY_PROVIDERS.includes(value as IdentityProvider);
}

/**
 * How long a signed-in session lives past its last use.
 *
 * Sliding, not absolute: every touch (below) moves `expires_at` this far
 * out again, so a session that is used at least once a month never expires,
 * and one left alone for a month is dead. There is no separate idle rule --
 * the sliding expiry *is* the idle rule, with one number to reason about.
 */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * `last_seen_at` and `expires_at` are rewritten at most once per hour, to
 * keep reads read-mostly. The window therefore slides in hour steps; a
 * session's real expiry is within an hour of "last use plus 30 days".
 */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** How long the OAuth handshake may stay open. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const DEFAULT_RETURN_TO = '/dashboard';

/**
 * Post-login destinations, as prefixes. architecture.md 15.3 asks for a strict
 * return URL: an allow list of in-app paths is the only form that cannot be
 * talked into pointing somewhere else.
 */
const RETURN_TO_PREFIXES = ['/dashboard', '/assets', '/channels', '/u', '/playground', '/pricing'];

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Normalizes a caller-supplied `returnTo` into a safe same-origin path.
 *
 * Rejects anything that is not a plain absolute path: absolute URLs, scheme
 * relative `//evil.example`, backslash forms the browser normalizes into
 * slashes, and control characters that could split a Location header.
 */
export function safeReturnTo(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) {
    return DEFAULT_RETURN_TO;
  }
  if (!input.startsWith('/') || input.startsWith('//')) return DEFAULT_RETURN_TO;
  if (input.includes('\\')) return DEFAULT_RETURN_TO;
  if (hasControlCharacter(input)) return DEFAULT_RETURN_TO;

  const path = (input.split('?')[0] ?? '').split('#')[0] ?? '';
  const allowed = RETURN_TO_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  return allowed ? input : DEFAULT_RETURN_TO;
}

/**
 * Whether an account's state still lets it authenticate.
 *
 * The single gate for requirement.md 3.2: suspending an account has to stop
 * *every* way it reaches the platform at once -- the web session, the API key,
 * and the answers its libraries give. Each of those resolves the caller in a
 * different place, so the rule lives here rather than being re-typed as
 * `status !== 'active'` in each of them, and every new principal resolver has
 * one obvious thing to call.
 *
 * Written as an allow list, so a status nobody has invented yet fails closed.
 */
export function isAccountUsable(status: string): boolean {
  return status === 'active';
}

export interface SessionRow {
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

/** Live means: not revoked, and its sliding window has not closed. */
export function isSessionLive(session: SessionRow, now: Date): boolean {
  if (session.revokedAt !== null) return false;
  return session.expiresAt.getTime() > now.getTime();
}

/** Whether this use should move the window (and rewrite `last_seen_at`). */
export function shouldTouchSession(session: SessionRow, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}

/** Where the window ends for a session used now: at sign-in and on every touch. */
export function sessionExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_LIFETIME_MS);
}

/**
 * Billing period for a newly created Free subscription.
 *
 * One month later, with the day clamped: Jan 31 ends Feb 28/29 rather than
 * overflowing into March.
 */
export function firstBillingPeriod(now: Date): { start: Date; end: Date } {
  const end = new Date(now.getTime());
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return { start: now, end };
}

export interface IdentityProfile {
  provider: IdentityProvider;
  /** The provider's stable subject. Never the email. architecture.md 5.1 */
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Personal workspace name for a brand new account.
 *
 * The name is stored, not rendered from a dictionary on every read, so the
 * phrasing has to be chosen once -- at sign-up, in the language the visitor
 * arrived in. The caller passes it in; this stays free of the i18n plumbing.
 */
export interface WorkspaceNaming {
  /** Carries an `{owner}` placeholder. */
  personalWorkspace: string;
  /** Stands in when the profile offers no usable name. */
  fallbackOwner: string;
}

export function personalWorkspaceName(profile: IdentityProfile, naming: WorkspaceNaming): string {
  const base = profile.displayName?.trim() || profile.email.split('@')[0] || naming.fallbackOwner;
  return fill(naming.personalWorkspace, { owner: base.slice(0, 40) });
}

/** Monogram drawn in the workspace avatar. */
export function workspaceInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return (first ?? 'R').toUpperCase();
}

/**
 * Stable, user-facing failure codes for the login screen.
 *
 * Deliberately coarse: a failed handshake must not tell the caller whether the
 * state was wrong, the code was replayed or the provider refused -- see
 * architecture.md 5.4 on minimal responses.
 */
export const LOGIN_ERRORS = [
  'oauth_failed',
  'oauth_canceled',
  'email_unverified',
  'account_disabled',
  'rate_limited',
  'provider_unavailable',
] as const;

export type LoginError = (typeof LOGIN_ERRORS)[number];

export function isLoginError(value: unknown): value is LoginError {
  return typeof value === 'string' && (LOGIN_ERRORS as readonly string[]).includes(value);
}

/**
 * A login attempt that ended for a reason the user may see.
 *
 * `message` is for our own logs; only `loginError` ever reaches the browser,
 * and it carries no provider detail.
 */
export class AuthFailure extends Error {
  constructor(
    readonly loginError: LoginError,
    message: string,
  ) {
    super(message);
    this.name = 'AuthFailure';
  }
}
