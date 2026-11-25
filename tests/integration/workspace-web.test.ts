/**
 * The workspace's web routes (`/api/files/*`): the signed-in owner on their
 * default workspace, through the service the `ws_*` tools use. Download is
 * byte for byte; trash, restore (from the trash and to an older version) and
 * deleting for good; refusals carry the service's codes.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const objects = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/workspace-store', () => ({
  workspaceObjectPath: (workspaceId: string, sha: string) => `workspace/${workspaceId.toLowerCase()}/${sha}`,
  putWorkspaceObject: async (path: string, bytes: Uint8Array) => void objects.set(path, bytes),
  readWorkspaceObject: async (path: string) => objects.get(path) ?? null,
  openWorkspaceObject: async (path: string) => (objects.has(path) ? { stream: new Response(Buffer.from(objects.get(path)!)).body, size: objects.get(path)!.length } : null),
  workspaceUploadPartPath: (workspaceId: string, id: string, n: number) => `workspace/${workspaceId}/upload/${id}/${n}`,
  deleteWorkspaceObjects: async (paths: readonly string[]) => paths.forEach((path) => objects.delete(path)),
}));
const signedIn = vi.hoisted(() => ({ id: '' }));
vi.mock('@/lib/http/session', () => ({ apiUser: async () => ({ id: signedIn.id }) }));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { db, schema } = await import('@/lib/infra/db');
const workspace = await import('@/lib/services/workspace');
const raw = await import('@/app/api/files/raw/route');
const trash = await import('@/app/api/files/trash/route');
const restore = await import('@/app/api/files/restore/route');
const purge = await import('@/app/api/files/purge/route');

async function owner() {
  const [user] = await db().insert(schema.user).values({ name: 'Files owner', email: `${uniqueName('files')}@example.test`, provider: 'github', providerSubject: uniqueName('files') }).returning();
  signedIn.id = user!.id;
  return workspace.webScope(user!.id);
}

const post = (url: string, input: unknown) => new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(input) });

describeWithDb('workspace web routes', () => {
  it('downloads a file and an older version byte for byte', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/r/日本.md', content: 'v1\r\n' });
    const history = await workspace.fileHistory(scope, { path: '/r/日本.md' });
    await workspace.writeFile({ ...scope, apiKeyId: crypto.randomUUID() }, { path: '/r/日本.md', content: 'v2\n' });
    const now = await raw.GET(new NextRequest(`http://localhost/api/files/raw?path=${encodeURIComponent('/r/日本.md')}`));
    expect(now.status).toBe(200);
    expect(await now.text()).toBe('v2\n');
    expect(now.headers.get('content-disposition')).toContain(encodeURIComponent('日本.md'));
    const old = await raw.GET(new NextRequest(`http://localhost/api/files/raw?path=${encodeURIComponent('/r/日本.md')}&revision=${history.versions[0]!.revision}`));
    expect(await old.text()).toBe('v1\r\n');
    const missing = await raw.GET(new NextRequest('http://localhost/api/files/raw?path=/nope.md'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not_found' });
  });

  it('trashes, restores, rolls back a version and deletes for good', async () => {
    const scope = await owner();
    await workspace.writeFile(scope, { path: '/t/a.md', content: 'first' });
    const first = (await workspace.fileHistory(scope, { path: '/t/a.md' })).versions[0]!.revision;
    await workspace.writeFile({ ...scope, apiKeyId: crypto.randomUUID() }, { path: '/t/a.md', content: 'second' });
    const rolled = await restore.POST(post('/api/files/restore', { path: '/t/a.md', revision: first }));
    expect(rolled.status).toBe(200);
    expect((await workspace.fileText(scope, '/t/a.md')).text).toBe('first');

    const trashed = await trash.POST(post('/api/files/trash', { path: '/t' }));
    const { trash_id: trashId } = (await trashed.json()) as { trash_id: string };
    expect(await workspace.kindAt(scope, '/t/a.md')).toBeNull();
    const back = await restore.POST(post('/api/files/restore', { trashId }));
    expect(await back.json()).toMatchObject({ path: '/t', restored: 2 });

    await trash.POST(post('/api/files/trash', { path: '/t' }));
    const purged = await purge.POST(post('/api/files/purge', { ids: [trashId, 'not-an-id'] }));
    expect(await purged.json()).toEqual({ purged: 2 });
    expect((await workspace.listEntries(scope, { trash: true })).entries).toEqual([]);
    const [usage] = await db().select().from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, scope.userId));
    expect(usage).toMatchObject({ entries: 0, databaseBytes: 0, blobBytes: 0 });
  });

  it("cannot restore or purge another account's trash", async () => {
    const theirs = await owner();
    await workspace.writeFile(theirs, { path: '/x.md', content: 'x' });
    const { trash_id: trashId } = await workspace.trashEntry(theirs, { path: '/x.md' });
    await owner();
    expect((await restore.POST(post('/api/files/restore', { trashId }))).status).toBe(404);
    expect(await (await purge.POST(post('/api/files/purge', { ids: [trashId] }))).json()).toEqual({ purged: 0 });
    expect((await workspace.listEntries(theirs, { trash: true })).entries).toHaveLength(1);
  });
});
