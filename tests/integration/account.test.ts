/**
 * Acceptance (8.4 step 1): a new user gets 100,000 welcome credits; signing in
 * again reuses the account without a second grant; a disabled account cannot
 * sign in; sign-out kills the session.
 */
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { eq } from 'drizzle-orm';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession, resolveSession, signOut, completeOAuth, beginOAuth } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');

const profile = (subject: string) => ({
  provider: 'github' as const,
  subject,
  handle: subject,
  email: `${subject}@example.test`,
  displayName: 'Tester',
  avatarUrl: null,
});

describeWithDb('sign-up and sessions', () => {
  it('grants 100,000 welcome credits once, with a ledger row', async () => {
    const subject = uniqueName('user');
    const first = await createSession(profile(subject), 'zh', '/dashboard');
    expect(first.created).toBe(true);
    expect(await balanceOf(db(), first.userId)).toBe(100_000);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.userId, first.userId));
    expect(entries.map((entry) => [entry.reason, entry.delta])).toEqual([['welcome', 100_000]]);

    const second = await createSession(profile(subject), 'zh', '/dashboard');
    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(await balanceOf(db(), first.userId)).toBe(100_000);
  });

  it('resolves a live session and forgets it on sign-out', async () => {
    const session = await createSession(profile(uniqueName('user')), 'en', '/dashboard');
    const user = await resolveSession(session.sessionToken);
    expect(user?.id).toBe(session.userId);
    expect(user?.lang).toBe('en');
    expect(session.lang).toBe('en');
    await signOut(session.sessionToken);
    expect(await resolveSession(session.sessionToken)).toBeNull();
    expect(await resolveSession('not-a-token')).toBeNull();
  });

  it("returns an existing account's own language at sign-in, not the browser's", async () => {
    const subject = uniqueName('user');
    expect((await createSession(profile(subject), 'en', '/dashboard')).lang).toBe('en');
    /* The callback sets the language cookie from this (app/api/auth/[provider]/callback). */
    expect((await createSession(profile(subject), 'zh', '/dashboard')).lang).toBe('en');
  });

  it('refuses a disabled account', async () => {
    const subject = uniqueName('user');
    const session = await createSession(profile(subject), 'zh', '/dashboard');
    await db().update(schema.user).set({ disabledAt: new Date() }).where(eq(schema.user.id, session.userId));
    expect(await resolveSession(session.sessionToken)).toBeNull();
    await expect(createSession(profile(subject), 'zh', '/dashboard')).rejects.toMatchObject({ loginError: 'account_disabled' });
  });

  it('completes the OAuth handshake against a stand-in provider', async () => {
    const subject = uniqueName('oauth');
    const adapter = { authorizeUrl: () => 'https://provider.test/authorize', exchange: async () => profile(subject) };
    const started = await beginOAuth({ provider: 'github', returnTo: '/rees/new', redirectUri: 'http://localhost/cb', adapter });
    const { unseal } = await import('@/lib/infra/crypto/sealed');
    const handshake = await unseal<{ state: string }>('oauth-handshake', started.handshake);
    const result = await completeOAuth({
      provider: 'github',
      code: 'code',
      state: handshake!.state,
      sealedHandshake: started.handshake,
      redirectUri: 'http://localhost/cb',
      lang: 'zh',
      adapter,
    });
    expect(result.returnTo).toBe('/rees/new');
    await expect(
      completeOAuth({ provider: 'github', code: 'code', state: 'forged', sealedHandshake: started.handshake, redirectUri: 'http://localhost/cb', lang: 'zh', adapter }),
    ).rejects.toMatchObject({ loginError: 'oauth_failed' });
  });
});
