/**
 * Large sources finish instead of being killed (lib/services/knowledge.ts):
 * a run stages its embedded passages slice by slice; when it stops beating
 * its heartbeat, `recoverStale` settles what it spent and queues the source
 * again, and the next attempt embeds only what was not staged -- nobody pays
 * twice. After `KNOWLEDGE_MAX_RESUMES` the source fails as `interrupted`.
 */
import { KNOWLEDGE_CLAIM_WINDOW_MS, KNOWLEDGE_HEARTBEAT_STALE_MS, KNOWLEDGE_MAX_RESUMES, KNOWLEDGE_SLOT_POOLS, KNOWLEDGE_STAGE_SLICE } from '@/lib/constants';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { asc, count, eq, inArray } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { expectChargedAtLeastCost, knowledgeBill } from './billing-audit';

const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
/** Every Blob read, to tell a resumed run that read the upload again from one that did not. */
const reads = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path)?.length ?? null,
  readBlob: async (path: string) => { reads.push(path); return blobs.get(path) ?? null; },
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
  const subject = uniqueName('resume');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'R', avatarUrl: null }, 'zh', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: 'Large', category: 'technology', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  await db().insert(schema.creditGrant).values({ userId, source: 'pack', amount: 100_000, remaining: 100_000 });
  return { userId, ree };
}

/** A document of `paragraphs` passages: each paragraph is long enough to be one chunk of its own. */
function largeDocument(paragraphs: number): Uint8Array {
  const body = Array.from({ length: paragraphs }, (_, at) => `Paragraph ${at}. ${`section${at} detail `.repeat(90)}`).join('\n\n');
  return new TextEncoder().encode(`# Handbook\n\n${body}\n`);
}

