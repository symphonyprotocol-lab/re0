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

    blobs.listed.set('knowledge/', [registered, orphanFile, foreignFile].map((pathname) => ({ pathname, uploadedAt: old })).concat({ pathname: recentFile, uploadedAt: recent }));
    blobs.listed.set('avatars/', [avatar, reeAvatar, draftAvatar, orphanAvatar].map((pathname) => ({ pathname, uploadedAt: old })));
    blobs.listed.set('ree-covers/', [keptCover, orphanCover, foreignCover].map((pathname) => ({ pathname, uploadedAt: old })));
    blobs.deleted = [];

    const removed = await purgeOrphanUploads(now);
    expect(new Set(blobs.deleted)).toEqual(new Set([orphanFile, orphanAvatar, orphanCover]));
    expect(removed).toEqual({ 'knowledge/': 1, 'avatars/': 1, 'ree-covers/': 1 });
  });
});
