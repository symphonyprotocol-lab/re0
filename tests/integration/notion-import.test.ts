/**
 * Importing a page from the person's own Notion account, end to end against
 * the database: the grant is stored sealed, the wizard's list is what the
 * grant can read, creation re-reads the chosen page with the same grant and
 * remembers the account on the source, and the build resolves that grant --
 * failing closed once it is gone. A token Notion reports revoked drops the
 * connection.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
/* Only the authorize URL is built here; nothing is exchanged with Notion. */
process.env.NOTION_OAUTH_CLIENT_ID ??= 'test-client-id';

const {
  beginNotionConnect,
  checkNotionImport,
  completeNotionConnect,
  disconnectNotion,
  listImportablePages,
  notionConnectionFor,
  notionTokenFor,
} = await import('@/lib/application/auth');
const { NotionGrantRevoked } = await import('@/lib/infrastructure/identity/notion');
const { createWorkspaceAsset } = await import('@/lib/application/assets');
const { NOTION_SOURCE_USER_KEY } = await import('@/lib/domain/notion');
const { seal, unseal } = await import('@/lib/infrastructure/crypto/sealed');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

type Page = import('@/lib/application/auth').NotionPage;

const TOKEN = 'ntn_test_token_value';
const PAGE_ID = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
const PAGE_URL = 'https://www.notion.so/Handbook-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const OTHER_ID = '9a9b9c9d-9e9f-4a8b-9c0d-1e2f3a4b5c6d';

const pages: Page[] = [
  { id: PAGE_ID, title: 'Handbook', url: PAGE_URL, lastEditedAt: '2026-09-01T00:00:00.000Z', archived: false },
];

/** Notion, as far as these tests need it: the token must be the one on file. */
function reader(options: { revoked?: boolean } = {}) {
  const guard = (token: string) => {
    if (options.revoked) throw new NotionGrantRevoked();
    if (token !== TOKEN) throw new Error(`unexpected token ${token}`);
  };
  return {
    async listAccessiblePages(token: string) {
      guard(token);
      return pages;
    },
    async readPage(token: string, pageId: string) {
      guard(token);
      return pages.find((page) => page.id === pageId) ?? null;
    },
  };
}

const users: string[] = [];
const workspaces: string[] = [];
const assets: string[] = [];
const planVersions: string[] = [];

async function account(): Promise<string> {
  const userId = uuidv7();
  users.push(userId);
  await db().insert(schema.user).values({
    id: userId,
    email: `notion-import-${userId}@example.test`,
    displayName: 'Noto',
    avatarUrl: null,
    status: 'active',
  });
  return userId;
}

async function workspaceOnPlan(): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'notion-import-test' });
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

const GRANT = {
  accessToken: TOKEN,
  botId: 'bot-1',
  workspaceId: 'ws-1',
  workspaceName: 'Acme',
  notionUserId: 'nu-1',
  ownerName: 'Noto',
};

/** The consent round trip with a fake exchange: begin, then complete with the state the cookie carries. */
async function connect(userId: string, grant = GRANT) {
  const started = await beginNotionConnect({
    returnTo: '/dashboard/assets/new',
    redirectUri: 'http://localhost:3000/api/auth/notion/callback/connect',
  });
  expect(started.redirectUrl).toContain('https://api.notion.com/v1/oauth/authorize?');
  expect(started.redirectUrl).toContain('owner=user');
  const handshake = await unseal<{ state: string }>(started.handshake);
  return completeNotionConnect({
    userId,
    code: 'code',
    state: handshake!.state,
    sealedHandshake: started.handshake,
    redirectUri: 'http://localhost:3000/api/auth/notion/callback/connect',
    exchange: async () => grant,
  });
}

