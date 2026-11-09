/**
 * Sign-in rules as pure functions: which providers exist, where a sign-in may
 * return to, and the coarse failure codes the login page shows.
 */
import { SESSION_LIFETIME_MS } from '@/lib/constants';

export type IdentityProvider = 'github' | 'google';
export const IDENTITY_PROVIDERS: readonly IdentityProvider[] = ['github', 'google'];

export function isIdentityProvider(value: unknown): value is IdentityProvider {
  return typeof value === 'string' && IDENTITY_PROVIDERS.includes(value as IdentityProvider);
}

export const DEFAULT_RETURN_TO = '/rees';

/** In-app destinations a sign-in may return to; an allow list cannot be talked into pointing elsewhere. */
const RETURN_TO_PREFIXES = ['/dashboard', '/rees', '/settings', '/chats', '/talk', '/explore', '/r', '/checkout', '/pricing', '/billing', '/videos', '/workspace'];

function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A caller-supplied `returnTo` as a safe same-origin path. Absolute and
 * scheme-relative URLs, backslash forms and control characters all fall back
 * to the dashboard.
 */
export function safeReturnTo(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) return DEFAULT_RETURN_TO;
  if (!input.startsWith('/') || input.startsWith('//')) return DEFAULT_RETURN_TO;
  if (input.includes('\\') || hasControlCharacter(input)) return DEFAULT_RETURN_TO;
  const path = (input.split('?')[0] ?? '').split('#')[0] ?? '';
  const allowed = path === '/' || RETURN_TO_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  return allowed ? input : DEFAULT_RETURN_TO;
}

/** Sessions slide: every use at least an hour after the last moves the end out again. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function sessionExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_LIFETIME_MS);
}

export function shouldSlide(expiresAt: Date, now: Date): boolean {
  return sessionExpiryFrom(now).getTime() - expiresAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}

export interface IdentityProfile {
  provider: IdentityProvider;
  /** The provider's stable subject, never the email. */
  subject: string;
  /** What the settings page shows as the platform account: GitHub login, Google email. */
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Deliberately coarse: a failed handshake never says which check failed. */
export const LOGIN_ERRORS = [
  'oauth_failed',
  'oauth_canceled',
  'email_unverified',
  'account_disabled',
  'provider_unavailable',
] as const;
export type LoginError = (typeof LOGIN_ERRORS)[number];

export function isLoginError(value: unknown): value is LoginError {
  return typeof value === 'string' && (LOGIN_ERRORS as readonly string[]).includes(value);
}

/** `message` is for our logs; only `loginError` reaches the browser. */
export class AuthFailure extends Error {
  constructor(
    readonly loginError: LoginError,
    message: string,
  ) {
    super(message);
    this.name = 'AuthFailure';
  }
}
