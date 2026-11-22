/**
 * Discover's search, against the database, for speed as much as for
 * results: the first level reads the profiles through their binary HNSW
 * index a batch at a time (with the join inside, or on the table alone, the
 * planner scanned every out-of-line vector instead -- a second per search in
 * production); Rees holding few passages are searched exactly, never through
 * the passage index, where one Ree's passages are too thin a slice to find
 * (a named Ree's nearest passage took seconds there); many passages go
 * through the binary passage index and are ordered by their stored vectors.
 * The half-precision and full-precision indexes still answer until the
 * binary ones are built.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { EMBEDDING_DIMENSIONS, EXPLORE_EXACT_PASSAGES, EXPLORE_PROFILE_REES } from '@/lib/constants';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { db, schema } = await import('@/lib/infra/db');
const explore = await import('@/lib/services/explore');
const { BASE_SPACE } = await import('@/lib/services/embedding-space');
const { SEARCH_INDEXES, createIndexStatement } = await import('@/lib/infra/search-indexes');

/*
 * The fixtures' vectors: a sign pattern over every dimension, with `flips`
 * of its signs turned, from a place of its own. Cosine similarity to the
 * unturned pattern is 1 - 2 × flips / 1536, and its binary copy differs in
 * exactly `flips` bits: a gradient in both distances. One-hot vectors (the
 * other files', and these tests' before the binary index) are all as far
 * from each other in bits, and an HNSW graph over them finds an arbitrary
 * one. A seed of its own keeps every test's pattern apart from the others'.
 */
const sign = (seed: number, d: number) => {
  const x = d + seed * 101;
  return (x * x + 3 * x) % 5 < 2 ? -1 : 1;
};
const turned = (d: number, flips: number, from: number) => (((d - from) % EMBEDDING_DIMENSIONS) + EMBEDDING_DIMENSIONS) % EMBEDDING_DIMENSIONS < flips;
const pattern = (seed: number, flips = 0, from = 0) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, d) => (sign(seed, d) * (turned(d, flips, from) ? -1 : 1)) / Math.sqrt(EMBEDDING_DIMENSIONS));
const similarityOf = (flips: number) => 1 - (2 * flips) / EMBEDDING_DIMENSIONS;
const question = (vector: number[]) => ({ vector, model: 'fake-embed', space: BASE_SPACE });
/* The same pattern in SQL, for the many passages (`d` the dimension, from 0). */
const patternSql = (seed: number, flips: SQL, from: SQL) =>
  sql`(select array_agg(case when ((d + ${seed * 101}) * (d + ${seed * 101}) + 3 * (d + ${seed * 101})) % 5 < 2 then -1 else 1 end
    * case when ((d - ${from}) % ${EMBEDDING_DIMENSIONS} + ${EMBEDDING_DIMENSIONS}) % ${EMBEDDING_DIMENSIONS} < ${flips} then -1 else 1 end
    / sqrt(${EMBEDDING_DIMENSIONS}) order by d) from generate_series(0, ${EMBEDDING_DIMENSIONS - 1}) d)::vector`;
/* The small Ree's passages: one-hot, searched exactly only. */
const oneHot = (at: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === at ? 1 : 0));
const DIM = 1530;

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
async function buildSearchIndexes(): Promise<string[]> {
  const { rows } = await db().execute<{ name: string }>(sql`select indexname as name from pg_indexes where schemaname = 'public'`);
  const existing = new Set(rows.map((row) => row.name));
  const built = SEARCH_INDEXES.filter((index) => !existing.has(index.name));
  for (const index of built) await db().execute(sql.raw(createIndexStatement(index, { concurrently: false })));
  explore.forgetSearchIndexCheck();
  return built.map((index) => index.name);
}

async function planOf(settings: SQL, statement: SQL): Promise<string> {
  return db().transaction(async (tx) => {
    await tx.execute(settings);
    const { rows } = await tx.execute(sql`explain (format json) ${statement}`);
    return JSON.stringify(rows[0]);
  });
}

