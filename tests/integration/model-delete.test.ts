/**
 * Deleting a console model entry (models.ts `deleteModelConfig`): refused
 * while any list, the enabled flags or a running re-embed job uses it;
 * otherwise the row is marked deleted, so model calls, re-embed jobs and
 * health events that name it keep working, and every console path treats
 * it as gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
vi.mock('@/lib/infra/ai/gateway-generation-pricing', () => ({ gatewayGenerationPricing: async () => undefined }));

const models = await import('@/lib/services/models');
const { db, schema } = await import('@/lib/infra/db');
const { writeChain } = await import('@/lib/services/model-chain');
const { startReembed } = await import('@/lib/services/reembed');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { forgetHealthCache } = await import('@/lib/infra/ai/model-health');
const { modelCallDetail } = await import('@/lib/services/admin-model-calls');

describeWithDb('model deletion', () => {
  let administratorId: string;
  const created: string[] = [];
  let savedChains: (typeof schema.modelChain.$inferSelect)[] = [];
  let savedFlags: { id: string; enabled: boolean; enabledPlan: boolean }[] = [];

  beforeAll(async () => {
    const [owner] = await db().insert(schema.administrator).values({ email: `${uniqueName('delete')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x', name: 'Delete' }).returning();
    administratorId = owner!.id;
    /* This file starts from empty lists; what other files left comes back afterwards. */
    savedChains = await db().select().from(schema.modelChain);
    savedFlags = await db().select({ id: schema.modelConfig.id, enabled: schema.modelConfig.enabled, enabledPlan: schema.modelConfig.enabledPlan }).from(schema.modelConfig).where(sql`${schema.modelConfig.enabled} or ${schema.modelConfig.enabledPlan}`);
    await db().delete(schema.modelChain);
    await db().update(schema.modelConfig).set({ enabled: false, enabledPlan: false });
    await db().update(schema.reembedJob).set({ status: 'failed', error: 'test' }).where(eq(schema.reembedJob.status, 'running'));
    forgetModelCache();
  });

  afterAll(async () => {
    await db().delete(schema.modelChain);
    if (created.length) {
      await db().delete(schema.modelCall).where(inArray(schema.modelCall.configId, created));
      await db().delete(schema.modelHealthEvent).where(inArray(schema.modelHealthEvent.modelConfigId, created));
      await db().delete(schema.reembedJob).where(inArray(schema.reembedJob.toModelConfigId, created));
      await db().delete(schema.modelConfig).where(inArray(schema.modelConfig.id, created));
    }
    if (savedChains.length) await db().insert(schema.modelChain).values(savedChains);
    for (const row of savedFlags) await db().update(schema.modelConfig).set({ enabled: row.enabled, enabledPlan: row.enabledPlan }).where(eq(schema.modelConfig.id, row.id));
    forgetModelCache();
    forgetHealthCache();
  });

  const entry = async (kind: 'generation' | 'embedding' | 'transcription' | 'speech', name: string, model: string) => {
    const config = await models.createModelConfig(administratorId, { name: uniqueName(name), kind, transport: 'gateway', model, apiKey: 'sk-test-9876', timeoutMs: 10_000 });
    created.push(config.id);
    return config;
  };
  const chain = (kind: 'generation' | 'embedding' | 'transcription' | 'speech', audience: 'free' | 'plan' | 'all', ids: string[]) =>
    db().transaction((tx) => writeChain(tx, kind, audience, ids.map((configId) => ({ configId, active: true })), administratorId));
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as { code?: string; uses?: string[] });

  it('refuses an entry any list uses, naming each list, and changes nothing', async () => {
    const free = await entry('generation', 'free-primary', 'openai/gpt-5-mini');
    const both = await entry('generation', 'shared-backup', 'openai/gpt-5-nano');
    const plan = await entry('generation', 'plan-primary', 'anthropic/claude-sonnet-4');
    await chain('generation', 'free', [free.id, both.id]);
    await chain('generation', 'plan', [plan.id, both.id]);
    const transcription = await entry('transcription', 'transcribe', 'openai/whisper-1');
    await chain('transcription', 'all', [transcription.id]);
    const speech = await entry('speech', 'voice', 'openai/tts-1');
    await chain('speech', 'all', [speech.id]);

    expect(await refusal(models.deleteModelConfig(administratorId, free.id))).toMatchObject({ code: 'in_use', uses: ['generation:free'] });
    expect(await refusal(models.deleteModelConfig(administratorId, plan.id))).toMatchObject({ code: 'in_use', uses: ['generation:plan'] });
    const backup = await refusal(models.deleteModelConfig(administratorId, both.id));
    expect(backup).toMatchObject({ code: 'in_use' });
    expect(backup?.uses?.sort()).toEqual(['generation:free', 'generation:plan']);
    expect(await refusal(models.deleteModelConfig(administratorId, transcription.id))).toMatchObject({ code: 'in_use', uses: ['transcription'] });
    expect(await refusal(models.deleteModelConfig(administratorId, speech.id))).toMatchObject({ code: 'in_use', uses: ['speech'] });

    /* An enabled flag alone (as before lists) also counts. */
    const legacy = await entry('generation', 'legacy-plan', 'openai/gpt-4o');
    await db().update(schema.modelConfig).set({ enabledPlan: false }).where(eq(schema.modelConfig.id, plan.id));
    await db().update(schema.modelConfig).set({ enabledPlan: true }).where(eq(schema.modelConfig.id, legacy.id));
    expect(await refusal(models.deleteModelConfig(administratorId, legacy.id))).toMatchObject({ code: 'in_use', uses: ['generation:plan'] });
    await db().update(schema.modelConfig).set({ enabledPlan: false }).where(eq(schema.modelConfig.id, legacy.id));
    await db().update(schema.modelConfig).set({ enabledPlan: true }).where(eq(schema.modelConfig.id, plan.id));

    const rows = await db().select().from(schema.modelConfig).where(inArray(schema.modelConfig.id, [free.id, both.id, plan.id, transcription.id, speech.id]));
    expect(rows.every((row) => row.deletedAt === null && row.apiKeyCipher !== null)).toBe(true);
    const deletes = await db().select().from(schema.adminAudit).where(sql`${schema.adminAudit.administratorId} = ${administratorId} and ${schema.adminAudit.action} = 'model.delete'`);
    expect(deletes).toHaveLength(0);

    /* Out of the list, it can go: the database still refuses a deleted entry that is enabled. */
    await models.removeFromChain(administratorId, 'generation', 'free', both.id, [{ id: free.id, active: true }, { id: both.id, active: true }]);
    expect(await refusal(models.deleteModelConfig(administratorId, both.id))).toMatchObject({ code: 'in_use', uses: ['generation:plan'] });
    await models.removeFromChain(administratorId, 'generation', 'plan', both.id, [{ id: plan.id, active: true }, { id: both.id, active: true }]);
    await models.deleteModelConfig(administratorId, both.id);
    await expect(db().update(schema.modelConfig).set({ enabled: true }).where(eq(schema.modelConfig.id, both.id))).rejects.toThrow();
  });

  it('never deletes the embedding primary, nor an entry a running re-embed job is making vectors for', async () => {
    const primary = await entry('embedding', 'embed-primary', 'openai/text-embedding-3-small');
    const backup = await entry('embedding', 'embed-backup', 'openai/text-embedding-3-small');
    await chain('embedding', 'all', [primary.id, backup.id]);
    expect(await refusal(models.deleteModelConfig(administratorId, primary.id))).toMatchObject({ code: 'in_use', uses: ['embedding'] });
    expect(await refusal(models.deleteModelConfig(administratorId, backup.id))).toMatchObject({ code: 'in_use', uses: ['embedding'] });

    /* The candidate of "Rebuild and switch" is in no list until the job ends, but the job is making its vectors. */
    const candidate = await entry('embedding', 'embed-candidate', 'openai/text-embedding-3-large');
    const [job] = await db().insert(schema.reembedJob)
      .values({ fromModelConfigId: primary.id, toModelConfigId: candidate.id, space: crypto.randomUUID(), startedBy: administratorId })
      .returning();
    expect(await refusal(models.deleteModelConfig(administratorId, candidate.id))).toMatchObject({ code: 'in_use', uses: ['reembed'] });
    /* A failed job no longer holds it: the job row keeps pointing at the kept entry. */
    await db().update(schema.reembedJob).set({ status: 'failed', error: 'test' }).where(eq(schema.reembedJob.id, job!.id));
    await models.deleteModelConfig(administratorId, candidate.id);
    const [kept] = await db().select().from(schema.reembedJob).where(eq(schema.reembedJob.id, job!.id));
    expect(kept?.toModelConfigId).toBe(candidate.id);
    /* And a deleted entry cannot be switched to. */
    await expect(startReembed(administratorId, candidate.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(models.activateModelConfig(administratorId, candidate.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deletes an unused entry: audited, hidden everywhere, history kept', async () => {
    const stale = await entry('generation', 'stale', 'openai/gpt-4.1-mini');
    const at = new Date();
    const [call] = await db().insert(schema.modelCall).values({
      kind: 'generation', model: stale.model, configId: stale.id, configName: stale.name, status: 'succeeded',
      usageKnown: true, inputTokens: 10, outputTokens: 5, costUsd: '0.0005', costBasis: 'provider_reported', createdAt: at,
    }).returning();
    await db().insert(schema.modelHealth).values({ modelConfigId: stale.id, state: 'cooling', reason: 'quota', coolingUntil: new Date(Date.now() + 60_000), consecutiveFailures: 2 });
    await db().insert(schema.modelHealthEvent).values({ modelConfigId: stale.id, event: 'cooling', reason: 'quota', createdAt: at });
    const before = await models.listModelConfigs();
    expect(before.configs.map((config) => config.id)).toContain(stale.id);
    expect(before.today[stale.id]).toEqual({ calls: 1, failed: 0 });

    await models.deleteModelConfig(administratorId, stale.id);

    const [row] = await db().select().from(schema.modelConfig).where(eq(schema.modelConfig.id, stale.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.apiKeyCipher).toBeNull();
    expect(row).toMatchObject({ name: stale.name, model: stale.model, apiKeyTail: '9876' });
    const [audit] = await db().select().from(schema.adminAudit).where(sql`${schema.adminAudit.action} = 'model.delete' and ${schema.adminAudit.target} = ${stale.id}`);
    expect(audit).toMatchObject({ administratorId, before: { name: stale.name, kind: 'generation', model: stale.model } });

    /* History: the call, its cost and the day's figures still read; the cooldown is gone, its event stays named. */
    expect(await modelCallDetail(call!.id)).toMatchObject({ configId: stale.id, configName: stale.name, costUsd: '0.0005' });
    const after = await models.listModelConfigs();
    expect(after.configs.map((config) => config.id)).not.toContain(stale.id);
    expect(after.today[stale.id]).toEqual({ calls: 1, failed: 0 });
    expect(after.health[stale.id]).toBeUndefined();
    expect(after.events.find((event) => event.configId === stale.id)).toMatchObject({ name: stale.name, event: 'cooling' });

    /* Every console path treats it as gone, and a second delete too. */
    await expect(models.deleteModelConfig(administratorId, stale.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(models.probeModelConfig(administratorId, stale.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(models.updateModelConfig(administratorId, stale.id, { name: 'back', transport: 'gateway', model: stale.model, timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(models.activateModelConfig(administratorId, stale.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(models.addToChain(administratorId, 'generation', 'free', stale.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(models.clearModelCooldown(administratorId, stale.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(models.deleteModelConfig(administratorId, '00000000-0000-4000-8000-0000000000aa')).rejects.toMatchObject({ code: 'not_found' });
  });
});
