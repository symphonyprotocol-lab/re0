/**
 * Discover's search, against the database, for speed as much as for
 * results: the first level reads the profile table through its HNSW index
 * (with the join inside, or on the table alone, the planner scanned every
 * out-of-line vector instead -- a second per search in production); Rees
 * holding few passages are searched exactly, never through the passage
 * index, where one Ree's passages are too thin a slice to find (a named
 * Ree's nearest passage took seconds there); many passages still go through
 * the index. Results are the same either way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { EXPLORE_EXACT_PASSAGES } from '@/lib/constants';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { db, schema } = await import('@/lib/infra/db');
const explore = await import('@/lib/services/explore');
const { BASE_SPACE } = await import('@/lib/services/embedding-space');
const { SEARCH_INDEXES } = await import('@/lib/infra/search-indexes');

/* Dimensions no other file's fixtures use (they one-hot their first few hundred). */
const DIM = 1530;
const oneHot = (at: number) => Array.from({ length: 1536 }, (_, index) => (index === at ? 1 : 0));
const question = (at: number) => ({ vector: oneHot(at), model: 'fake-embed', space: BASE_SPACE });

async function owner(): Promise<string> {
  const subject = uniqueName('es');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'Owner', avatarUrl: null }, 'en', '/');
  return userId;
}

/* Every Ree these tests make, removed after them with their sources (the passages and profiles go with those). */
const made: string[] = [];

async function ree(ownerId: string, { isPublic = true } = {}): Promise<string> {
  const [row] = await db()
    .insert(schema.ree)
    .values({ ownerId, name: uniqueName('ree'), slug: uniqueName('slug'), isPublic, isPublished: isPublic, category: 'technology' })
    .returning({ id: schema.ree.id });
  made.push(row!.id);
  return row!.id;
}

async function source(reeId: string): Promise<string> {
  const [row] = await db()
    .insert(schema.knowledge)
    .values({ reeId, kind: 'text', title: 'Source', originalTitle: 'Source', status: 'ready', content: 'text' })
    .returning({ id: schema.knowledge.id });
  return row!.id;
}

/* The index statements as `ensureSearchIndexes` writes them, without CONCURRENTLY (nothing else runs). */
async function buildSearchIndexes(): Promise<void> {
  for (const index of SEARCH_INDEXES) {
    await db().execute(sql.raw(`create index if not exists "${index.name}" on public.chunk using hnsw (("${index.column}"::halfvec(1536)) halfvec_cosine_ops)`));
  }
  explore.forgetSearchIndexCheck();
}