async function stagedCount(id: string): Promise<number> {
  const [row] = await db().select({ n: count() }).from(schema.knowledgeStage).where(eq(schema.knowledgeStage.knowledgeId, id));
  return row?.n ?? 0;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** After a heartbeat has been silent long enough to call the run dead. */
const silent = () => new Date(Date.now() + KNOWLEDGE_HEARTBEAT_STALE_MS + 60_000);

describeWithDb('resuming killed runs', () => {
  it('resumes a killed run from its staged passages, billing each passage once', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/large/handbook.md`;
    const passages = KNOWLEDGE_STAGE_SLICE + 120;
    blobs.set(path, largeDocument(passages));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'handbook.md' });

    const original = models.embedTexts;
    let enterSecond!: () => void;
    const secondEntered = new Promise<void>((resolve) => { enterSecond = resolve; });
    let answerFirst!: () => void;
    const firstAnswered = new Promise<void>((resolve) => { answerFirst = resolve; });
    const sizes: number[] = [];
    const spy = vi.spyOn(models, 'embedTexts')
      .mockImplementationOnce(async (texts, endpoint) => { sizes.push(texts.length); return original(texts, endpoint); })
      /*
       * The second slice takes so long the run misses its heartbeats and is
       * presumed dead -- but it is alive, and its vectors come back later.
       */
      .mockImplementationOnce(async (texts, endpoint) => {
        sizes.push(texts.length);
        enterSecond();
        await firstAnswered;
        return { vectors: texts.map(() => Array.from({ length: 1536 }, () => 0.5)), endpoint: endpoint! };
      })
      .mockImplementation(async (texts, endpoint) => { sizes.push(texts.length); return original(texts, endpoint); });
    const firstRun = knowledge.processKnowledge(id, { profile: false });
    try {
      await secondEntered;
      await until(async () => (await stagedCount(id)) === KNOWLEDGE_STAGE_SLICE, 'the first slice to be staged');
      const chunkTotal = sizes[0]! + sizes[1]!;
      expect(sizes[0]).toBe(KNOWLEDGE_STAGE_SLICE);

      /* The run went silent: it is resumed, not failed, and the source waits for its next attempt. */
      const restart = await knowledge.recoverStale(ree.id, silent());
      expect(restart).toEqual([id]);
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'pending', error: null });
      /* What it read is kept for the next attempt. */
      const [kept] = await db().select().from(schema.knowledgeExtract).where(eq(schema.knowledgeExtract.knowledgeId, id));
      expect(kept?.extracted).toHaveProperty('full');

      /* The superseded run gets its vectors after all, and may no longer write them. */
      answerFirst();
      expect(await firstRun).toBeNull();
      expect(await stagedCount(id)).toBe(KNOWLEDGE_STAGE_SLICE);
      const [dead] = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.knowledgeId, id)).orderBy(asc(schema.knowledgeCostRun.createdAt));
      expect(dead).toMatchObject({ status: 'failed', error: 'interrupted' });
      /* It paid for what it embedded: a receipt per embedding request of the first slice, kept. */
      expect(dead!.charges.filter((charge) => charge.service === 'embedding').length).toBeGreaterThan(0);
      expect(dead!.chargedCredits).toBeGreaterThan(0);

      /* The next attempt embeds only the passages that were not staged, from the text the first one read. */
      expect(await knowledge.processKnowledge(id, { profile: false })).toBe(ree.id);
      expect(sizes.slice(2)).toEqual([chunkTotal - KNOWLEDGE_STAGE_SLICE]);
      expect(reads.filter((read) => read === path)).toHaveLength(1);
      expect(await db().select().from(schema.knowledgeExtract).where(eq(schema.knowledgeExtract.knowledgeId, id))).toEqual([]);
      const detail = await knowledge.knowledgeDetail(ree.id, id);
      expect(detail).toMatchObject({ status: 'ready', chunkTotal });
      expect(detail!.activity.map((entry) => entry.code)).toContain('interrupted');
      expect(detail!.activity.find((entry) => entry.code === 'chunked')?.detail).toEqual({ chunks: chunkTotal, reused: KNOWLEDGE_STAGE_SLICE });
      expect(await stagedCount(id)).toBe(0);
      const chunks = await db().select({ ordinal: schema.chunk.ordinal, space: schema.chunk.embeddingSpace }).from(schema.chunk).where(eq(schema.chunk.knowledgeId, id));
      expect(new Set(chunks.map((chunk) => chunk.ordinal)).size).toBe(chunkTotal);
      expect(chunks.every((chunk) => chunk.space !== null)).toBe(true);

      /* Two runs, each charged at least what it cost; no reservation left open. */
      const bills = await expectChargedAtLeastCost(id);
      expect(bills.map((bill) => [bill.status, bill.error])).toEqual([['failed', 'interrupted'], ['ready', null]]);
      expect((await knowledgeBill(id)).open).toBe(0);
    } finally {
      answerFirst();
      await firstRun;
      spy.mockRestore();
    }
    expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'ready' });
  });

  it(`fails as interrupted after ${KNOWLEDGE_MAX_RESUMES} resumes, settling every attempt and dropping what was staged`, async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/large/stuck.md`;
    blobs.set(path, new TextEncoder().encode('# Stuck\n\nA short source that is killed every time.\n'));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'stuck.md' });
    const kills: ((error: Error) => void)[] = [];
    const spy = vi.spyOn(models, 'embedTexts').mockImplementation(() => new Promise((_resolve, reject) => { kills.push(reject); }));
    const runs: Promise<string | null>[] = [];
    try {
      for (let attempt = 0; attempt <= KNOWLEDGE_MAX_RESUMES; attempt += 1) {
        runs.push(knowledge.processKnowledge(id, { profile: false }));
        await until(async () => kills.length === attempt + 1, `attempt ${attempt + 1} to embed`);
        const restart = await knowledge.recoverStale(ree.id, silent());
        expect(restart).toEqual(attempt < KNOWLEDGE_MAX_RESUMES ? [id] : []);
      }
      const detail = await knowledge.knowledgeDetail(ree.id, id);
      expect(detail).toMatchObject({ status: 'failed', error: 'interrupted' });
      expect(detail!.activity.filter((entry) => entry.code === 'interrupted')).toHaveLength(KNOWLEDGE_MAX_RESUMES);
      const bills = await expectChargedAtLeastCost(id);
      expect(bills).toHaveLength(KNOWLEDGE_MAX_RESUMES + 1);
      expect(bills.every((bill) => bill.status === 'failed' && bill.error === 'interrupted')).toBe(true);
      expect((await knowledgeBill(id)).open).toBe(0);
      expect(await stagedCount(id)).toBe(0);
    } finally {
      for (const kill of kills) kill(new Error('function killed'));
      await Promise.allSettled(runs);
      spy.mockRestore();
    }
  });

  it('keeps judging runs from before heartbeats by their age, and never resumes a deleted Ree', async () => {
    const { userId, ree } = await userWithRee();
    const legacy = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Legacy', content: 'Started before heartbeats.' });
    const old = new Date(Date.now() - 5 * 60_000);
    await db().update(schema.knowledge).set({ status: 'processing', updatedAt: old, activity: [{ code: 'processing', at: old.toISOString(), detail: { runId: 'legacy-run' } }] }).where(eq(schema.knowledge.id, legacy));
    await db().update(schema.knowledgeCostRun).set({ status: 'processing', runId: 'legacy-run', heartbeatAt: null }).where(eq(schema.knowledgeCostRun.knowledgeId, legacy));
    /* Five minutes without heartbeats is not yet dead for such a run... */
    expect(await knowledge.recoverStale(ree.id)).toEqual([]);
    expect(await knowledge.knowledgeDetail(ree.id, legacy)).toMatchObject({ status: 'processing' });
    /* ...fifteen is, and it fails as before rather than resuming. */
    await knowledge.recoverStale(ree.id, new Date(Date.now() + 11 * 60_000));
    expect(await knowledge.knowledgeDetail(ree.id, legacy)).toMatchObject({ status: 'failed', error: 'unknown' });

    const path = `knowledge/${userId}/large/purged.md`;
    blobs.set(path, new TextEncoder().encode('# Purged\n\nKilled in a Ree being deleted.\n'));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'purged.md' });
    let kill!: (error: Error) => void;
    let entered!: () => void;
    const embedding = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(models, 'embedTexts').mockImplementationOnce(() => new Promise((_resolve, reject) => { kill = reject; entered(); }));
    const run = knowledge.processKnowledge(id, { profile: false });
    try {
      await embedding;
      expect(await knowledge.recoverStale(ree.id, silent(), { resume: false })).toEqual([]);
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'interrupted' });
    } finally {
      kill(new Error('function killed'));
      await run;
      spy.mockRestore();
    }
  });
});