describeWithDb('explore search', () => {
  let built: string[] = [];

  beforeAll(async () => {
    built = await buildSearchIndexes();
  }, 120_000);

  afterAll(async () => {
    if (made.length) {
      await db().delete(schema.knowledge).where(inArray(schema.knowledge.reeId, made));
      await db().delete(schema.ree).where(inArray(schema.ree.id, made));
    }
    /* Leave the database as found: the other files search exactly. */
    for (const name of built) await db().execute(sql.raw(`drop index if exists "${name}"`));
    explore.forgetSearchIndexCheck();
  });

  it('reads the profiles through their binary HNSW index, then keeps public, not excluded Rees', async () => {
    expect(await explore.searchIndexes()).toEqual({ passages: 'bit', profiles: 'bit' });
    const userId = await owner();
    const [shown, hidden, excluded] = [await ree(userId), await ree(userId, { isPublic: false }), await ree(userId)];
    /* A Ree made private keeps its profile until it is rebuilt: it must not be found. */
    for (const id of [shown, hidden, excluded]) {
      await db().insert(schema.reeProfileVector).values({ reeId: id, kind: 'profile', embedding: pattern(1), embeddingSpace: BASE_SPACE });
    }
    const search = explore.profileSearch(question(pattern(1)), { category: null, exclude: [excluded] }, 'bit');
    if (!('stream' in search)) throw new Error('expected the index search');
    expect(await planOf(search.settings, search.stream)).toContain('ree_profile_vector_embedding_bit_idx');
    /* Until it is built, the full-precision index. */
    const fallback = explore.profileSearch(question(pattern(1)), { category: null, exclude: [excluded] }, null);
    if (!('stream' in fallback)) throw new Error('expected the index search');
    expect(await planOf(fallback.settings, fallback.stream)).toContain('ree_profile_vector_embedding_idx');

    const rows = await explore.nearestProfiles(question(pattern(1)), { category: null, exclude: [excluded] });
    /* Ties at 1 only when the same database ran this file before (its Rees are still there): the found Ree is among the nearest. */
    const nearest = (found: { reeId: string; similarity: number }[]) => found.filter((row) => Number(row.similarity) > 0.9999).map((row) => row.reeId);
    expect(nearest(rows)).toContain(shown);
    expect(rows.map((row) => row.reeId)).not.toContain(hidden);
    expect(rows.map((row) => row.reeId)).not.toContain(excluded);
    /* Best first, one row per Ree. */
    expect(rows.map((row) => row.similarity)).toEqual([...rows.map((row) => row.similarity)].sort((a, b) => b - a));
    expect(new Set(rows.map((row) => row.reeId)).size).toBe(rows.length);

    /* With a category, the slice is scanned exactly, and the same Ree leads it. */
    expect('exact' in explore.profileSearch(question(pattern(1)), { category: 'technology', exclude: [excluded] })).toBe(true);
    const inCategory = await explore.nearestProfiles(question(pattern(1)), { category: 'technology', exclude: [excluded] });
    expect(nearest(inCategory)).toContain(shown);
    expect(inCategory.map((row) => row.reeId)).not.toContain(hidden);
  });

  it('reads the profiles a batch at a time until enough Rees have turned up, and scores them by their stored vectors', async () => {
    const userId = await owner();
    /* 45 Rees of 3 vectors each around the question, each Ree nearer than the next: 40 Rees (twice the 20) take three batches. */
    const rees: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      const id = await ree(userId);
      rees.push(id);
      await db().insert(schema.reeProfileVector).values(
        [0, 1, 2].map((j) => ({ reeId: id, kind: 'centroid' as const, embedding: pattern(2, 2 + i * 6 + j * 2, i * 40 + j * 7), embeddingSpace: BASE_SPACE })),
      );
    }
    const found = await explore.nearestProfiles(question(pattern(2)), { category: null, exclude: [rees[1]!] });
    expect(found).toHaveLength(EXPLORE_PROFILE_REES);
    for (const row of found) expect(rees).toContain(row.reeId);
    expect(found.map((row) => row.reeId)).not.toContain(rees[1]);
    /*
     * Scored by the stored vector of the nearest row read of each Ree: the
     * nearest Ree's rows have 2, 4 and 6 signs turned, and the approximate
     * scan may reach it through its second or third before the first (once
     * in a full run). Any of the three is a stored vector's similarity, not
     * the bits'.
     */
    expect(found[0]).toMatchObject({ reeId: rees[0] });
    expect([2, 4, 6].some((flips) => Math.abs(found[0]!.similarity - similarityOf(flips)) < 1e-5)).toBe(true);
    expect(found.map((row) => row.similarity)).toEqual([...found.map((row) => row.similarity)].sort((a, b) => b - a));
    /* Approximate, but near: the 20 found are among the nearest 25 (each Ree 6 signs farther than the last). */
    for (const row of found) expect(rees.indexOf(row.reeId)).toBeLessThan(26);
  });

  it('searches Rees with few passages exactly and many through the binary index, near either way', async () => {
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
     * One past the limit. Passage `g` has 20 to 720 signs turned as `g`
     * grows, each from a place of its own; passage 7 none. So the nearest is
     * unique (1, against at most 0.974), and both distances have a gradient
     * to follow, as real passages near a topic do.
     */
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding)
      select ${largeSource}::uuid, ${large}::uuid, g, 'passage ' || g, ${patternSql(3, sql`flips`, sql`g * 37`)}
      from (select g, case when g = 7 then 0 else 20 + g * 700 / ${EXPLORE_EXACT_PASSAGES} end as flips from generate_series(0, ${EXPLORE_EXACT_PASSAGES}) g) turned`);
    await db().execute(sql`analyze ${schema.chunk}`);

    expect(await explore.fewPassages([small])).toBe(true);
    expect(await explore.fewPassages([large])).toBe(false);
    expect(await explore.fewPassages([small, large])).toBe(false);

    const [near] = await explore.nearestPassages(question(oneHot(DIM + 1)), [small], 1);
    expect(near).toMatchObject({ reeId: small, content: 'the near passage' });
    expect(near!.similarity).toBeCloseTo(1, 3);

    const search = explore.passageSearch(question(pattern(3)), [large], 1, 'bit');
    expect(await planOf(search.settings, search.indexed)).toContain('chunk_embedding_bit_idx');
    /* Until the binary pair is built, the half-precision pair. */
    const half = explore.passageSearch(question(pattern(3)), [large], 1, 'half');
    expect(await planOf(half.settings, half.indexed)).toContain('chunk_embedding_half_idx');
    /*
     * Through the index, the result is near, not necessarily the nearest: an
     * HNSW graph is approximate (on CI's x86 runners one run of the
     * half-precision search missed the nearest). "Near" is the top 2% here:
     * at most 34 signs turned, a similarity of 0.955 or more, some 60 of the
     * 3,001.
     */
    const [deep] = await explore.nearestPassages(question(pattern(3)), [large], 1);
    expect(deep!.reeId).toBe(large);
    expect(deep!.similarity).toBeGreaterThanOrEqual(similarityOf(34));
    /* The similarity is the stored vectors', not the bits'. */
    const flipped = deep!.content === 'passage 7' ? 0 : 20 + Math.floor((Number(deep!.content.slice('passage '.length)) * 700) / EXPLORE_EXACT_PASSAGES);
    expect(deep!.similarity).toBeCloseTo(similarityOf(flipped), 4);
    /* The exact scan, the fallback, finds the nearest itself. */
    const { rows: [exactly] } = await db().execute<{ content: string; similarity: number }>(search.exact);
    expect(exactly).toMatchObject({ content: 'passage 7' });
    expect(Number(exactly!.similarity)).toBeCloseTo(1, 3);
    /* Both Rees together go through the index too: three passages, all near, nearest first. */
    const both = await explore.nearestPassages(question(pattern(3)), [small, large], 3);
    expect(both).toHaveLength(3);
    for (const passage of both) {
      expect(passage.reeId).toBe(large);
      expect(passage.similarity).toBeGreaterThanOrEqual(similarityOf(34));
    }
    expect(both.map((passage) => passage.similarity)).toEqual([...both.map((passage) => passage.similarity)].sort((a, b) => b - a));
  }, 120_000);
});
