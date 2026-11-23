/**
 * The console's model page (rebuild-proposal.md 2.5): entries per kind,
 * and per kind (per audience for generation) a list of a primary and its
 * backups (lib/services/model-chain.ts, lib/domain/model-failover.ts).
 * Entries in a list are frozen in model and endpoint; keys are sealed with
 * only their tail shown, and probes send one real request.
 *
 * Generation and transcription switch on activation; the next request
 * reads the new row (this instance at once, others within the minute
 * `modelFor` caches for). Embedding switches only through a re-embed job.
 */
import { embed } from 'ai';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { ModelKind } from '@/lib/constants';
import { changesWhatAnswers, keyTail, mayCarryKey, parseModelConfig, perMillionUsd, readsImages, switchesImmediately, type GenerationAudience, type ModelConfigInput, type ModelGenerationPrice } from '@/lib/domain/models';
import type { ProviderRate } from '@/lib/domain/provider-cost';
import { gatewayGenerationPricing, gatewayModelVision } from '@/lib/infra/ai/gateway-generation-pricing';
import { configuredProviderRate, providerPrices, saveModelGenerationPrice, saveModelProcessingPrice, type ProviderPrices } from '@/lib/services/provider-pricing';
import { modelPricingTarget, servicePricingOf, type ServicePricingInput } from '@/lib/domain/service-pricing';
import { consoleEndpoint, embeddingModel, endpointHasCredentials, environmentEndpoint, forgetModelCache } from '@/lib/infra/ai/models';
import { probeEndpoint, type ProbeResult } from '@/lib/infra/ai/probe';
import { chainAudience, hasFailover, HEALTH_PROBE_EVERY_MS, sameEmbeddingSpace, type ChainAudience, type SwitchingClass } from '@/lib/domain/model-failover';
import { clearHealth, reportSuccess } from '@/lib/infra/ai/model-health';
import { chainsOf, inAnyChain, lockKind, readAllChains, readChain, writeChain, type ChainItem } from '@/lib/services/model-chain';
import { sealCredential } from '@/lib/infra/crypto/credentials';
import { db, schema, type Executor } from '@/lib/infra/db';
import { audit, AdminInputError } from '@/lib/services/admin';
import { runningReembedJob, startReembed } from '@/lib/services/reembed';

export type ModelConfigRow = typeof schema.modelConfig.$inferSelect;

/** What the page receives: never the cipher. */
export type ModelConfigView = Omit<ModelConfigRow, 'apiKeyCipher' | 'deletedAt'> & {
  hasKey: boolean;
  costPricing: ServicePricingInput | null;
  generationPricing: (Partial<ModelGenerationPrice> & { source: 'gateway' | 'configured' | 'unknown' }) | null;
  /** Generation: whether the entry reads images (posts carry them); null when the gateway's catalog cannot say. Always true for other kinds. */
  readsImages: boolean | null;
};

/**
 * What a generation entry's image check reads: the catalog for a gateway
 * model, the saved flag otherwise. A catalog answer is kept on the gateway
 * entry, so an outage later falls back to it instead of freezing changes.
 */
async function imageReading(row: ModelConfigRow): Promise<boolean | undefined> {
  if (row.kind !== 'generation' || row.transport !== 'gateway') return readsImages(row, undefined);
  const vision = await gatewayModelVision(row.model);
  if (vision !== undefined && vision !== row.supportsImages) {
    await db().update(schema.modelConfig).set({ supportsImages: vision }).where(and(eq(schema.modelConfig.id, row.id), eq(schema.modelConfig.model, row.model)));
  }
  return readsImages(row, vision);
}

/**
 * Posts carry images and any generation entry may answer one (moderation,
 * the image description, the answers), so an entry that cannot read them
 * never starts answering: enabling it, adding it to a list or resuming it
 * is refused -- `no_vision`, or `vision_unknown` while the gateway's
 * catalog cannot be read.
 */
async function assertReadsImages(row: ModelConfigRow): Promise<void> {
  const reads = await imageReading(row);
  if (reads === undefined) throw new AdminInputError('vision_unknown');
  if (!reads) throw new AdminInputError('no_vision');
}