describeWithDb('notion page import', () => {
  afterAll(async () => {
    const database = db();
    if (assets.length > 0) {
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
    if (users.length > 0) {
      await database.delete(schema.notionConnection).where(inArray(schema.notionConnection.userId, users));
      await database.delete(schema.user).where(inArray(schema.user.id, users));
    }
  });

  it('refuses to import before the account is connected', async () => {
    const userId = await account();
    expect(await notionConnectionFor(userId)).toBeNull();
    expect(await notionTokenFor(userId)).toBeNull();
    expect(await listImportablePages(userId, reader())).toEqual({ connected: false });
    await expect(checkNotionImport({ userId, location: PAGE_URL }, reader())).rejects.toMatchObject({
      code: 'claim_verification_failed',
      reason: 'account_not_linked',
      refusal: 'not_connected',
    });
  });

  it('stores the grant sealed, lists what it can read, and re-checks at create', async () => {
    const userId = await account();
    const workspaceId = await workspaceOnPlan();

    /* The handshake is verified the way login's is. */
    await expect(
      completeNotionConnect({
        userId,
        code: 'code',
        state: 'wrong',
        sealedHandshake: await seal({ purpose: 'notion_connect', state: 'right', returnTo: '/dashboard', expiresAt: Date.now() + 60_000 }),
        redirectUri: 'x',
        exchange: async () => GRANT,
      }),
    ).rejects.toMatchObject({ loginError: 'oauth_failed' });

    const connected = await connect(userId);
    expect(connected).toEqual({ workspaceName: 'Acme', returnTo: '/dashboard/assets/new' });

    /* Sealed at rest: the token is not in the row, and reading it back needs the key. */
    const [row] = await db().select().from(schema.notionConnection).where(eq(schema.notionConnection.userId, userId));
    expect(row?.botId).toBe('bot-1');
    expect(row?.tokenSealed).not.toContain(TOKEN);
    expect(await unseal<string>(row!.tokenSealed)).toBe(TOKEN);
    expect((await notionConnectionFor(userId))?.workspaceName).toBe('Acme');
    expect(await notionTokenFor(userId)).toBe(TOKEN);

    /* Reconnecting replaces rather than adds. */
    await connect(userId, { ...GRANT, workspaceName: 'Acme renamed' });
    const rows = await db().select().from(schema.notionConnection).where(eq(schema.notionConnection.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspaceName).toBe('Acme renamed');

    const listed = await listImportablePages(userId, reader());
    expect(listed.connected).toBe(true);
    if (listed.connected) expect(listed.pages.map((page) => page.title)).toEqual(['Handbook']);

    const attempt = (location: string) =>
      createWorkspaceAsset({
        role: 'owner',
        workspaceId,
        userId,
        title: 'Handbook',
        rights: { origin: 'own', license: 'open_source', generation: 'human' },
        sourceType: 'notion',
        location,
        slug: 'handbook',
        checkPage: (input) => checkNotionImport(input, reader()),
      });

    /* A page the grant cannot see, and a URL that names no page at all. */
    await expect(attempt(`https://www.notion.so/${OTHER_ID}`)).rejects.toMatchObject({ refusal: 'not_found', reason: 'source_mismatch' });
    await expect(attempt('https://www.notion.so/acme/no-id-here')).rejects.toMatchObject({ refusal: 'not_found' });
    /* No account at all on the call: refused before anything is read. */
    await expect(
      createWorkspaceAsset({ role: 'owner', workspaceId, title: 'x', rights: { origin: 'own', license: 'open_source', generation: 'human' }, sourceType: 'notion', location: PAGE_URL, slug: 'x' }),
    ).rejects.toMatchObject({ code: 'access_denied' });

    /* The one that passes: location from Notion's spelling, the account on the source. */
    const created = await attempt(`https://acme.notion.site/${PAGE_ID.replace(/-/g, '')}`);
    assets.push(created.assetId);
    expect(created.publicId).toBe('/notion/handbook');
    expect(created.operationId).not.toBeNull();
    const [source] = await db().select().from(schema.source).where(eq(schema.source.assetId, created.assetId));
    expect(source?.location).toBe(PAGE_URL);
    expect(source?.config).toEqual({ pageId: PAGE_ID, [NOTION_SOURCE_USER_KEY]: userId });
  });

  it('forgets a grant Notion reports revoked, and disconnecting removes it', async () => {
    const userId = await account();
    await connect(userId);
    expect(await listImportablePages(userId, reader({ revoked: true }))).toEqual({ connected: false });
    expect(await notionConnectionFor(userId)).toBeNull();

    await connect(userId);
    await expect(checkNotionImport({ userId, location: PAGE_URL }, reader({ revoked: true }))).rejects.toMatchObject({ refusal: 'not_connected' });
    expect(await notionConnectionFor(userId)).toBeNull();

    await connect(userId);
    await disconnectNotion(userId);
    expect(await notionTokenFor(userId)).toBeNull();
  });
});
