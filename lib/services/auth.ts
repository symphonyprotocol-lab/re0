/**
 * Sign-in with Google or GitHub (ported from the old auth use cases), the
 * user session, and sign-out.
 *
 * The OAuth handshake -- state, PKCE verifier, nonce, where to return --
 * travels in one sealed short-lived cookie, so the callback needs no store.
 * A first sign-in creates the user and grants the welcome credits in the
 * same transaction as the session (rebuild-proposal.md 2.3).
 */
import { and, eq, gt } from 'drizzle-orm';
import { OAUTH_STATE_TTL_MS, DISPLAY_NAME_MAX } from '@/lib/constants';
import {
  AuthFailure,
  safeReturnTo,
  sessionExpiryFrom,
  shouldSlide,
  type IdentityProfile,
  type IdentityProvider,
} from '@/lib/domain/auth';
import { seal, unseal } from '@/lib/infra/crypto/sealed';
import { authSecret } from '@/lib/infra/crypto/secrets';
import { codeChallengeS256, hmacSha256, randomToken, timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { db, schema } from '@/lib/infra/db';
import * as github from '@/lib/infra/identity/github';
import * as google from '@/lib/infra/identity/google';
import { grantWelcome } from '@/lib/services/credits';

export interface Handshake {
  provider: IdentityProvider;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

export interface IdentityAdapter {
  authorizeUrl(input: { provider: IdentityProvider; state: string; nonce: string; codeChallenge: string; redirectUri: string }): string;
  exchange(input: { provider: IdentityProvider; code: string; codeVerifier: string; nonce: string; redirectUri: string }): Promise<IdentityProfile>;
}

export const identityAdapter: IdentityAdapter = {
  authorizeUrl: (input) =>
    input.provider === 'github'
      ? github.authorizeUrl({ state: input.state, redirectUri: input.redirectUri })
      : google.authorizeUrl(input),
  exchange: (input) =>
    input.provider === 'github'
      ? github.exchange({ code: input.code, redirectUri: input.redirectUri })
      : google.exchange(input),
};

export function sessionTokenHash(token: string): Promise<string> {
  return hmacSha256(authSecret(), `session:${token}`);
}

export async function beginOAuth(input: {
  provider: IdentityProvider;
  returnTo: unknown;
  redirectUri: string;
  now?: Date;
  adapter?: IdentityAdapter;
}): Promise<{ redirectUrl: string; handshake: string; expiresAt: number }> {
  const now = input.now ?? new Date();
  const handshake: Handshake = {
    provider: input.provider,
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier: randomToken(),
    returnTo: safeReturnTo(input.returnTo),
    expiresAt: now.getTime() + OAUTH_STATE_TTL_MS,
  };
  const redirectUrl = (input.adapter ?? identityAdapter).authorizeUrl({
    provider: input.provider,
    state: handshake.state,
    nonce: handshake.nonce,
    codeChallenge: await codeChallengeS256(handshake.codeVerifier),
    redirectUri: input.redirectUri,
  });
  return { redirectUrl, handshake: await seal('oauth-handshake', handshake), expiresAt: handshake.expiresAt };
}

/** A handshake sealed before purposes: an OAuth one names a provider and no purpose. Ten minutes at most. */
const legacyHandshake = (payload: unknown) => typeof payload === 'object' && payload !== null && typeof (payload as { provider?: unknown }).provider === 'string' && !('purpose' in payload);

function verifyHandshake(handshake: Handshake | null, provider: IdentityProvider, state: string | null, code: string | null, now: Date): Handshake {
  if (!handshake || typeof handshake.state !== 'string') throw new AuthFailure('oauth_failed', 'missing or unreadable handshake');
  if (handshake.expiresAt <= now.getTime()) throw new AuthFailure('oauth_failed', 'handshake expired');
  if (handshake.provider !== provider) throw new AuthFailure('oauth_failed', 'handshake provider mismatch');
  if (!state || !timingSafeEqual(handshake.state, state)) throw new AuthFailure('oauth_failed', 'state mismatch');
  if (!code) throw new AuthFailure('oauth_failed', 'callback carried no code');
  return handshake;
}

export interface CompleteOAuthResult {
  sessionToken: string;
  expiresAt: Date;
  returnTo: string;
  userId: string;
  created: boolean;
}

export async function completeOAuth(input: {
  provider: IdentityProvider;
  code: string | null;
  state: string | null;
  sealedHandshake: string | null | undefined;
  redirectUri: string;
  lang: 'zh' | 'en';
  now?: Date;
  adapter?: IdentityAdapter;
}): Promise<CompleteOAuthResult> {
  const now = input.now ?? new Date();
  const handshake = verifyHandshake(await unseal<Handshake>('oauth-handshake', input.sealedHandshake, legacyHandshake), input.provider, input.state, input.code, now);
  const profile = await (input.adapter ?? identityAdapter).exchange({
    provider: input.provider,
    code: input.code!,
    codeVerifier: handshake.codeVerifier,
    nonce: handshake.nonce,
    redirectUri: input.redirectUri,
  });
  return createSession(profile, input.lang, handshake.returnTo, now);
}

/** Finds or creates the user for a verified identity and opens a session. */
export async function createSession(
  profile: IdentityProfile,
  lang: 'zh' | 'en',
  returnTo: string,
  now = new Date(),
): Promise<CompleteOAuthResult> {
  const sessionToken = randomToken();
  const expiresAt = sessionExpiryFrom(now);
  const tokenHash = await sessionTokenHash(sessionToken);

  const { userId, created } = await db().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.user.id, disabledAt: schema.user.disabledAt })
      .from(schema.user)
      .where(and(eq(schema.user.provider, profile.provider), eq(schema.user.providerSubject, profile.subject)))
      .limit(1);
    if (existing) {
      if (existing.disabledAt) throw new AuthFailure('account_disabled', 'account is disabled');
      /* Email and handle follow the provider; the name and avatar are the user's own once set. */
      await tx
        .update(schema.user)
        .set({ email: profile.email, providerHandle: profile.handle, lastLoginAt: now })
        .where(eq(schema.user.id, existing.id));
      await tx.insert(schema.session).values({ id: tokenHash, userId: existing.id, expiresAt });
      return { userId: existing.id, created: false };
    }
    const name = (profile.displayName?.trim() || profile.email.split('@')[0] || 'Ree user').slice(0, DISPLAY_NAME_MAX);
    const [user] = await tx
      .insert(schema.user)
      .values({
        email: profile.email,
        name,
        avatarBlob: profile.avatarUrl,
        lang,
        provider: profile.provider,
        providerSubject: profile.subject,
        providerHandle: profile.handle,
        lastLoginAt: now,
        createdAt: now,
      })
      .returning({ id: schema.user.id });
    await grantWelcome(tx, user!.id, now);
    await tx.insert(schema.session).values({ id: tokenHash, userId: user!.id, expiresAt });
    return { userId: user!.id, created: true };
  });

  return { sessionToken, expiresAt, returnTo, userId, created };
}

export type SessionUser = typeof schema.user.$inferSelect;

/** The signed-in user for a cookie's token, sliding the session on use; null for anything else. */
export async function resolveSession(token: string | undefined | null, now = new Date()): Promise<SessionUser | null> {
  if (!token) return null;
  const id = await sessionTokenHash(token);
  const [row] = await db()
    .select({ user: schema.user, expiresAt: schema.session.expiresAt })
    .from(schema.session)
    .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
    .where(and(eq(schema.session.id, id), gt(schema.session.expiresAt, now)))
    .limit(1);
  if (!row || row.user.disabledAt) return null;
  if (shouldSlide(row.expiresAt, now)) {
    await db().update(schema.session).set({ expiresAt: sessionExpiryFrom(now) }).where(eq(schema.session.id, id));
  }
  return row.user;
}

export async function signOut(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db().delete(schema.session).where(eq(schema.session.id, await sessionTokenHash(token)));
}
