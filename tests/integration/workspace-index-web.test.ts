/**
 * The workspace's second-phase web routes: index mode and estimate
 * (`/api/files/index`, `/api/files/estimate`), a Ree from a folder
 * (`/api/files/create-ree`), and a Ree's workspace sources
 * (`/api/rees/[id]/workspace`: bind, auto, confirm / dismiss, unbind, move).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const objects = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/workspace-store', () => ({
  workspaceObjectPath: (workspaceId: string, sha: string) => `workspace/${workspaceId.toLowerCase()}/${sha}`,
  putWorkspaceObject: async (path: string, bytes: Uint8Array) => void objects.set(path, bytes),
  readWorkspaceObject: async (path: string) => objects.get(path) ?? null,
  deleteWorkspaceObjects: async (paths: readonly string[]) => paths.forEach((path) => objects.delete(path)),
}));
const signedIn = vi.hoisted(() => ({ id: '' }));
vi.mock('@/lib/http/session', () => ({ apiUser: async () => ({ id: signedIn.id }) }));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { db, schema } = await import('@/lib/infra/db');
const workspace = await import('@/lib/services/workspace');
const index = await import('@/lib/services/workspace-index');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const { addGrant } = await import('@/lib/services/credits');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const indexRoute = await import('@/app/api/files/index/route');
const estimateRoute = await import('@/app/api/files/estimate/route');
const createRoute = await import('@/app/api/files/create-ree/route');
const reeRoute = await import('@/app/api/rees/[id]/workspace/route');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

async function owner() {
  const [user] = await db().insert(schema.user).values({ name: 'Index owner', email: `${uniqueName('wiw')}@example.test`, provider: 'github', providerSubject: uniqueName('wiw') }).returning();
  await db().transaction((tx) => addGrant(tx, { userId: user!.id, source: 'pack', amount: 1_000, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  signedIn.id = user!.id;
  return workspace.webScope(user!.id);
}

const post = (url: string, input: unknown) => new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(input) });
const reePost = (id: string, input: unknown) => reeRoute.POST(post(`/api/rees/${id}/workspace`, input), { params: Promise.resolve({ id }) });
const indexNow = () => index.runIndexQueue(new Date(Date.now() + 3 * 60_000));

describeWithDb('workspace index web routes', () => {
  it('estimates, turns indexing on and off, and refuses above max cost', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/n/a.md', content: 'notes about the Chaco' });
    const estimate = await (await estimateRoute.GET(new NextRequest('http://localhost/api/files/estimate?path=/n'))).json();
    expect(estimate).toMatchObject({ files: 1, reused: 0 });
    expect((await indexRoute.POST(post('/api/files/index', { path: '/n', mode: 'on', maxCost: 0 }))).status).toBe(402);
    expect(await (await indexRoute.POST(post('/api/files/index', { path: '/n', mode: 'on' }))).json()).toMatchObject({ mode: 'on', queued: 1 });
    expect((await indexRoute.POST(post('/api/files/index', { path: '/n', mode: 'sometimes' }))).status).toBe(422);
    await indexNow();
    expect((await index.indexedFolders(scope)).map((row) => [row.path, row.mode])).toEqual([['/n', 'on']]);
    await indexRoute.POST(post('/api/files/index', { path: '/n', mode: 'off' }));
    await indexNow();
    expect(await db().select().from(schema.workspacePassage).where(eq(schema.workspacePassage.workspaceId, scope.workspaceId))).toEqual([]);
  });

  it('creates a Ree from a folder, then binds, confirms, unbinds and moves text in through the Ree route', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/trip/a.md', content: 'Day one in Asunción.' });
    const created = await createRoute.POST(post('/api/files/create-ree', { path: '/trip', name: uniqueName('Trip').slice(0, 40), category: 'travel' }));
    expect(created.status).toBe(201);
    const { reeId } = (await created.json()) as { reeId: string };
    await indexNow();
    expect((await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, reeId))).map((row) => row.title)).toEqual(['a.md']);

    await rees.setReesVisibility(scope.userId, [reeId], true);
    await rees.setReePublished(scope.userId, reeId, true);
    await workspace.writeFile(scope, { path: '/more/b.md', content: 'Day two in Encarnación.' });
    const bound = await (await reePost(reeId, { action: 'bind', path: '/more' })).json();
    expect(bound.bindings.map((binding: { path: string }) => binding.path).sort()).toEqual(['/more', '/trip']);
    await indexNow();
    const [waiting] = await db().select().from(schema.knowledge).where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.title, 'b.md')));
    expect(waiting).toMatchObject({ awaitingConfirmation: true, enabled: false });
    expect(await (await reePost(reeId, { action: 'confirm', ids: [waiting!.id] })).json()).toEqual({ changed: 1, refused: 0 });

    const binding = bound.bindings.find((row: { path: string }) => row.path === '/more');
    expect((await reePost(reeId, { action: 'auto', bindingId: binding.id, value: true })).status).toBe(200);
    await reePost(reeId, { action: 'unbind', bindingId: binding.id });
    const [gone] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, waiting!.id));
    expect(gone!.deletedAt).not.toBeNull();

    const { ree: old } = await rees.createRee(scope.userId, { name: uniqueName('Old').slice(0, 40), description: 'x', category: 'travel', tags: [], systemPrompt: '', sampleQuestions: [], queryFee: 0, isPublic: false, color: 'default' });
    const textId = await knowledge.addKnowledge(scope.userId, old, { kind: 'text', title: 'Notes', content: 'Text to move.' });
    await knowledge.processKnowledge(textId, { profile: false });
    expect(await (await reePost(old.id, { action: 'move' })).json()).toMatchObject({ moved: 1, folder: `/Rees/${old.slug}` });
    expect((await reePost(old.id, { action: 'nonsense' })).status).toBe(422);
  });

  it("cannot touch another account's Ree", async () => {
    const theirs = await owner();
    const { ree } = await rees.createRee(theirs.userId, { name: uniqueName('Theirs').slice(0, 40), description: 'x', category: 'travel', tags: [], systemPrompt: '', sampleQuestions: [], queryFee: 0, isPublic: false, color: 'default' });
    await owner();
    expect((await reePost(ree.id, { action: 'move' })).status).toBe(404);
    expect((await reePost(ree.id, { action: 'bind', path: '/' })).status).toBe(404);
  });
});
