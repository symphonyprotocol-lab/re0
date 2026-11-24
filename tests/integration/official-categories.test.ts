/**
 * The one-off recategorisation (scripts/recategorise-official-rees.mts):
 * Wikivoyage guides leave `life` for `travel`, fiction, poetry and drama
 * leave `other` for `literature`, non-fiction stays, only the named owner's
 * Rees move, and a second run moves nothing.
 */
import { describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { db, schema } = await import('@/lib/infra/db');
const { planRecategorise, applyRecategorise } = await import('@/lib/services/official-categories');

async function newUser(name: string) {
  const subject = uniqueName('official');
  const session = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: name, avatarUrl: null }, 'en', '/');
  return session.userId;
}

async function ree(ownerId: string, name: string, category: 'life' | 'other', values: { tags?: string[]; description?: string } = {}) {
  const [row] = await db()
    .insert(schema.ree)
    .values({ ownerId, name, slug: uniqueName('slug'), category, ...values })
    .returning({ id: schema.ree.id });
  return row!.id;
}

describeWithDb('official Ree recategorisation', () => {
  it('moves travel guides and literature, and nothing else', async () => {
    const ownerName = uniqueName('RE0 Official');
    const owner = await newUser(ownerName);
    const someone = await newUser(uniqueName('someone'));
    const ids = {
      guide: await ree(owner, 'Japan Travel Guide Assistant', 'life'),
      shortName: await ree(owner, 'Luang Prabang Travel Assistant', 'life', { description: 'Answers travel questions, citing the Wikivoyage guides (CC BY-SA).' }),
      cooking: await ree(owner, 'Cooking Basics Assistant', 'life', { tags: ['Cooking'] }),
      novel: await ree(owner, 'Emma Assistant', 'other', { tags: ['Novel', 'Austen', 'Classics'] }),
      russian: await ree(owner, 'Fathers and Sons Assistant', 'other', { tags: ['Turgenev', 'Russian literature'] }),
      poetry: await ree(owner, 'Leaves of Grass Assistant', 'other', { description: "Answers questions on Whitman's poetry, quoting the 1855 text." }),
      philosophy: await ree(owner, 'The Republic Assistant', 'other', { tags: ['Philosophy', 'Plato'], description: "Answers questions on Plato's Republic." }),
      othersGuide: await ree(someone, 'Peru Travel Guide Assistant', 'life'),
      othersNovel: await ree(someone, 'Dracula Assistant', 'other', { tags: ['Novel'] }),
    };

    const plan = await planRecategorise({ owners: [ownerName] });
    expect(plan.owners.map((row) => row.id)).toEqual([owner]);
    expect(plan.travel.map((row) => row.id).sort()).toEqual([ids.guide, ids.shortName].sort());
    expect(plan.literature.map((row) => row.id).sort()).toEqual([ids.novel, ids.russian, ids.poetry].sort());
    expect(plan.remainingOther.map((row) => row.id)).toEqual([ids.philosophy]);

    expect(await applyRecategorise(plan)).toEqual({ travel: 2, literature: 3 });
    const rows = await db().select({ id: schema.ree.id, category: schema.ree.category }).from(schema.ree).where(inArray(schema.ree.id, Object.values(ids)));
    const category = Object.fromEntries(rows.map((row) => [row.id, row.category]));
    expect(category).toEqual({
      [ids.guide]: 'travel',
      [ids.shortName]: 'travel',
      [ids.cooking]: 'life',
      [ids.novel]: 'literature',
      [ids.russian]: 'literature',
      [ids.poetry]: 'literature',
      [ids.philosophy]: 'other',
      [ids.othersGuide]: 'life',
      [ids.othersNovel]: 'other',
    });

    const again = await planRecategorise({ owners: [ownerName] });
    expect(again.travel).toEqual([]);
    expect(again.literature).toEqual([]);
    expect(await applyRecategorise(again)).toEqual({ travel: 0, literature: 0 });
  });

  it('honours include and exclude by slug', async () => {
    const ownerName = uniqueName('RE0 Official');
    const owner = await newUser(ownerName);
    await ree(owner, 'Utopia Assistant', 'other', { tags: ['Utopia', 'More'] });
    await ree(owner, 'Hamlet Assistant', 'other', { tags: ['Shakespeare', 'Drama'] });
    const [utopia, hamlet] = (await planRecategorise({ owners: [ownerName] })).remainingOther.concat((await planRecategorise({ owners: [ownerName] })).literature);
    const plan = await planRecategorise({ owners: [ownerName], include: [utopia!.slug], exclude: [hamlet!.slug] });
    expect(plan.literature.map((row) => row.name)).toEqual(['Utopia Assistant']);
    expect(plan.remainingOther.map((row) => row.name)).toEqual(['Hamlet Assistant']);
  });
});
