/**
 * The website widget, against a real database. requirement.md 9.4.
 *
 * A site key is public, so the two things this file pins down are the two
 * brakes that stand in for secrecy: the widget page is served with a
 * frame-ancestors header naming exactly the owner's origins and refuses any
 * other parent, and the ask route stops spending the workspace's quota once
 * the key's daily limit is reached. In between, a question from an allowed
 * site reaches the owner's *private* asset and comes back as passages with
 * the pages to open -- without an LLM configured, which is the search-only
 * shape of the widget.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { and, eq, inArray, sql } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.APP_BASE_URL ??= 'https://app.example.test';

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { createPlatformAsset } = await import(
  '@/lib/application/administration/manage-platform-assets'
);
const {
  createSiteKey,
  deleteFaqEntry,
  listFaqEntries,
  listFaqGroups,
  listSiteKeys,
  listWidgetExchanges,
  listWorkspaceWidgetSites,
  saveFaqEntry,
  widgetExchangeStats,
  recordWidgetOrigin,
  revokeSiteKey,
  SiteKeyInvalid,
  updateSiteKey,
} = await import('@/lib/application/embed');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { sessionTokenHash } = await import('@/lib/application/auth/session-token');
const { GET: embedPage } = await import('@/app/embed/route');
const { POST: askRoute } = await import('@/app/api/embed/ask/route');
const { surfaceEnabled } = await import('@/lib/domain/surfaces');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const assets: string[] = [];
const workspaces: string[] = [];
const users: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();

const SITE = 'https://shop.example.test';
const LOCAL = 'http://localhost:3000';

function dependencies() {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/returns.md',
            url: 'https://shop.example.test/help/returns',
            content:
              '# Returns\n\nA zugwidget can be returned within thirty days of delivery with the original receipt.',
          },
        ],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          folders: [],
          excludeFolders: [],
          excludeFiles: [],
          rules: [],
        },
        revision: 'fixture-revision',
        lastModifiedAt: new Date(),
        hasLicense: true,
        stale: false,
      };
    },
    embeddings: () => ({
      model: 'fixture-embed-1',
      dimensions: EMBEDDING_COLUMN_DIMENSIONS,
      async embed(texts: string[]) {
        return texts.map((text) =>
          Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17),
        );
      },
    }),
    store: () => store,
    configured: () => ({ embeddings: true, storage: true }),
  };
}

async function workspaceOnPlan(
  monthlyCalls = 1_000,
  capabilities: Record<string, unknown> = {},
): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'widget-test' });
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'free',
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls,
    apiKeyLimit: 5,
    capabilities,
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

/** A dashboard session of a new owner of `workspaceId`: the cookie its requests carry. */
async function signedInOwner(workspaceId: string): Promise<string> {
  const database = db();
  const userId = uuidv7();
  users.push(userId);
  await database.insert(schema.user).values({
    id: userId,
    email: `owner-${userId}@example.test`,
    displayName: 'Owner',
    status: 'active',
  });
  await database.insert(schema.workspaceMember).values({ workspaceId, userId, role: 'owner' });
  const token = `widget-preview-${crypto.randomUUID()}`;
  await database.insert(schema.userSession).values({
    id: uuidv7(),
    userId,
    tokenHash: await sessionTokenHash(token),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return `r0_session=${token}`;
}

/** A built, published, *private* asset owned by the workspace. */
async function ownedAsset(workspaceId: string, slug: string): Promise<string> {
  const { assetId } = await createPlatformAsset({
    actor,
    title: `Shop help ${slug}`,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://shop.example.test/${slug}`,
    refreshPolicy: 'manual',
    language: 'en',
    reason: 'integration test fixture',
  });
  assets.push(assetId);
  const built = await buildVersion({ assetId, operationId: uuidv7(), dependencies: dependencies() });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ assetId, versionId: built.versionId });
  await db()
    .update(schema.asset)
    .set({
      lifecycleStatus: 'published',
      isPlatformAsset: false,
      ownerWorkspaceId: workspaceId,
    })
    .where(eq(schema.asset.id, assetId));
  return assetId;
}

