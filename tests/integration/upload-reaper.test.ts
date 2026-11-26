/**
 * `/api/cron/purge-uploads`: an upload nobody registered goes a day after
 * upload; anything a row still names, anything recent, and another
 * environment's files stay.
 */
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const blobs = vi.hoisted(() => ({ listed: new Map<string, { pathname: string; uploadedAt: Date }[]>(), deleted: [] as string[] }));
vi.mock('@/lib/infra/blob-access', () => ({
  listByPrefix: async (prefix: string) => ({ blobs: blobs.listed.get(prefix) ?? [], cursor: null }),
  deleteBlobs: async (pathnames: string[]) => {
    blobs.deleted.push(...pathnames);
  },
}));

const { db, schema } = await import('@/lib/infra/db');
const { purgeOrphanUploads } = await import('@/lib/services/upload-reaper');
const { GET } = await import('@/app/api/cron/purge-uploads/route');

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const users: string[] = [];
const rees: string[] = [];

afterAll(async () => {
  vi.unstubAllEnvs();
  if (rees.length) await db().delete(schema.knowledge).where(inArray(schema.knowledge.reeId, rees));
  if (rees.length) await db().delete(schema.ree).where(inArray(schema.ree.id, rees));
  if (users.length) await db().delete(schema.user).where(inArray(schema.user.id, users));
});

