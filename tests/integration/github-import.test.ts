/**
 * Importing a repository from the person's own GitHub account, end to end
 * against the database: the grant is stored sealed, the wizard's list holds
 * only importable repositories, and creation re-checks the chosen one with
 * the same grant -- refusing forks, private repositories, other people's
 * repositories and an account that never connected. A token GitHub reports
 * revoked drops the connection.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
/* Only the authorize URL is built here; nothing is exchanged with GitHub. */
process.env.GITHUB_OAUTH_CLIENT_ID ??= 'test-client-id';

const {
  beginGithubConnect,
  checkGithubImport,
  completeGithubConnect,
  githubConnectionFor,
  listImportableRepositories,
} = await import('@/lib/application/auth');
const { GithubGrantRevoked } = await import('@/lib/infrastructure/identity/github');
const { createWorkspaceLibrary } = await import('@/lib/application/libraries');
const { seal, unseal } = await import('@/lib/infrastructure/crypto/sealed');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

type Repository = import('@/lib/application/auth').GithubRepository;

const ACCOUNT = '424242';
const TOKEN = 'gho_test_token_value';

const repositories: Repository[] = [
  { id: 1, name: 'Docs', fullName: 'Octocat/Docs', description: 'the docs', defaultBranch: 'main', pushedAt: null, ownerId: 424242, private: false, fork: false, archived: false, permission: 'admin' },
  { id: 2, name: 'forked', fullName: 'octocat/forked', description: null, defaultBranch: 'main', pushedAt: null, ownerId: 424242, private: false, fork: true, archived: false, permission: 'admin' },
  { id: 3, name: 'secret', fullName: 'octocat/secret', description: null, defaultBranch: 'main', pushedAt: null, ownerId: 424242, private: true, fork: false, archived: false, permission: 'admin' },
  { id: 4, name: 'else', fullName: 'someone/else', description: null, defaultBranch: 'main', pushedAt: null, ownerId: 7, private: false, fork: false, archived: false, permission: 'write' },
  { id: 5, name: 'handbook', fullName: 'acme/handbook', description: null, defaultBranch: 'main', pushedAt: null, ownerId: 9000, private: false, fork: false, archived: false, permission: 'maintain' },
];

/** GitHub, as far as these tests need it: the token must be the one on file. */
function reader(options: { revoked?: boolean } = {}) {
  const guard = (token: string) => {
    if (options.revoked) throw new GithubGrantRevoked();
    if (token !== TOKEN) throw new Error(`unexpected token ${token}`);
  };
  return {
    async listOwnedPublicRepositories(token: string) {
      guard(token);
      /* GitHub's own filters: owned or member-of, public. */
      return repositories.filter((repository) => !repository.private);
    },
    async readRepository(token: string, location: string) {
      guard(token);
      return repositories.find((r) => r.fullName.toLowerCase() === location.toLowerCase()) ?? null;
    },
  };
}

const users: string[] = [];
const workspaces: string[] = [];
const libraries: string[] = [];
const planVersions: string[] = [];

async function account(): Promise<string> {
  const userId = uuidv7();
  users.push(userId);
  await db().insert(schema.user).values({
    id: userId,
    email: `github-import-${userId}@example.test`,
    displayName: 'Octo',
    avatarUrl: null,
    status: 'active',
  });
  return userId;
}

async function workspaceOnPlan(): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'github-import-test' });
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'free',
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls: 1_000,
    apiKeyLimit: 5,
    capabilities: {},
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  await database.insert(schema.subscription).values({
    id: uuidv7(),
    workspaceId,
    planVersionId,
    status: 'active',
    periodStart: new Date(Date.now() - 86_400_000),
    periodEnd: new Date(Date.now() + 86_400_000),
  });
  return workspaceId;
}

/** The consent round trip with a fake exchange: begin, then complete with the state the cookie carries. */
async function connect(userId: string, grant = { accessToken: TOKEN, scope: 'read:user read:org', githubUserId: ACCOUNT, login: 'octocat' }) {
  const started = await beginGithubConnect({
    returnTo: '/dashboard/libraries/new',
    redirectUri: 'http://localhost:3000/api/auth/github/callback/connect',
  });
  const handshake = await unseal<{ state: string }>(started.handshake);
  return completeGithubConnect({
    userId,
    code: 'code',
    state: handshake!.state,
    sealedHandshake: started.handshake,
    redirectUri: 'http://localhost:3000/api/auth/github/callback/connect',
    exchange: async () => grant,
  });
}

