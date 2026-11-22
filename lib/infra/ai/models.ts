/**
 * `modelFor(kind, audience?)`: the one way business code reaches a model
 * (rebuild-proposal.md 7). It reads the enabled `model_config` row for that
 * kind and generation audience, cached separately for a minute; without one it falls back to the environment,
 * and without that to a gateway default, so a first deployment answers.
 *
 * Two transports, both through the AI SDK: the Vercel AI Gateway with
 * `provider/model` names, or any OpenAI-compatible endpoint. Callers get an
 * AI SDK model and a plain description of where it came from; nothing else
 * about the provider leaks out.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGateway, gateway, wrapEmbeddingModel, type EmbeddingModel, type LanguageModel } from 'ai';
import { and, asc, eq, ne } from 'drizzle-orm';
import {
  DEFAULT_MODELS,
  EMBEDDING_DIMENSIONS,
  MODEL_CACHE_MS,
  MODEL_TIMEOUT_MS,
  OPENAI_SPEECH_BASE,
  type ModelKind,
} from '@/lib/constants';
import { mayCarryKey, type GenerationAudience, type ModelTransport } from '@/lib/domain/models';
import { chainAudience, embeddingModelName, hasFailover, planWithFree, type ChainEntry } from '@/lib/domain/model-failover';
import { failoverEmbeddingModel, failoverLanguageModel, type EmbeddingModelV4, type LanguageModelV4, type Link } from '@/lib/infra/ai/failover';
import type { GenerationCallContext } from '@/lib/domain/model-calls';
import { openCredential } from '@/lib/infra/crypto/credentials';
import { modelFetch } from '@/lib/infra/connectors/address';
import { db, schema } from '@/lib/infra/db';
import { loggedLanguageModel, recordModelCall } from '@/lib/infra/ai/usage';
import { embedInBatches, embeddingTokenBound } from '@/lib/infra/ai/embedding-batches';
import { modelCostTarget, prepareProviderCall, providerWork } from '@/lib/infra/ai/provider-meter';
import { gatewayProviderMs } from '@/lib/domain/provider-cost';
import { untimed, type StepTimer } from '@/lib/infra/timing';

export interface ModelEndpoint {
  kind: ModelKind;
  /** The `model_config` row, or null when the environment or the default supplied it. */
  configId: string | null;
  name: string;
  transport: ModelTransport;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
  source: 'console' | 'environment' | 'default';
  /** Embedding only: the space of the vectors this entry makes while enabled (null: the base space; lib/services/embedding-space.ts). */
  space?: string | null;
  /** The entry's place in its kind's list (0: the primary); null or absent outside one. */
  position?: number | null;
}

const ENV_PREFIX: Record<ModelKind, string> = {
  generation: 'GENERATION',
  embedding: 'EMBEDDING',
  transcription: 'TRANSCRIPTION',
  speech: 'SPEECH',
};

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** The endpoint a kind falls back to with no console entry. */
export function environmentEndpoint(kind: ModelKind): ModelEndpoint {
  const prefix = ENV_PREFIX[kind];
  if (kind === 'speech') {
    const apiKey = env('SPEECH_API_KEY') ?? env('AI_GATEWAY_API_KEY');
    const model = env('SPEECH_MODEL');
    return {
      kind, configId: null, name: 'Vercel AI Gateway', transport: 'gateway',
      baseUrl: null, model: model ?? DEFAULT_MODELS.speech, apiKey,
      timeoutMs: MODEL_TIMEOUT_MS.default, source: apiKey || model ? 'environment' : 'default',
    };
  }
  /* EMBEDDING_PROVIDER_* are what deployments before the rebuild hold. */
  const legacyKey = kind === 'embedding' ? env('EMBEDDING_PROVIDER_API_KEY') : null;
  const legacyBase =
    kind === 'embedding' ? (env('EMBEDDING_PROVIDER_BASE_URL') ?? (legacyKey ? 'https://api.openai.com/v1' : null)) : null;
  const baseUrl = env(`${prefix}_BASE_URL`) ?? legacyBase ?? env('LLM_BASE_URL');
  const apiKey = env(`${prefix}_API_KEY`) ?? legacyKey ?? (baseUrl ? env('LLM_API_KEY') : env('AI_GATEWAY_API_KEY'));
  const named = env(`${prefix}_MODEL`);
  if (baseUrl) {
    return {
      kind,
      configId: null,
      name: `${prefix}_MODEL`,
      transport: 'openai_compatible',
      baseUrl: baseUrl.replace(/\/+$/, ''),
      /* An OpenAI-compatible endpoint takes the bare model name. */
      model: named ?? DEFAULT_MODELS[kind].split('/').pop()!,
      apiKey,
      timeoutMs: MODEL_TIMEOUT_MS.default,
      source: named ? 'environment' : 'default',
    };
  }
  return {
    kind,
    configId: null,
    name: `${prefix}_MODEL`,
    transport: 'gateway',
    baseUrl: null,
    model: named ?? DEFAULT_MODELS[kind],
    apiKey,
    timeoutMs: MODEL_TIMEOUT_MS.default,
    source: named ? 'environment' : 'default',
  };
}

