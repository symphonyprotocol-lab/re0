/**
 * Console management of the two retrieval models: the embedding model a
 * version's vectors are built and queried with, and the reranker in front of
 * the fused head. architecture.md 9.1, 9.2, 15.3, requirement.md 5.3 (a change
 * takes a reason and lands in the audit chain).
 *
 * One entry per kind, the newest row in force, append-only like
 * `retrieval_config` -- there is exactly one model an installation indexes
 * with, so unlike the generation registry there is nothing here to assign.
 * Nothing is ever updated: a change to either model changes what retrieval
 * *is*, and the record of when it changed is the table.
 *
 * The credential is sealed (`lib/infrastructure/crypto/credentials.ts`) and
 * opened only on the way to an adapter. Nothing in this module returns it to a
 * caller that renders: the console view says whether a key is stored, which is
 * all an operator needs to tell a configured model from a half-configured one.
 *
 * A kind nobody has saved yet falls back to the deployment's variables
 * (`EMBEDDING_PROVIDER_*`, `RERANK_PROVIDER_*`), which is what an installation
 * upgraded from before this table keeps running on until its first save.
 */
import { desc, eq } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import { uuidv7 } from '@/lib/domain/id';
import {
  API_KEY_MAX_LENGTH,
  EMBEDDING_COLUMN_DIMENSIONS,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_TIMEOUT_MS,
  isModelKind,
  mayCarryCredential,
  RERANK_TIMEOUT_MS,
  timeoutBoundsFor,
  type ModelKind,
} from '@/lib/domain/model-config';
import {
  embeddingAdapter,
  ProviderUnavailable,
  rerankAdapter,
  type EmbeddingAdapter,
  type EmbeddingProviderConfig,
  type RerankAdapter,
  type RerankProviderConfig,
} from '@/lib/infrastructure/ai/providers';
import {
  isCredentialKeyConfigured,
  openCredential,
  sealCredential,
} from '@/lib/infrastructure/crypto/credentials';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from './audit';

/** One entry as the console shows it: never the credential, only its shape. */
export interface ProviderModelRow {
  id: string;
  kind: ModelKind;
  label: string;
  baseUrl: string;
  model: string;
  /**
   * Whether a credential is stored -- never the key, nor a mask of it.
   * Rendering a mask would mean opening a provider secret to display eight
   * characters of it, and the page's question is only whether the model can
   * be called at all.
   */
  hasCredential: boolean;
  /** Embedding only. */
  dimensions: number | null;
  timeoutMs: number;
  enabled: boolean;
  createdAt: Date;
}

export interface ModelConfiguration {
  /** The entry in force for each kind, or null where none was ever saved. */
  current: Record<ModelKind, ProviderModelRow | null>;
  /**
   * Whether each stage can actually run -- the credential opened, not merely
   * stored. A row can hold a cipher that no longer opens (a missing or
   * rotated `CREDENTIAL_ENCRYPTION_KEY`), and showing that as "in force"
   * would send an operator looking for the fault everywhere but the key.
   */
  usable: Record<ModelKind, boolean>;
  /** Kinds with no saved row that run on the deployment's variables instead. */
  fromEnvironment: Record<ModelKind, boolean>;
  /** Whether stored credentials can be sealed and opened at all. */
  credentialKeyConfigured: boolean;
  /** Newest first, both kinds together -- the record of what changed when. */
  history: ProviderModelRow[];
}

/** The stored row, credential included. Never leaves this module. */
type StoredRow = typeof schema.providerModelConfig.$inferSelect;

