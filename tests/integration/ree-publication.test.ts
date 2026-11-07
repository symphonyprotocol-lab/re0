import { describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/infra/db';
import { blobSize } from '@/lib/infra/blob';
import { newReeDraft } from '@/lib/domain/ree';
import { createSession } from '@/lib/services/auth';
import { createReeFromDraft, getDraft, ownedRee, saveDraft, setReePublished, setReesVisibility, updateRee, listRees } from '@/lib/services/rees';
import { coverVisibleTo, publicReeBySlug, reeForPreview } from '@/lib/services/public-rees';
import { reeBriefs, createConversation } from '@/lib/services/conversations';
import { reeCards } from '@/lib/services/explore';

vi.mock('@/lib/infra/blob', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/infra/blob')>(),
  blobSize: vi.fn(),
}));

const suite = TEST_DATABASE_URL ? describe : describe.skip;
async function person() {
  const name = uniqueName('publisher');
  return (await createSession({ provider: 'github', subject: name, handle: name, email: `${name}@example.test`, displayName: name, avatarUrl: null }, 'en', '/')).userId;
}
async function create(ownerId: string, isPublic = true) {
  // Publication cannot be injected through a draft, even by a stale or custom client.
  await saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Ree'), category: 'technology', isPublic, isPublished: true, step: 3, reached: 3 });
  return (await createReeFromDraft(ownerId)).ree;
}

