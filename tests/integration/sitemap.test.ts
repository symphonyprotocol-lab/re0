import { describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/infra/db';
import { newReeDraft } from '@/lib/domain/ree';
import { createSession } from '@/lib/services/auth';
import { createReeFromDraft, deleteRee, saveDraft, setReePublished } from '@/lib/services/rees';
import sitemap from '@/app/sitemap';
import { GET as sitemapIndex } from '@/app/sitemap-index.xml/route';
import { sitemapIds } from '@/lib/sitemaps';
import { authorOthers, authorOthersPages, publicReeBySlug } from '@/lib/services/public-rees';
import { PUBLIC_LIST_PAGE_SIZE } from '@/lib/constants';

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

    const pages = (await sitemap({ id: 'pages' })).map((entry) => entry.url);
    for (const path of ['', '/explore', '/pricing', '/legal/terms', '/legal/privacy']) {
      expect(pages).toContain(`https://re0.test/zh${path}`);
      expect(pages).toContain(`https://re0.test/en${path}`);
    }
    expect(pages.join('\n')).not.toContain('/r/');
    const entries = (await Promise.all((await sitemapIds()).filter((id) => id.startsWith('rees-')).map((id) => sitemap({ id })))).flat();
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain(`https://re0.test/zh/r/${shown.slug}`);
    expect(urls).toContain(`https://re0.test/en/r/${shown.slug}`);
    for (const hidden of [privateOne, unpublished, takenDown, deleted]) expect(urls.join('\n')).not.toContain(`/r/${hidden.slug}`);
    expect([...pages, ...urls].some((url) => /re0\.test\/(r|s|explore|pricing)\b/.test(url))).toBe(false);
    expect(entries.find((entry) => entry.url === `https://re0.test/en/r/${shown.slug}`)).toMatchObject({
      lastModified: expect.any(Date),
      alternates: { languages: { zh: `https://re0.test/zh/r/${shown.slug}`, en: `https://re0.test/en/r/${shown.slug}`, 'x-default': `https://re0.test/en/r/${shown.slug}` } },
    });
    vi.unstubAllEnvs();
  });

  it('lists an official Ree once, on its English page, with no hreflang (A7)', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://re0.test');
    const owner = await person();
    await db().update(schema.user).set({ role: 'official' }).where(eq(schema.user.id, owner));
    const official = await ree(owner);
    const entries = (await Promise.all((await sitemapIds()).filter((id) => id.startsWith('rees-')).map((id) => sitemap({ id })))).flat();
    const listed = entries.filter((entry) => entry.url.endsWith(`/r/${official.slug}`));
    expect(listed).toEqual([{ url: `https://re0.test/en/r/${official.slug}`, lastModified: expect.any(Date), changeFrequency: 'weekly', priority: 0.8 }]);
    vi.unstubAllEnvs();
  });

  it('serves /sitemap.xml as an index of the parts there are, and 404s a part that is not', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://re0.test');
    await ree(await person());
    const ids = await sitemapIds();
    expect(ids[0]).toBe('pages');
    expect(ids).toContain('rees-1');
    expect(ids.every((id) => /^(pages|rees-\d+|posts-\d+)$/.test(id))).toBe(true);
    const response = await sitemapIndex();
    expect(response.headers.get('content-type')).toBe('application/xml');
    const xml = await response.text();
    expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])).toEqual(ids.map((id) => `https://re0.test/sitemap/${id}.xml`));
    const past = ids.filter((id) => id.startsWith('rees-')).length + 1;
    await expect(sitemap({ id: `rees-${past}` })).rejects.toThrow();
    await expect(sitemap({ id: 'nope' })).rejects.toThrow();
    vi.unstubAllEnvs();
  });

  it('counts the pages of 同一创作者的更多 Ree the way the list pages them (the ?ap= gate)', async () => {
    const owner = await person();
    const first = await ree(owner);
    const shown = await publicReeBySlug(first.slug);
    expect(shown).not.toBeNull();
    expect(await authorOthersPages(shown!)).toBe(1);
    for (let i = 0; i <= PUBLIC_LIST_PAGE_SIZE; i += 1) await ree(owner);
    const pages = await authorOthersPages(shown!);
    expect(pages).toBe(2);
    expect((await authorOthers(shown!, 99)).page).toBe(pages);
  });
});