function shown(row: StoredRow): ProviderModelRow {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    hasCredential: Boolean(row.apiKeyCipher),
    dimensions: row.dimensions,
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

/**
 * The row in force for every kind, in one query.
 *
 * One `distinct on` rather than a query per kind, because this is on the
 * retrieval path: a request asks which stages it can run and then resolves the
 * embedding model, and three round trips for two rows is three more than the
 * pinned-version read beside it.
 */
async function rowsInForce(): Promise<Record<ModelKind, StoredRow | null>> {
  const rows = await db()
    .selectDistinctOn([schema.providerModelConfig.kind])
    .from(schema.providerModelConfig)
    .orderBy(schema.providerModelConfig.kind, desc(schema.providerModelConfig.createdAt));
  const inForce: Record<ModelKind, StoredRow | null> = { embedding: null, rerank: null };
  for (const row of rows) inForce[row.kind] = row;
  return inForce;
}

/** The newest row of one kind. For the write path, which needs only one. */
async function newestRow(kind: ModelKind): Promise<StoredRow | null> {
  const [row] = await db()
    .select()
    .from(schema.providerModelConfig)
    .where(eq(schema.providerModelConfig.kind, kind))
    .orderBy(desc(schema.providerModelConfig.createdAt))
    .limit(1);
  return row ?? null;
}

export async function readModelConfiguration(): Promise<ModelConfiguration> {
  const [inForce, history] = await Promise.all([
    rowsInForce(),
    db()
      .select()
      .from(schema.providerModelConfig)
      .orderBy(desc(schema.providerModelConfig.createdAt))
      .limit(40),
  ]);
  const [embedding, rerank] = await Promise.all([
    embeddingProviderFrom(inForce.embedding),
    rerankProviderFrom(inForce.rerank),
  ]);
  return {
    current: {
      embedding: inForce.embedding ? shown(inForce.embedding) : null,
      rerank: inForce.rerank ? shown(inForce.rerank) : null,
    },
    usable: { embedding: embedding !== null, rerank: rerank !== null },
    fromEnvironment: {
      embedding: !inForce.embedding && embedding !== null,
      rerank: !inForce.rerank && rerank !== null,
    },
    credentialKeyConfigured: isCredentialKeyConfigured(),
    history: history.map(shown),
  };
}

/**
 * What an installation deployed before the console held these models keeps
 * running on: the variables, defaults and clocks the adapters used to read for
 * themselves.
 *
 * Consulted only for a kind that has never had a row saved. A saved row --
 * even one switched off -- is the console's decision and wins; without the
 * fallback, upgrading would quietly turn off vector recall, reranking and
 * every build until somebody re-entered keys the deployment already holds.
 */
function embeddingFromEnvironment(): EmbeddingProviderConfig | null {
  const apiKey = process.env.EMBEDDING_PROVIDER_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.EMBEDDING_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    ),
    model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
    apiKey,
    dimensions: EMBEDDING_COLUMN_DIMENSIONS,
    timeoutMs: EMBEDDING_TIMEOUT_MS.default,
  };
}

function rerankFromEnvironment(): RerankProviderConfig | null {
  const apiKey = process.env.RERANK_PROVIDER_API_KEY;
  const baseUrl = process.env.RERANK_PROVIDER_BASE_URL;
  if (!apiKey || !baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model: process.env.RERANK_MODEL ?? 'rerank-v3.5',
    apiKey,
    timeoutMs: RERANK_TIMEOUT_MS.default,
  };
}

/**
 * A row resolved and opened for its adapter -- or null, which is retrieval's
 * documented degradation (keyword leg alone, fusion order) and a build's
 * refusal to start (architecture.md 9.1).
 *
 * A row whose credential cannot be opened -- sealed under a secret that has
 * since been rotated -- is null for the same reason a missing row is: the
 * stage cannot run, and pretending otherwise turns a configuration problem
 * into a provider error on every request.
 */
async function embeddingProviderFrom(
  row: StoredRow | null,
): Promise<EmbeddingProviderConfig | null> {
  if (!row) return embeddingFromEnvironment();
  if (row.kind !== 'embedding' || !row.enabled || row.dimensions === null) return null;
  const apiKey = await openCredential(row.apiKeyCipher);
  if (!apiKey) return null;
  return {
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey,
    dimensions: row.dimensions,
    timeoutMs: row.timeoutMs,
  };
}