suite('explicit Ree publication', () => {
  it('keeps the preview and saved cover private until publication', async () => {
    const owner = await person();
    const other = await person();
    const ree = await create(owner);
    const cover = `ree-covers/${ree.id}/${crypto.randomUUID()}.webp`;
    const otherCover = `ree-covers/${crypto.randomUUID()}/${crypto.randomUUID()}.webp`;

    expect(ree.coverBlob).toBeNull();
    expect(await reeForPreview(ree.id, other)).toBeNull();
    expect(await reeForPreview(ree.id, owner)).toMatchObject({ id: ree.id, coverBlob: null });
    await expect(updateRee(owner, ree.id, { ...ree, coverBlob: otherCover })).rejects.toMatchObject({ field: 'invalid_cover' });
    vi.mocked(blobSize).mockResolvedValueOnce(null);
    await expect(updateRee(owner, ree.id, { ...ree, coverBlob: cover })).rejects.toMatchObject({ field: 'invalid_cover' });
    vi.mocked(blobSize).mockResolvedValueOnce(1024);
    expect(await updateRee(owner, ree.id, { ...ree, coverBlob: cover })).toMatchObject({ coverBlob: cover });
    expect(await updateRee(owner, ree.id, { ...ree, coverBlob: undefined })).toMatchObject({ coverBlob: cover });
    expect(await reeForPreview(ree.id, owner)).toMatchObject({ coverBlob: cover });
    expect(await coverVisibleTo(ree.id, cover, owner)).toBe(true);
    expect(await coverVisibleTo(ree.id, cover, other)).toBe(false);
    expect(await coverVisibleTo(ree.id, cover, null)).toBe(false);
    expect(await publicReeBySlug(ree.slug)).toBeNull();

    await setReePublished(owner, ree.id, true);
    expect(await reeForPreview(ree.id, other)).toBeNull();
    expect(await publicReeBySlug(ree.slug)).toMatchObject({ coverBlob: cover });
    expect(await reeCards([ree.id])).toMatchObject([{ coverBlob: cover }]);
    expect(await coverVisibleTo(ree.id, cover, null)).toBe(true);
    await setReePublished(owner, ree.id, false);
    expect(await coverVisibleTo(ree.id, cover, null)).toBe(false);
    await updateRee(owner, ree.id, { ...ree, coverBlob: null });
    expect(await coverVisibleTo(ree.id, cover, owner)).toBe(false);
    await db().update(schema.ree).set({ deletedAt: new Date() }).where(eq(schema.ree.id, ree.id));
    expect(await reeForPreview(ree.id, owner)).toBeNull();
  });

  it('creates public Rees unpublished and permits only the owner to see and use them', async () => {
    const owner = await person();
    const other = await person();
    const ree = await create(owner);
    expect(ree).toMatchObject({ isPublic: true, isPublished: false });
    expect(await getDraft(owner)).toBeNull();
    expect(await publicReeBySlug(ree.slug)).toBeNull();
    expect(await reeCards([ree.id])).toEqual([]);
    expect((await reeBriefs(db(), owner, [ree.id])).get(ree.id)?.usable).toBe(true);
    expect((await reeBriefs(db(), other, [ree.id])).get(ree.id)?.usable).toBe(false);
    await expect(createConversation(other, { reeIds: [ree.id] })).rejects.toMatchObject({ code: 'ree_unavailable' });
    expect(await ownedRee(db(), owner, ree.id)).not.toBeNull();
  });

  it('publishes explicitly, unpublishes without losing public settings, and preserves owner conversations', async () => {
    const owner = await person();
    const other = await person();
    const ree = await create(owner);
    expect(await setReePublished(owner, ree.id, true)).toMatchObject({ isPublic: true, isPublished: true });
    expect(await publicReeBySlug(ree.slug)).toMatchObject({ id: ree.id });
    expect(await reeCards([ree.id])).toHaveLength(1);
    const othersChat = await createConversation(other, { reeIds: [ree.id] });
    const ownChat = await createConversation(owner, { reeIds: [ree.id] });
    expect(await setReePublished(owner, ree.id, false)).toMatchObject({ isPublic: true, isPublished: false });
    expect(await publicReeBySlug(ree.slug)).toBeNull();
    expect(await reeCards([ree.id])).toEqual([]);
    expect(await db().select().from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, othersChat.id))).toHaveLength(0);
    expect(await db().select().from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, ownChat.id))).toHaveLength(1);
    expect((await reeBriefs(db(), other, [ree.id])).get(ree.id)?.usable).toBe(false);
    expect(await setReePublished(owner, ree.id, false)).toMatchObject({ isPublished: false });
    expect(await setReePublished(owner, ree.id, true)).toMatchObject({ isPublished: true });
  });

  it('blocks other owners, private and moderated Rees, and deleted Rees', async () => {
    const owner = await person();
    const other = await person();
    const ree = await create(owner, false);
    expect(await setReePublished(other, ree.id, true)).toBeNull();
    await expect(setReePublished(owner, ree.id, true)).rejects.toMatchObject({ code: 'not_public' });
    await db().update(schema.ree).set({ moderatedAt: new Date() }).where(eq(schema.ree.id, ree.id));
    await expect(setReePublished(owner, ree.id, true)).rejects.toMatchObject({ code: 'moderated' });
    await db().update(schema.ree).set({ deletedAt: new Date() }).where(eq(schema.ree.id, ree.id));
    expect(await setReePublished(owner, ree.id, true)).toBeNull();
  });

  it('requires publishing again after changing visibility through settings or batch actions', async () => {
    const owner = await person();
    const ree = await create(owner);
    await setReePublished(owner, ree.id, true);
    const fields = { ...ree, isPublic: false };
    expect(await updateRee(owner, ree.id, fields)).toMatchObject({ isPublic: false, isPublished: false });
    expect(await updateRee(owner, ree.id, { ...fields, isPublic: true })).toMatchObject({ isPublic: true, isPublished: false });
    await setReePublished(owner, ree.id, true);
    await setReesVisibility(owner, [ree.id], false);
    await setReesVisibility(owner, [ree.id], true);
    expect(await ownedRee(db(), owner, ree.id)).toMatchObject({ isPublic: true, isPublished: false });
    const query = { q: '', sort: 'default' as const, size: 12, page: 1 };
    expect((await listRees(owner, { ...query, visibility: 'unpublished' })).items.map(r => r.id)).toContain(ree.id);
    expect((await listRees(owner, { ...query, visibility: 'published' })).items).toHaveLength(0);
  });
});