describeWithDb('github repository import', () => {
  afterAll(async () => {
    const database = db();
    if (libraries.length > 0) {
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.libraryId, libraries));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, libraries));
      await database.delete(schema.library).where(inArray(schema.library.id, libraries));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
    if (users.length > 0) {
      await database.delete(schema.githubConnection).where(inArray(schema.githubConnection.userId, users));
      await database.delete(schema.user).where(inArray(schema.user.id, users));
    }
  });

  it('refuses to import before the account is connected', async () => {
    const userId = await account();
    expect(await githubConnectionFor(userId)).toBeNull();
    expect(await listImportableRepositories(userId, reader())).toEqual({ connected: false });
    await expect(checkGithubImport({ userId, location: 'octocat/docs' }, reader())).rejects.toMatchObject({
      code: 'claim_verification_failed',
      reason: 'account_not_linked',
      refusal: 'not_connected',
    });
  });

  it('stores the grant sealed, lists only importable repositories, and re-checks at create', async () => {
    const userId = await account();
    const workspaceId = await workspaceOnPlan();

    /* The handshake is verified the way login's is. */
    await expect(
      completeGithubConnect({
        userId,
        code: 'code',
        state: 'wrong',
        sealedHandshake: await seal({ purpose: 'github_connect', state: 'right', returnTo: '/dashboard', expiresAt: Date.now() + 60_000 }),
        redirectUri: 'x',
        exchange: async () => ({ accessToken: TOKEN, scope: '', githubUserId: ACCOUNT, login: 'octocat' }),
      }),
    ).rejects.toMatchObject({ loginError: 'oauth_failed' });

    const connected = await connect(userId);
    expect(connected).toEqual({ login: 'octocat', returnTo: '/dashboard/libraries/new' });

    /* Sealed at rest: the token is not in the row, and reading it back needs the key. */
    const [row] = await db().select().from(schema.githubConnection).where(eq(schema.githubConnection.userId, userId));
    expect(row?.githubUserId).toBe(ACCOUNT);
    expect(row?.tokenSealed).not.toContain(TOKEN);
    expect(await unseal<string>(row!.tokenSealed)).toBe(TOKEN);
    expect((await githubConnectionFor(userId))?.login).toBe('octocat');

    /* Reconnecting replaces rather than adds. */
    await connect(userId, { accessToken: TOKEN, scope: 'read:user read:org', githubUserId: ACCOUNT, login: 'octocat-renamed' });
    const rows = await db().select().from(schema.githubConnection).where(eq(schema.githubConnection.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.login).toBe('octocat-renamed');

    /* The wizard's list: the fork is out, the private one GitHub already withheld. */
    const listed = await listImportableRepositories(userId, reader());
    expect(listed.connected).toBe(true);
    if (listed.connected) expect(listed.repositories.map((r) => r.fullName)).toEqual(['Octocat/Docs', 'acme/handbook']);

    const attempt = (location: string) =>
      createWorkspaceLibrary({
        role: 'owner',
        workspaceId,
        userId,
        title: 'Repo docs',
        visibility: 'public',
        rights: { origin: 'own', license: 'open_source', generation: 'human' },
        sourceType: 'github',
        location,
        slug: '',
        checkRepository: (input) => checkGithubImport(input, reader()),
      });

    await expect(attempt('octocat/forked')).rejects.toMatchObject({ refusal: 'fork', reason: 'insufficient_permission' });
    await expect(attempt('octocat/secret')).rejects.toMatchObject({ refusal: 'private' });
    await expect(attempt('someone/else')).rejects.toMatchObject({ refusal: 'not_owner' });
    await expect(attempt('octocat/missing')).rejects.toMatchObject({ refusal: 'not_found', reason: 'source_mismatch' });
    /* No account at all on the call: refused before anything is read. */
    await expect(
      createWorkspaceLibrary({ role: 'owner', workspaceId, title: 'x', visibility: 'public', rights: { origin: 'own', license: 'open_source', generation: 'human' }, sourceType: 'github', location: 'octocat/docs', slug: '' }),
    ).rejects.toMatchObject({ code: 'access_denied' });

    /* The one that passes: id from GitHub's spelling, repository id on the source. */
    const created = await attempt('octocat/docs');
    libraries.push(created.libraryId);
    /* The id follows GitHub's spelling of the name, not the form post's. */
    expect(created.publicId).toBe('/Octocat/Docs');
    expect(created.operationId).not.toBeNull();
    const [source] = await db().select().from(schema.source).where(eq(schema.source.libraryId, created.libraryId));
    expect(source?.location).toBe('Octocat/Docs');
    expect(source?.config).toEqual({ repositoryId: 1 });
  });

  it('treats a grant taken with fewer scopes as not connected', async () => {
    const userId = await account();
    await connect(userId, { accessToken: TOKEN, scope: 'read:user', githubUserId: ACCOUNT, login: 'octocat' });
    expect(await listImportableRepositories(userId, reader())).toEqual({ connected: false });
    await expect(checkGithubImport({ userId, location: 'octocat/docs' }, reader())).rejects.toMatchObject({ refusal: 'not_connected' });
    /* Consent again with the full scope, and the same row is what gets replaced. */
    await connect(userId);
    expect((await listImportableRepositories(userId, reader())).connected).toBe(true);
  });

  it('forgets a grant GitHub reports revoked', async () => {
    const userId = await account();
    await connect(userId);
    expect(await listImportableRepositories(userId, reader({ revoked: true }))).toEqual({ connected: false });
    expect(await githubConnectionFor(userId)).toBeNull();

    await connect(userId);
    await expect(checkGithubImport({ userId, location: 'octocat/docs' }, reader({ revoked: true }))).rejects.toMatchObject({ refusal: 'not_connected' });
    expect(await githubConnectionFor(userId)).toBeNull();
  });
});
