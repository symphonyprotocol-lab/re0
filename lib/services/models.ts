/**
 * The console's model page (rebuild-proposal.md 2.5): entries per kind,
 * exactly one enabled, enabled entries frozen in model and endpoint, keys
 * sealed with only their tail shown, probes that send one real request.
 *
 * Generation and transcription switch on activation; the next request
 * reads the new row (this instance at once, others within the minute
 * `modelFor` caches for). Embedding switches only through a re-embed job.
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import type { ModelKind } from '@/lib/constants';
import { changesWhatAnswers, keyTail, mayCarryKey, parseModelConfig, switchesImmediately, type ModelConfigInput } from '@/lib/domain/models';
import { consoleEndpoint, environmentEndpoint, forgetModelCache } from '@/lib/infra/ai/models';
import { probeEndpoint, type ProbeResult } from '@/lib/infra/ai/probe';
import { sealCredential } from '@/lib/infra/crypto/credentials';
import { db, schema } from '@/lib/infra/db';
import { audit, AdminInputError } from '@/lib/services/admin';
import { runningReembedJob, startReembed } from '@/lib/services/reembed';

export type ModelConfigRow = typeof schema.modelConfig.$inferSelect;

/** What the page receives: never the cipher. */
export type ModelConfigView = Omit<ModelConfigRow, 'apiKeyCipher'> & { hasKey: boolean };

function view(row: ModelConfigRow): ModelConfigView {
  const { apiKeyCipher, ...rest } = row;
  return { ...rest, hasKey: Boolean(apiKeyCipher) };
}

function shown(row: ModelConfigRow) {
  return { name: row.name, kind: row.kind, transport: row.transport, baseUrl: row.baseUrl, model: row.model, apiKeyTail: row.apiKeyTail, timeoutMs: row.timeoutMs, enabled: row.enabled };
}

export async function listModelConfigs(): Promise<{
  configs: ModelConfigView[];
  fallbacks: Record<ModelKind, { model: string; transport: string }>;
}> {
  const rows = await db().select().from(schema.modelConfig).orderBy(asc(schema.modelConfig.kind), asc(schema.modelConfig.updatedAt));
  const fallback = (kind: ModelKind) => {
    const endpoint = environmentEndpoint(kind);
    return { model: endpoint.model, transport: endpoint.transport };
  };
  return {
    configs: rows.map(view),
    fallbacks: { generation: fallback('generation'), embedding: fallback('embedding'), transcription: fallback('transcription') },
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
    .where(eq(schema.modelConfig.transport, input.transport));
  const donor = rows.find((row) => row.apiKeyCipher && mayCarryKey(row, input));
  return donor?.apiKeyCipher ? { cipher: donor.apiKeyCipher, tail: donor.apiKeyTail } : null;
}

export async function createModelConfig(administratorId: string, raw: Record<string, unknown>): Promise<ModelConfigView> {
  const input = parsed(raw);
  const key = input.apiKey
    ? { cipher: await sealCredential(input.apiKey, 'provider'), tail: keyTail(input.apiKey) }
    : await carriedKey(input);
  const database = db();
  return database.transaction(async (tx) => {
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
        enabled: false,
        updatedBy: administratorId,
        updatedAt: new Date(),
      })
      .returning();
    await audit(tx, { administratorId, action: 'model.create', target: row!.id, after: shown(row!) });
    return view(row!);
  });
}

export async function updateModelConfig(administratorId: string, id: string, raw: Record<string, unknown>): Promise<ModelConfigView> {
  const database = db();
  const [current] = await database.select().from(schema.modelConfig).where(eq(schema.modelConfig.id, id)).limit(1);
  if (!current) throw new AdminInputError('not_found');
  const input = parsed({ ...raw, kind: current.kind });
  if (current.enabled && changesWhatAnswers(current, input)) throw new AdminInputError('locked');
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
  return database.transaction(async (tx) => {
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
        updatedBy: administratorId,
        updatedAt: new Date(),
      })
      .where(eq(schema.modelConfig.id, id))
      .returning();
    await audit(tx, { administratorId, action: 'model.update', target: id, before: shown(current), after: shown(row!) });
    forgetModelCache();
    return view(row!);
  });
}

/**
 * Makes an entry the one in use for its kind. Embedding starts a re-embed
 * job instead (`lib/services/reembed.ts`) and switches when the job ends --
 * unless nothing is indexed yet, when the entry is enabled at once.
 */
export async function activateModelConfig(administratorId: string, id: string): Promise<{ activated: boolean; reembed: boolean; jobId: string | null }> {
  const database = db();
  const [target] = await database.select().from(schema.modelConfig).where(eq(schema.modelConfig.id, id)).limit(1);
  if (!target) throw new AdminInputError('not_found');
  if (target.enabled) return { activated: true, reembed: false, jobId: null };
  if (!switchesImmediately(target.kind)) {
    const job = await startReembed(administratorId, id);
    if (job) return { activated: false, reembed: true, jobId: job.id };
  }
  return { ...(await enable(administratorId, target)), jobId: null };
}

async function enable(administratorId: string, target: ModelConfigRow): Promise<{ activated: boolean; reembed: boolean }> {
  await db().transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(schema.modelConfig)
      .where(and(eq(schema.modelConfig.kind, target.kind), eq(schema.modelConfig.enabled, true)))
      .for('update');
    await tx
      .update(schema.modelConfig)
      .set({ enabled: false, updatedBy: administratorId, updatedAt: new Date() })
      .where(and(eq(schema.modelConfig.kind, target.kind), ne(schema.modelConfig.id, target.id)));
    await tx
      .update(schema.modelConfig)
      .set({ enabled: true, updatedBy: administratorId, updatedAt: new Date() })
      .where(eq(schema.modelConfig.id, target.id));
    await audit(tx, {
      administratorId,
      action: 'model.activate',
      target: target.id,
      before: previous ? shown(previous) : null,
      after: { ...shown(target), enabled: true },
    });
  });
  forgetModelCache();
  return { activated: true, reembed: false };
}

export async function probeModelConfig(administratorId: string, id: string): Promise<ProbeResult> {
  const database = db();
  const [row] = await database.select().from(schema.modelConfig).where(eq(schema.modelConfig.id, id)).limit(1);
  if (!row) throw new AdminInputError('not_found');
  const result = await probeEndpoint(await consoleEndpoint(row));
  await database
    .update(schema.modelConfig)
    .set({ lastProbeAt: new Date(), lastProbeOk: result.ok })
    .where(eq(schema.modelConfig.id, id));
  await audit(database, { administratorId, action: 'model.probe', target: id, after: { ok: result.ok, latencyMs: result.latencyMs } });
  return result;
}
