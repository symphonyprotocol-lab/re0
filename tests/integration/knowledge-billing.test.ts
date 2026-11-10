/**
 * docs/audit/credit-import-audit.md P2–P4: what knowledge costs beyond one
 * source's processing run is billed to the knowledge-base owner, never below
 * cost --
 *   - the knowledge profile's embedding and the example questions' generation (P2),
 *   - re-embedding every passage after an embedding model switch (P3),
 *   - storage: Blob files and database rows by the second, daily and at purge (P4).
 * (Transfer receipts of processing runs, and P1's failures keeping what they
 * spent, are asserted in knowledge.test.ts and knowledge-kinds.test.ts.)
 */
import { readFileSync } from 'node:fs';
import { REEMBED_BATCH, WELCOME_CREDITS } from '@/lib/constants';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { debtOf } from './billing-audit';

vi.mock('@/lib/infra/blob', () => ({
  blobSize: async () => null,
  readBlob: async () => null,
  deleteBlob: async () => undefined,
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const profile = await import('@/lib/services/profile');
const reembed = await import('@/lib/services/reembed');
const storage = await import('@/lib/services/storage-billing');
const library = await import('@/lib/services/knowledge-library');
const rees = await import('@/lib/services/rees');
const { placeHold } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { providerTotal } = await import('@/lib/domain/provider-cost');
const { chunkOverheadBytes, defaultInfraCostRates } = await import('@/lib/domain/infra-cost');
const metered = await import('@/lib/services/metered-work');
const { withProviderMeter, prepareProviderCall } = await import('@/lib/infra/ai/provider-meter');
const { providerPrices } = await import('@/lib/services/provider-pricing');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await fake?.close();
});

async function newUser(credits?: number): Promise<string> {
  const subject = uniqueName('kb');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'B', avatarUrl: null }, 'zh', '/');
  if (credits !== undefined) await db().update(schema.creditGrant).set({ remaining: credits }).where(eq(schema.creditGrant.userId, userId));
  return userId;
}

const vector = (seed: number) => Array.from({ length: 1536 }, (_, index) => (index === seed % 1536 ? 1 : 0));

async function reeWith(ownerId: string, options: { passages?: number; isPublic?: boolean } = {}) {
  const [ree] = await db()
    .insert(schema.ree)
    .values({ ownerId, name: uniqueName('ree'), slug: uniqueName('slug'), isPublic: options.isPublic ?? true, isPublished: options.isPublic ?? true, category: 'technology', description: 'A handbook.' })
    .returning();
  const [source] = await db()
    .insert(schema.knowledge)
    .values({ reeId: ree!.id, kind: 'text', title: 'Source', originalTitle: 'Source', status: 'ready', content: 'The office opens at nine.' })
    .returning({ id: schema.knowledge.id });
  for (let index = 0; index < (options.passages ?? 1); index += 1) {
    await db().insert(schema.chunk).values({ knowledgeId: source!.id, reeId: ree!.id, ordinal: index, content: `The office opens at nine, passage ${index}.`, embedding: vector(index) });
  }
  return { ree: ree!, sourceId: source!.id };
}

/** Every metered run of a kind for a user, each closed and charged at least its receipts' cost. */
async function runsOf(userId: string, kind: string) {
  const runs = await db().select().from(schema.knowledgeCostRun).where(and(eq(schema.knowledgeCostRun.userId, userId), eq(schema.knowledgeCostRun.kind, kind)));
  for (const run of runs) {
    const known = run.charges.filter((charge) => charge.costUsd !== null);
    expect(run.status === 'ready' || run.status === 'failed').toBe(true);
    expect(run.chargedCredits ?? 0).toBeGreaterThanOrEqual(known.length > 0 ? providerTotal(known).credits : 0);
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.id, run.id));
    expect(hold!.status).not.toBe('held');
  }
  return runs;
}

/** A source's reservation as `addKnowledge` places it, with its cost run waiting. */
async function placeHoldFor(tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0], userId: string, knowledgeId: string): Promise<string> {
  const id = await placeHold(tx, { userId, kind: 'knowledge', amount: 1, refId: knowledgeId, reeId: null, note: 'Queued' });
  await tx.insert(schema.knowledgeCostRun).values({ id, knowledgeId, reeId: null, userId, title: 'Queued', reeName: 'Ree', kind: 'text', status: 'pending' });
  return id;
}

