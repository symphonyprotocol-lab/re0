/**
 * Acceptance for primary and backup models (the model-failover design):
 * the 0078 data migration, a primary out of quota answered by its backup,
 * the cooldown shared through `model_health`, the cron's probe bringing the
 * primary back, Plan continuing with Free, the console's list rules, and
 * embedding backups limited to the primary's vector space.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, pointModelsAt, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
vi.mock('@/lib/infra/ai/gateway-generation-pricing', () => ({ gatewayGenerationPricing: async () => undefined }));

const { generateText } = await import('ai');
const models = await import('@/lib/services/models');
const { db, schema } = await import('@/lib/infra/db');
const { chainFor, embedTexts, forgetModelCache, modelFor } = await import('@/lib/infra/ai/models');
const { forgetHealthCache, healthSnapshot, settleHealthWrites } = await import('@/lib/infra/ai/model-health');

/**
 * A chat endpoint whose models answer by name: a model in `failing` answers
 * the status and body set for it, every other model answers "ok from <model>".
 */
interface Chat { baseUrl: string; failing: Map<string, { status: number; body: string }>; calls: string[]; close(): Promise<void> }
async function startChat(): Promise<Chat> {
  const failing = new Map<string, { status: number; body: string }>();
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as { model?: string; stream?: boolean };
      const model = body.model ?? '';
      calls.push(model);
      const failure = failing.get(model);
      if (failure) {
        res.writeHead(failure.status, { 'content-type': 'application/json' });
        res.end(failure.body);
        return;
      }
      const content = `ok from ${model}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, failing, calls, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const QUOTA = { status: 429, body: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}' };

describeWithDb('model failover', () => {
  let chat: Chat;
  let embedA: FakeOpenAi;
  let embedB: FakeOpenAi;
  let embedC: FakeOpenAi;
  let administratorId: string;
  const created: string[] = [];
  const restore: { generation: string[]; plan: string[]; embedding: string[]; transcription: string[] } = { generation: [], plan: [], embedding: [], transcription: [] };

  beforeAll(async () => {
    [chat, embedA, embedB, embedC] = await Promise.all([startChat(), startFakeOpenAi(), startFakeOpenAi(), startFakeOpenAi()]);
    pointModelsAt(embedA.baseUrl);
    /* The same model name on B makes other vectors: not the primary's space. */
    embedB.embeddings.shift['fake-embed'] = 5;
    const [owner] = await db().insert(schema.administrator).values({ email: `${uniqueName('failover')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x', name: 'Failover' }).returning();
    administratorId = owner!.id;
    /* What other files left enabled comes back afterwards; this file starts from nothing enabled. */
    const enabled = await db().select().from(schema.modelConfig).where(sql`${schema.modelConfig.enabled} or ${schema.modelConfig.enabledPlan}`);
    for (const row of enabled) {
      if (row.enabledPlan) restore.plan.push(row.id);
      if (row.enabled) (restore[row.kind as 'generation' | 'embedding' | 'transcription'] ?? []).push(row.id);
    }
    await db().update(schema.modelConfig).set({ enabled: false, enabledPlan: false }).where(sql`${schema.modelConfig.kind} <> 'speech'`);
    await db().delete(schema.modelChain).where(sql`${schema.modelChain.kind} <> 'speech'`);
    forgetModelCache();
    forgetHealthCache();
  });

  afterAll(async () => {
    await settleHealthWrites();
    if (created.length) await db().delete(schema.modelConfig).where(inArray(schema.modelConfig.id, created));
    for (const id of [...restore.generation, ...restore.embedding, ...restore.transcription]) await db().update(schema.modelConfig).set({ enabled: true }).where(eq(schema.modelConfig.id, id));
    for (const id of restore.plan) await db().update(schema.modelConfig).set({ enabledPlan: true }).where(eq(schema.modelConfig.id, id));
    forgetModelCache();
    forgetHealthCache();
    await Promise.all([chat?.close(), embedA?.close(), embedB?.close(), embedC?.close()]);
  });

  const generation = async (name: string, model: string) => {
    const config = await models.createModelConfig(administratorId, { name: uniqueName(name), kind: 'generation', transport: 'openai_compatible', baseUrl: chat.baseUrl, model, apiKey: 'sk-test-0000', timeoutMs: 10_000 });
    created.push(config.id);
    return config;
  };

  it('moves the existing enabled entries into lists, Free and Plan apart', async () => {
    const migration = await readFile(new URL('../../db/migrations/0078_model_chain.sql', import.meta.url), 'utf8');
    const inserts = migration.split('--> statement-breakpoint').filter((statement) => statement.trim().startsWith('INSERT'));
    expect(inserts).toHaveLength(2);
    await db().transaction(async (tx) => {
      /* Temporary tables shadow the real ones, so the data migration runs on legacy-shaped rows only. */
      await tx.execute(sql`create temporary table model_config (id uuid primary key, kind text not null, enabled boolean not null, enabled_plan boolean not null, updated_by uuid) on commit drop`);
      await tx.execute(sql`create temporary table model_chain (kind text, audience text, model_config_id uuid, position integer, updated_by uuid, updated_at timestamptz, unique (kind, audience, model_config_id)) on commit drop`);
      await tx.execute(sql`insert into model_config values
        ('00000000-0000-4000-8000-000000000001', 'generation', true, false, null),
        ('00000000-0000-4000-8000-000000000002', 'generation', false, true, null),
        ('00000000-0000-4000-8000-000000000003', 'generation', false, false, null),
        ('00000000-0000-4000-8000-000000000004', 'embedding', true, false, null),
        ('00000000-0000-4000-8000-000000000005', 'transcription', true, false, null)`);
      for (const statement of inserts) await tx.execute(sql.raw(statement));
      const rows = await tx.execute(sql`select kind, audience, right(model_config_id::text, 1) as id, position from model_chain order by kind, audience`);
      expect(rows.rows).toEqual([
        { kind: 'embedding', audience: 'all', id: '4', position: 0 },
        { kind: 'generation', audience: 'free', id: '1', position: 0 },
        { kind: 'generation', audience: 'plan', id: '2', position: 0 },
        { kind: 'transcription', audience: 'all', id: '5', position: 0 },
      ]);
    });
  });

  it('answers from the backup when the primary is out of quota, and shares the cooldown', async () => {
    const primary = await generation('primary', 'gen-primary');
    const backup = await generation('backup', 'gen-backup');
    await models.activateModelConfig(administratorId, primary.id, 'free');
    /* Adding probes the entry: one real request that must succeed. */
    await models.addToChain(administratorId, 'generation', 'free', backup.id);
    expect((await chainFor('generation')).map((endpoint) => endpoint.configId)).toEqual([primary.id, backup.id]);

    chat.failing.set('gen-primary', QUOTA);
    chat.calls.length = 0;
    const handle = await modelFor('generation', 'free', { purpose: 'other' });
    const result = await generateText({ model: handle.model, prompt: 'hello', maxRetries: 0 });
    expect(result.text).toBe('ok from gen-backup');
    expect(result.response.modelId).toBe('gen-backup');
    expect(chat.calls).toEqual(['gen-primary', 'gen-backup']);
    await settleHealthWrites();

    const [health] = await db().select().from(schema.modelHealth).where(eq(schema.modelHealth.modelConfigId, primary.id));
    expect(health).toMatchObject({ state: 'cooling', reason: 'quota', lastErrorCode: 'quota:429' });
    expect(health!.coolingUntil!.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    const events = await db().select().from(schema.modelHealthEvent).where(eq(schema.modelHealthEvent.modelConfigId, primary.id));
    expect(events.map((event) => [event.event, event.reason])).toEqual([['cooling', 'quota']]);
    const audits = await db().select().from(schema.adminAudit).where(and(eq(schema.adminAudit.action, 'model.cooldown'), eq(schema.adminAudit.target, primary.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.administratorId).toBeNull();
    await vi.waitFor(async () => {
      const calls = await db().select().from(schema.modelCall).where(and(inArray(schema.modelCall.configId, [primary.id, backup.id]), sql`${schema.modelCall.purpose} <> 'probe'`));
      expect(calls.map((call) => [call.configId, call.status, call.chainPosition, call.errorCode]).sort()).toEqual([
        [backup.id, 'succeeded', 1, null],
        [primary.id, 'failed', 0, 'provider_error:quota:429'],
      ].sort());
    });

    /* Another instance: nothing in memory, the table says the primary cools -- it is not tried. */
    forgetHealthCache();
    expect((await healthSnapshot()).get(primary.id)?.state).toBe('cooling');
    chat.calls.length = 0;
    const again = await generateText({ model: (await modelFor('generation', 'free')).model, prompt: 'again', maxRetries: 0 });
    expect(again.text).toBe('ok from gen-backup');
    expect(chat.calls).toEqual(['gen-backup']);
    expect((await models.listModelConfigs()).health[primary.id]).toMatchObject({ state: 'cooling', reason: 'quota' });

    /* Topped up: the cron's probe clears the cooldown and the primary answers again. */
    chat.failing.delete('gen-primary');
    expect(await models.probeCoolingModels()).toEqual({ probed: 1, recovered: 1 });
    expect(await models.probeCoolingModels()).toEqual({ probed: 0, recovered: 0 });
    const [recovered] = await db().select().from(schema.modelHealth).where(eq(schema.modelHealth.modelConfigId, primary.id));
    expect(recovered).toMatchObject({ state: 'ok', reason: null, coolingUntil: null });
    chat.calls.length = 0;
    const back = await generateText({ model: (await modelFor('generation', 'free')).model, prompt: 'back', maxRetries: 0 });
    expect(back.text).toBe('ok from gen-primary');
    expect(chat.calls).toEqual(['gen-primary']);
    const kinds = (await db().select().from(schema.modelHealthEvent).where(eq(schema.modelHealthEvent.modelConfigId, primary.id))).map((event) => event.event).sort();
    expect(kinds).toEqual(['cooling', 'recovered']);
  });

  it('streams from the backup when the primary is rate limited before writing', async () => {
    chat.failing.set('gen-primary', { status: 429, body: '{"error":{"message":"Rate limit reached"}}' });
    try {
      const { streamText } = await import('ai');
      const result = streamText({ model: (await modelFor('generation', 'free')).model, prompt: 'stream', maxRetries: 0 });
      expect(await result.text).toBe('ok from gen-backup');
      expect((await result.response).modelId).toBe('gen-backup');
      await settleHealthWrites();
      expect((await healthSnapshot()).get((await chainFor('generation'))[0]!.configId!)).toMatchObject({ state: 'cooling', reason: 'rate_limit' });
    } finally {
      chat.failing.delete('gen-primary');
      await models.clearModelCooldown(administratorId, (await chainFor('generation'))[0]!.configId!);
    }
  });

  it('continues a failing Plan list with the Free list', async () => {
    const plan = await generation('plan', 'gen-plan');
    await models.activateModelConfig(administratorId, plan.id, 'plan');
    chat.failing.set('gen-plan', { status: 503, body: '{"error":"overloaded"}' });
    try {
      const chain = await chainFor('generation', 'plan');
      expect(chain.map((endpoint) => endpoint.model)).toEqual(['gen-plan', 'gen-primary', 'gen-backup']);
      const result = await generateText({ model: (await modelFor('generation', 'plan')).model, prompt: 'plan', maxRetries: 0 });
      expect(result.text).toBe('ok from gen-primary');
    } finally {
      chat.failing.delete('gen-plan');
    }
  });

  it('keeps the list rules: mirror on the first active entry, never empty, frozen members, probed additions', async () => {
    const free = (await models.listModelConfigs()).chains['generation:free'];
    const [primary, backup] = free.map((entry) => entry.configId);
    /* Reordering moves the primary, and `enabled` with it. */
    await models.saveChain(administratorId, 'generation', 'free', [{ id: backup, active: true }, { id: primary, active: true }]);
    const enabled = await db().select({ id: schema.modelConfig.id }).from(schema.modelConfig).where(and(eq(schema.modelConfig.kind, 'generation'), eq(schema.modelConfig.enabled, true)));
    expect(enabled.map((row) => row.id)).toEqual([backup]);
    expect((await chainFor('generation'))[0]!.configId).toBe(backup);
    /* Pausing the first entry hands the primary to the next active one. */
    await models.saveChain(administratorId, 'generation', 'free', [{ id: backup, active: false }, { id: primary, active: true }]);
    expect((await chainFor('generation')).map((endpoint) => endpoint.configId)).toEqual([primary]);
    await expect(models.saveChain(administratorId, 'generation', 'free', [{ id: backup, active: false }, { id: primary, active: false }])).rejects.toMatchObject({ code: 'chain_empty' });
    await expect(models.saveChain(administratorId, 'generation', 'free', [{ id: primary, active: true }, { id: '00000000-0000-4000-8000-0000000000ff', active: true }])).rejects.toMatchObject({ code: 'stale' });
    await expect(models.saveChain(administratorId, 'generation', 'nobody', [{ id: primary, active: true }])).rejects.toMatchObject({ code: 'audience' });
    /* A backup is frozen like the primary. */
    await expect(models.updateModelConfig(administratorId, backup!, { name: 'renamed', transport: 'openai_compatible', baseUrl: chat.baseUrl, model: 'gen-other', timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'locked' });
    /* An entry whose probe fails is not added. */
    const broken = await generation('broken', 'gen-broken');
    chat.failing.set('gen-broken', { status: 401, body: '{"error":"bad key"}' });
    await expect(models.addToChain(administratorId, 'generation', 'free', broken.id)).rejects.toMatchObject({ code: 'probe_failed' });
    await expect(models.addToChain(administratorId, 'speech', 'free', broken.id)).rejects.toMatchObject({ code: 'speech_single' });
    const actions = (await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(eq(schema.adminAudit.administratorId, administratorId))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['model.chain.update', 'model.activate', 'model.cooldown.clear']));
    await models.saveChain(administratorId, 'generation', 'free', [{ id: primary, active: true }, { id: backup, active: true }]);
  });

  it('takes only same-space embedding backups, and moves a failing batch to one', async () => {
    const space = crypto.randomUUID();
    const [primary] = await db().insert(schema.modelConfig)
      .values({ name: uniqueName('embed'), kind: 'embedding', transport: 'openai_compatible', baseUrl: embedA.baseUrl, model: 'fake-embed', enabled: true, embeddingSpace: space, apiKeyCipher: null })
      .returning();
    created.push(primary!.id);
    await db().insert(schema.modelChain).values({ kind: 'embedding', audience: 'all', modelConfigId: primary!.id, position: 0 });
    const add = async (baseUrl: string, model: string) => {
      const config = await models.createModelConfig(administratorId, { name: uniqueName('embed-backup'), kind: 'embedding', transport: 'openai_compatible', baseUrl, model, apiKey: 'sk-test-0000' });
      created.push(config.id);
      return config;
    };
    const shifted = await add(embedB.baseUrl, 'fake-embed');
    await expect(models.addToChain(administratorId, 'embedding', undefined, shifted.id)).rejects.toMatchObject({ code: 'embedding_space_mismatch' });
    const other = await add(embedA.baseUrl, 'fake-embed-2');
    await expect(models.addToChain(administratorId, 'embedding', undefined, other.id)).rejects.toMatchObject({ code: 'embedding_space_mismatch' });
    const same = await add(embedC.baseUrl, 'fake-embed');
    await models.addToChain(administratorId, 'embedding', undefined, same.id);
    const [stored] = await db().select().from(schema.modelConfig).where(eq(schema.modelConfig.id, same.id));
    expect(stored!.embeddingSpace).toBe(space);
    const chain = await chainFor('embedding');
    expect(chain.map((endpoint) => [endpoint.configId, endpoint.space])).toEqual([[primary!.id, space], [same.id, space]]);

    embedA.embeddings.failModel = 'fake-embed';
    embedA.embeddings.after = 0;
    try {
      const before = embedC.requests.length;
      const { vectors, endpoint } = await embedTexts(['warehouse inventory']);
      expect(vectors).toHaveLength(1);
      /* Tagged as the primary's: the vectors are in its space. */
      expect(endpoint.configId).toBe(primary!.id);
      expect(embedC.requests.length).toBeGreaterThan(before);
    } finally {
      embedA.embeddings.failModel = null;
    }

    /* Making the backup primary is a reorder, never a re-embed. */
    expect(await models.activateModelConfig(administratorId, same.id)).toMatchObject({ activated: true, reembed: false });
    expect((await chainFor('embedding')).map((endpoint) => [endpoint.configId, endpoint.space])).toEqual([[same.id, space], [primary!.id, space]]);
    /* An entry enabled outside the list's space (a re-embed's switch) never takes the old space's backups. */
    await db().update(schema.modelConfig).set({ embeddingSpace: crypto.randomUUID() }).where(eq(schema.modelConfig.id, same.id));
    forgetModelCache();
    expect((await chainFor('embedding')).map((endpoint) => endpoint.configId)).toEqual([same.id]);
  });
});
