/**
 * Shared plumbing for the three auth Route Handlers.
 *
 * Failures always land back on the login page with one of the stable codes
 * from `lib/domain/auth`; the detail stays server side (architecture.md 5.4,
 * "response minimisation").
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { LoginError } from '@/lib/domain/auth';
import { hmacSha256 } from '@/lib/infrastructure/crypto/tokens';
import { rateLimiter, type RateLimitRule } from '@/lib/infrastructure/cache/redis';
import { appBaseUrl } from '@/lib/http/session';
import { clientAddress } from '@/lib/http/client-address';

export function loginRedirect(error?: LoginError, returnTo?: string): NextResponse {
  const url = new URL('/login', appBaseUrl());
  if (error) url.searchParams.set('error', error);
  if (returnTo) url.searchParams.set('returnTo', returnTo);
  return NextResponse.redirect(url, 303);
}

export function appRedirect(path: string, status: 303 | 302 = 303): NextResponse {
  return NextResponse.redirect(new URL(path, appBaseUrl()), status);
}

/** The secret the rate-limit keys and signed reader addresses are keyed with. */
export function signingSecret(): string {
  const secret = process.env.SESSION_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SIGNING_SECRET is not set (needs at least 32 characters)');
  }
  return secret;
}

/**
 * Rate limit bucket for one address.
 *
 * The address is keyed through an HMAC and never stored or logged in the
 * clear -- architecture.md 11.2 requires hashed IP signals.
 */
export async function addressRateLimitKey(scope: string, address: string): Promise<string> {
  return `ratelimit:${scope}:${await hmacSha256(signingSecret(), address)}`;
}

/** Rate limit bucket for one caller, by the address our own edge saw (`clientAddress`). */
export async function rateLimitKey(request: NextRequest, scope: string): Promise<string> {
  return addressRateLimitKey(scope, clientAddress(request.headers) ?? 'unknown');
}

/** Login endpoints are bursty by nature; the window blunts scripted retries. */
export const AUTH_RATE_RULE: RateLimitRule = { limit: 20, windowSeconds: 300 };

export async function withinRateLimit(request: NextRequest, scope: string): Promise<boolean> {
  const verdict = await rateLimiter().check(await rateLimitKey(request, scope), AUTH_RATE_RULE);
  return verdict.allowed;
}

/**
 * Server-side breadcrumb for a failed login.
 *
 * Codes, provider and request id only: no token, no authorization code, no id
 * token, no address (requirement.md 12).
 */
export function logAuthFailure(input: {
  requestId: string;
  provider: string;
  error: LoginError;
  detail: string;
}): void {
  console.warn(
    `auth ${input.provider} failed code=${input.error} requestId=${input.requestId} detail=${input.detail}`,
  );
}