const chatCalls = () => fake.requests.filter((request) => request.path.endsWith('/chat/completions')).length;

describeWithDb('P2: the knowledge profile and example questions', () => {
  it('bills the profile embedding to the owner', async () => {
    const owner = await newUser();
    const { ree } = await reeWith(owner, { passages: 3 });
    expect(await profile.refreshProfile(ree.id)).toBeGreaterThan(0);
    const [run] = await runsOf(owner, 'profile');
    expect(run).toMatchObject({ status: 'ready', reeId: ree.id, knowledgeId: null });
    expect(run!.charges.map((charge) => charge.service)).toEqual(['embedding']);
    expect(run!.chargedCredits).toBeGreaterThan(0);
    expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS - run!.chargedCredits!);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, run!.runId!));
    expect(-entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(run!.chargedCredits);
  });

  it('still builds the profile on an empty balance, and the owner owes it', async () => {
    const owner = await newUser(0);
    const { ree } = await reeWith(owner);
    expect(await profile.refreshProfile(ree.id)).toBeGreaterThan(0);
    const [run] = await runsOf(owner, 'profile');
    expect(run!.chargedCredits).toBeGreaterThan(0);
    expect(await balanceOf(db(), owner)).toBe(0);
    expect(await debtOf(owner)).toBe(run!.chargedCredits);
  });

  it('a private Ree has no profile and pays nothing', async () => {
    const owner = await newUser();
    const { ree } = await reeWith(owner, { isPublic: false });
    expect(await profile.refreshProfile(ree.id)).toBe(0);
    expect(await runsOf(owner, 'profile')).toHaveLength(0);
    expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS);
  });

  it('bills the example questions generation to the owner', async () => {
    const owner = await newUser();
    const { ree } = await reeWith(owner, { isPublic: false });
    const before = chatCalls();
    expect(await profile.suggestQuestions(ree.id)).not.toHaveLength(0);
    expect(chatCalls()).toBe(before + 1);
    const [run] = await runsOf(owner, 'suggestions');
    expect(run).toMatchObject({ status: 'ready' });
    const [generation] = run!.charges;
    // The fake answers 10 prompt and 5 completion tokens at $1 / $4 per million.
    expect(generation).toMatchObject({ service: 'generation', model: 'fake-gen-1', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: '0.000030000000', basis: 'configured_rate' });
    expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS - run!.chargedCredits!);
  });

  it('skips the example questions, unbilled and uncalled, when the balance cannot cover them', async () => {
    const owner = await newUser(0);
    const { ree } = await reeWith(owner, { isPublic: false });
    const before = chatCalls();
    expect(await profile.suggestQuestions(ree.id)).toEqual([]);
    expect(chatCalls()).toBe(before);
    expect(await balanceOf(db(), owner)).toBe(0);
    expect(await debtOf(owner)).toBe(0);
  });
});

