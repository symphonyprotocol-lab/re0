import { TEST_DATABASE_URL, uniqueName } from './setup';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/infra/db';
import { apiUser } from '@/lib/http/session';
import { GET, PATCH } from '@/app/api/account/route';
import { publicReeBySlug } from '@/lib/services/public-rees';

vi.mock('@/lib/http/session', () => ({ apiUser: vi.fn() }));

const request = (input: unknown) => new NextRequest('http://localhost/api/account', { method: 'PATCH', body: JSON.stringify(input) });
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb('account profile persistence', () => {
  it('reads current public author details and removes the page when the Ree is no longer public', async () => {
    const details = { title: 'Designer', description: 'About the creator', website: 'https://example.com', socialContacts: [{ platform: 'WeChat', value: 'creator-id' }] };
    const [user] = await db().insert(schema.user).values({ name: 'Public author', email: 'private@example.test', provider: 'github', providerSubject: uniqueName('public-profile'), ...details }).returning();
    try {
      const [ree] = await db().insert(schema.ree).values({ ownerId: user!.id, name: 'Public Ree', slug: uniqueName('profile-ree'), isPublic: true, isPublished: true }).returning();
      const read = await publicReeBySlug(ree!.slug);
      expect(read).toMatchObject({ ownerName: user!.name, ownerTitle: details.title, ownerDescription: details.description, ownerWebsite: details.website, ownerSocialContacts: details.socialContacts });
      expect(read).not.toHaveProperty('email');
      expect(read).not.toHaveProperty('providerHandle');
      await db().update(schema.user).set({ title: 'Updated title', website: '', socialContacts: [] }).where(eq(schema.user.id, user!.id));
      expect(await publicReeBySlug(ree!.slug)).toMatchObject({ ownerTitle: 'Updated title', ownerWebsite: '', ownerSocialContacts: [] });
      await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, ree!.id));
      expect(await publicReeBySlug(ree!.slug)).toBeNull();
      await db().update(schema.ree).set({ isPublic: true, deletedAt: new Date() }).where(eq(schema.ree.id, ree!.id));
      expect(await publicReeBySlug(ree!.slug)).toBeNull();
    } finally {
      await db().delete(schema.ree).where(eq(schema.ree.ownerId, user!.id));
      await db().delete(schema.user).where(eq(schema.user.id, user!.id));
    }
  });

  it('saves, reads, preserves on language changes, and clears all optional profile fields', async () => {
    const providerAvatar = 'https://lh3.googleusercontent.com/provider-photo';
    const [user] = await db().insert(schema.user).values({ name: 'Tester', email: 'tester@example.test', provider: 'google', providerSubject: uniqueName('profile'), avatarBlob: providerAvatar }).returning();
    vi.mocked(apiUser).mockImplementation(async () => (await db().select().from(schema.user).where(eq(schema.user.id, user!.id)))[0]!);
    try {
      const details = { title: '独立开发者', description: 'Building useful things.\n分享知识。', website: 'https://example.com/about', socialContacts: [{ platform: '微信', value: 'my-wechat-id' }, { platform: 'Custom network', value: 'https://social.example/me' }] };
      const response = await PATCH(request({ name: ' Updated ', avatarBlob: providerAvatar, ...details, title: ` ${details.title} ` }));
      expect(response.status).toBe(200);
      expect((await response.json()).account).toMatchObject({ name: 'Updated', ...details });
      const read = await GET(new NextRequest('http://localhost/api/account'));
      expect((await read.json()).account).toMatchObject(details);
      // An unchanged OAuth URL is allowed, but new external URLs and other users' uploads are not.
      for (const avatarBlob of ['https://example.com/new-avatar.png', 'avatars/someone-else/photo.webp']) {
        const rejected = await PATCH(request({ avatarBlob }));
        expect(rejected.status).toBe(422);
        expect(await rejected.json()).toEqual({ error: 'avatar' });
      }
      const ownAvatar = `avatars/${user!.id}/photo.webp`;
      expect((await PATCH(request({ avatarBlob: ownAvatar }))).status).toBe(200);
      expect((await PATCH(request({ avatarBlob: providerAvatar }))).status).toBe(422);
      expect((await PATCH(request({ avatarBlob: null }))).status).toBe(200);
      await PATCH(request({ lang: 'en' }));
      const [stored] = await db().select().from(schema.user).where(eq(schema.user.id, user!.id));
      expect(stored).toMatchObject({ lang: 'en', ...details });
      const invalid = await PATCH(request({ title: 'Overwrite', website: 'javascript:alert(1)' }));
      expect(invalid.status).toBe(422);
      expect((await invalid.json()).error).toBe('website');
      expect((await db().select().from(schema.user).where(eq(schema.user.id, user!.id)))[0]!.title).toBe(details.title);
      const cleared = await PATCH(request({ title: '', description: '', website: '', socialContacts: [] }));
      expect((await cleared.json()).account).toMatchObject({ title: '', description: '', website: '', socialContacts: [] });
    } finally {
      await db().delete(schema.user).where(eq(schema.user.id, user!.id));
    }
  });
});