async function view(row: ModelConfigRow, prices?: ProviderPrices): Promise<ModelConfigView> {
  const { apiKeyCipher, deletedAt: _deleted, ...rest } = row;
  let generationPricing: ModelConfigView['generationPricing'] = null;
  if (row.kind === 'generation') {
    let rate: ProviderRate | undefined;
    if (row.transport === 'gateway') rate = (await gatewayGenerationPricing(row.model))?.rate;
    else {
      const endpoint = new URL(row.baseUrl!);
      endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
      rate = configuredProviderRate(prices ?? await providerPrices(), { service: 'generation', endpoint: endpoint.href.replace(/\/+$/, ''), model: row.model });
    }
    generationPricing = {
      source: row.transport === 'gateway' ? 'gateway' : rate ? 'configured' : 'unknown',
      ...(rate ? { inputUsdPerMillion: perMillionUsd(rate.usdPerUnit), ...(rate.outputUsdPerUnit !== undefined ? { outputUsdPerMillion: perMillionUsd(rate.outputUsdPerUnit) } : {}) } : {}),
    };
  }
  const costPricing = row.kind === 'embedding' || row.kind === 'transcription'
    ? servicePricingOf(configuredProviderRate(prices ?? await providerPrices(), modelPricingTarget({ ...row, kind: row.kind })))
    : null;
  return { ...rest, hasKey: Boolean(apiKeyCipher), generationPricing, costPricing, readsImages: (await imageReading(row)) ?? null };
}

function shown(row: ModelConfigRow) {
  return { name: row.name, kind: row.kind, transport: row.transport, baseUrl: row.baseUrl, model: row.model, apiKeyTail: row.apiKeyTail, timeoutMs: row.timeoutMs, enabled: row.enabled, enabledPlan: row.enabledPlan, supportsImages: row.supportsImages };
}

/** An entry not deleted (`deleteModelConfig`): a deleted one answers like one that never existed. */
async function live(executor: Executor, id: string): Promise<ModelConfigRow | undefined> {
  const [row] = await executor.select().from(schema.modelConfig).where(and(eq(schema.modelConfig.id, id), isNull(schema.modelConfig.deletedAt))).limit(1);
  return row;
}

/** One list as the page shows it: `generation:free`, `generation:plan`, `embedding`, `transcription`, `speech`. */
export type ChainKey = 'generation:free' | 'generation:plan' | 'embedding' | 'transcription' | 'speech';
export interface ChainEntryView { configId: string; position: number; active: boolean }
export interface ModelHealthView {
  state: 'ok' | 'cooling';
  reason: SwitchingClass | null;
  coolingUntil: Date | null;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
}
export interface ModelHealthEventView { id: string; configId: string; name: string | null; event: 'cooling' | 'recovered' | 'manual_clear'; reason: SwitchingClass | null; coolingUntil: Date | null; createdAt: Date }

export function chainKey(kind: ModelKind, audience: ChainAudience): ChainKey {
  return kind === 'generation' ? `generation:${audience === 'plan' ? 'plan' : 'free'}` : kind as ChainKey;
}

const EVENTS_SHOWN = 20;

