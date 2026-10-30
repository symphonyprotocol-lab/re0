/**
 * The console sign-in against a real database: credentials verify, the second
 * factor is mandatory, repeated failures lock the account, a product session is
 * not an admin session, and every attempt lands in the audit chain
 * (requirement.md 3.2, 5.3).
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database -- these
 * tests write rows. Against Neon, use a dev branch:
 *
 *   TEST_DATABASE_URL='postgres://...' npx vitest run tests/integration
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { signInAdmin, revokeAdminSession } = await import(
  '@/lib/application/administration/sign-in-admin'
);
const { resolveAdminSession } = await import(
  '@/lib/application/administration/resolve-admin-session'
);
const { hashAdminPassword } = await import('@/lib/application/administration/password');
const { sessionTokenHash } = await import('@/lib/application/auth/session-token');
const { completeOAuth } = await import('@/lib/application/auth/complete-oauth');
const { resolveSession } = await import('@/lib/application/auth/resolve-session');
const { OAUTH_STATE_TTL_MS } = await import('@/lib/domain/auth');
const { seal } = await import('@/lib/infrastructure/crypto/sealed');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { ADMIN_MAX_FAILED_ATTEMPTS } = await import('@/lib/domain/admin');
const { randomTotpSecret, base32Decode } = await import('@/lib/domain/totp');

const PASSWORD = 'correct horse battery staple';
const email = `admin-${Date.now()}@example.test`;
const administratorId = crypto.randomUUID();
const secret = randomTotpSecret();

/** The code the authenticator would be showing right now. */
async function currentCode(now = new Date()): Promise<string> {
  const counter = Math.floor(now.getTime() / 1000 / 30);
  const message = new Uint8Array(8);
  let low = counter >>> 0;
  let high = Math.floor(counter / 2 ** 32);
  for (let i = 3; i >= 0; i -= 1) {
    message[i] = high & 0xff;
    high >>>= 8;
    message[i + 4] = low & 0xff;
    low >>>= 8;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret)!,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 1_000_000).toString().padStart(6, '0');
}

async function seedAdministrator(): Promise<void> {
  await db()
    .insert(schema.administrator)
    .values({
      id: administratorId,
      username: 'Integration Admin',
      email,
      passwordHash: await hashAdminPassword(PASSWORD),
      mfaSecret: await seal(secret),
      mfaEnrolledAt: new Date(),
      status: 'active',
    });
  await db()
    .insert(schema.administratorRole)
    .values({ administratorId, roleId: 'reviewer' })
    .onConflictDoNothing();
}

/**
 * Back to a clean slate between cases.
 *
 * `mfa_last_counter` has to be cleared too: a successful sign-in now spends its
 * TOTP step, so a second sign-in inside the same 30 seconds is refused as a
 * replay -- correct behaviour, and something each case has to opt out of.
 */
async function resetAccount(): Promise<void> {
  await db()
    .update(schema.administrator)
    .set({ failedAttempts: 0, lockedUntil: null, mfaLastCounter: null })
    .where(eq(schema.administrator.id, administratorId));
}