/**
 * A console entry as an endpoint. An entry saved without a key borrows the
 * environment's key for the same kind -- but only for the same transport and,
 * for an OpenAI-compatible endpoint, the same origin, so a blank key can never
 * send the deployment's credential to a host an operator typed in.
 */
export async function consoleEndpoint(row: typeof schema.modelConfig.$inferSelect): Promise<ModelEndpoint> {
  let apiKey = await openCredential(row.apiKeyCipher, 'provider');
  if (!row.apiKeyCipher) {
    const fallback = environmentEndpoint(row.kind);
    apiKey = mayCarryKey(fallback, row) ? fallback.apiKey
      : row.kind === 'speech' && row.baseUrl === OPENAI_SPEECH_BASE ? env('OPENAI_API_KEY') : null;
  }
  return {
    kind: row.kind,
    configId: row.id,
    name: row.name,
    transport: row.transport,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey,
    timeoutMs: row.timeoutMs,
    source: 'console',
    ...(row.kind === 'embedding' ? { space: row.embeddingSpace } : {}),
  };
}

const cache = new Map<string, { at: number; chain: ModelEndpoint[] }>();

/** Called after the console changes an entry, so this instance does not wait out the minute. */
export function forgetModelCache(): void {
  cache.clear();
}

/** The enabled entry of a kind and audience: the primary. */
async function primaryRow(kind: ModelKind, plan: boolean) {
  const [row] = await db()
    .select()
    .from(schema.modelConfig)
    .where(and(eq(schema.modelConfig.kind, kind), eq(plan ? schema.modelConfig.enabledPlan : schema.modelConfig.enabled, true)))
    .limit(1);
  return row;
}

/** One list's active entries other than its primary, in order. */
async function storedBackups(kind: ModelKind, audience: 'free' | 'plan' | 'all', primaryId: string) {
  return db()
    .select({ config: schema.modelConfig, position: schema.modelChain.position })
    .from(schema.modelChain)
    .innerJoin(schema.modelConfig, eq(schema.modelConfig.id, schema.modelChain.modelConfigId))
    .where(and(eq(schema.modelChain.kind, kind), eq(schema.modelChain.audience, audience), eq(schema.modelChain.active, true), ne(schema.modelChain.modelConfigId, primaryId)))
    .orderBy(asc(schema.modelChain.position));
}

/** A list: the enabled entry first (it names the primary, as before lists), then its backups. Empty without an enabled entry. */
async function storedChain(kind: ModelKind, plan: boolean): Promise<ModelEndpoint[]> {
  const primary = await primaryRow(kind, plan);
  if (!primary) return [];
  const head = { ...(await consoleEndpoint(primary)), position: 0 };
  if (!hasFailover(kind)) return [head];
  let backups = await storedBackups(kind, chainAudience(kind, plan ? 'plan' : 'free'), primary.id);
  /* An embedding backup must make the primary's vectors: the same model in the same space, or it is left out. */
  if (kind === 'embedding') {
    backups = backups.filter(({ config }) => config.embeddingSpace === primary.embeddingSpace && embeddingModelName(config.model) === embeddingModelName(primary.model));
  }
  const rest = await Promise.all(backups.map(async (row) => ({ ...(await consoleEndpoint(row.config)), position: Math.max(1, row.position) })));
  return [head, ...rest];
}