function page(key: string | null, parent: string | null, cookie?: string): NextRequest {
  const url = new URL('https://app.example.test/embed');
  if (key) url.searchParams.set('key', key);
  if (parent) url.searchParams.set('parent', parent);
  url.searchParams.set('lang', 'en');
  return new NextRequest(url, { headers: cookie ? { cookie } : {} });
}

function ask(body: unknown, origin?: string, cookie?: string): NextRequest {
  return new NextRequest('https://app.example.test/api/embed/ask', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function lines(response: Response): Promise<{ type: string; [key: string]: unknown }[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { type: string });
}

/*
 * The widget is offline (agent-first-proposal.md 3.6, lib/domain/surfaces.ts):
 * its routes answer 404 and the tests that drive them wait behind the switch.
 * Key management itself still works, so those cases run regardless.
 */
const whileOn = surfaceEnabled('widget') ? it : it.skip;

describeWithDb('website widget', () => {
  it('answers 404 from every widget route while the surface is off', async () => {
    if (surfaceEnabled('widget')) return;
    const page = await embedPage(new NextRequest('https://api.example.test/embed?key=mm_site_x&parent=https%3A%2F%2Fexample.test'));
    expect(page.status).toBe(404);
    const ask = await askRoute(
      new NextRequest('https://api.example.test/api/embed/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'mm_site_x', question: 'hello' }),
      }),
    );
    expect(ask.status).toBe(404);
  });

  afterAll(async () => {
    const database = db();
    if (assets.length > 0) {
      await database.delete(schema.widgetExchange).where(inArray(schema.widgetExchange.assetId, assets));
      await database.delete(schema.assetFaq).where(inArray(schema.assetFaq.assetId, assets));
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.assetId, assets));
      await database.delete(schema.siteKey).where(inArray(schema.siteKey.assetId, assets));
      await database
        .update(schema.asset)
        .set({ currentVersionId: null })
        .where(inArray(schema.asset.id, assets));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.assetId, assets));
      await database
        .delete(schema.assetProfileVector)
        .where(inArray(schema.assetProfileVector.assetId, assets));
      await database
        .delete(schema.assetProfile)
        .where(inArray(schema.assetProfile.assetId, assets));
      await database.delete(schema.chunk).where(inArray(schema.chunk.assetId, assets));
      await database.delete(schema.document).where(inArray(schema.document.assetId, assets));
      await database
        .delete(schema.assetVersion)
        .where(inArray(schema.assetVersion.assetId, assets));
      await database.delete(schema.assetScore).where(inArray(schema.assetScore.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.delete(schema.assetAlias).where(inArray(schema.assetAlias.assetId, assets));
      await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, assets));
      /* Again, last: an exchange is recorded off the request path and may land after the first sweep. */
      await database.delete(schema.widgetExchange).where(inArray(schema.widgetExchange.assetId, assets));
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
    }
    if (users.length > 0) {
      await database.delete(schema.userSession).where(inArray(schema.userSession.userId, users));
      await database.delete(schema.workspaceMember).where(inArray(schema.workspaceMember.userId, users));
      await database.delete(schema.user).where(inArray(schema.user.id, users));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.requestLog).where(inArray(schema.requestLog.workspaceId, workspaces));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database
        .delete(schema.usageReservation)
        .where(inArray(schema.usageReservation.workspaceId, workspaces));
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('holds a workspace to its plan’s site keys across assets, and frees the slot on revoke', async () => {
    /* A Free-shaped cap on the version: one key for the whole workspace. */
    const workspaceId = await workspaceOnPlan(1_000, { siteKeys: 1 });
    const first = await ownedAsset(workspaceId, `widget-cap-a-${Date.now()}`);
    const second = await ownedAsset(workspaceId, `widget-cap-b-${Date.now()}`);

    const held = await createSiteKey({ workspaceId, role: 'owner', assetId: first, name: 'One', origins: SITE });
    await expect(
      createSiteKey({ workspaceId, role: 'owner', assetId: second, name: 'Two', origins: SITE }),
    ).rejects.toMatchObject({ code: 'api_key_limit_exceeded', ceiling: 'plan' });

    await revokeSiteKey({ workspaceId, role: 'owner', siteKeyId: held.id });
    await expect(
      createSiteKey({ workspaceId, role: 'owner', assetId: second, name: 'Two', origins: SITE }),
    ).resolves.toMatchObject({ name: 'Two' });

    /* A version with the cap lifted: the per-asset ceiling is the only one left. */
    const uncapped = await workspaceOnPlan(1_000, { siteKeys: -1 });
    const asset = await ownedAsset(uncapped, `widget-cap-uncapped-${Date.now()}`);
    for (const name of ['a', 'b']) {
      await createSiteKey({ workspaceId: uncapped, role: 'owner', assetId: asset, name, origins: SITE });
    }
    expect((await listSiteKeys({ workspaceId: uncapped, assetId: asset })).length).toBe(2);
  });

  it('mints a key the owner can read back, and refuses bad settings by field', async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-mint-${Date.now()}`);

    const created = await createSiteKey({
      workspaceId,
      role: 'owner',
      assetId,
      name: 'Production',
      origins: `${SITE}\n${LOCAL}`,
      dailyLimit: '50',
      welcome: '  Hi there  ',
      accent: '#112233',
    });
    expect(created.key.startsWith('mm_site_')).toBe(true);
    expect(created.allowedOrigins).toEqual([SITE, LOCAL]);
    expect(created.dailyLimit).toBe(50);
    expect(created.welcome).toBe('Hi there');

    const listed = await listSiteKeys({ workspaceId, assetId });
    expect(listed.map((key) => key.key)).toEqual([created.key]);

    await expect(
      createSiteKey({ workspaceId, role: 'owner', assetId, name: 'x', origins: 'shop.example.test' }),
    ).rejects.toMatchObject({ field: 'origins_invalid' });
    await expect(
      createSiteKey({ workspaceId, role: 'owner', assetId, name: 'x', origins: SITE, dailyLimit: '0' }),
    ).rejects.toBeInstanceOf(SiteKeyInvalid);
    /* A developer may use the widget, not mint its key. */
    await expect(
      createSiteKey({ workspaceId, role: 'developer', assetId, name: 'x', origins: SITE }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    /* Nor may another workspace mint one for this asset. */
    const other = await workspaceOnPlan();
    await expect(
      createSiteKey({ workspaceId: other, role: 'owner', assetId, name: 'x', origins: SITE }),
    ).rejects.toMatchObject({ code: 'asset_not_found' });

    const updated = await updateSiteKey({
      workspaceId,
      role: 'owner',
      siteKeyId: created.id,
      name: 'Production',
      origins: SITE,
      dailyLimit: '10',
    });
    expect(updated.key).toBe(created.key);
    expect(updated.allowedOrigins).toEqual([SITE]);
    expect(updated.dailyLimit).toBe(10);

    /* A blank limit or colour on edit keeps the row's own, never the default. */
    const kept = await updateSiteKey({
      workspaceId,
      role: 'owner',
      siteKeyId: created.id,
      name: 'Production',
      origins: SITE,
      dailyLimit: '',
      accent: '',
    });
    expect(kept.dailyLimit).toBe(10);
    expect(kept.accent).toBe('#112233');
  });

  whileOn('serves the widget page only to listed parents, with the header that enforces it', async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-page-${Date.now()}`);
    const key = await createSiteKey({
      workspaceId,
      role: 'owner',
      assetId,
      name: 'Site',
      origins: `${SITE}\n${LOCAL}`,
      welcome: 'Welcome to the shop',
    });

    const allowed = await embedPage(page(key.key, SITE));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-security-policy')).toBe(`frame-ancestors ${SITE} ${LOCAL}`);
    const html = await allowed.text();
    expect(html).toContain('Welcome to the shop');
    expect(html).toContain('/embed-app.js');
    expect(html).toContain(`"parent":"${SITE}"`);

    /* The header is the owner's list whatever the loader claims. */
    const refused = await embedPage(page(key.key, 'https://evil.example.test'));
    expect(refused.status).toBe(403);
    expect(refused.headers.get('content-security-policy')).toBe(`frame-ancestors ${SITE} ${LOCAL}`);

    const unknown = await embedPage(page(`mm_site_${'0'.repeat(32)}`, SITE));
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");

    await revokeSiteKey({ workspaceId, role: 'owner', siteKeyId: key.id });
    expect((await embedPage(page(key.key, SITE))).status).toBe(404);
    expect(await listSiteKeys({ workspaceId, assetId })).toEqual([]);
  });

  whileOn('answers from the private asset with pages to open, as the workspace', async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-ask-${Date.now()}`);
    const key = await createSiteKey({
      workspaceId,
      role: 'owner',
      assetId,
      name: 'Site',
      origins: SITE,
    });

    const response = await askRoute(
      ask({ key: key.key, parent: SITE, question: 'how do I return a zugwidget' }, SITE),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const parts = await lines(response);
    expect(parts[0]).toMatchObject({ type: 'allowance', limit: 200, remaining: 199 });
    const sources = parts.find((part) => part.type === 'sources') as
      | { sources: { url: string; title: string; chunkIds: string[] }[] }
      | undefined;
    expect(sources?.sources[0]?.url).toBe('https://shop.example.test/help/returns');
    /* Pages, not passages: one card per URL, carrying every chunk of it. */
    expect(new Set(sources?.sources.map((source) => source.url)).size).toBe(sources?.sources.length);
    expect(sources?.sources[0]?.chunkIds.length).toBeGreaterThanOrEqual(1);
    /* No LLM in the test database: passages and a degraded note, no claims. */
    expect(parts.find((part) => part.type === 'outcome')).toMatchObject({ kind: 'degraded' });
    expect(parts.filter((part) => part.type === 'claim')).toHaveLength(0);

    /* The Call was the workspace's. */
    const [event] = await db()
      .select({ workspaceId: schema.usageEvent.workspaceId })
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.assetId, assetId))
      .limit(1);
    expect(event?.workspaceId).toBe(workspaceId);

    /* A parent the owner did not list is refused before anything is spent. */
    const elsewhere = await askRoute(
      ask({ key: key.key, parent: 'https://evil.example.test', question: 'returns' }),
    );
    expect(elsewhere.status).toBe(403);
    /* So is a browser Origin that is neither this deployment nor the site. */
    const spoofed = await askRoute(
      ask({ key: key.key, parent: SITE, question: 'returns' }, 'https://evil.example.test'),
    );
    expect(spoofed.status).toBe(403);
    const unknown = await askRoute(ask({ key: 'mm_site_nope', parent: SITE, question: 'returns' }));
    expect(unknown.status).toBe(401);
    const empty = await askRoute(ask({ key: key.key, parent: SITE, question: '' }));
    expect(empty.status).toBe(400);
  });

  whileOn('tells the owner which allowed sites have actually loaded the widget', async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-sites-${Date.now()}`);
    const key = await createSiteKey({
      workspaceId,
      role: 'owner',
      assetId,
      name: 'Shop',
      origins: `${SITE}\n${LOCAL}`,
    });

    /* Allowed, nothing seen yet: both origins are listed as waiting. */
    const before = await listWorkspaceWidgetSites(workspaceId);
    expect(before).toHaveLength(1);
    expect(before[0]?.asset.title).toContain('Shop help');
    expect(before[0]?.asset.ready).toBe(true);
    expect(before[0]?.origins.map((origin) => [origin.origin, origin.lastSeenAt])).toEqual([
      [SITE, null],
      [LOCAL, null],
    ]);

    /* The page served to the shop, and a question asked from it, leave marks. */
    expect((await embedPage(page(key.key, SITE))).status).toBe(200);
    expect((await askRoute(ask({ key: key.key, parent: SITE, question: 'returns' }, SITE))).status).toBe(200);
    /* The marks are written off the request path; give them a moment. */
    let shop = before[0]?.origins[0];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      shop = (await listWorkspaceWidgetSites(workspaceId))[0]?.origins.find((origin) => origin.origin === SITE);
      if (shop && shop.loads >= 1 && shop.questions >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(shop).toMatchObject({ origin: SITE, loads: 1, questions: 1 });
    expect(shop?.firstSeenAt).not.toBeNull();

    /* A refused parent leaves no mark: the browser never shows it the widget. */
    expect((await embedPage(page(key.key, 'https://evil.example.test'))).status).toBe(403);
    await recordWidgetOrigin(key.id, LOCAL, 'load');
    await recordWidgetOrigin(key.id, LOCAL, 'load');
    const after = await listWorkspaceWidgetSites(workspaceId);
    expect(after[0]?.origins).toHaveLength(2);
    expect(after[0]?.origins[1]).toMatchObject({ origin: LOCAL, loads: 2, questions: 0 });

    /* An origin taken off the allowlist is no longer an integrated site. */
    await updateSiteKey({ workspaceId, role: 'owner', siteKeyId: key.id, name: 'Shop', origins: SITE });
    expect((await listWorkspaceWidgetSites(workspaceId))[0]?.origins.map((o) => o.origin)).toEqual([SITE]);

    /* A revoked key takes its sites with it. */
    await revokeSiteKey({ workspaceId, role: 'owner', siteKeyId: key.id });
    expect(await listWorkspaceWidgetSites(workspaceId)).toEqual([]);
  });

  whileOn('lets the owner try the widget from the dashboard, and nobody else', async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-preview-${Date.now()}`);
    const key = await createSiteKey({ workspaceId, role: 'owner', assetId, name: 'Site', origins: SITE });
    const APP = 'https://app.example.test';

    /* The app's own origin is not on the list: anonymous, it is refused like any other. */
    const anonymous = await embedPage(page(key.key, APP));
    expect(anonymous.status).toBe(403);
    expect(anonymous.headers.get('content-security-policy')).toBe(`frame-ancestors ${SITE}`);

    /* Another workspace's owner is refused too: the session must own the key. */
    const stranger = await signedInOwner(await workspaceOnPlan());
    expect((await embedPage(page(key.key, APP, stranger))).status).toBe(403);

    /* The key's own owner gets the page, framed by this origin as well. */
    const owner = await signedInOwner(workspaceId);
    const preview = await embedPage(page(key.key, APP, owner));
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-security-policy')).toBe(`frame-ancestors ${SITE} 'self'`);
    const html = await preview.text();
    expect(html).toContain(`"parent":"${APP}"`);
    expect(html).toContain('"preview":true');

    /* Questions from the preview are answered as a visitor's would be. */
    const answered = await askRoute(ask({ key: key.key, parent: APP, question: 'returns' }, APP, owner));
    expect(answered.status).toBe(200);
    expect((await lines(answered))[0]).toMatchObject({ type: 'allowance' });
    expect((await askRoute(ask({ key: key.key, parent: APP, question: 'returns' }, APP))).status).toBe(403);
    expect((await askRoute(ask({ key: key.key, parent: APP, question: 'returns' }, APP, stranger))).status).toBe(403);

    /* The owner's own try-out is not an integrated site. */
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sites = await listWorkspaceWidgetSites(workspaceId);
    expect(sites[0]?.origins.map((origin) => origin.origin)).toEqual([SITE]);
    expect(sites[0]?.origins[0]?.lastSeenAt).toBeNull();

    /* But it is in the asset's history, marked as the owner's preview. */
    const history = await listWidgetExchanges({ workspaceId, assetId });
    expect(history.total).toBe(1);
    expect(history.exchanges[0]).toMatchObject({
      origin: APP,
      preview: true,
      question: 'returns',
      outcome: 'degraded',
    });
    expect(history.exchanges[0]?.sources[0]?.url).toBe('https://shop.example.test/help/returns');
    /* Previews do not count as visitors' questions. */
    expect(await widgetExchangeStats({ workspaceId, assetId })).toMatchObject({ questions: 0, missed: 0 });
    /* Another workspace reads nothing of it. */
    expect((await listWidgetExchanges({ workspaceId: await workspaceOnPlan(), assetId })).total).toBe(0);
  });

  whileOn("keeps what visitors asked, and counts the questions the asset could not answer", async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-history-${Date.now()}`);
    const key = await createSiteKey({ workspaceId, role: 'owner', assetId, name: 'Site', origins: SITE });

    const answered = await askRoute(ask({ key: key.key, parent: SITE, question: 'how do I return a zugwidget' }, SITE));
    expect(answered.status).toBe(200);
    /* Read to the end: the exchange is recorded once its stream has ended. No
       model in the test database, so passages come back -- degraded, not a miss. */
    await lines(answered);
    await db().update(schema.asset).set({ lifecycleStatus: 'suspended' }).where(eq(schema.asset.id, assetId));
    const paused = await askRoute(ask({ key: key.key, parent: SITE, question: 'opening hours' }, SITE));
    expect(paused.status).toBe(200);
    await lines(paused);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const history = await listWidgetExchanges({ workspaceId, assetId });
    expect(history.exchanges.map((exchange) => [exchange.question, exchange.outcome])).toEqual([
      ['opening hours', 'not_ready'],
      ['how do I return a zugwidget', 'degraded'],
    ]);
    expect(history.exchanges[1]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(await widgetExchangeStats({ workspaceId, assetId })).toMatchObject({
      questions: 2,
      answered: 1,
      missed: 1,
    });
  });

  whileOn("builds the owner's FAQ into the asset and groups what visitors asked", async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-faq-${Date.now()}`);
    const key = await createSiteKey({ workspaceId, role: 'owner', assetId, name: 'Site', origins: SITE });
    for (const question of ['Can I return a zugwidget?', 'can i return a zugwidget', 'opening hours']) {
      await lines(await askRoute(ask({ key: key.key, parent: SITE, question }, SITE)));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    /* Grouped by text when no embedding provider is there to group by meaning. */
    const textOnly = {
      configured: async () => ({ embeddings: false, rerank: false }),
      embeddings: () => {
        throw new Error('not configured');
      },
    };
    const groups = await listFaqGroups({ workspaceId, assetId, dependencies: textOnly });
    expect(groups.map((group) => [group.question, group.count, group.covered])).toEqual([
      ['Can I return a zugwidget?', 2, false],
      ['opening hours', 1, false],
    ]);
    expect(groups[0]?.pages[0]?.url).toBe('https://shop.example.test/help/returns');

    /* An entry written from the group queues a build and becomes a document of it. */
    const saved = await saveFaqEntry({
      workspaceId,
      role: 'owner',
      assetId,
      question: 'Can I return a zugwidget?',
      answer: 'Yes, within thirty days of delivery with the receipt.',
      pageUrl: 'https://shop.example.test/help/returns',
    });
    expect(saved.entry?.question).toBe('Can I return a zugwidget?');
    const [queued] = await db()
      .select({ status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, saved.operationId));
    expect(queued?.status).toBe('pending');

    const built = await buildVersion({ assetId, operationId: saved.operationId, dependencies: dependencies() });
    if (!built.changed) throw new Error('the FAQ did not change the build');
    const docs = await db()
      .select({ title: schema.document.title, sourceUrl: schema.document.sourceUrl })
      .from(schema.document)
      .where(eq(schema.document.versionId, built.versionId));
    expect(docs).toContainEqual({
      title: 'Can I return a zugwidget?',
      sourceUrl: 'https://shop.example.test/help/returns',
    });
    /* Its chunks are marked as the FAQ's, which is what the direct answer reads. */
    const [faqChunk] = await db()
      .select({ kind: sql<string | null>`${schema.chunk.citation}->>'kind'` })
      .from(schema.chunk)
      .where(and(eq(schema.chunk.versionId, built.versionId), sql`${schema.chunk.citation}->>'title' = 'Can I return a zugwidget?'`));
    expect(faqChunk?.kind).toBe('faq');
    await publishVersion({ assetId, versionId: built.versionId });

    /* Nothing changed -- source or FAQ -- so nothing is built. */
    expect((await buildVersion({ assetId, operationId: uuidv7(), dependencies: dependencies() })).changed).toBe(false);
    /* The FAQ alone changing is a change. */
    await saveFaqEntry({
      workspaceId,
      role: 'owner',
      assetId,
      entryId: saved.entry!.id,
      question: 'Can I return a zugwidget?',
      answer: 'Yes, within sixty days.',
      pageUrl: 'https://shop.example.test/help/returns',
    });
    const rebuilt = await buildVersion({ assetId, operationId: uuidv7(), dependencies: dependencies() });
    expect(rebuilt.changed).toBe(true);

    /* The group now reads as covered; removing the entry uncovers it. */
    expect((await listFaqGroups({ workspaceId, assetId, dependencies: textOnly }))[0]?.covered).toBe(true);
    await expect(
      saveFaqEntry({ workspaceId, role: 'developer', assetId, question: 'x', answer: 'y', pageUrl: SITE }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    await deleteFaqEntry({ workspaceId, role: 'owner', assetId, entryId: saved.entry!.id });
    expect(await listFaqEntries({ workspaceId, assetId })).toEqual([]);
  });

  whileOn("stops at the key's daily limit", async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-limit-${Date.now()}`);
    const key = await createSiteKey({
      workspaceId,
      role: 'owner',
      assetId,
      name: 'Tiny',
      origins: SITE,
      dailyLimit: '1',
    });

    const first = await askRoute(ask({ key: key.key, parent: SITE, question: 'returns' }));
    expect(first.status).toBe(200);
    expect((await lines(first))[0]).toMatchObject({ type: 'allowance', limit: 1, remaining: 0 });

    const second = await askRoute(ask({ key: key.key, parent: SITE, question: 'returns' }));
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('quota_exceeded');
  });

  whileOn('does not spend the day on an asset that cannot answer yet', async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-paused-${Date.now()}`);
    const key = await createSiteKey({
      workspaceId,
      role: 'owner',
      assetId,
      name: 'Paused',
      origins: SITE,
      dailyLimit: '1',
    });
    /* The owner pauses the asset: its version stays indexed, the widget stops. */
    await db()
      .update(schema.asset)
      .set({ lifecycleStatus: 'suspended' })
      .where(eq(schema.asset.id, assetId));

    expect((await embedPage(page(key.key, SITE))).status).toBe(200);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await askRoute(ask({ key: key.key, parent: SITE, question: 'returns' }));
      expect(response.status).toBe(200);
      expect(await lines(response)).toEqual([{ type: 'outcome', kind: 'not_ready' }]);
    }

    /* Resumed: the single question of the day is still there to spend. */
    await db()
      .update(schema.asset)
      .set({ lifecycleStatus: 'published' })
      .where(eq(schema.asset.id, assetId));
    const answered = await askRoute(ask({ key: key.key, parent: SITE, question: 'returns' }));
    expect(answered.status).toBe(200);
    expect((await lines(answered))[0]).toMatchObject({ type: 'allowance', remaining: 0 });
  });

  whileOn("tells the visitor the assistant is unavailable when the workspace's quota is spent", async () => {
    const workspaceId = await workspaceOnPlan();
    const assetId = await ownedAsset(workspaceId, `widget-quota-${Date.now()}`);
    const key = await createSiteKey({ workspaceId, role: 'owner', assetId, name: 'Broke', origins: SITE });

    const response = await askRoute(ask({ key: key.key, parent: SITE, question: 'returns' }));
    expect(response.status).toBe(200);
    const parts = await lines(response);
    expect(parts.find((part) => part.type === 'outcome')).toMatchObject({ kind: 'unavailable' });
    expect(parts.filter((part) => part.type === 'sources')).toHaveLength(0);
  });
});
