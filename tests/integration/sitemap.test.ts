import { describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/infra/db';
import { newReeDraft } from '@/lib/domain/ree';
import { createSession } from '@/lib/services/auth';
import { createReeFromDraft, deleteRee, saveDraft, setReePublished } from '@/lib/services/rees';
import sitemap from '@/app/sitemap';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

async function person() {
  const name = uniqueName('mapped');
  return (await createSession({ provider: 'github', subject: name, handle: name, email: `${name}@example.test`, displayName: name, avatarUrl: null }, 'en', '/')).userId;
}
async function ree(ownerId: string, { published = true } = {}) {
  await saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Ree'), category: 'technology', isPublic: true, isPublished: true, step: 3, reached: 3 });
  const created = (await createReeFromDraft(ownerId)).ree;
  if (published) await setReePublished(ownerId, created.id, true);
  return created;
}

suite('sitemap', () => {
  it('lists the public pages and public Rees once per language, each with its hreflang alternates', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://re0.test');
    const owner = await person();
    const shown = await ree(owner);
    const privateOne = await ree(owner);
    const unpublished = await ree(owner, { published: false });
    const takenDown = await ree(owner);
    const deleted = await ree(owner);
    /* Published once, then made private again (which unpublishes it: ree_published_public_check). */
    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, privateOne.id));
    await db().update(schema.ree).set({ moderatedAt: new Date(), isPublic: false, isPublished: false }).where(eq(schema.ree.id, takenDown.id));
    expect(await deleteRee(owner, deleted.id)).toBe(true);

    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);
    for (const path of ['', '/explore', '/pricing', '/legal/terms', '/legal/privacy', `/r/${shown.slug}`]) {
      expect(urls).toContain(`https://re0.test/zh${path}`);
      expect(urls).toContain(`https://re0.test/en${path}`);
    }
    for (const hidden of [privateOne, unpublished, takenDown, deleted]) expect(urls.join('\n')).not.toContain(`/r/${hidden.slug}`);
    expect(urls.some((url) => /re0\.test\/(r|s|explore|pricing)\b/.test(url))).toBe(false);
    expect(entries.find((entry) => entry.url === `https://re0.test/en/r/${shown.slug}`)).toMatchObject({
      lastModified: expect.any(Date),
      alternates: { languages: { zh: `https://re0.test/zh/r/${shown.slug}`, en: `https://re0.test/en/r/${shown.slug}`, 'x-default': `https://re0.test/r/${shown.slug}` } },
    });
    vi.unstubAllEnvs();
  });
});