/**
 * The entries a request of this kind and audience may use, primary first;
 * the environment's model when no entry is enabled. Speech has one entry (a
 * narration keeps its voice). A Plan list with a primary continues with the
 * Free list's entries (design Q3); one without falls back to the
 * environment, as before lists existed. Every entry of the embedding list
 * makes the primary's vectors: it reports the primary's space.
 */
export async function chainFor(kind: ModelKind, audience: GenerationAudience = 'free', now = Date.now()): Promise<ModelEndpoint[]> {
  const plan = kind === 'generation' && audience === 'plan';
  const cacheKey = plan ? 'generation:plan' : kind;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < MODEL_CACHE_MS) return cached.chain;
  let chain = await storedChain(kind, plan);
  if (plan && chain.length > 0) {
    const entry = (endpoint: ModelEndpoint): ChainEntry<ModelEndpoint> => ({ configId: endpoint.configId!, position: endpoint.position ?? 0, value: endpoint });
    chain = planWithFree(chain.map(entry), (await storedChain('generation', false)).map(entry)).map((link) => ({ ...link.value, position: link.position }));
  }
  if (kind === 'embedding' && chain.length > 1) {
    const primary = chain[0]!;
    chain = chain.map((endpoint) => ({ ...endpoint, space: primary.space ?? null }));
  }
  if (chain.length === 0) chain = [environmentEndpoint(kind)];
  cache.set(cacheKey, { at: now, chain });
  return chain;
}

/** The primary: the list's first active entry, or the environment's model. */
export async function endpointFor(kind: ModelKind, now = Date.now(), audience: GenerationAudience = 'free'): Promise<ModelEndpoint> {
  return (await chainFor(kind, audience, now))[0]!;
}

function compatible(endpoint: ModelEndpoint) {
  return createOpenAICompatible({
    name: 'llm',
    baseURL: endpoint.baseUrl ?? '',
    apiKey: endpoint.apiKey ?? '',
    /* Without it an OpenAI-compatible stream omits usage and the cost log reads zero. */
    includeUsage: true,
    /* An administrator's base URL may be a private host, never link-local or a metadata service. */
    fetch: modelFetch,
  });
}

export function endpointHasCredentials(endpoint: ModelEndpoint): boolean {
  return Boolean(endpoint.apiKey || (endpoint.transport === 'gateway' && (env('VERCEL_OIDC_TOKEN') || env('VERCEL') === '1')));
}

export function gatewayFor(endpoint: ModelEndpoint) {
  return endpoint.apiKey ? createGateway({ apiKey: endpoint.apiKey }) : gateway;
}

export function languageModel(endpoint: ModelEndpoint, context: GenerationCallContext = {}): LanguageModelV4 {
  const model =
    endpoint.transport === 'gateway' ? gatewayFor(endpoint).languageModel(endpoint.model) : compatible(endpoint).chatModel(endpoint.model);
  return loggedLanguageModel(model, { ...context, model: endpoint.model, configId: endpoint.configId, configName: endpoint.name, transport: endpoint.transport, baseUrl: endpoint.baseUrl, chainPosition: endpoint.position ?? null });
}

export function embeddingModel(endpoint: ModelEndpoint): EmbeddingModelV4 {
  const model = endpoint.transport === 'gateway'
    ? gatewayFor(endpoint).embeddingModel(endpoint.model)
    : compatible(endpoint).embeddingModel(endpoint.model);
  return wrapEmbeddingModel({ model, middleware: {
    specificationVersion: 'v4',
    wrapEmbed: async ({ doEmbed, params }) => providerWork(async () => {
      const call = await prepareProviderCall(modelCostTarget(endpoint, 'embedding'), { estimate: { inputTokens: embeddingTokenBound(params.values) } });
      try {
        const result = await doEmbed();
        await call?.complete({
          usage: { inputTokens: result.usage?.tokens }, providerMetadata: result.providerMetadata,
          requestId: result.response?.headers?.['x-request-id'],
        });
        return result;
      } finally {
        call?.release();
      }
    }),
  } });
}

/**
 * A language model over the list: each attempt is one entry's logged model;
 * the entry that answered is `response.modelId` (its configured model name,
 * also with a single entry, so answers record what they always recorded).
 */