describeWithDb('console sign-in', () => {
  afterAll(async () => {
    const database = db();
    await database.delete(schema.auditLog).where(eq(schema.auditLog.administratorId, administratorId));
    await database
      .delete(schema.adminSession)
      .where(eq(schema.adminSession.administratorId, administratorId));
    await database
      .delete(schema.administratorRole)
      .where(eq(schema.administratorRole.administratorId, administratorId));
    await database.delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
  });

  it('signs in with password and code, and resolves the session with its role', async () => {
    await seedAdministrator();

    const { token } = await signInAdmin({
      email,
      password: PASSWORD,
      mfaCode: await currentCode(),
    });

    const session = await resolveAdminSession(token);
    expect(session?.administratorId).toBe(administratorId);
    expect(session?.roles).toEqual(['reviewer']);
    // requirement.md 3.1: a reviewer reaches user assets and nothing else.
    expect(session?.capabilities).toEqual(['assets']);
  });

  it('slides a console session forward when it is used inside its window', async () => {
    await resetAccount();
    const { token } = await signInAdmin({ email, password: PASSWORD, mfaCode: await currentCode() });
    const before = await resolveAdminSession(token);
    const stale = new Date(Date.now() - 5 * 60 * 1000);
    const closing = new Date(Date.now() + 60 * 1000);
    await db()
      .update(schema.adminSession)
      .set({ lastSeenAt: stale, expiresAt: closing })
      .where(eq(schema.adminSession.id, before!.id));

    const after = await resolveAdminSession(token);
    expect(after).not.toBeNull();
    expect(after!.expiresAt.getTime()).toBeGreaterThan(closing.getTime() + 29 * 24 * 60 * 60 * 1000);

    /* Signed in 89 days ago: the next touch slides to the cap, not 30 days out. */
    const day = 24 * 60 * 60 * 1000;
    const signedIn = new Date(Date.now() - 89 * day);
    await db()
      .update(schema.adminSession)
      .set({ createdAt: signedIn, lastSeenAt: stale })
      .where(eq(schema.adminSession.id, before!.id));
    const capped = await resolveAdminSession(token);
    expect(capped!.expiresAt.getTime()).toBe(signedIn.getTime() + 90 * day);

    /* And past the cap it is gone, whatever expires_at says. */
    await db()
      .update(schema.adminSession)
      .set({ createdAt: new Date(Date.now() - 91 * day) })
      .where(eq(schema.adminSession.id, before!.id));
    expect(await resolveAdminSession(token)).toBeNull();
  });

  it('refuses a correct password with a wrong code -- MFA is not optional', async () => {
    await resetAccount();
    await expect(
      signInAdmin({ email, password: PASSWORD, mfaCode: '000000' }),
    ).rejects.toMatchObject({ loginError: 'invalid_credentials' });
  });

  it('refuses a correct code with a wrong password', async () => {
    await resetAccount();
    await expect(
      signInAdmin({ email, password: 'wrong password', mfaCode: await currentCode() }),
    ).rejects.toMatchObject({ loginError: 'invalid_credentials' });
  });

  it('answers an unknown address the same way as a wrong password', async () => {
    await expect(
      signInAdmin({ email: 'nobody@example.test', password: PASSWORD, mfaCode: '000000' }),
    ).rejects.toMatchObject({ loginError: 'invalid_credentials' });
  });

  it('locks the account after repeated failures, without saying so', async () => {
    await resetAccount();
    for (let attempt = 0; attempt < ADMIN_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(
        signInAdmin({ email, password: 'wrong password', mfaCode: '000000' }),
      ).rejects.toThrow();
    }
    // Correct credentials now, and still refused: the lock is checked first.
    // The code is the same one an unknown address gets, so a caller cannot tell
    // a locked administrator from an address that was never one.
    await expect(
      signInAdmin({ email, password: PASSWORD, mfaCode: await currentCode() }),
    ).rejects.toMatchObject({ loginError: 'invalid_credentials' });
    await resetAccount();
  });

  it('counts parallel failures instead of letting them overwrite each other', async () => {
    await resetAccount();
    /*
     * Exactly the lockout threshold, not one more: the lock lands with the
     * final increment, so no attempt in this burst can observe it before
     * incrementing -- one more attempt could, legitimately short-circuit on
     * the lock, and turn a correct behaviour into a flaky assertion.
     */
    const bursts = ADMIN_MAX_FAILED_ATTEMPTS;
    await Promise.all(
      Array.from({ length: bursts }, () =>
        signInAdmin({ email, password: 'wrong password', mfaCode: '000000' }).catch(() => null),
      ),
    );

    const [row] = await db()
      .select({
        failedAttempts: schema.administrator.failedAttempts,
        lockedUntil: schema.administrator.lockedUntil,
      })
      .from(schema.administrator)
      .where(eq(schema.administrator.id, administratorId));

    // Read-modify-write in the application would leave this at 1.
    expect(row?.failedAttempts).toBe(bursts);
    expect(row?.lockedUntil).not.toBeNull();
    await resetAccount();
  });

  it('refuses a TOTP code that has already been spent', async () => {
    await resetAccount();
    const code = await currentCode();
    const { token } = await signInAdmin({ email, password: PASSWORD, mfaCode: code });
    expect(token).toBeTruthy();

    // Same code, same step: an observer who captured it gets nothing.
    await expect(
      signInAdmin({ email, password: PASSWORD, mfaCode: code }),
    ).rejects.toMatchObject({ loginError: 'invalid_credentials' });
    await resetAccount();
  });

  it('does not accept a product session token as a console session', async () => {
    /* A real product login, the same way login.test.ts mints one: the
       handshake is genuine, only the provider's network call is not. */
    const subject = `console-cross-${Date.now()}`;
    const profile: import('@/lib/domain/auth').IdentityProfile = {
      provider: 'github',
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      displayName: 'Product User',
      avatarUrl: null,
    };
    const state = 'state-for-console-cross-check';
    const now = new Date();
    const { sessionToken } = await completeOAuth({
      provider: 'github',
      code: 'code',
      state,
      sealedHandshake: await seal({
        provider: 'github',
        state,
        nonce: 'nonce',
        codeVerifier: 'verifier',
        returnTo: '/dashboard',
        expiresAt: now.getTime() + OAUTH_STATE_TTL_MS,
      }),
      redirectUri: 'https://example.test/api/auth/github/callback',
      workspaceNaming: { personalWorkspace: '{owner} 的空间', fallbackOwner: '个人' },
      adapter: {
        supportsPkce: () => false,
        authorizeUrl: () => 'https://example.test/authorize',
        exchange: async () => profile,
      },
      now,
    });

    try {
      // The token really is a live product session...
      expect(await resolveSession(sessionToken)).not.toBeNull();
      // ...hashed into the product namespace, never stored raw...
      expect(await sessionTokenHash(sessionToken)).not.toBe(sessionToken);
      // ...and the console refuses it outright.
      expect(await resolveAdminSession(sessionToken)).toBeNull();
    } finally {
      const database = db();
      const [account] = await database
        .select({ userId: schema.oauthAccount.userId })
        .from(schema.oauthAccount)
        .where(
          and(
            eq(schema.oauthAccount.provider, 'github'),
            eq(schema.oauthAccount.providerSubject, subject),
          ),
        );
      if (account) {
        const memberships = await database
          .select({ workspaceId: schema.workspaceMember.workspaceId })
          .from(schema.workspaceMember)
          .where(eq(schema.workspaceMember.userId, account.userId));
        const workspaceIds = memberships.map((member) => member.workspaceId);
        await database
          .delete(schema.userSession)
          .where(eq(schema.userSession.userId, account.userId));
        if (workspaceIds.length > 0) {
          await database
            .delete(schema.subscription)
            .where(inArray(schema.subscription.workspaceId, workspaceIds));
        }
        await database
          .delete(schema.workspaceMember)
          .where(eq(schema.workspaceMember.userId, account.userId));
        if (workspaceIds.length > 0) {
          await database
            .delete(schema.workspace)
            .where(inArray(schema.workspace.id, workspaceIds));
        }
        await database
          .delete(schema.oauthAccount)
          .where(eq(schema.oauthAccount.userId, account.userId));
        await database.delete(schema.user).where(eq(schema.user.id, account.userId));
      }
    }
  });

  it('kills the session on sign-out', async () => {
    await resetAccount();
    const { token } = await signInAdmin({
      email,
      password: PASSWORD,
      mfaCode: await currentCode(),
    });
    expect(await resolveAdminSession(token)).not.toBeNull();

    await revokeAdminSession(token);
    expect(await resolveAdminSession(token)).toBeNull();
  });

  it('never forks the audit chain, even under concurrent writes', async () => {
    await resetAccount();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        signInAdmin({ email, password: 'wrong password', mfaCode: '000000' }).catch(() => null),
      ),
    );
    await resetAccount();

    const rows = await db()
      .select({ seq: schema.auditLog.seq, prevHash: schema.auditLog.prevHash })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.administratorId, administratorId));

    // Each prev_hash may be claimed by exactly one successor, or the chain has
    // branched and a row on the orphaned branch could be removed unnoticed.
    const claimed = rows.map((row) => row.prevHash).filter((hash): hash is string => hash !== null);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(new Set(rows.map((row) => row.seq)).size).toBe(rows.length);
  });

  it('records every attempt in an unbroken audit chain', async () => {
    const rows = await db()
      .select({
        action: schema.auditLog.action,
        result: schema.auditLog.result,
        prevHash: schema.auditLog.prevHash,
        hash: schema.auditLog.hash,
        ipDigest: schema.auditLog.ipDigest,
      })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.administratorId, [administratorId]));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.result === 'success')).toBe(true);
    expect(rows.some((row) => row.result === 'failure')).toBe(true);
    for (const row of rows) {
      expect(row.action).toBe('admin.sign_in');
      expect(row.hash).toMatch(/^[A-Za-z0-9_-]+$/);
      // requirement.md 12: a summary of the origin, never the address itself.
      expect(row.ipDigest).toBeNull();
    }
  });
});