export async function listModelConfigs(now = new Date()): Promise<{
  configs: ModelConfigView[];
  fallbacks: Record<ModelKind, { model: string; transport: string }>;
  chains: Record<ChainKey, ChainEntryView[]>;
  health: Record<string, ModelHealthView>;
  /** Calls since 00:00 UTC per entry. */
  today: Record<string, { calls: number; failed: number }>;
  events: ModelHealthEventView[];
}> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [rows, prices, chainRows, healthRows, todayRows, eventRows] = await Promise.all([
    db().select().from(schema.modelConfig).where(isNull(schema.modelConfig.deletedAt)).orderBy(asc(schema.modelConfig.kind), asc(schema.modelConfig.updatedAt)),
    providerPrices(),
    readAllChains(db()),
    db().select().from(schema.modelHealth),
    db()
      .select({ configId: schema.modelCall.configId, calls: sql<number>`count(*)::int`, failed: sql<number>`(count(*) filter (where ${schema.modelCall.status} = 'failed'))::int` })
      .from(schema.modelCall)
      .where(and(gte(schema.modelCall.createdAt, day), sql`${schema.modelCall.configId} is not null`))
      .groupBy(schema.modelCall.configId),
    db()
      .select({ event: schema.modelHealthEvent, name: schema.modelConfig.name })
      .from(schema.modelHealthEvent)
      .leftJoin(schema.modelConfig, eq(schema.modelConfig.id, schema.modelHealthEvent.modelConfigId))
      .orderBy(desc(schema.modelHealthEvent.createdAt))
      .limit(EVENTS_SHOWN),
  ]);
  const chains: Record<ChainKey, ChainEntryView[]> = { 'generation:free': [], 'generation:plan': [], embedding: [], transcription: [], speech: [] };
  for (const row of chainRows) chains[chainKey(row.kind, row.audience)].push({ configId: row.modelConfigId, position: row.position, active: row.active });
  const health = Object.fromEntries(healthRows.map((row) => [row.modelConfigId, {
    state: row.state, reason: row.reason ?? null, coolingUntil: row.coolingUntil, consecutiveFailures: row.consecutiveFailures,
    lastFailureAt: row.lastFailureAt, lastSuccessAt: row.lastSuccessAt, lastErrorCode: row.lastErrorCode,
  } satisfies ModelHealthView]));
  const today = Object.fromEntries(todayRows.map((row) => [row.configId!, { calls: Number(row.calls), failed: Number(row.failed) }]));
  const events = eventRows.map(({ event, name }) => ({ id: event.id, configId: event.modelConfigId, name, event: event.event, reason: event.reason ?? null, coolingUntil: event.coolingUntil, createdAt: event.createdAt }));
  const fallback = (kind: ModelKind) => {
    const endpoint = environmentEndpoint(kind);
    return { model: endpoint.model, transport: endpoint.transport };
  };
  return {
    configs: await Promise.all(rows.map((row) => view(row, prices))),
    fallbacks: { generation: fallback('generation'), embedding: fallback('embedding'), transcription: fallback('transcription'), speech: fallback('speech') },
    chains,
    health,
    today,
    events,
  };
}

function parsed(raw: Record<string, unknown>): ModelConfigInput {
  const result = parseModelConfig(raw);
  if ('error' in result) throw new AdminInputError(result.error);
  return result;
}

/** A key saved for the same endpoint, so a candidate on that endpoint needs no retyping. */
async function carriedKey(input: ModelConfigInput): Promise<{ cipher: string; tail: string | null } | null> {
  const rows = await db()
    .select()
    .from(schema.modelConfig)
    .where(and(eq(schema.modelConfig.transport, input.transport), isNull(schema.modelConfig.deletedAt)))
    .orderBy(desc(schema.modelConfig.enabled), desc(schema.modelConfig.updatedAt));
  const donor = rows.find((row) => row.kind !== 'speech' && row.apiKeyCipher && mayCarryKey(row, input));
  return donor?.apiKeyCipher ? { cipher: donor.apiKeyCipher, tail: donor.apiKeyTail } : null;
}

export async function createModelConfig(administratorId: string, raw: Record<string, unknown>): Promise<ModelConfigView> {
  const input = parsed(raw);
  const key = input.apiKey
    ? { cipher: await sealCredential(input.apiKey, 'provider'), tail: keyTail(input.apiKey) }
    : input.kind === 'speech' && input.transport !== 'gateway' ? null : await carriedKey(input);
  const database = db();
  const created = await database.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.modelConfig)
      .values({
        name: input.name,
        kind: input.kind,
        transport: input.transport,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyCipher: key?.cipher ?? null,
        apiKeyTail: key?.tail ?? null,
        timeoutMs: input.timeoutMs,
        supportsImages: input.supportsImages ?? false,
        enabled: false,
        updatedBy: administratorId,
        updatedAt: new Date(),
      })
      .returning();
    await audit(tx, { administratorId, action: 'model.create', target: row!.id, after: shown(row!) });
    await saveModelGenerationPrice(tx, administratorId, input);
    await saveModelProcessingPrice(tx, administratorId, input);
    return row!;
  });
  return view(created);
}