describeWithDb('P3: re-embedding after a model switch', () => {
  async function switchSetup() {
    await db().update(schema.reembedJob).set({ status: 'failed' }).where(eq(schema.reembedJob.status, 'running'));
    await db().update(schema.modelConfig).set({ enabled: false }).where(eq(schema.modelConfig.kind, 'embedding'));
    forgetModelCache();
    const [admin] = await db().insert(schema.administrator).values({ name: 'Reviewer', email: `${uniqueName('admin')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' }).returning({ id: schema.administrator.id });
    const [next] = await db().insert(schema.modelConfig).values({ name: uniqueName('next'), kind: 'embedding', transport: 'openai_compatible', baseUrl: fake.baseUrl, model: 'fake-embed-2' }).returning();
    return { adminId: admin!.id, next: next! };
  }
  async function switchTeardown() {
    fake.embeddings.failModel = null;
    await db().update(schema.modelConfig).set({ enabled: false }).where(eq(schema.modelConfig.kind, 'embedding'));
    forgetModelCache();
  }

  it('bills every owner for their own passages, owing what a balance cannot cover', async () => {
    const paying = await newUser();
    const broke = await newUser(0);
    await reeWith(paying, { passages: 3, isPublic: false });
    await reeWith(broke, { passages: 2, isPublic: false });
    const { adminId, next } = await switchSetup();
    try {
      expect(await reembed.startReembed(adminId, next.id)).toMatchObject({ status: 'running' });
      const done = await reembed.runReembed(120_000);
      expect(done!.status).toBe('done');
      for (const owner of [paying, broke]) {
        const runs = await runsOf(owner, 'reembed');
        expect(runs.length).toBeGreaterThan(0);
        expect(runs.every((run) => run.status === 'ready' && run.charges.every((charge) => charge.service === 'embedding' && charge.model === 'fake-embed-2'))).toBe(true);
      }
      const paid = (await runsOf(paying, 'reembed')).reduce((sum, run) => sum + (run.chargedCredits ?? 0), 0);
      const owed = (await runsOf(broke, 'reembed')).reduce((sum, run) => sum + (run.chargedCredits ?? 0), 0);
      expect(await balanceOf(db(), paying)).toBe(WELCOME_CREDITS - paid);
      expect(await debtOf(broke)).toBe(owed);
    } finally {
      await switchTeardown();
    }
  }, 60_000);

  it('charges an owner once per job, the whole cost rounded up once, however many batches their passages span', async () => {
    const owner = await newUser();
    const other = await newUser();
    await reeWith(owner, { passages: REEMBED_BATCH * 2 + 5, isPublic: false });
    await reeWith(other, { passages: 4, isPublic: false });
    const { adminId, next } = await switchSetup();
    try {
      const job = await reembed.startReembed(adminId, next.id);
      expect((await reembed.runReembed(120_000))!.status).toBe('done');
      const runs = await runsOf(owner, 'reembed');
      // One run for the whole job (it was one per batch: three or more), at the cost of all its calls rounded up once.
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'ready', runId: `reembed:${job!.id}:${owner}` });
      expect(runs[0]!.charges.length).toBeGreaterThanOrEqual(3);
      expect(runs[0]!.chargedCredits).toBe(providerTotal(runs[0]!.charges).credits);
      expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS - runs[0]!.chargedCredits!);
    } finally {
      await switchTeardown();
    }
  }, 120_000);

  it('a failed switch restarted to the same model keeps what it embedded, and nobody pays for it twice', async () => {
    const owner = await newUser();
    await reeWith(owner, { passages: 3, isPublic: false });
    const { adminId, next } = await switchSetup();
    try {
      fake.embeddings.failModel = 'fake-embed-2';
      fake.embeddings.after = 1;
      const first = await reembed.startReembed(adminId, next.id);
      expect((await reembed.runReembed(60_000))!.status).toBe('failed');
      const kept = await db().select({ id: schema.chunk.id, content: schema.chunk.content }).from(schema.chunk).where(sql`embedding_next is not null`);
      expect(kept.length).toBeGreaterThan(0);
      // The failed job is settled at what it spent: every run closed, none left holding.
      await reembed.runReembed(60_000);
      const settled = await db().select().from(schema.knowledgeCostRun).where(sql`run_id like ${`reembed:${first!.id}:%`}`);
      expect(settled.length).toBeGreaterThan(0);
      expect(settled.every((run) => run.status !== 'processing')).toBe(true);

      fake.embeddings.failModel = null;
      const sentAgain = fake.requests.length;
      const second = await reembed.startReembed(adminId, next.id);
      expect(second!.done).toBe(kept.length);
      expect(await db().select({ id: schema.chunk.id }).from(schema.chunk).where(sql`embedding_next is not null`)).toHaveLength(kept.length);
      expect((await reembed.runReembed(120_000))!.status).toBe('done');
      // The restart embedded exactly the passages the failed job had not.
      const all = await db().select({ content: schema.chunk.content }).from(schema.chunk);
      /* Passages only: the profiles rebuilt after the switch embed their own texts. */
      const passages = new Set(all.map((row) => row.content));
      const resent = fake.requests.slice(sentAgain).filter((request) => request.model === 'fake-embed-2').flatMap((request) => request.inputs ?? []).filter((input) => passages.has(input));
      const sorted = (values: string[]) => [...values].sort();
      expect(sorted(resent)).toEqual(sorted(subtract(all.map((row) => row.content), kept.map((row) => row.content))));
    } finally {
      await switchTeardown();
    }
  }, 180_000);

  it('the switch leaves no vector index for every passage to rebuild', async () => {
    const { rows } = await db().execute<{ n: string }>(sql`select count(*)::text as n from pg_indexes where tablename = 'chunk' and indexdef ilike '%embedding%'`);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

/** `all` without one occurrence of each of `taken`. */
function subtract(all: string[], taken: string[]): string[] {
  const left = [...all];
  for (const value of taken) left.splice(left.indexOf(value), 1);
  return left;
}

describeWithDb('P4: storage', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function storedDocument(ownerId: string, options: { fileSize: number; ageDays: number; deletedDaysAgo?: number }) {
    const { ree } = await reeWith(ownerId, { isPublic: false, passages: 0 });
    const created = new Date(Date.now() - options.ageDays * DAY);
    const [row] = await db()
      .insert(schema.knowledge)
      .values({
        reeId: ree.id, kind: 'document', title: 'Manual', originalTitle: 'Manual', status: 'ready', content: 'Manual text.',
        source: `knowledge/${ownerId}/manual.pdf`, fileName: 'manual.pdf', fileSize: options.fileSize, createdAt: created,
        ...(options.deletedDaysAgo !== undefined ? { deletedAt: new Date(Date.now() - options.deletedDaysAgo * DAY) } : {}),
      })
      .returning({ id: schema.knowledge.id });
    await db().insert(schema.chunk).values({ knowledgeId: row!.id, reeId: ree.id, ordinal: 0, content: 'Manual text.', embedding: vector(1) });
    /* The `reeWith` text source is the owner's too; age it the same, so the expected cost below covers every row. */
    await db().update(schema.knowledge).set({ createdAt: created }).where(eq(schema.knowledge.reeId, ree.id));
    return { reeId: ree.id, id: row!.id, created };
  }

  /** Credits for a pico-dollar cost, rounded up (1 credit = $0.0001 = 10^8 pico-dollars), and whether they cover it. */
  const ceilCredits = (pico: bigint) => Number((pico + 99_999_999n) / 100_000_000n);
  const covers = (credits: number, pico: bigint) => BigInt(credits) * 100_000_000n >= pico;
  /** An independent lower bound: Vercel's $0.023 / GB-month for the file alone over a 31-day month. */
  const blobFloorUsd = (bytes: number, seconds: number) => (bytes / 1e9) * 0.023 * (seconds / (31 * 24 * 3600));

  it('bills stored files and rows by the second, never below cost, and only once', async () => {
    const owner = await newUser();
    const { id, created } = await storedDocument(owner, { fileSize: 20_000_000, ageDays: 10 });
    const now = new Date();
    const charged = await db().transaction((tx) => storage.accrueStorage(tx, storage.ownedBy(owner), now));
    expect(charged).toHaveLength(1);
    const accrual = await storage.storageAccrualOf(owner);
    const seconds = (now.getTime() - created.getTime()) / 1000;
    const costUsd = Number(accrual!.costPico) / 1e12;
    expect(costUsd).toBeGreaterThan(blobFloorUsd(20_000_000, seconds));
    // Rows: the document's text, its passage with its vector, and the text source beside it.
    expect(Number(accrual!.costPico)).toBeGreaterThan(0);
    expect(accrual!.chargedCredits).toBe(ceilCredits(accrual!.costPico));
    expect(covers(accrual!.chargedCredits, accrual!.costPico)).toBe(true);
    expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS - accrual!.chargedCredits);
    const [entry] = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, owner), eq(schema.creditEntry.reason, 'storage_charge')));
    expect(entry).toMatchObject({ delta: -accrual!.chargedCredits, note: 'Knowledge storage' });
    const [row] = await db().select({ billed: schema.knowledge.storageBilledAt }).from(schema.knowledge).where(eq(schema.knowledge.id, id));
    expect(row!.billed?.getTime()).toBe(now.getTime());

    // Run again at the same moment: nothing more is due.
    await db().transaction((tx) => storage.accrueStorage(tx, storage.ownedBy(owner), now));
    expect((await storage.storageAccrualOf(owner))!.chargedCredits).toBe(accrual!.chargedCredits);
  });

  it('carries fractions across runs so many small charges never fall below the total cost', async () => {
    const owner = await newUser();
    const { created } = await storedDocument(owner, { fileSize: 1_000_000, ageDays: 3 });
    let at = created.getTime();
    for (let day = 0; day < 3; day += 1) {
      at += DAY;
      await db().transaction((tx) => storage.accrueStorage(tx, storage.ownedBy(owner), new Date(at)));
      const accrual = (await storage.storageAccrualOf(owner))!;
      expect(covers(accrual.chargedCredits, accrual.costPico)).toBe(true);
      expect(accrual.chargedCredits).toBe(ceilCredits(accrual.costPico));
    }
  });

  it('owes storage the balance cannot cover', async () => {
    const owner = await newUser(0);
    await storedDocument(owner, { fileSize: 50_000_000, ageDays: 20 });
    // Only rows unbilled for 15 days or more: this owner's, not the fresh ones other tests made.
    const [charge] = await storage.chargeStorage(new Date(), { minimumSeconds: 15 * 24 * 3600 }).then((all) => all.filter((entry) => entry.userId === owner));
    expect(charge!.credits).toBeGreaterThan(0);
    expect(await debtOf(owner)).toBe(charge!.credits);
  });

  it('bills a purged source up to the moment it goes', async () => {
    const owner = await newUser();
    const { id, created } = await storedDocument(owner, { fileSize: 30_000_000, ageDays: 40, deletedDaysAgo: 31 });
    const before = Date.now();
    await library.purgeTrash();
    expect(await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, id))).toHaveLength(0);
    const accrual = (await storage.storageAccrualOf(owner))!;
    const costUsd = Number(accrual.costPico) / 1e12;
    expect(costUsd).toBeGreaterThan(blobFloorUsd(30_000_000, (before - created.getTime()) / 1000));
    expect(covers(accrual.chargedCredits, accrual.costPico)).toBe(true);
    expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS - accrual.chargedCredits);
  });

  it('counts a passage with its vector beyond its text', async () => {
    const owner = await newUser();
    const { id } = await storedDocument(owner, { fileSize: 0, ageDays: 28 });
    const [measured] = (await db().execute<{ bytes: string }>(sql`select sum(octet_length(content) + ${chunkOverheadBytes(defaultInfraCostRates())})::text as bytes from ${schema.chunk} where knowledge_id = ${id}`)).rows;
    expect(Number(measured!.bytes)).toBeGreaterThan(1536 * 4);
    const ids = (await db().select({ id: schema.knowledge.id }).from(schema.knowledge).innerJoin(schema.ree, eq(schema.ree.id, schema.knowledge.reeId)).where(eq(schema.ree.ownerId, owner))).map((row) => row.id);
    await db().transaction((tx) => storage.accrueStorage(tx, storage.rowsIn(ids), new Date()));
    expect(Number((await storage.storageAccrualOf(owner))!.costPico)).toBeGreaterThan(0);
    expect(await db().select().from(schema.knowledge).where(and(inArray(schema.knowledge.id, ids), sql`storage_billed_at is null`))).toHaveLength(0);
  });
  it('stops billing when the Ree is deleted, and the next purge removes its knowledge, passages and pending work', async () => {
    const owner = await newUser();
    const { reeId, id } = await storedDocument(owner, { fileSize: 40_000_000, ageDays: 10 });
    const [pending] = await db().insert(schema.knowledge)
      .values({ reeId, kind: 'text', title: 'Queued', originalTitle: 'Queued', status: 'pending', content: 'Queued text.', updatedAt: new Date(Date.now() - DAY) })
      .returning({ id: schema.knowledge.id });
    const holdId = await db().transaction((tx) => placeHoldFor(tx, owner, pending!.id));
    expect(await rees.deleteRee(owner, reeId)).toBe(true);
    const now = new Date();
    await db().transaction((tx) => storage.accrueStorage(tx, storage.ownedBy(owner), now));
    const atDeletion = (await storage.storageAccrualOf(owner))!;
    // Ten days later nothing more is due: the Ree has been gone all along.
    await db().transaction((tx) => storage.accrueStorage(tx, storage.ownedBy(owner), new Date(now.getTime() + 10 * DAY)));
    expect((await storage.storageAccrualOf(owner))!.costPico).toBe(atDeletion.costPico);
    const due = await storage.chargeStorage(new Date(now.getTime() + 10 * DAY), { minimumSeconds: 0 });
    expect(due.filter((charge) => charge.userId === owner)).toHaveLength(0);

    await library.purgeTrash();
    expect(await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, reeId))).toHaveLength(0);
    expect(await db().select().from(schema.chunk).where(eq(schema.chunk.knowledgeId, id))).toHaveLength(0);
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.id, holdId));
    expect(hold!.status).toBe('released');
    expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS - atDeletion.chargedCredits);
  });

  it('bills existing knowledge from the release, not from its creation (migration 0038)', async () => {
    const owner = await newUser();
    const { id } = await storedDocument(owner, { fileSize: 50_000_000, ageDays: 300 });
    await db().update(schema.knowledge).set({ storageBilledAt: null }).where(eq(schema.knowledge.id, id));
    const migration = readFileSync('db/migrations/0038_knowledge_billing_fixes.sql', 'utf8');
    const backfill = migration.split('--> statement-breakpoint').find((statement) => /UPDATE "knowledge"/.test(statement))!;
    const released = Date.now();
    await db().execute(sql.raw(backfill));
    const [row] = await db().select({ billed: schema.knowledge.storageBilledAt }).from(schema.knowledge).where(eq(schema.knowledge.id, id));
    expect(row!.billed!.getTime()).toBeGreaterThanOrEqual(released - 5_000);
    await db().transaction((tx) => storage.accrueStorage(tx, storage.rowsIn([id]), new Date(released + 1000)));
    // A 50 MB file for 300 days would cost far more than one credit; for a second it costs a fraction of one.
    expect((await storage.storageAccrualOf(owner))!.chargedCredits).toBeLessThanOrEqual(1);
  });

  it('reaches every owner in one run, page after page', async () => {
    const owners = [await newUser(), await newUser(), await newUser()];
    for (const owner of owners) await storedDocument(owner, { fileSize: 1_000_000, ageDays: 400 });
    const charged = await storage.chargeStorage(new Date(), { minimumSeconds: 350 * 24 * 3600, limit: 1 });
    for (const owner of owners) expect(charged.some((charge) => charge.userId === owner)).toBe(true);
  });

  it("never moves a row's billed mark back to an earlier moment", async () => {
    const owner = await newUser();
    const { id } = await storedDocument(owner, { fileSize: 1_000_000, ageDays: 2 });
    const later = new Date(Date.now() + 5 * 60_000);
    await db().update(schema.knowledge).set({ storageBilledAt: later }).where(eq(schema.knowledge.id, id));
    await db().transaction((tx) => storage.accrueStorage(tx, storage.rowsIn([id]), new Date()));
    const [row] = await db().select({ billed: schema.knowledge.storageBilledAt }).from(schema.knowledge).where(eq(schema.knowledge.id, id));
    expect(row!.billed!.getTime()).toBe(later.getTime());
  });
});

describeWithDb('metered runs: crash recovery and unknown prices', () => {
  it('settles a run whose function died, giving back what it reserved and never spent', async () => {
    const owner = await newUser();
    const input = { userId: owner, reeId: null, kind: 'suggestions' as const, title: 'Example questions', reeName: 'Ree', refuse: true };
    const run = await metered.openMeteredRun(input, {}, new Date(Date.now() - 60 * 60_000));
    expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS - 1);
    // A run still young is left alone: its function may be working.
    const fresh = await metered.openMeteredRun(input);
    expect(await metered.reapMeteredRuns()).toBeGreaterThanOrEqual(1);
    const [reaped] = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.id, run.holdId));
    expect(reaped).toMatchObject({ status: 'failed', error: 'abandoned', chargedCredits: 0 });
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.id, run.holdId));
    expect(hold!.status).toBe('released');
    const [young] = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.id, fresh.holdId));
    expect(young!.status).toBe('processing');
    await metered.closeMeteredRun(fresh, null);
    expect(await balanceOf(db(), owner)).toBe(WELCOME_CREDITS);
  });

  it('optional work never calls a model whose price is unknown beforehand, even on AI Gateway', async () => {
    const prices = await providerPrices();
    const target = { service: 'generation' as const, endpoint: 'https://ai-gateway.vercel.sh/v1', model: 're0-test/no-such-model' };
    const meter = { runId: crypto.randomUUID(), prices, record: async () => undefined };
    await expect(withProviderMeter({ ...meter, requireRate: true }, () => prepareProviderCall(target))).rejects.toMatchObject({ code: 'pricing_unavailable' });
    // Required work (no `requireRate`) still goes ahead and takes the cost Gateway reports.
    await expect(withProviderMeter(meter, () => prepareProviderCall(target))).resolves.not.toBeNull();
  });
});
