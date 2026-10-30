/**
 * Suspending and re-enabling a registered account against a real database
 * (requirement.md 3.2, 5.3): the web session dies the moment the operator
 * confirms, the reason is mandatory, and the audit log carries the before and
 * after values.
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
process.env.API_KEY_HASH_SECRET ??= 'test-api-key-hash-secret-000000000000';

const { completeOAuth } = await import('@/lib/application/auth/complete-oauth');
const { resolveSession } = await import('@/lib/application/auth/resolve-session');
const { getConsoleUser, setUserAccountStatus } = await import(
  '@/lib/application/administration/manage-users'
);
const { listConsoleUsers } = await import('@/lib/application/administration/list-users');
const { createApiKey } = await import('@/lib/application/auth/manage-api-keys');
const { resolveApiKey } = await import('@/lib/application/auth/api-key');
const { seal } = await import('@/lib/infrastructure/crypto/sealed');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { OAUTH_STATE_TTL_MS, SESSION_LIFETIME_MS } = await import('@/lib/domain/auth');
const { uuidv7 } = await import('@/lib/domain/id');

const subject = `suspend-${Date.now()}`;
const profile: import('@/lib/domain/auth').IdentityProfile = {
  provider: 'github',
  subject,
  email: `${subject}@example.test`,
  emailVerified: true,
  displayName: 'Suspension Subject',
  avatarUrl: null,
};

const adapter = {
  supportsPkce: () => false,
  authorizeUrl: () => 'https://example.test/authorize',
  exchange: async () => profile,
};

/** No administrator row is needed: `audit_log.administrator_id` is nullable. */
const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };

async function login() {
  const now = new Date();
  const state = 'state-for-suspension';
  const sealedHandshake = await seal({
    provider: 'github',
    state,
    nonce: 'nonce',
    codeVerifier: 'verifier',
    returnTo: '/dashboard',
    expiresAt: now.getTime() + OAUTH_STATE_TTL_MS,
  });
  return completeOAuth({
    provider: 'github',
    code: 'code',
    state,
    sealedHandshake,
    redirectUri: 'https://example.test/api/auth/github/callback',
    workspaceNaming: { personalWorkspace: '{owner} 的空间', fallbackOwner: '个人' },
    adapter,
    now,
  });
}