export async function updateModelConfig(administratorId: string, id: string, raw: Record<string, unknown>): Promise<ModelConfigView> {
  const database = db();
  const current = await live(database, id);
  if (!current) throw new AdminInputError('not_found');
  const input = parsed({ ...raw, kind: current.kind });
  const inUse = current.enabled || current.enabledPlan || (await inAnyChain(database, id));
  if (inUse && changesWhatAnswers(current, input)) throw new AdminInputError('locked');
  /* An entry in use keeps reading images: taking the mark off would let it answer posts it cannot see. */
  /* A gateway entry keeps the catalog's last answer while it names the same model. */
  const supportsImages = input.transport === 'openai_compatible'
    ? (input.supportsImages ?? (current.transport === 'openai_compatible' ? current.supportsImages : false))
    : current.transport === 'gateway' && current.model === input.model ? current.supportsImages : false;
  if (inUse && current.supportsImages && !supportsImages && current.transport === 'openai_compatible') throw new AdminInputError('locked');
  /* The candidate of a running re-embed job is frozen too: its vectors are being made. */
  if (changesWhatAnswers(current, input) && (await runningReembedJob())?.toModelConfigId === id) throw new AdminInputError('locked');
  let cipher = current.apiKeyCipher;
  let tail = current.apiKeyTail;
  if (input.apiKey) {
    cipher = await sealCredential(input.apiKey, 'provider');
    tail = keyTail(input.apiKey);
  } else if (!mayCarryKey(current, input)) {
    /* A new host never inherits the old host's key. */
    cipher = null;
    tail = null;
  }
  const updated = await database.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.modelConfig)
      .set({
        name: input.name,
        transport: input.transport,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyCipher: cipher,
        apiKeyTail: tail,
        timeoutMs: input.timeoutMs,
        supportsImages,
        updatedBy: administratorId,
        updatedAt: new Date(),
      })
      .where(eq(schema.modelConfig.id, id))
      .returning();
    await audit(tx, { administratorId, action: 'model.update', target: id, before: shown(current), after: shown(row!) });
    await saveModelGenerationPrice(tx, administratorId, input);
    await saveModelProcessingPrice(tx, administratorId, input);
    return row!;
  });
  forgetModelCache();
  return view(updated);
}

/**
 * Makes an entry the one in use for its kind and generation audience. Embedding starts a re-embed
 * job instead (`lib/services/reembed.ts`) and switches when the job ends --
 * unless nothing is indexed yet, when the entry is enabled at once.
 */
export async function activateModelConfig(administratorId: string, id: string, audience: GenerationAudience = 'free'): Promise<{ activated: boolean; reembed: boolean; jobId: string | null }> {
  const database = db();
  const target = await live(database, id);
  if (!target) throw new AdminInputError('not_found');
  if (target.kind === 'speech' && !endpointHasCredentials(await consoleEndpoint(target))) throw new AdminInputError('voice_key_required');
  if ((audience !== 'free' && audience !== 'plan') || (audience === 'plan' && target.kind !== 'generation')) throw new AdminInputError('audience');
  if (target.kind === 'generation') await assertReadsImages(target);
  if (target.kind === 'embedding' && target.enabled) return { activated: true, reembed: false, jobId: null };
  /* A backup of the embedding list makes the primary's vectors: becoming the primary is a reorder, never a re-embed. */
  if (target.kind === 'embedding' && (await inAnyChain(database, target.id))) return { ...(await promote(administratorId, target, 'all')), jobId: null };
  if (!switchesImmediately(target.kind)) {
    const job = await startReembed(administratorId, id);
    if (job) return { activated: false, reembed: true, jobId: job.id };
  }
  return { ...(await enable(administratorId, target, audience)), jobId: null };
}