async function rerankProviderFrom(row: StoredRow | null): Promise<RerankProviderConfig | null> {
  if (!row) return rerankFromEnvironment();
  if (row.kind !== 'rerank' || !row.enabled) return null;
  const apiKey = await openCredential(row.apiKeyCipher);
  if (!apiKey) return null;
  return {
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey,
    timeoutMs: row.timeoutMs,
  };
}

/** Both retrieval models in force, opened, from one read of the table. */
export interface ResolvedModelProviders {
  embedding: EmbeddingProviderConfig | null;
  rerank: RerankProviderConfig | null;
}

export async function resolveModelProviders(): Promise<ResolvedModelProviders> {
  const inForce = await rowsInForce();
  const [embedding, rerank] = await Promise.all([
    embeddingProviderFrom(inForce.embedding),
    rerankProviderFrom(inForce.rerank),
  ]);
  return { embedding, rerank };
}

/** The embedding model in force, opened for the adapter, or null. */
export async function resolveEmbeddingProvider(): Promise<EmbeddingProviderConfig | null> {
  return embeddingProviderFrom((await rowsInForce()).embedding);
}

/** The reranker in force, opened for the adapter. Null leaves fusion order. */
export async function resolveRerankProvider(): Promise<RerankProviderConfig | null> {
  return rerankProviderFrom((await rowsInForce()).rerank);
}

/**
 * Which retrieval stages this installation can actually run.
 *
 * Read from the same rows the adapters resolve from, so the console cannot
 * report a stage as configured that the request path then skips.
 */
export async function modelProviderStatus(): Promise<Record<ModelKind, boolean>> {
  const { embedding, rerank } = await resolveModelProviders();
  return { embedding: embedding !== null, rerank: rerank !== null };
}

/**
 * The default model seams of retrieval and ingestion, over one resolution.
 *
 * `configured()`, `embeddings()` and `rerank()` share a single read, so the
 * adapters a caller gets come from the very rows that said the stage could
 * run: a model switched off between two reads can no longer turn
 * "configured" into a `ProviderUnavailable` thrown from the vector leg, and a
 * request reads the table once rather than once per stage. Make one per
 * request or build -- it holds opened keys for as long as it is referenced.
 */
export interface ModelAdapters {
  configured(): Promise<{ embeddings: boolean; rerank: boolean }>;
  embeddings(): Promise<EmbeddingAdapter>;
  rerank(): Promise<RerankAdapter>;
}

export function modelAdapters(): ModelAdapters {
  let resolved: Promise<ResolvedModelProviders> | undefined;
  const models = () => (resolved ??= resolveModelProviders());
  return {
    async configured() {
      const { embedding, rerank } = await models();
      return { embeddings: embedding !== null, rerank: rerank !== null };
    },
    async embeddings() {
      const { embedding } = await models();
      if (!embedding) throw new ProviderUnavailable('embedding', 'no embedding model is configured');
      return embeddingAdapter(embedding);
    },
    async rerank() {
      const { rerank } = await models();
      if (!rerank) throw new ProviderUnavailable('rerank', 'no rerank model is configured');
      return rerankAdapter(rerank);
    },
  };
}

export class ModelConfigRefused extends Error {
  constructor(
    readonly code:
      | 'invalid_kind'
      | 'invalid_base_url'
      | 'invalid_model'
      | 'invalid_dimensions'
      | 'invalid_timeout'
      | 'invalid_api_key'
      | 'api_key_required',
  ) {
    super(code);
    this.name = 'ModelConfigRefused';
  }
}

export interface UpdateModelConfigInput {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  kind: string;
  label: string;
  baseUrl: string;
  model: string;
  /**
   * Blank carries the stored credential forward: a row is re-minted on every
   * edit, and asking an operator to re-type a provider key to change a timeout
   * is how keys end up pasted into a chat window to be copied from.
   */
  apiKey: string | null;
  /** Embedding only; ignored for a reranker, which has no width. */
  dimensions: number | null;
  timeoutMs: number;
  enabled: boolean;
  reason: string;
}