describeWithDb('suspending a registered account', () => {
  let userId = '';

  afterAll(async () => {
    if (!userId) return;
    const database = db();
    const workspaces = await database
      .select({ id: schema.workspaceMember.workspaceId })
      .from(schema.workspaceMember)
      .where(eq(schema.workspaceMember.userId, userId));
    const workspaceIds = workspaces.map((row) => row.id);

    await database
      .delete(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'user'), eq(schema.auditLog.targetId, userId)));
    await database.delete(schema.userSession).where(eq(schema.userSession.userId, userId));
    if (workspaceIds.length > 0) {
      await database
        .delete(schema.subscription)
        .where(inArray(schema.subscription.workspaceId, workspaceIds));
    }
    if (workspaceIds.length > 0) {
      await database.delete(schema.apiKey).where(inArray(schema.apiKey.workspaceId, workspaceIds));
    }
    await database.delete(schema.workspaceMember).where(eq(schema.workspaceMember.userId, userId));
    if (workspaceIds.length > 0) {
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaceIds));
    }
    await database.delete(schema.oauthAccount).where(eq(schema.oauthAccount.userId, userId));
    await database.delete(schema.user).where(eq(schema.user.id, userId));
  });

  it('reads the account back with its workspace, plan and sessions', async () => {
    const result = await login();
    const session = await resolveSession(result.sessionToken);
    userId = session!.user.id;

    const detail = await getConsoleUser(userId);
    expect(detail).not.toBeNull();
    expect(detail!.email).toBe(profile.email);
    expect(detail!.identities.map((row) => row.provider)).toEqual(['github']);
    expect(detail!.workspaces[0]?.role).toBe('owner');
    expect(detail!.workspaces[0]?.planName).toBe('Free');
    expect(detail!.liveSessions).toBeGreaterThan(0);
  });

  it('refuses a change with no reason, before touching anything', async () => {
    await expect(
      setUserAccountStatus({ actor, userId, status: 'suspended', reason: '   ' }),
    ).rejects.toMatchObject({ code: 'reason_required' });

    const [row] = await db()
      .select({ status: schema.user.status })
      .from(schema.user)
      .where(eq(schema.user.id, userId));
    expect(row!.status).toBe('active');
  });

  it('kills every live web session the moment it suspends', async () => {
    const first = await login();
    const second = await login();
    expect(await resolveSession(first.sessionToken)).not.toBeNull();

    const outcome = await setUserAccountStatus({
      actor,
      userId,
      status: 'suspended',
      reason: 'bulk scraping of public assets',
    });

    expect(outcome.sessionsRevoked).toBeGreaterThanOrEqual(2);
    // requirement.md 3.2: immediately, not at expiry.
    expect(await resolveSession(first.sessionToken)).toBeNull();
    expect(await resolveSession(second.sessionToken)).toBeNull();
  });

  /**
   * requirement.md 3.2, and the contract `isAccountUsable` states: suspension
   * has to stop *every* way the account reaches the platform. `resolveApiKey`
   * checked only `revoked_at`, so a suspended account kept reading its usage
   * and revenue, rewriting its policies and spending its quota through REST
   * and MCP long after its browser sessions were gone.
   */
  it('stops the account’s API keys too, not only its web sessions', async () => {
    const [membership] = await db()
      .select({ workspaceId: schema.workspaceMember.workspaceId })
      .from(schema.workspaceMember)
      .where(eq(schema.workspaceMember.userId, userId));

    const { key } = await createApiKey({
      role: 'owner',
      workspaceId: membership!.workspaceId,
      name: 'suspension probe',
    });

    // Still suspended from the test above.
    await expect(resolveApiKey(`Bearer ${key}`)).rejects.toMatchObject({
      code: 'invalid_api_key',
    });

    await setUserAccountStatus({ actor, userId, status: 'active', reason: 'appeal upheld' });
    const principal = await resolveApiKey(`Bearer ${key}`);
    expect(principal?.workspaceId).toBe(membership!.workspaceId);

    await setUserAccountStatus({
      actor,
      userId,
      status: 'suspended',
      reason: 'bulk scraping of public assets',
    });
    await expect(resolveApiKey(`Bearer ${key}`)).rejects.toMatchObject({
      code: 'invalid_api_key',
    });
  });

  it('writes the operator, the values before and after, and the reason', async () => {
    const [entry] = await db()
      .select({
        action: schema.auditLog.action,
        reason: schema.auditLog.reason,
        beforeValue: schema.auditLog.beforeValue,
        afterValue: schema.auditLog.afterValue,
        result: schema.auditLog.result,
      })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'user'), eq(schema.auditLog.targetId, userId)))
      .orderBy(schema.auditLog.seq);

    expect(entry!.action).toBe('user.suspend');
    expect(entry!.result).toBe('success');
    expect(entry!.reason).toBe('bulk scraping of public assets');
    expect(entry!.beforeValue).toMatchObject({ status: 'active' });
    expect(entry!.afterValue).toMatchObject({ status: 'suspended' });
  });

  it('shows the account under the suspended filter and not under active', async () => {
    const suspended = await listConsoleUsers({ query: profile.email, status: 'suspended' });
    expect(suspended.rows.map((row) => row.id)).toContain(userId);

    const active = await listConsoleUsers({ query: profile.email, status: 'active' });
    expect(active.rows.map((row) => row.id)).not.toContain(userId);
  });

  it('lets the account back in once it is re-enabled', async () => {
    await setUserAccountStatus({
      actor,
      userId,
      status: 'active',
      reason: 'appeal upheld',
    });

    const result = await login();
    expect(await resolveSession(result.sessionToken)).not.toBeNull();
  });

  it('answers null for an id that is not a user, rather than throwing', async () => {
    expect(await getConsoleUser('not-a-uuid')).toBeNull();
    expect(await getConsoleUser(crypto.randomUUID())).toBeNull();
  });

  /**
   * The detail panels stop at 20 rows. The numbers the suspend dialog quotes
   * must not: they are what an operator confirms against, and a count taken
   * from the truncated list would understate what confirming does.
   */
  it('counts sessions past the page the panel shows', async () => {
    const now = new Date();
    const extra = Array.from({ length: 25 }, (_, index) => ({
      id: uuidv7(now.getTime() + index),
      userId,
      tokenHash: `count-probe-${subject}-${index}`,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
    }));
    await db().insert(schema.userSession).values(extra);

    const detail = await getConsoleUser(userId);
    expect(detail!.sessions).toHaveLength(20);
    expect(detail!.sessionTotal).toBeGreaterThanOrEqual(25);
    expect(detail!.liveSessions).toBeGreaterThanOrEqual(25);
  });

  /**
   * `workspace_member` allows more than one row per account, so the list query
   * must not reach it through a join: the account would take two of the page's
   * slots and render twice, while `total` -- which counts `user` -- still
   * counts it once, and the last page would quietly lose accounts.
   */
  it('lists an account once even when it holds several workspace memberships', async () => {
    const secondWorkspaceId = crypto.randomUUID();
    await db().insert(schema.workspace).values({ id: secondWorkspaceId, name: 'Second' });
    await db()
      .insert(schema.workspaceMember)
      .values({ workspaceId: secondWorkspaceId, userId, role: 'admin' });

    const { rows, total } = await listConsoleUsers({ query: profile.email });
    expect(rows.filter((row) => row.id === userId)).toHaveLength(1);
    expect(rows.length).toBeLessThanOrEqual(total);
  });
});