/**
 * The entry becomes its list's primary: generation and transcription keep
 * the other entries as backups after it; embedding (a new space) and speech
 * (one voice) start a list of their own.
 */
async function enable(administratorId: string, target: ModelConfigRow, audience: GenerationAudience): Promise<{ activated: boolean; reembed: boolean }> {
  const list = chainAudience(target.kind, audience);
  const now = new Date();
  await db().transaction(async (tx) => {
    /* Serialize even the first activation, when there is no active row to lock. */
    await lockKind(tx, target.kind);
    if (!(await live(tx, target.id))) throw new AdminInputError('not_found');
    const enabledField = audience === 'plan' ? 'enabledPlan' : 'enabled';
    const [previous] = await tx
      .select()
      .from(schema.modelConfig)
      .where(and(eq(schema.modelConfig.kind, target.kind), eq(schema.modelConfig[enabledField], true)))
      .for('update');
    const current = await readChain(tx, target.kind, list);
    const others: ChainItem[] = hasFailover(target.kind) && target.kind !== 'embedding'
      ? current.filter((row) => row.modelConfigId !== target.id).map((row) => ({ configId: row.modelConfigId, active: row.active }))
      : [];
    /* An embedding entry enabled without a job (nothing indexed yet) still starts a space of its own: no stored profile vector of the last model is read as its. */
    if (target.kind === 'embedding') await tx.update(schema.modelConfig).set({ embeddingSpace: crypto.randomUUID() }).where(eq(schema.modelConfig.id, target.id));
    await writeChain(tx, target.kind, list, [{ configId: target.id, active: true }, ...others], administratorId, now);
    const [enabled] = await tx.select().from(schema.modelConfig).where(eq(schema.modelConfig.id, target.id));
    await audit(tx, {
      administratorId,
      action: 'model.activate',
      target: target.id,
      before: previous ? shown(previous) : null,
      after: { ...shown(enabled!), ...(target.kind === 'generation' ? { audience } : {}) },
    });
  });
  forgetModelCache();
  return { activated: true, reembed: false };
}

/** An entry already in its list moves to the front; the rest keep their order. */
async function promote(administratorId: string, target: ModelConfigRow, list: ChainAudience): Promise<{ activated: boolean; reembed: boolean }> {
  await db().transaction(async (tx) => {
    await lockKind(tx, target.kind);
    if (!(await live(tx, target.id))) throw new AdminInputError('not_found');
    const current = await readChain(tx, target.kind, list);
    if (!current.some((row) => row.modelConfigId === target.id)) throw new AdminInputError('stale');
    const before = current.map((row) => ({ configId: row.modelConfigId, active: row.active }));
    const after = [{ configId: target.id, active: true }, ...before.filter((item) => item.configId !== target.id)];
    await writeChain(tx, target.kind, list, after, administratorId);
    await audit(tx, { administratorId, action: 'model.chain.update', target: chainKey(target.kind, list), before, after });
  });
  forgetModelCache();
  return { activated: true, reembed: false };
}

function listFor(kind: ModelKind, audience: unknown): ChainAudience {
  if (kind !== 'generation') return 'all';
  if (audience !== 'free' && audience !== 'plan') throw new AdminInputError('audience');
  return audience;
}

function chainItems(raw: unknown): ChainItem[] {
  if (!Array.isArray(raw)) throw new AdminInputError('chain');
  const items: ChainItem[] = raw.map((item) => {
    const entry = item as { id?: unknown; active?: unknown } | null;
    if (!entry || typeof entry.id !== 'string' || typeof entry.active !== 'boolean') throw new AdminInputError('chain');
    return { configId: entry.id, active: entry.active };
  });
  if (new Set(items.map((item) => item.configId)).size !== items.length) throw new AdminInputError('chain');
  return items;
}

const sameItems = (a: readonly ChainItem[], b: readonly ChainItem[]) =>
  a.length === b.length && a.every((item, index) => item.configId === b[index]!.configId && item.active === b[index]!.active);