export function chainLanguageModel(chain: readonly ModelEndpoint[], context: GenerationCallContext = {}): LanguageModelV4 {
  return failoverLanguageModel(chain.map((endpoint) => ({ endpoint, position: endpoint.position ?? null, model: languageModel(endpoint, context) })));
}

/**
 * `endpoint` is the primary (the list's first entry): what answers when
 * nothing fails. Which entry did answer is the result's `response.modelId`.
 */
export async function modelFor(kind: 'generation', audience?: GenerationAudience, context?: GenerationCallContext): Promise<{ model: LanguageModel; endpoint: ModelEndpoint }>;
export async function modelFor(kind: 'embedding'): Promise<{ model: EmbeddingModel; endpoint: ModelEndpoint }>;
export async function modelFor(kind: 'generation' | 'embedding', audience: GenerationAudience = 'free', context: GenerationCallContext = {}): Promise<{ model: LanguageModel | EmbeddingModel; endpoint: ModelEndpoint }> {
  const chain = await chainFor(kind, audience);
  return kind === 'generation'
    ? { model: chainLanguageModel(chain, { ...context, audience }), endpoint: chain[0]! }
    : { model: chainEmbeddingModel(chain).model, endpoint: chain[0]! };
}

/** An embedding model over the list; `served()` names the entry that took the latest batch. */
export function chainEmbeddingModel(chain: readonly ModelEndpoint[]): { model: EmbeddingModelV4; served: () => ModelEndpoint } {
  let last = chain[0]!;
  const links: Link<EmbeddingModelV4>[] = chain.map((endpoint) => ({ endpoint, position: endpoint.position ?? null, model: embeddingModel(endpoint) }));
  const model = links.length === 1 ? links[0]!.model : failoverEmbeddingModel(links, (link) => { last = link.endpoint; });
  return { model, served: () => last };
}

/**
 * Vectors in the stored column's width. A narrower model is zero-padded
 * (cosine distance is unchanged by it); a wider one cannot be stored.
 */
export function toColumn(vector: readonly number[]): number[] {
  if (vector.length > EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding of ${vector.length} dimensions does not fit the ${EMBEDDING_DIMENSIONS}-wide column`);
  }
  return vector.length === EMBEDDING_DIMENSIONS
    ? [...vector]
    : [...vector, ...new Array<number>(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
}

/**
 * Vectors for `texts`, in their order. Large inputs go out as several
 * requests, each under the provider's per-request token and count limits
 * (embedding-batches.ts); every request is metered by `embeddingModel`.
 */
/*
 * An explicit endpoint (a re-embed job's candidate) is used alone; otherwise
 * the embedding list, whose entries all make the primary's vectors -- the
 * endpoint answered is the primary, the one vectors are tagged with.
 *
 * `timing` (Discover's Server-Timing) gets the parts: `embed-chain` (the
 * list, a minute's cache), `embed-call` (the requests, retries included)
 * and, through AI Gateway, `embed-provider` (the providers' share of them,
 * as the Gateway reports it).
 */
export async function embedTexts(
  texts: string[],
  explicit?: ModelEndpoint,
  { timing = untimed }: { timing?: StepTimer } = {},
): Promise<{ vectors: number[][]; endpoint: ModelEndpoint }> {
  const chain = explicit ? [explicit] : await timing.measure('embed-chain', () => chainFor('embedding'));
  const endpoint = chain[0]!;
  const { model, served } = chainEmbeddingModel(chain);
  const { embeddings, tokens, metadata } = await timing.measure('embed-call', () =>
    embedInBatches(model, texts, { timeoutMs: Math.max(endpoint.timeoutMs, 30_000), maxRetries: 2 }));
  const reported = metadata.map(gatewayProviderMs).filter((ms): ms is number => ms !== null);
  if (reported.length > 0) timing.record('embed-provider', reported.reduce((sum, ms) => sum + ms, 0));
  const used = served();
  recordModelCall({ kind: 'embedding', model: used.model, configId: used.configId, inputTokens: tokens, chainPosition: used.position ?? null });
  return { vectors: embeddings.map(toColumn), endpoint };
}
