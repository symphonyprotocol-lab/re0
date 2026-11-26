/**
 * What the removed agent workspace left in Blob (migration 0101): only the
 * prefixes of the workspaces 0101 listed in `removed_workspace` are deleted,
 * everything under them, upload parts included; a database with no rows
 * there deletes nothing, whatever the shared store holds; the run keeps to
 * its budget and picks up where it stopped; a workspace's row goes once its
 * prefix is empty. The purge-uploads cron runs it after the orphan reaper.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { TEST_DATABASE_URL } from './setup';

const store = vi.hoisted(() => ({ objects: new Set<string>(), listed: [] as string[], deleted: [] as string[] }));
vi.mock('@/lib/infra/blob-access', () => ({
  /* Pages of `limit`, in name order; the cursor is the next index. */
  listByPrefix: async (prefix: string, options: { cursor?: string; limit?: number } = {}) => {
    store.listed.push(prefix);
    const all = [...store.objects].filter((pathname) => pathname.startsWith(prefix)).sort();
    const from = Number(options.cursor ?? 0);
    const to = from + (options.limit ?? 1000);
    return { blobs: all.slice(from, to).map((pathname) => ({ pathname, uploadedAt: new Date() })), cursor: to < all.length ? String(to) : null };
  },
  deleteBlobs: async (pathnames: readonly string[]) => {
    for (const pathname of pathnames) {
      store.objects.delete(pathname);
      store.deleted.push(pathname);
    }
  },
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { db, schema } = await import('@/lib/infra/db');
const { purgeRemovedWorkspaceBlobs } = await import('@/lib/services/removed-workspace-blobs');
const { GET } = await import('@/app/api/cron/purge-uploads/route');

const objectsOf = (workspace: string, n: number) => Array.from({ length: n }, (_, i) => `workspace/${workspace}/${String(i).padStart(64, '0')}`);
const tombstones = async () => (await db().select().from(schema.removedWorkspace)).map((row) => row.workspaceId).sort();

beforeEach(async () => {
  await db().delete(schema.removedWorkspace);
  store.objects.clear();
  store.listed = [];
  store.deleted = [];
});

describeWithDb('removed workspace Blob cleanup', () => {
  it('deletes nothing when this database listed no workspace, whatever the store holds', async () => {
    const theirs = crypto.randomUUID();
    for (const pathname of objectsOf(theirs, 3)) store.objects.add(pathname);
    expect(await purgeRemovedWorkspaceBlobs()).toEqual({ deleted: 0, finished: 0, left: 0 });
    expect(store.listed).toEqual([]);
    expect(store.deleted).toEqual([]);
    expect(store.objects.size).toBe(3);
  });

  it("deletes everything under a listed workspace's prefix, uploads included, and nothing of another's", async () => {
    const ours = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    const part = `workspace/${ours}/upload/${crypto.randomUUID()}/1`;
    const mine = [...objectsOf(ours, 3), part];
    const other = objectsOf(theirs, 2);
    for (const pathname of [...mine, ...other]) store.objects.add(pathname);
    /* A look-alike outside the prefix: another workspace id that starts with ours. */
    const lookAlike = `workspace/${ours}x/${'f'.repeat(64)}`;
    store.objects.add(lookAlike);
    await db().insert(schema.removedWorkspace).values({ workspaceId: ours });

    expect(await purgeRemovedWorkspaceBlobs()).toEqual({ deleted: 4, finished: 1, left: 0 });
    expect(new Set(store.deleted)).toEqual(new Set(mine));
    expect([...store.objects].sort()).toEqual([...other, lookAlike].sort());
    expect(store.listed.every((prefix) => prefix === `workspace/${ours}/`)).toBe(true);
    expect(await tombstones()).toEqual([]);
  });

  it('keeps to its budget, keeps the row while objects remain, and finishes on a later run', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    for (const pathname of [...objectsOf(a, 5), ...objectsOf(b, 2)]) store.objects.add(pathname);
    await db().insert(schema.removedWorkspace).values([{ workspaceId: a, removedAt: new Date(Date.now() - 1000) }, { workspaceId: b }]);

    expect(await purgeRemovedWorkspaceBlobs({ budget: 3 })).toEqual({ deleted: 3, finished: 0, left: 2 });
    expect(await tombstones()).toEqual([a, b].sort());
    expect(await purgeRemovedWorkspaceBlobs({ budget: 3 })).toEqual({ deleted: 3, finished: 1, left: 1 });
    expect(await tombstones()).toEqual([b]);
    expect(await purgeRemovedWorkspaceBlobs({ budget: 3 })).toEqual({ deleted: 1, finished: 1, left: 0 });
    expect(store.objects.size).toBe(0);
    /* Once done, a run lists nothing at all. */
    store.listed = [];
    expect(await purgeRemovedWorkspaceBlobs()).toEqual({ deleted: 0, finished: 0, left: 0 });
    expect(store.listed).toEqual([]);
  });

  it('stops at the deadline and leaves the rest for the next run', async () => {
    const a = crypto.randomUUID();
    for (const pathname of objectsOf(a, 2)) store.objects.add(pathname);
    await db().insert(schema.removedWorkspace).values({ workspaceId: a });
    expect(await purgeRemovedWorkspaceBlobs({ deadline: Date.now() - 1 })).toEqual({ deleted: 0, finished: 0, left: 1 });
    expect(store.objects.size).toBe(2);
  });

  it('runs from the purge-uploads cron, after the orphan reaper', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    const a = crypto.randomUUID();
    for (const pathname of objectsOf(a, 2)) store.objects.add(pathname);
    await db().insert(schema.removedWorkspace).values({ workspaceId: a });
    const response = await GET(new NextRequest('http://localhost/api/cron/purge-uploads', { headers: { authorization: 'Bearer cron-secret' } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ removedWorkspaces: { deleted: 2, finished: 1, left: 0 } });
    vi.unstubAllEnvs();
  });
});