suite('orphan upload reaper', () => {
  it('requires the cron secret', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    expect((await GET(new NextRequest('http://localhost/api/cron/purge-uploads'))).status).toBe(401);
    expect((await GET(new NextRequest('http://localhost/api/cron/purge-uploads', { headers: { authorization: 'Bearer cron-secret' } }))).status).toBe(200);
  });

  it('deletes only old, unreferenced uploads of this database', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const recent = new Date(now.getTime() - 60 * 60 * 1000);
    const subject = uniqueName('reaper');
    const [user] = await db().insert(schema.user).values({ name: 'Reaper', email: `${subject}@example.test`, provider: 'github', providerSubject: subject }).returning();
    users.push(user!.id);
    const u = user!.id;
    const id = () => crypto.randomUUID();
    const avatar = `avatars/${u}/${id()}.png`;
    const reeAvatar = `avatars/${u}/${id()}.webp`;
    const draftAvatar = `avatars/${u}/${id()}.jpg`;
    const cover = `ree-covers/PLACEHOLDER/${id()}.png`;
    const [ree] = await db().insert(schema.ree).values({ ownerId: u, name: 'Reaped', slug: uniqueName('reaped'), avatarBlob: reeAvatar }).returning();
    rees.push(ree!.id);
    const keptCover = cover.replace('PLACEHOLDER', ree!.id);
    const orphanCover = `ree-covers/${ree!.id}/${id()}.png`;
    await db().update(schema.ree).set({ coverBlob: keptCover }).where(inArray(schema.ree.id, [ree!.id]));
    await db().update(schema.user).set({ avatarBlob: avatar, reeDraft: { avatarBlob: draftAvatar } as never }).where(inArray(schema.user.id, [u]));
    const registered = `knowledge/${u}/${id()}/kept.pdf`;
    await db().insert(schema.knowledge).values({ reeId: ree!.id, kind: 'document', title: 'Kept', originalTitle: 'Kept', source: registered });
    const orphanFile = `knowledge/${u}/${id()}/never-registered.pdf`;
    const recentFile = `knowledge/${u}/${id()}/just-uploaded.pdf`;
    const foreignFile = `knowledge/${id()}/${id()}/other-environment.pdf`;
    const orphanAvatar = `avatars/${u}/${id()}.png`;
    const foreignCover = `ree-covers/${id()}/${id()}.png`;
    /* A post's image is kept while a post names it; one the composer uploaded and never posted goes. */
    const [post] = await db().insert(schema.post).values({ userId: u, source: 'post', question: 'Reaped?', lang: 'en' }).returning();
    const postedImage = `post-images/${u}/${id()}.png`;
    await db().insert(schema.postImage).values({ postId: post!.id, position: 0, pathname: postedImage, contentType: 'image/png', bytes: 10 });
    const orphanImage = `post-images/${u}/${id()}.webp`;
    /* Thumbnails go with their image: kept while a row names them, reaped when none does. */
    const thumbed = id();
    await db().insert(schema.postImage).values({ postId: post!.id, position: 1, pathname: `post-images/${u}/${thumbed}.jpg`, contentType: 'image/jpeg', bytes: 10, thumbPathname: `post-images/${u}/${thumbed}.thumb.jpg` });
    const keptThumb = `post-images/${u}/${thumbed}.thumb.jpg`;
    const orphanThumb = `post-images/${u}/${id()}.thumb.jpg`;

    /* An agent workspace object is kept while `agent_workspace_blob` counts it; one a rolled-back write left behind goes. */
    const [space] = await db().insert(schema.workspace).values({ ownerId: u }).returning();
    const keptSha = 'a'.repeat(64);
    await db().insert(schema.workspaceBlob).values({ workspaceId: space!.id, sha256: keptSha, size: 3, refs: 1 });
    const keptObject = `workspace/${space!.id}/${keptSha}`;
    const orphanObject = `workspace/${space!.id}/${'b'.repeat(64)}`;
    const foreignObject = `workspace/${id()}/${'c'.repeat(64)}`;
    /* A workspace deleted here (its account, by cascade): its tombstone makes its objects ours to remove. */
    const [deleted] = await db().insert(schema.workspace).values({ ownerId: u, name: 'gone' }).returning();
    await db().delete(schema.workspace).where(inArray(schema.workspace.id, [deleted!.id]));
    const deletedObject = `workspace/${deleted!.id}/${'d'.repeat(64)}`;

    /* An upload's parts stay while it takes parts or is being put together; those of one that ended (or of none) go. */
    const ticket = (status: 'open' | 'assembling' | 'done') =>
      db().insert(schema.workspaceUpload).values({ tokenHash: id(), workspaceId: space!.id, userId: u, path: '/x.bin', size: 10, parts: 3, status, expiresAt: now }).returning().then((rows) => rows[0]!.id);
    const [openUpload, stitching, finished] = [await ticket('open'), await ticket('assembling'), await ticket('done')];
    const keptPart = `workspace/${space!.id}/upload/${openUpload}/1`;
    const keptPiece = `workspace/${space!.id}/upload/${stitching}/assembled.2`;
    const latePart = `workspace/${space!.id}/upload/${finished}/3`;
    const strayPart = `workspace/${space!.id}/upload/${id()}/1`;

    blobs.listed.set('workspace/', [keptObject, orphanObject, foreignObject, deletedObject, keptPart, keptPiece, latePart, strayPart].map((pathname) => ({ pathname, uploadedAt: old })));
    blobs.listed.set('knowledge/', [registered, orphanFile, foreignFile].map((pathname) => ({ pathname, uploadedAt: old })).concat({ pathname: recentFile, uploadedAt: recent }));
    blobs.listed.set('avatars/', [avatar, reeAvatar, draftAvatar, orphanAvatar].map((pathname) => ({ pathname, uploadedAt: old })));
    blobs.listed.set('ree-covers/', [keptCover, orphanCover, foreignCover].map((pathname) => ({ pathname, uploadedAt: old })));
    blobs.listed.set('post-images/', [postedImage, orphanImage, keptThumb, orphanThumb].map((pathname) => ({ pathname, uploadedAt: old })));
    blobs.deleted = [];

    const removed = await purgeOrphanUploads(now);
    expect(new Set(blobs.deleted)).toEqual(new Set([orphanFile, orphanAvatar, orphanCover, orphanImage, orphanThumb, orphanObject, deletedObject, latePart, strayPart]));
    expect(removed).toEqual({ 'knowledge/': 1, 'avatars/': 1, 'ree-covers/': 1, 'post-images/': 2, 'workspace/': 4 });
  });
});
