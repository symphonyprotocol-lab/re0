/**
 * Staging a large source while its supplier receipts arrive
 * (lib/services/knowledge.ts): the write of one slice and the charge for the
 * next one's embedding take the source and cost-run rows in the same order,
 * so they wait for each other instead of deadlocking; and a write that fails
 * while the next slice is still embedding fails the run in place, never as an
 * unhandled rejection that would take the whole function instance down.
 */
import { KNOWLEDGE_STAGE_SLICE } from '@/lib/constants';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, count, eq, sql } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { expectChargedAtLeastCost, knowledgeBill } from './billing-audit';

const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path)?.length ?? null,
  readBlob: async (path: string) => blobs.get(path) ?? null,
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const models = await import('@/lib/infra/ai/models');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  models.forgetModelCache();
});
beforeEach(() => { pointModelsAt(fake.baseUrl); fake.billing.embeddingTokens = 1000; fake.billing.omitEmbeddingUsage = false; });
afterAll(async () => { vi.unstubAllEnvs(); await fake?.close(); });

async function userWithRee() {
  const subject = uniqueName('locks');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'L', avatarUrl: null }, 'zh', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: 'Locks', category: 'technology', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  await db().insert(schema.creditGrant).values({ userId, source: 'pack', amount: 100_000, remaining: 100_000 });
  return { userId, ree };
}

/** A document of `paragraphs` passages, one chunk each: more than one staging slice. */
function largeDocument(paragraphs: number): Uint8Array {
  const body = Array.from({ length: paragraphs }, (_, at) => `Paragraph ${at}. ${`section${at} detail `.repeat(90)}`).join('\n\n');
  return new TextEncoder().encode(`# Handbook\n\n${body}\n`);
}

const vectors = (texts: readonly string[], value = 0.5) => texts.map(() => Array.from({ length: 1536 }, () => value));

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Backends waiting on a lock `pid` holds, directly or behind one that is. */
async function waitingBehind(pid: number): Promise<number> {
  const result = await db().execute(sql`
    with direct as (select pid from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid)))
    select ((select count(*) from direct)
      + (select count(*) from pg_stat_activity a
         where a.pid not in (select pid from direct) and exists (select 1 from direct d where d.pid = any(pg_blocking_pids(a.pid)))))::int as n`);
  return Number((result.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/** Every unhandled rejection while `work` runs: one would crash a production instance. */
async function withRejections<T>(work: () => Promise<T>): Promise<{ result: T; rejections: unknown[] }> {
  const rejections: unknown[] = [];
  const listener = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const result = await work();
    /* A rejection is reported a tick after the promise settles unhandled. */
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { result, rejections };
  } finally {
    process.off('unhandledRejection', listener);
  }
}

describeWithDb('staging locks', () => {
  it('writes one slice while the next one\'s supplier charge is recorded, without a deadlock', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/locks/handbook.md`;
    blobs.set(path, largeDocument(KNOWLEDGE_STAGE_SLICE + 120));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'handbook.md' });

    /*
     * The interleaving production hit, made certain: a stand-in holds the
     * cost-run row while the first slice's write queues on it and the
     * second slice's real embedding (its estimate, its request, its receipt)
     * runs against the same rows. Then the stand-in lets go. With the two
     * transactions taking the rows in opposite orders, one was killed as
     * `deadlock detected`.
     */
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let blocker: Promise<void> = Promise.resolve();
    let blockerPid = 0;
    const sizes: number[] = [];
    const original = models.embedTexts;
    const spy = vi.spyOn(models, 'embedTexts')
      .mockImplementationOnce(async (texts, endpoint) => {
        sizes.push(texts.length);
        let holding!: () => void;
        const held = new Promise<void>((resolve) => { holding = resolve; });
        blocker = db().transaction(async (tx) => {
          const pid = await tx.execute(sql`select pg_backend_pid()::int as pid`);
          blockerPid = Number((pid.rows[0] as { pid: number }).pid);
          await tx.select({ id: schema.knowledgeCostRun.id }).from(schema.knowledgeCostRun)
            .where(and(eq(schema.knowledgeCostRun.knowledgeId, id), eq(schema.knowledgeCostRun.status, 'processing')))
            .for('no key update');
          holding();
          await released;
        });
        await held;
        return { vectors: vectors(texts), endpoint: endpoint! };
      })
      .mockImplementationOnce(async (texts, endpoint) => {
        sizes.push(texts.length);
        try {
          await until(async () => (await waitingBehind(blockerPid)) >= 1, 'the first slice\'s write to queue');
          const answer = original(texts, endpoint);
          answer.catch(() => undefined);
          await until(async () => (await waitingBehind(blockerPid)) >= 2, 'the second slice\'s charge to queue');
          release();
          return await answer;
        } finally {
          release();
        }
      })
      .mockImplementation(async (texts, endpoint) => { sizes.push(texts.length); return original(texts, endpoint); });

    try {
      const { result, rejections } = await withRejections(() => knowledge.processKnowledge(id, { profile: false }));
      await blocker;
      expect(rejections).toEqual([]);
      const detail = await knowledge.knowledgeDetail(ree.id, id);
      expect(detail).toMatchObject({ status: 'ready', error: null });
      expect(result).toBe(ree.id);
      expect(sizes).toHaveLength(2);
      expect(detail!.chunkTotal).toBe(sizes[0]! + sizes[1]!);
      /* The second slice's receipt was kept and billed. */
      const [bill] = await expectChargedAtLeastCost(id);
      expect(bill).toMatchObject({ status: 'ready' });
      expect((await knowledgeBill(id)).open).toBe(0);
    } finally {
      release();
      await blocker.catch(() => undefined);
      spy.mockRestore();
    }
  }, 30_000);

  it('fails the run cleanly when a slice\'s write fails while the next one embeds, and logs the database\'s own error', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/locks/broken.md`;
    blobs.set(path, largeDocument(KNOWLEDGE_STAGE_SLICE + 40));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'broken.md' });

    /* The first slice's vectors are refused by the database (pgvector takes no NaN); the second is still embedding when that happens. */
    const spy = vi.spyOn(models, 'embedTexts')
      .mockImplementationOnce(async (texts, endpoint) => ({ vectors: vectors(texts, Number.NaN), endpoint: endpoint! }))
      .mockImplementationOnce(async (texts, endpoint) => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { vectors: vectors(texts), endpoint: endpoint! };
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { result, rejections } = await withRejections(() => knowledge.processKnowledge(id, { profile: false }));
      expect(rejections).toEqual([]);
      expect(result).toBeNull();
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'unknown' });
      expect(spy).toHaveBeenCalledTimes(2);
      /* Nothing is kept for a retry, and nothing stays reserved. */
      const [staged] = await db().select({ n: count() }).from(schema.knowledgeStage).where(eq(schema.knowledgeStage.knowledgeId, id));
      expect(staged?.n).toBe(0);
      expect((await knowledgeBill(id)).open).toBe(0);

      /* The log line carries the cause, not the statement's thousands of parameters. */
      const line = warn.mock.calls.map((call) => String(call[0])).find((text) => text.startsWith(`knowledge ${id} failed`));
      expect(line).toBeDefined();
      expect(line).toMatch(/code=unknown/);
      expect(line).toMatch(/cause=22\w{3} /);
      expect(line).not.toMatch(/params/);
      expect(line!.length).toBeLessThan(1_000);
    } finally {
      warn.mockRestore();
      spy.mockRestore();
    }
  }, 30_000);
});