/**
 * Changes a list the page saw as `expected` (its entries in order, each
 * active or not): anything else stored since -- another administrator's
 * addition, removal or reorder -- answers `stale` and changes nothing.
 */
async function changeChain(administratorId: string, kind: ModelKind, list: ChainAudience, expected: ChainItem[], next: (current: ChainItem[]) => ChainItem[]): Promise<ChainEntryView[]> {
  const saved = await db().transaction(async (tx) => {
    await lockKind(tx, kind);
    const before = (await readChain(tx, kind, list)).map((row) => ({ configId: row.modelConfigId, active: row.active }));
    if (!sameItems(before, expected)) throw new AdminInputError('stale');
    const after = next(before);
    /* A list keeps an active entry: an empty embedding list would read another space, and no list could be emptied before lists existed either. */
    if (!after.some((item) => item.active)) throw new AdminInputError('chain_empty');
    await writeChain(tx, kind, list, after, administratorId);
    await audit(tx, { administratorId, action: 'model.chain.update', target: chainKey(kind, list), before, after });
    return readChain(tx, kind, list);
  });
  forgetModelCache();
  return saved.map((row) => ({ configId: row.modelConfigId, position: row.position, active: row.active }));
}

/**
 * Reorders, pauses or resumes a list's entries: `entries` must hold exactly
 * the entries the page saw (`expected`) -- removing one is `removeFromChain`,
 * adding one `addToChain`.
 */
export async function saveChain(administratorId: string, kind: ModelKind, audience: unknown, raw: unknown, rawExpected: unknown): Promise<ChainEntryView[]> {
  const list = listFor(kind, audience);
  const items = chainItems(raw);
  const expected = chainItems(rawExpected);
  const ids = (entries: ChainItem[]) => entries.map((item) => item.configId).sort().join(',');
  if (ids(items) !== ids(expected)) throw new AdminInputError('chain');
  /* Resuming a paused generation entry starts it answering: it must read images too. */
  const resumed = items.filter((item) => item.active && !expected.some((seen) => seen.configId === item.configId && seen.active)).map((item) => item.configId);
  if (kind === 'generation' && resumed.length > 0) {
    const rows = await db().select().from(schema.modelConfig).where(inArray(schema.modelConfig.id, resumed));
    for (const row of rows) await assertReadsImages(row);
  }
  return changeChain(administratorId, kind, list, expected, () => items);
}

/** Takes one entry out of a list the page saw as `expected`. */
export async function removeFromChain(administratorId: string, kind: ModelKind, audience: unknown, id: unknown, rawExpected: unknown): Promise<ChainEntryView[]> {
  const list = listFor(kind, audience);
  const expected = chainItems(rawExpected);
  if (typeof id !== 'string' || !expected.some((item) => item.configId === id)) throw new AdminInputError('stale');
  return changeChain(administratorId, kind, list, expected, (current) => current.filter((item) => item.configId !== id));
}

/** What keeps an entry from being deleted: a list it is in, or the running re-embed job making its vectors. */
export type ModelUse = ChainKey | 'reembed';

/** `in_use`, naming each list the entry has to be removed from first. */
export class ModelInUseError extends AdminInputError {
  constructor(readonly uses: ModelUse[]) {
    super('in_use');
  }
}

/**
 * Deletes an entry that nothing uses: in no list (generation's Free or Plan
 * list, embedding's, transcription's, speech's single entry), not enabled
 * for either audience, and not the candidate of a running re-embed job. The
 * environment's model is no entry, so nothing stored depends on it. Model
 * calls, re-embed jobs, the cost backfill and audit rows still name the
 * entry, so the row stays, marked deleted (no page, list or request reads
 * it again, and its sealed key is dropped); its cooldown state goes, its
 * health events stay as history.
 */
