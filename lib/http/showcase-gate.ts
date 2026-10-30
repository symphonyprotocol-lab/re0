/**
 * The visitor's side of a showcase page's gate (lib/domain/showcase.ts
 * `showcaseGate`): the unlock cookie a correct password earns, and the
 * check every route of the page runs before it serves anything.
 *
 * The cookie is a signed statement, not a session row: "this browser
 * unlocked page X at password version N, until T", under the session
 * signing secret. Changing the password bumps N and every cookie for the
 * old version stops matching, with nothing to revoke. HttpOnly, SameSite
 * Lax, one per page, scoped to the page's own path (`/s/{slug}`, which its
 * routes also live under) so a visitor who has unlocked many pages does
 * not carry every cookie on every request to the site.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { AppError } from '@/contracts/errors';
import type { ShowcaseGateInput } from '@/lib/application/showcase';
import { SHOWCASE_UNLOCK_TTL_MS, showcaseGate, type ShowcaseGateState } from '@/lib/domain/showcase';
import { showcasePath } from '@/lib/domain/showcase';
import { hmacSha256, timingSafeEqual } from '@/lib/infrastructure/crypto/tokens';
import { isSecureDeployment } from './cookie-names';

function secret(): string {
  const value = process.env.SESSION_SIGNING_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SIGNING_SECRET is not set (needs at least 32 characters)');
  return value;
}

export function showcaseCookieName(showcaseId: string): string {
  return `r0_sc_${showcaseId.replace(/-/g, '')}`;
}

async function sign(showcaseId: string, version: number, expiresAt: number): Promise<string> {
  return hmacSha256(secret(), `showcase-unlock:${showcaseId}:${version}:${expiresAt}`);
}

/** The cookie a correct password earns. */
export async function issueShowcaseUnlock(
  showcaseId: string,
  version: number,
  now: number = Date.now(),
): Promise<{ name: string; value: string; expires: Date }> {
  const expiresAt = now + SHOWCASE_UNLOCK_TTL_MS;
  return {
    name: showcaseCookieName(showcaseId),
    value: `${version}.${expiresAt}.${await sign(showcaseId, version, expiresAt)}`,
    expires: new Date(expiresAt),
  };
}

/** Whether a cookie value unlocks this page at this password version, right now. */
export async function showcaseUnlocked(
  value: string | undefined,
  showcaseId: string,
  version: number,
  now: number = Date.now(),
): Promise<boolean> {
  if (!value) return false;
  const [v, exp, sig] = value.split('.');
  if (!v || !exp || !sig) return false;
  const expiresAt = Number(exp);
  if (Number(v) !== version || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return timingSafeEqual(sig, await sign(showcaseId, version, expiresAt));
}

interface CookieJar {
  get(name: string): { value: string } | undefined;
}

/** The gate for one request: expired, locked, or open. */
export async function showcaseGateFor(cookies: CookieJar, gate: ShowcaseGateInput): Promise<ShowcaseGateState> {
  const unlocked = gate.hasPassword
    ? await showcaseUnlocked(cookies.get(showcaseCookieName(gate.showcaseId))?.value, gate.showcaseId, gate.passwordVersion)
    : false;
  return showcaseGate({ hasPassword: gate.hasPassword, expiresAt: gate.expiresAt, unlocked });
}

/** For the routes: a locked page refuses, an expired page is gone. */
export async function assertShowcaseOpen(request: NextRequest, gate: ShowcaseGateInput): Promise<void> {
  const state = await showcaseGateFor(request.cookies, gate);
  if (state === 'locked') throw new AppError('access_denied', 'this page asks for a password');
  if (state === 'expired') throw new AppError('asset_not_found', 'this page has expired');
}

export function setShowcaseUnlockCookie(response: NextResponse, cookie: { name: string; value: string; expires: Date }, slug: string): void {
  response.cookies.set(cookie.name, cookie.value, {
    httpOnly: true,
    secure: isSecureDeployment(),
    sameSite: 'lax',
    path: showcasePath(slug),
    expires: cookie.expires,
  });
}
