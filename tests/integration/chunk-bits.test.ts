/**
 * `chunk_bit`, the binary copies of the passages' vectors (0079): the
 * trigger keeps them in step with every write of a vector slot -- the
 * insert of a source's passages (knowledge.ts), a re-embedding's fill of
 * the spare slot and its clean-up (reembed.ts) -- the backfill fills what
 * was stored before it, and a named Ree's nearest passage -- and a
 * follow-up's few Rees' nearest passages -- are ranked by them and read from
 * the stored vectors of only the nearest few.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@neondatabase/serverless';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { EMBEDDING_DIMENSIONS, EXPLORE_OWN_BIT_CANDIDATES } from '@/lib/constants';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { db, schema } = await import('@/lib/infra/db');
const explore = await import('@/lib/services/explore');
const { BASE_SPACE } = await import('@/lib/services/embedding-space');
const { backfillChunkBits, chunkBitsComplete, MISSING_SQL } = await import('@/lib/infra/chunk-bits');

/* Sign patterns, as in explore-search.test.ts: `flips` signs turned from `from`; cosine 1 - 2 × flips / 1536, and exactly `flips` bits apart. */
const sign = (seed: number, d: number) => {
  const x = d + seed * 101;
  return (x * x + 3 * x) % 5 < 2 ? -1 : 1;
};
const turned = (d: number, flips: number, from: number) => (((d - from) % EMBEDDING_DIMENSIONS) + EMBEDDING_DIMENSIONS) % EMBEDDING_DIMENSIONS < flips;
const pattern = (seed: number, flips = 0, from = 0) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, d) => (sign(seed, d) * (turned(d, flips, from) ? -1 : 1)) / Math.sqrt(EMBEDDING_DIMENSIONS));
const similarityOf = (flips: number) => 1 - (2 * flips) / EMBEDDING_DIMENSIONS;
const OTHER_SPACE = '11111111-1111-1111-1111-111111111111';
const question = (vector: number[], space = BASE_SPACE) => ({ vector, model: 'fake-embed', space });
const literal = (vector: number[]) => `[${vector.join(',')}]`;

const made: string[] = [];

async function ree(): Promise<string> {
  const subject = uniqueName('cb');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'Owner', avatarUrl: null }, 'en', '/');
  const [row] = await db()
    .insert(schema.ree)
    .values({ ownerId: userId, name: uniqueName('ree'), slug: uniqueName('slug'), isPublic: true, isPublished: true, category: 'technology' })
    .returning({ id: schema.ree.id });
  made.push(row!.id);
  return row!.id;
}

async function source(reeId: string, enabled = true): Promise<string> {
  const [row] = await db()
    .insert(schema.knowledge)
    .values({ reeId, kind: 'text', title: 'Source', originalTitle: 'Source', status: 'ready', content: 'text', enabled })
    .returning({ id: schema.knowledge.id });
  return row!.id;
}

type BitRow = { slot: number; space: string; ree_id: string; knowledge_id: string; same: boolean };

/* A chunk's rows, each with whether its bits are the binary copy of the slot's vector now. */
async function bitsOf(chunkId: string): Promise<BitRow[]> {
  const { rows } = await db().execute<BitRow>(sql`select b.slot, b.space::text, b.ree_id::text, b.knowledge_id::text,
      b.bits = binary_quantize(case when b.slot = 0 then c.embedding else c.embedding_next end)::bit(1536) as same
    from chunk_bit b join chunk c on c.id = b.chunk_id where b.chunk_id = ${chunkId}::uuid order by b.slot`);
  return rows;
}

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Subplan Name'?: string;
  'CTE Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
};
const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

/* The statement run (EXPLAIN ANALYZE, VERBOSE for each node's output columns), as a tree; seq scans off as in `planOf`. */
async function runPlanOf(statement: SQL): Promise<PlanNode> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(sql`explain (analyze, verbose, format json) ${statement}`);
    const raw = rows[0]!['QUERY PLAN'];
    return ((typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PlanNode }[])[0]!.Plan;
  });
}

/* Seq scans off: these tables are a few hundred rows, where reading all of one beats any index; production's hold a million. */
async function planOf(statement: SQL): Promise<string> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const { rows } = await tx.execute(sql`explain (format json) ${statement}`);
    return JSON.stringify(rows[0]);
  });
}