export async function deleteModelConfig(administratorId: string, id: string): Promise<void> {
  const database = db();
  const [found] = await database.select({ kind: schema.modelConfig.kind }).from(schema.modelConfig).where(eq(schema.modelConfig.id, id)).limit(1);
  if (!found) throw new AdminInputError('not_found');
  await database.transaction(async (tx) => {
    /* The kind's lock holds off list changes and activations; the re-embed lock a job starting for this entry. */
    await lockKind(tx, found.kind);
    if (found.kind === 'embedding') await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:reembed'))`);
    const [current] = await tx.select().from(schema.modelConfig).where(and(eq(schema.modelConfig.id, id), isNull(schema.modelConfig.deletedAt))).for('update');
    if (!current) throw new AdminInputError('not_found');
    const uses = new Set<ModelUse>((await chainsOf(tx, [id])).map((row) => chainKey(row.kind, row.audience)));
    if (current.enabled) uses.add(chainKey(current.kind, current.kind === 'generation' ? 'free' : 'all'));
    if (current.enabledPlan) uses.add('generation:plan');
    if (current.kind === 'embedding') {
      const job = await runningReembedJob(tx);
      if (job && (job.toModelConfigId === id || job.fromModelConfigId === id)) uses.add('reembed');
    }
    if (uses.size > 0) throw new ModelInUseError([...uses]);
    const now = new Date();
    await tx.update(schema.modelConfig)
      .set({ deletedAt: now, apiKeyCipher: null, updatedBy: administratorId, updatedAt: now })
      .where(eq(schema.modelConfig.id, id));
    await tx.delete(schema.modelHealth).where(eq(schema.modelHealth.modelConfigId, id));
    await audit(tx, { administratorId, action: 'model.delete', target: id, before: shown(current) });
  });
  await clearHealth(id).catch(() => undefined);
  forgetModelCache();
}

/** The text both embedding entries embed to show they share a space. */
const SPACE_CHECK_TEXT = 're0 embedding space check: 知识库检索 / knowledge retrieval';

/**
 * Appends an entry to a list as its last backup, once one real request to
 * it succeeds. An embedding backup must also make the primary's vectors:
 * the same model, and the same vector for the same text.
 */
export async function addToChain(administratorId: string, kind: ModelKind, audience: unknown, id: string): Promise<ChainEntryView[]> {
  const list = listFor(kind, audience);
  if (!hasFailover(kind)) throw new AdminInputError('speech_single');
  const target = await live(db(), id);
  if (!target || target.kind !== kind) throw new AdminInputError('not_found');
  if (kind === 'generation') await assertReadsImages(target);
  const current = await readChain(db(), kind, list);
  if (current.some((row) => row.modelConfigId === id)) throw new AdminInputError('stale');
  /* With an empty list the entry would be the primary: an embedding one goes through re-embedding, the others through enabling. */
  if (current.length === 0) throw new AdminInputError('chain_empty');
  const endpoint = await consoleEndpoint(target);
  const probe = await probeEndpoint(endpoint);
  await db().update(schema.modelConfig).set({ lastProbeAt: new Date(), lastProbeOk: probe.ok }).where(eq(schema.modelConfig.id, id));
  if (!probe.ok) throw new AdminInputError('probe_failed');
  let space: string | null | undefined;
  if (kind === 'embedding') {
    const [primary] = await db().select().from(schema.modelConfig).where(eq(schema.modelConfig.id, current[0]!.modelConfigId)).limit(1);
    const signal = AbortSignal.timeout(Math.max(endpoint.timeoutMs, 30_000));
    const [mine, theirs] = await Promise.all([
      embed({ model: embeddingModel(await consoleEndpoint(primary!)), value: SPACE_CHECK_TEXT, maxRetries: 0, abortSignal: signal }),
      embed({ model: embeddingModel(endpoint), value: SPACE_CHECK_TEXT, maxRetries: 0, abortSignal: signal }),
    ]).catch(() => { throw new AdminInputError('probe_failed'); });
    if (!sameEmbeddingSpace({ model: primary!.model, vector: mine.embedding }, { model: target.model, vector: theirs.embedding })) throw new AdminInputError('embedding_space_mismatch');
    space = primary!.embeddingSpace;
  }
  const saved = await db().transaction(async (tx) => {
    await lockKind(tx, kind);
    if (!(await live(tx, id))) throw new AdminInputError('not_found');
    const latest = await readChain(tx, kind, list);
    if (latest.some((row) => row.modelConfigId === id) || latest[0]?.modelConfigId !== current[0]?.modelConfigId) throw new AdminInputError('stale');
    /* A backup's vectors are the primary's: it carries the primary's space, so it still does if it ever leads the list. */
    if (space !== undefined) await tx.update(schema.modelConfig).set({ embeddingSpace: space }).where(eq(schema.modelConfig.id, id));
    const before = latest.map((row) => ({ configId: row.modelConfigId, active: row.active }));
    const after = [...before, { configId: id, active: true }];
    await writeChain(tx, kind, list, after, administratorId);
    await audit(tx, { administratorId, action: 'model.chain.update', target: chainKey(kind, list), before, after });
    return readChain(tx, kind, list);
  });
  forgetModelCache();
  return saved.map((row) => ({ configId: row.modelConfigId, position: row.position, active: row.active }));
}

