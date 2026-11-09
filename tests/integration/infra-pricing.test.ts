/**
 * The infrastructure rates on 价格与促销 (docs/audit/credit-import-audit.md P4):
 * seeded defaults, audited saves that refuse anything at or below zero,
 * the administrator check, and billing at the rate in effect -- transfer at
 * charge time, storage split where a rate changed, never repricing time
 * already accrued.
 */
import { WELCOME_CREDITS } from '@/lib/constants';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { expectChargedAtLeastCost } from './billing-audit';

const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path)?.length ?? null,
  readBlob: async (path: string) => blobs.get(path) ?? null,
  deleteBlob: async () => undefined,
}));
const session = vi.hoisted(() => ({ token: null as string | null }));
vi.mock('next/headers', async () => {
  const { ADMIN_SESSION_COOKIE } = await import('@/lib/http/cookies');
  return {
    cookies: async () => ({ get: (name: string) => (name === ADMIN_SESSION_COOKIE && session.token ? { value: session.token } : undefined) }),
    headers: async () => new Headers(),
  };
});

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const { openAdminSession } = await import('@/lib/services/admin');
const infra = await import('@/lib/services/infra-pricing');
const storage = await import('@/lib/services/storage-billing');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const { newReeDraft } = await import('@/lib/domain/ree');
const { db, schema } = await import('@/lib/infra/db');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { defaultInfraCostRates, storageCostPico } = await import('@/lib/domain/infra-cost');
const route = await import('@/app/api/admin/pricing/route');

let fake: FakeOpenAi;
let administratorId: string;
/** Rows this file adds, removed afterwards so other files bill at the seeded rates. */
const added: string[] = [];
const DAY = 24 * 60 * 60 * 1000;
const valid = { transferPerGb: '0.2', blobStoragePerGbMonth: '0.03', databaseStoragePerGbMonth: '0.6', databaseIndexFactor: '2.5', chunkRowBytes: 256 };

async function save(input: Record<string, unknown>, now?: Date) {
  const saved = await infra.saveInfraCostRates(administratorId, { revision: (await infra.infraCostRates(db(), now)).revision, ...input }, now);
  added.push(saved.revision);
  return saved;
}

beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
  const [admin] = await db().insert(schema.administrator).values({ name: 'Rates', email: `${uniqueName('rates')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' }).returning({ id: schema.administrator.id });
  administratorId = admin!.id;
});
afterAll(async () => {
  if (added.length) await db().delete(schema.infraCostRates).where(inArray(schema.infraCostRates.id, added));
  session.token = null;
  await fake?.close();
});

describeWithDb('infrastructure rates on the pricing page', () => {
  it('reads the seeded rates, and the defaults when nothing is configured -- never zero', async () => {
    const seeded = await infra.infraCostRates();
    expect(seeded).toMatchObject({ transferPerGb: '0.15', blobStoragePerGbMonth: '0.028', databaseStoragePerGbMonth: '0.55', databaseIndexFactor: '2', chunkRowBytes: 200 });
    expect(seeded.revision).not.toBe('default');
    // Before the seeded row's moment (the epoch) nothing is configured: the built-in defaults apply.
    expect(await infra.infraCostRates(db(), new Date(-1))).toEqual(defaultInfraCostRates());
    expect(defaultInfraCostRates()).toMatchObject({ transferPerGb: '0.15', revision: 'default', effectiveFrom: null });
  });

  it('saves audited rates from now on, and refuses zero, negative and stale ones', async () => {
    const before = await infra.infraCostRates();
    const saved = await save(valid);
    expect(saved).toMatchObject({ ...valid, databaseIndexFactor: '2.5' });
    expect(saved.revision).not.toBe(before.revision);
    expect(await infra.infraCostRates()).toEqual(saved);
    const [entry] = await db().select().from(schema.adminAudit).where(and(eq(schema.adminAudit.action, 'pricing.update'), eq(schema.adminAudit.target, 'infra_costs'), eq(schema.adminAudit.administratorId, administratorId)));
    expect(entry).toMatchObject({ before, after: saved });

    for (const bad of [
      { transferPerGb: '0' }, { transferPerGb: '-0.1' }, { blobStoragePerGbMonth: '0.000000000000' }, { databaseStoragePerGbMonth: '' },
      { databaseIndexFactor: '0.5' }, { databaseIndexFactor: '0' }, { chunkRowBytes: 0 }, { chunkRowBytes: 1.5 }, { transferPerGb: '1e-3' },
    ]) {
      await expect(infra.saveInfraCostRates(administratorId, { ...valid, ...bad, revision: saved.revision })).rejects.toMatchObject({ code: 'invalid_infra_costs' });
    }
    await expect(infra.saveInfraCostRates(administratorId, { ...valid, revision: before.revision })).rejects.toMatchObject({ code: 'pricing_conflict' });
    expect(await infra.infraCostRates()).toEqual(saved);
    // The database refuses a zero rate too, whatever writes it.
    await expect(db().insert(schema.infraCostRates).values({ ...valid, transferPerGb: '0', effectiveFrom: new Date() })).rejects.toThrow();
  });

  it('requires an administrator session to read or change them through the pricing API', async () => {
    const put = (input: Record<string, unknown>) => new NextRequest('http://localhost:3000/api/admin/pricing', {
      method: 'PUT', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    vi.stubEnv('APP_BASE_URL', 'http://localhost:3000');
    try {
      session.token = null;
      expect((await route.GET(new NextRequest('http://localhost:3000/api/admin/pricing'))).status).toBe(401);
      const current = await infra.infraCostRates();
      expect((await route.PUT(put({ kind: 'infra_costs', ...valid, transferPerGb: '9', revision: current.revision }))).status).toBe(401);
      expect(await infra.infraCostRates()).toEqual(current);

      session.token = (await openAdminSession(administratorId)).token;
      const read = await (await route.GET(new NextRequest('http://localhost:3000/api/admin/pricing'))).json();
      expect(read.infraCosts).toEqual(current);
      const refused = await route.PUT(put({ kind: 'infra_costs', ...valid, transferPerGb: '0', revision: current.revision }));
      expect(refused.status).toBe(422);
      const accepted = await route.PUT(put({ kind: 'infra_costs', ...valid, transferPerGb: '0.3', revision: current.revision }));
      expect(accepted.status).toBe(200);
      const { infraCosts } = await accepted.json();
      added.push(infraCosts.revision);
      expect(infraCosts).toMatchObject({ transferPerGb: '0.3' });
    } finally {
      session.token = null;
      vi.unstubAllEnvs();
    }
  });

  it('bills transfer at the rate in effect when it is charged', async () => {
    // $1,000 a GB: the 100 kB file read back from Blob alone costs $0.1, 1,000 credits.
    const rate = await save({ ...valid, transferPerGb: '1000' });
    const subject = uniqueName('rates');
    const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'R', avatarUrl: null }, 'zh', '/');
    await rees.saveDraft(userId, { ...newReeDraft(), name: 'Rates', category: 'business', step: 4, reached: 4 });
    const { ree } = await rees.createReeFromDraft(userId);
    const path = `knowledge/${userId}/rates/notes.md`;
    blobs.set(path, new TextEncoder().encode('Office hours are nine to five. '.repeat(3_226)).slice(0, 100_000));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'notes.md' });
    await knowledge.processKnowledge(id, { profile: false });
    const [run] = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.knowledgeId, id));
    const transfer = run!.charges.find((charge) => charge.service === 'bandwidth');
    expect(transfer).toMatchObject({ model: 'blob_read', usage: { bytes: 100_000 }, costUsd: '0.100000000000', priceRevision: `infra:${rate.revision}:1000` });
    const [bill] = await expectChargedAtLeastCost(id);
    expect(bill!.charged).toBeGreaterThanOrEqual(1_000);
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - bill!.charged);
  });

  it('prices storage at the rate in effect for each part of the time, never repricing what was accrued', async () => {
    const owner = await createSession({ provider: 'github', subject: uniqueName('store'), handle: uniqueName('store'), email: `${uniqueName('store')}@example.test`, displayName: 'S', avatarUrl: null }, 'zh', '/').then((r) => r.userId);
    const [ree] = await db().insert(schema.ree).values({ ownerId: owner, name: uniqueName('ree'), slug: uniqueName('slug'), category: 'technology' }).returning();
    const now = Date.now();
    const created = new Date(now - 10 * DAY);
    const [row] = await db().insert(schema.knowledge).values({
      reeId: ree!.id, kind: 'document', title: 'Manual', originalTitle: 'Manual', status: 'ready', content: 'Manual.',
      source: `knowledge/${owner}/manual.pdf`, fileName: 'manual.pdf', fileSize: 40_000_000, createdAt: created,
    }).returning();
    // Rates in effect: whatever applies now until five days ago, then dearer ones.
    const old = await infra.infraCostRates(db(), created);
    const dearer = await save({ ...valid, blobStoragePerGbMonth: '0.5', databaseStoragePerGbMonth: '2' }, new Date(now - 5 * DAY));
    const at = new Date(now);
    await db().transaction((tx) => storage.accrueStorage(tx, storage.rowsIn([row!.id]), at));
    const [measured] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, row!.id));
    const databaseBytes = BigInt(new TextEncoder().encode(measured!.content ?? '').length + JSON.stringify(measured!.children).length + JSON.stringify(measured!.activity).length);
    // No passages, so the per-passage overhead does not enter.
    const part = (ms: number, rates: typeof old) => storageCostPico(40_000_000n * BigInt(ms), databaseBytes * BigInt(ms), rates);
    const expected = part(at.getTime() - 5 * DAY - created.getTime(), old) + part(5 * DAY, dearer);
    const first = (await storage.storageAccrualOf(owner))!;
    // Postgres measures jsonb text a little differently from JSON.stringify; within a pico-dollar per segment and a few bytes.
    expect(Number(first.costPico)).toBeCloseTo(Number(expected), -6);
    expect(first.costPico).toBeGreaterThan(part(5 * DAY, old) * 2n);

    // A rate saved now applies only from now: the next day is priced at it, the ten before keep theirs.
    const cheaper = await save({ ...valid, blobStoragePerGbMonth: '0.001', databaseStoragePerGbMonth: '0.001' }, at);
    const next = new Date(at.getTime() + DAY);
    await db().transaction((tx) => storage.accrueStorage(tx, storage.rowsIn([row!.id]), next));
    const second = (await storage.storageAccrualOf(owner))!;
    const increment = second.costPico - first.costPico;
    expect(Number(increment)).toBeCloseTo(Number(part(DAY, cheaper)), -6);
    expect(increment).toBeLessThan(part(DAY, dearer));
    expect(BigInt(second.chargedCredits) * 100_000_000n).toBeGreaterThanOrEqual(second.costPico);
  });
});