describeWithDb('chunk_bit', () => {
  afterAll(async () => {
    if (made.length) {
      await db().delete(schema.knowledge).where(inArray(schema.knowledge.reeId, made));
      await db().delete(schema.ree).where(inArray(schema.ree.id, made));
    }
    await db().execute(sql`update chunk_bit_backfill set completed_at = coalesce(completed_at, now())`);
    explore.forgetSearchIndexCheck();
  });

  it('follows every write of a slot: insert, the spare slot filled and cleared, a space or source changed, a delete', async () => {
    const id = await ree();
    const first = await source(id);
    const second = await source(id);
    /* As knowledge.ts stores a source's passages: the first slot, tagged. */
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding, embedding_space, locator)
      values (${first}::uuid, ${id}::uuid, 0, 'one', ${literal(pattern(5))}::vector, ${BASE_SPACE}::uuid, '{}'::jsonb),
        (${first}::uuid, ${id}::uuid, 1, 'none', null, null, '{}'::jsonb)`);
    const [one, none] = (await db().select({ id: schema.chunk.id }).from(schema.chunk).where(sql`${schema.chunk.knowledgeId} = ${first}::uuid order by ${schema.chunk.ordinal}`)).map((row) => row.id);
    expect(await bitsOf(one!)).toEqual([{ slot: 0, space: BASE_SPACE, ree_id: id, knowledge_id: first, same: true }]);
    expect(await bitsOf(none!)).toEqual([]);

    /* As reembed.ts fills the spare slot (the case keeps the slot in use as it is). */
    await db().execute(sql`update ${schema.chunk} c set
        embedding = case when true then c.embedding else v.e end,
        embedding_space = case when true then c.embedding_space else ${OTHER_SPACE}::uuid end,
        embedding_next = case when true then v.e else c.embedding_next end,
        embedding_next_space = case when true then ${OTHER_SPACE}::uuid else c.embedding_next_space end
      from (values (${one}::uuid, ${literal(pattern(6))}::vector)) as v(id, e) where c.id = v.id`);
    expect(await bitsOf(one!)).toEqual([
      { slot: 0, space: BASE_SPACE, ree_id: id, knowledge_id: first, same: true },
      { slot: 1, space: OTHER_SPACE, ree_id: id, knowledge_id: first, same: true },
    ]);

    /* A write that touches no slot leaves the rows alone. */
    const before = await db().execute<{ x: string }>(sql`select xmin::text as x from chunk_bit where chunk_id = ${one}::uuid order by slot`);
    await db().execute(sql`update ${schema.chunk} set content = 'one, again' where id = ${one}::uuid`);
    await db().execute(sql`update ${schema.chunk} set embedding = embedding where id = ${one}::uuid`);
    expect((await db().execute<{ x: string }>(sql`select xmin::text as x from chunk_bit where chunk_id = ${one}::uuid order by slot`)).rows).toEqual(before.rows);

    /* The first slot re-tagged: its row moves to that space. A new vector: new bits. */
    await db().execute(sql`update ${schema.chunk} set embedding_space = ${OTHER_SPACE}::uuid, embedding_next = ${literal(pattern(7))}::vector where id = ${one}::uuid`);
    expect(await bitsOf(one!)).toEqual([
      { slot: 0, space: OTHER_SPACE, ree_id: id, knowledge_id: first, same: true },
      { slot: 1, space: OTHER_SPACE, ree_id: id, knowledge_id: first, same: true },
    ]);

    /* As reembed.ts clears stale slots: a slot without its vector, or the spare one without its tag, has no row. */
    await db().execute(sql`update ${schema.chunk} set embedding = null, embedding_space = null where id = ${one}::uuid`);
    expect((await bitsOf(one!)).map((row) => row.slot)).toEqual([1]);
    await db().execute(sql`update ${schema.chunk} set embedding_next_space = null where id = ${one}::uuid`);
    expect(await bitsOf(one!)).toEqual([]);
    await db().execute(sql`update ${schema.chunk} set embedding = ${literal(pattern(5))}::vector where id = ${one}::uuid`);
    expect(await bitsOf(one!)).toEqual([{ slot: 0, space: BASE_SPACE, ree_id: id, knowledge_id: first, same: true }]);

    /* Moved to another source: the row follows. */
    await db().execute(sql`update ${schema.chunk} set knowledge_id = ${second}::uuid where id = ${one}::uuid`);
    expect((await bitsOf(one!))[0]).toMatchObject({ knowledge_id: second });

    /* Deleted with its passage, and with its source (as knowledge.ts replaces a source's passages). */
    await db().delete(schema.chunk).where(sql`${schema.chunk.id} = ${one}::uuid`);
    expect((await db().execute(sql`select 1 from chunk_bit where chunk_id = ${one}::uuid`)).rows).toHaveLength(0);
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding) values (${second}::uuid, ${id}::uuid, 0, 'two', ${literal(pattern(5))}::vector)`);
    await db().delete(schema.knowledge).where(sql`${schema.knowledge.id} = ${second}::uuid`);
    expect((await db().execute(sql`select 1 from chunk_bit where knowledge_id = ${second}::uuid`)).rows).toHaveLength(0);
  });

  it('fills what was stored before the trigger, picks up where it stopped, drops rows no slot backs, and marks itself complete', async () => {
    const id = await ree();
    const src = await source(id);
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding, embedding_next, embedding_next_space)
      select ${src}::uuid, ${id}::uuid, g, 'passage ' || g, ${literal(pattern(8))}::vector,
        case when g % 3 = 0 then ${literal(pattern(9))}::vector end, case when g % 3 = 0 then ${OTHER_SPACE}::uuid end
      from generate_series(0, 24) g`);
    /* As before 0079: no rows, and no mark. A row backed by nothing, as a slot cleared mid-copy leaves. */
    await db().execute(sql`delete from chunk_bit where ree_id = ${id}::uuid`);
    await db().execute(sql`update chunk_bit_backfill set completed_at = null`);
    const [stray] = (await db().execute<{ id: string }>(sql`select id from chunk where knowledge_id = ${src}::uuid and ordinal = 1`)).rows;
    await db().execute(sql`insert into chunk_bit (chunk_id, slot, space, ree_id, knowledge_id, bits)
      values (${stray!.id}::uuid, 1, ${OTHER_SPACE}::uuid, ${id}::uuid, ${src}::uuid, binary_quantize(${literal(pattern(9))}::vector)::bit(1536))`);
    explore.forgetSearchIndexCheck();
    expect(await explore.chunkBitsReady()).toBe(false);

    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      expect(await chunkBitsComplete(client)).toBe(false);
      expect(Number((await client.query(MISSING_SQL)).rows[0]!.missing)).toBeGreaterThanOrEqual(25 + 9);
      const pauses: number[] = [];
      const run = await backfillChunkBits(client, { batch: 10, pauseMs: 5, sleep: async (ms) => void pauses.push(ms) });
      expect(run).toMatchObject({ completed: true, missing: 0, dropped: 1 });
      expect(run.inserted).toBeGreaterThanOrEqual(25 + 9);
      /* Ten passages a statement (this source's 25 took three), a pause after every ten. */
      expect(run.statements).toBeGreaterThanOrEqual(3);
      expect(pauses.length).toBeGreaterThanOrEqual(2);
      expect(pauses.length).toBeLessThanOrEqual(run.statements);
      expect(pauses.every((ms) => ms === 5)).toBe(true);
      const { rows } = await db().execute<{ slot: number; n: number; same: number }>(sql`select b.slot, count(*)::int as n,
          count(*) filter (where b.bits = binary_quantize(case when b.slot = 0 then c.embedding else c.embedding_next end)::bit(1536))::int as same
        from chunk_bit b join chunk c on c.id = b.chunk_id where b.ree_id = ${id}::uuid group by b.slot order by b.slot`);
      expect(rows).toEqual([{ slot: 0, n: 25, same: 25 }, { slot: 1, n: 9, same: 9 }]);
      expect(await chunkBitsComplete(client)).toBe(true);
      explore.forgetSearchIndexCheck();
      expect(await explore.chunkBitsReady()).toBe(true);

      /* Again: nothing to add, still complete. */
      const again = await backfillChunkBits(client, { batch: 5000, pauseMs: 0 });
      expect(again).toMatchObject({ inserted: 0, dropped: 0, missing: 0, completed: true });
    } finally {
      await client.end();
    }
  });

  it("ranks a named Ree's passages by their bits, then by the stored vectors of the nearest few, answerable and in the question's space only", async () => {
    const id = await ree();
    const src = await source(id);
    const off = await source(id, false);
    /*
     * 300 passages, passage g with 10 + g signs turned from a place of its
     * own, so the nearest is passage 0 (10 turned). A nearer one in a
     * disabled source, and one nearer still in another space only, must
     * not be found.
     */
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding)
      select ${src}::uuid, ${id}::uuid, g, 'passage ' || g, v.e from generate_series(0, 299) g,
        lateral (select (select array_agg(case when ((d + 1010) * (d + 1010) + 3 * (d + 1010)) % 5 < 2 then -1 else 1 end
          * case when ((d - g * 29) % 1536 + 1536) % 1536 < 10 + g then -1 else 1 end / sqrt(1536) order by d) from generate_series(0, 1535) d)::vector as e) v`);
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding) values (${off}::uuid, ${id}::uuid, 0, 'disabled', ${literal(pattern(10, 2))}::vector)`);
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding, embedding_next, embedding_next_space)
      values (${src}::uuid, ${id}::uuid, 300, 'other space', ${literal(pattern(10, 900))}::vector, ${literal(pattern(10))}::vector, ${OTHER_SPACE}::uuid)`);
    await db().execute(sql`analyze chunk_bit`);

    const [near] = await explore.nearestOwnPassage(question(pattern(10)), id);
    expect(near).toMatchObject({ reeId: id, content: 'passage 0' });
    expect(near!.similarity).toBeCloseTo(similarityOf(10), 4);
    /* In the other space, the passage whose spare slot is there. */
    const [other] = await explore.nearestOwnPassage(question(pattern(10), OTHER_SPACE), id);
    expect(other).toMatchObject({ content: 'other space' });
    expect(other!.similarity).toBeCloseTo(1, 4);
    /* A Ree with nothing there: nothing. */
    expect(await explore.nearestOwnPassage(question(pattern(10)), await ree())).toEqual([]);

    /* The candidates come from chunk_bit by Ree and space, before any chunk is read. */
    const plan = await planOf(explore.ownPassageSearch(question(pattern(10)), id));
    expect(plan).toContain('chunk_bit_ree_idx');
    expect(plan).toContain('"CTE Name":"near"');
    /* Then only the candidates' passages, by key. */
    expect(plan).toContain('chunk_pkey');
    expect(plan).not.toContain('chunk_embedding');
    expect(EXPLORE_OWN_BIT_CANDIDATES).toBeGreaterThanOrEqual(20);
  });

  it("ranks a follow-up's few Rees' passages by their bits, reads only the nearest few's vectors, and scans exactly until the bits are filled or when the ranking fails", async () => {
    await db().execute(sql`update chunk_bit_backfill set completed_at = coalesce(completed_at, now())`);
    explore.forgetSearchIndexCheck();
    const [first, second, outside] = [await ree(), await ree(), await ree()];
    const [firstSource, secondSource, outsideSource] = [await source(first), await source(second), await source(outside)];
    const off = await source(first, false);
    /*
     * 150 passages in each of two Rees, the first Ree's passage g with
     * 10 + 2g signs turned and the second's with 11 + 2g, each from a place
     * of its own: the nearest five are first 0, second 0, first 1, second 1,
     * first 2. Nearer ones in a Ree not asked about, in a disabled source,
     * and in another space only, must not be found.
     */
    const many = (reeId: string, knowledgeId: string, base: number, shift: number) =>
      db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding)
        select ${knowledgeId}::uuid, ${reeId}::uuid, g, ${`${shift}:`} || g, v.e from generate_series(0, 149) g,
          lateral (select (select array_agg(case when ((d + 1111) * (d + 1111) + 3 * (d + 1111)) % 5 < 2 then -1 else 1 end
            * case when ((d - g * 31 - ${shift}) % 1536 + 1536) % 1536 < ${base} + 2 * g then -1 else 1 end / sqrt(1536) order by d) from generate_series(0, 1535) d)::vector as e) v`);
    await many(first, firstSource, 10, 0);
    await many(second, secondSource, 11, 7);
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding) values
      (${outsideSource}::uuid, ${outside}::uuid, 0, 'outside', ${literal(pattern(11))}::vector),
      (${off}::uuid, ${first}::uuid, 0, 'disabled', ${literal(pattern(11, 1))}::vector)`);
    await db().execute(sql`insert into ${schema.chunk} (knowledge_id, ree_id, ordinal, content, embedding, embedding_next, embedding_next_space)
      values (${secondSource}::uuid, ${second}::uuid, 150, 'other space', ${literal(pattern(11, 900))}::vector, ${literal(pattern(11, 2))}::vector, ${OTHER_SPACE}::uuid)`);
    await db().execute(sql`analyze chunk_bit`);
    expect(await explore.fewPassages([first, second])).toBe(true);

    const want = [['0:0', 10], ['7:0', 11], ['0:1', 12], ['7:1', 13], ['0:2', 14]] as const;
    const found = await explore.nearestPassages(question(pattern(11)), [first, second], 5);
    expect(found.map((passage) => passage.content)).toEqual(want.map(([content]) => content));
    found.forEach((passage, index) => expect(passage.similarity).toBeCloseTo(similarityOf(want[index]![1]), 4));
    expect(found.map((passage) => passage.reeId)).toEqual([first, second, first, second, first]);
    /* The statement alone answers the same; in the other space, the passage whose spare slot is there. */
    const { rows: direct } = await db().execute<{ content: string }>(explore.bitPassageSearch(question(pattern(11)), [first, second], 5));
    expect(direct.map((row) => row.content)).toEqual(want.map(([content]) => content));
    expect((await explore.nearestPassages(question(pattern(11), OTHER_SPACE), [first, second], 5)).map((passage) => passage.content)).toEqual(['other space']);

    /*
     * The candidates come from chunk_bit by Ree and space, before any chunk
     * is read: nothing under the CTE touches `chunk` or a vector column.
     * Then only the candidates' passages are read, by key -- 100 of the 302
     * in these Rees -- so only their vectors are detoasted.
     */
    const take = Math.max(2 * 5, EXPLORE_OWN_BIT_CANDIDATES);
    const plan = await runPlanOf(explore.bitPassageSearch(question(pattern(11)), [first, second], 5));
    const all = nodesOf(plan);
    const cte = all.find((node) => node['Subplan Name'] === 'CTE near');
    expect(cte).toBeDefined();
    const below = nodesOf(cte!);
    expect(below.some((node) => node['Index Name'] === 'chunk_bit_ree_idx')).toBe(true);
    expect(below.some((node) => node['Relation Name'] === 'chunk')).toBe(false);
    expect(JSON.stringify(cte)).not.toMatch(/embedding/);
    const chunkReads = all.filter((node) => node['Relation Name'] === 'chunk');
    expect(chunkReads.length).toBeGreaterThan(0);
    expect(chunkReads.every((node) => node['Index Name'] === 'chunk_pkey')).toBe(true);
    const chunkRows = chunkReads.reduce((sum, node) => sum + (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1), 0);
    expect(chunkRows).toBeGreaterThan(0);
    expect(chunkRows).toBeLessThanOrEqual(take);
    expect(JSON.stringify(plan)).not.toContain('chunk_embedding');

    /* Proof of which path answers: without its chunk_bit row, the nearest passage is out of the ranking, not out of the exact scan. */
    const [nearest] = (await db().execute<{ id: string }>(sql`select id from chunk where ree_id = ${first}::uuid and content = '0:0'`)).rows;
    await db().execute(sql`delete from chunk_bit where chunk_id = ${nearest!.id}::uuid`);
    expect((await explore.nearestPassages(question(pattern(11)), [first, second], 1))[0]!.content).toBe('7:0');

    /* A ranking that fails answers by the exact scan. */
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    await db().execute(sql`alter table chunk_bit rename to chunk_bit_away`);
    try {
      expect((await explore.nearestPassages(question(pattern(11)), [first, second], 1))[0]!.content).toBe('0:0');
    } finally {
      await db().execute(sql`alter table chunk_bit_away rename to chunk_bit`);
      console.error = log;
    }
    expect(String(errors[0])).toMatch(/chunk_bit ranking failed, scanning exactly/);

    /* Until the bits are filled, the exact scan. */
    await db().execute(sql`update chunk_bit_backfill set completed_at = null`);
    explore.forgetSearchIndexCheck();
    try {
      expect(await explore.chunkBitsReady()).toBe(false);
      const exactly = await explore.nearestPassages(question(pattern(11)), [first, second], 5);
      expect(exactly.map((passage) => passage.content)).toEqual(want.map(([content]) => content));
    } finally {
      await db().execute(sql`update chunk_bit_backfill set completed_at = now()`);
      explore.forgetSearchIndexCheck();
    }
  }, 120_000);
});