/** "解除冷却": requests use the entry again at once (this instance) or within ten seconds (others). */
export async function clearModelCooldown(administratorId: string, id: string): Promise<{ cleared: boolean }> {
  if (!(await live(db(), id))) throw new AdminInputError('not_found');
  const cleared = await clearHealth(id);
  await audit(db(), { administratorId, action: 'model.cooldown.clear', target: id, after: { cleared } });
  return { cleared };
}

export async function probeModelConfig(administratorId: string, id: string): Promise<ProbeResult> {
  const database = db();
  const row = await live(database, id);
  if (!row) throw new AdminInputError('not_found');
  const result = await probeEndpoint(await consoleEndpoint(row));
  await database
    .update(schema.modelConfig)
    .set({ lastProbeAt: new Date(), lastProbeOk: result.ok })
    .where(eq(schema.modelConfig.id, id));
  /* A probe that works ends a cooldown, whatever its reason. */
  if (result.ok) await reportSuccess({ configId: row.id, kind: row.kind, name: row.name, model: row.model }, new Date(), 'probe');
  await audit(database, { administratorId, action: 'model.probe', target: id, after: { ok: result.ok, latencyMs: result.latencyMs } });
  return result;
}

/**
 * The health cron: probes each listed entry cooling for a reason only a
 * probe clears (quota, a bad key, a missing model), once per
 * `HEALTH_PROBE_EVERY_MS`. A probe that answers clears the cooldown.
 */
export async function probeCoolingModels(now = new Date()): Promise<{ probed: number; recovered: number }> {
  const database = db();
  const due = await database
    .select({ config: schema.modelConfig })
    .from(schema.modelHealth)
    .innerJoin(schema.modelConfig, eq(schema.modelConfig.id, schema.modelHealth.modelConfigId))
    .where(sql`${schema.modelHealth.state} = 'cooling'
      and ${schema.modelHealth.reason} in ('quota', 'auth', 'model_missing')
      and (${schema.modelHealth.lastProbeAt} is null or ${schema.modelHealth.lastProbeAt} <= ${new Date(now.getTime() - HEALTH_PROBE_EVERY_MS)})
      and exists (select 1 from ${schema.modelChain} c where c.model_config_id = ${schema.modelConfig.id} and c.active)`);
  /* Side by side: one slow entry must not hold the others past the cron's time. */
  const outcomes = await Promise.allSettled(due.map(async ({ config }) => {
    const result = await probeEndpoint(await consoleEndpoint(config));
    await database.update(schema.modelHealth).set({ lastProbeAt: now }).where(eq(schema.modelHealth.modelConfigId, config.id));
    await database.update(schema.modelConfig).set({ lastProbeAt: now, lastProbeOk: result.ok }).where(eq(schema.modelConfig.id, config.id));
    if (result.ok) await reportSuccess({ configId: config.id, kind: config.kind, name: config.name, model: config.model }, now, 'probe');
    return result.ok;
  }));
  return { probed: due.length, recovered: outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value).length };
}