export async function updateModelConfig(
  input: UpdateModelConfigInput,
): Promise<{ configId: string }> {
  const reason = normalizeReason(input.reason);

  if (!isModelKind(input.kind)) throw new ModelConfigRefused('invalid_kind');
  const kind: ModelKind = input.kind;

  let baseUrl: URL;
  try {
    baseUrl = new URL(input.baseUrl);
  } catch {
    throw new ModelConfigRefused('invalid_base_url');
  }
  /* Same rule as the generation registry: the server opens this connection
     carrying a credential, and plain http would put it on the wire. */
  if (baseUrl.protocol !== 'https:') throw new ModelConfigRefused('invalid_base_url');

  const model = input.model.trim();
  if (model.length === 0 || model.length > 120) throw new ModelConfigRefused('invalid_model');
  const label = input.label.trim().slice(0, 120) || model;

  /*
   * A width belongs to an embedding entry and only to one. The ceiling is the
   * stored column: a wider vector cannot be written at all, and refusing it
   * here is the difference between a message an operator can act on and a
   * driver error in the middle of a build.
   */
  let dimensions: number | null = null;
  if (kind === 'embedding') {
    const value = input.dimensions ?? Number.NaN;
    if (
      !Number.isSafeInteger(value) ||
      value < EMBEDDING_DIMENSIONS.min ||
      value > EMBEDDING_DIMENSIONS.max
    ) {
      throw new ModelConfigRefused('invalid_dimensions');
    }
    dimensions = value;
  }

  const bounds = timeoutBoundsFor(kind);
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < bounds.min ||
    input.timeoutMs > bounds.max
  ) {
    throw new ModelConfigRefused('invalid_timeout');
  }

  const before = await newestRow(kind);

  const normalizedBaseUrl = baseUrl.toString().replace(/\/+$/, '');
  const typed = input.apiKey?.trim() ?? '';
  if (typed.length > API_KEY_MAX_LENGTH) throw new ModelConfigRefused('invalid_api_key');
  /* A first entry with no credential would be saved as a configured model
     that cannot answer, which reads on the page as "enabled" and behaves as
     "off". Carrying one forward is only possible when there is one, and only
     to the host it was saved for (`mayCarryCredential`). */
  const carried =
    before?.apiKeyCipher && mayCarryCredential(before.baseUrl, normalizedBaseUrl)
      ? before.apiKeyCipher
      : null;
  if (typed.length === 0 && !carried) throw new ModelConfigRefused('api_key_required');
  const apiKeyCipher = typed.length > 0 ? await sealCredential(typed) : carried;

  const written = {
    kind,
    label,
    baseUrl: normalizedBaseUrl,
    model,
    dimensions,
    timeoutMs: input.timeoutMs,
    enabled: input.enabled,
  };

  const configId = uuidv7();
  await db()
    .insert(schema.providerModelConfig)
    .values({ id: configId, ...written, apiKeyCipher });

  /*
   * The audit values carry everything but the credential, and say only
   * whether one is present. A rotation is a fact worth recording; the key
   * itself in an append-only log that is exported and anchored is a key that
   * cannot be un-leaked.
   */
  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'model_config.update',
    targetType: 'provider_model_config',
    targetId: configId,
    reason,
    beforeValue: before
      ? {
          kind: before.kind,
          label: before.label,
          baseUrl: before.baseUrl,
          model: before.model,
          dimensions: before.dimensions,
          timeoutMs: before.timeoutMs,
          enabled: before.enabled,
          hasCredential: Boolean(before.apiKeyCipher),
        }
      : null,
    afterValue: { ...written, hasCredential: true, credentialRotated: typed.length > 0 },
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });

  return { configId };
}