describeWithDb('explore search', () => {
  let builtIndexes = false;

  beforeAll(async () => {
    const before = await explore.searchIndexesReady();
    if (!before) {
      await buildSearchIndexes();
      builtIndexes = true;
    }
  }, 120_000);

  afterAll(async () => {
    if (made.length) {
      await db().delete(schema.knowledge).where(inArray(schema.knowledge.reeId, made));
      await db().delete(schema.ree).where(inArray(schema.ree.id, made));
    }
    /* Leave the database as found: the other files search exactly. */
    if (builtIndexes) {
      for (const index of SEARCH_INDEXES) await db().execute(sql.raw(`drop index if exists "${index.name}"`));
    }
    explore.forgetSearchIndexCheck();
  });

  it('reads the profiles through their HNSW index, then keeps public, not excluded Rees', async () => {
    const userId = await owner();
    const [shown, hidden, excluded] = [await ree(userId), await ree(userId, { isPublic: false }), await ree(userId)];
    /* A Ree made private keeps its profile until it is rebuilt: it must not be found. */
    for (const id of [shown, hidden, excluded]) {
      await db().insert(schema.reeProfileVector).values({ reeId: id, kind: 'profile', embedding: oneHot(DIM), embeddingSpace: BASE_SPACE });
    }
    const search = explore.profileSearch(question(DIM), { category: null, exclude: [excluded] });
    const { plan, rows } = await db().transaction(async (tx) => {
      await tx.execute(search.settings!);
      const explained = await tx.execute<{ 'QUERY PLAN': unknown }>(sql`explain (format json) ${search.nearest}`);
      const found = await tx.execute<{ reeId: string; similarity: number }>(search.nearest);
      return { plan: JSON.stringify(explained.rows[0]!['QUERY PLAN']), rows: found.rows };
    });
    expect(plan).toContain('ree_profile_vector_embedding_idx');
    /* Ties at 1 only when the same database ran this file before (its Rees are still there): the found Ree is among the nearest. */
    const nearest = (found: { reeId: string; similarity: number }[]) => found.filter((row) => Number(row.similarity) > 0.9999).map((row) => row.reeId);
    expect(nearest(rows)).toContain(shown);
    expect(rows.map((row) => row.reeId)).not.toContain(hidden);
    expect(rows.map((row) => row.reeId)).not.toContain(excluded);

    /* With a category, the slice is scanned exactly, and the same Ree leads it. */
    const sliced = explore.profileSearch(question(DIM), { category: 'technology', exclude: [excluded] });
    expect(sliced.settings).toBeNull();
    const { rows: inCategory } = await db().execute<{ reeId: string; similarity: number }>(sliced.nearest);
    expect(nearest(inCategory)).toContain(shown);
    expect(inCategory.map((row) => row.reeId)).not.toContain(hidden);
  });

  it('searches Rees with few passages exactly and many through the index, finding the nearest either way', async () => {
    expect(await explore.searchIndexesReady()).toBe(true);
    const userId = await owner();
    const small = await ree(userId);
    const smallSource = await source(small);
    await db().insert(schema.chunk).values([
      { knowledgeId: smallSource, reeId: small, ordinal: 0, content: 'the near passage', embedding: oneHot(DIM + 1) },
      { knowledgeId: smallSource, reeId: small, ordinal: 1, content: 'a far passage', embedding: oneHot(DIM + 2) },
    ]);
    const large = await ree(userId);
    const largeSource = await source(large);
    /*
     * One past the limit, and not degenerate: one-hot passages are all
     * orthogonal, equally far from the question, and an HNSW graph over them
     * finds an arbitrary one (CI did). Here every passage leans towards the
     * question's dimension by its own amount, 0.3 to 0.9 as `g` grows, the
     * rest on a dimension of its own; passage 7 points straight at it. So the
     * nearest is unique and well apart (1 against at most 0.9), and the graph
     * has a gradient to follow, as real passages near a topic do.
     */
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding)
      select ${largeSource}::uuid, ${large}::uuid, g, 'passage ' || g,
        (select array_agg(case when i = ${DIM + 3} then lean when i = g % 1500 then sqrt(1 - lean * lean) else 0 end order by i) from generate_series(0, 1535) i)::vector
      from (select g, case when g = 7 then 1.0 else 0.3 + 0.6 * g / ${EXPLORE_EXACT_PASSAGES} end as lean from generate_series(0, ${EXPLORE_EXACT_PASSAGES}) g) leaning`);
    await db().execute(sql`analyze ${schema.chunk}`);

    expect(await explore.fewPassages([small])).toBe(true);
    expect(await explore.fewPassages([large])).toBe(false);
    expect(await explore.fewPassages([small, large])).toBe(false);

    const [near] = await explore.nearestPassages(question(DIM + 1), [small], 1);
    expect(near).toMatchObject({ reeId: small, content: 'the near passage' });
    expect(near!.similarity).toBeCloseTo(1, 3);
    const [deep] = await explore.nearestPassages(question(DIM + 3), [large], 1);
    expect(deep).toMatchObject({ reeId: large, content: 'passage 7' });
    expect(deep!.similarity).toBeCloseTo(1, 3);
    /* Both Rees together go through the index too, and find what the exact scan finds. */
    const both = await explore.nearestPassages(question(DIM + 3), [small, large], 3);
    const { rows: exact } = await db().execute<{ content: string; similarity: number }>(explore.passageSearch(question(DIM + 3), [small, large], 3).exact);
    /* The runners-up lean within 0.0002 of each other: the index may swap them, never by more than that. */
    expect(both).toHaveLength(exact.length);
    both.forEach((passage, at) => expect(passage.similarity).toBeCloseTo(Number(exact[at]!.similarity), 2));
    expect(both[0]).toMatchObject({ reeId: large, content: 'passage 7' });
  }, 120_000);
});