describeWithDb('the queue', () => {
  /** Stand-ins for live runs: processing, beating their heartbeats. */
  async function running(ids: readonly string[]) {
    for (const id of ids) {
      const runId = `live-${id}`;
      await db().update(schema.knowledge).set({ status: 'processing', activity: [{ code: 'processing', at: new Date().toISOString(), detail: { runId } }] }).where(eq(schema.knowledge.id, id));
      await db().update(schema.knowledgeCostRun).set({ status: 'processing', runId, heartbeatAt: new Date() }).where(eq(schema.knowledgeCostRun.knowledgeId, id));
    }
  }

  async function document(userId: string, ree: { id: string }, name: string) {
    const path = `knowledge/${userId}/queue/${name}`;
    blobs.set(path, new TextEncoder().encode(`# ${name}\n\nA document waiting its turn.\n`));
    return knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: name });
  }

  it('makes documents and audio wait for a slot of their own pool, not behind repositories', async () => {
    const { userId, ree } = await userWithRee();
    const owned = KNOWLEDGE_SLOT_POOLS.file.owner;
    const ids: string[] = [];
    for (let at = 0; at <= owned; at += 1) ids.push(await document(userId, ree, `doc-${at}.md`));
    await running(ids.slice(0, owned));
    const waiting = ids.at(-1)!;
    expect(await knowledge.processKnowledge(waiting, { profile: false })).toBeNull();
    expect(await knowledge.knowledgeDetail(ree.id, waiting)).toMatchObject({ status: 'pending' });
    /* Text never waits. */
    const note = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Note', content: 'Quick.' });
    expect(await knowledge.processKnowledge(note, { profile: false })).toBe(ree.id);
    /* The stand-ins end: the document starts. */
    await knowledge.recoverStale(ree.id, silent(), { resume: false });
    expect(await knowledge.processKnowledge(waiting, { profile: false })).toBe(ree.id);
  });

  it('claims nothing once the claim window has passed, and leaves the rest for the next round', async () => {
    const { userId, ree } = await userWithRee();
    const a = await document(userId, ree, 'late-a.md');
    const b = await document(userId, ree, 'late-b.md');
    const late = Date.now() - KNOWLEDGE_CLAIM_WINDOW_MS - 1;
    await knowledge.processQueued([a], { startedAt: late });
    await knowledge.processMany([b], late);
    for (const id of [a, b]) expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'pending' });
    await knowledge.processQueued([a, b]);
    for (const id of [a, b]) expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'ready' });
  });

  it('gives every owner a turn: thirty waiting repositories do not hide another owner\'s one', async () => {
    const first = await userWithRee();
    const second = await userWithRee();
    const insert = async (reeId: string, count: number) => {
      const rows = await db().insert(schema.knowledge)
        .values(Array.from({ length: count }, (_, at) => ({ reeId, kind: 'github' as const, title: `repo ${at}`, originalTitle: `repo ${at}`, source: `https://github.com/acme/r${at}`, status: 'pending' as const, createdAt: new Date(Date.now() - (count - at) * 60_000) })))
        .returning({ id: schema.knowledge.id });
      return rows.map((row) => row.id);
    };
    const backlog = await insert(first.ree.id, 30);
    const [late] = await insert(second.ree.id, 1);
    try {
      const offered = await knowledge.queuedKnowledge(500);
      expect(offered).toContain(late);
      expect(offered.filter((id) => backlog.includes(id))).toEqual(backlog.slice(0, KNOWLEDGE_SLOT_POOLS.crawl.owner));
    } finally {
      await db().delete(schema.knowledge).where(inArray(schema.knowledge.id, [...backlog, late!]));
    }
  });
});
