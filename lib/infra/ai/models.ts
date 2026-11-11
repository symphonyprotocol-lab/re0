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
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_MODELS,
  EMBEDDING_DIMENSIONS,
  MODEL_CACHE_MS,
  MODEL_TIMEOUT_MS,
  OPENAI_SPEECH_BASE,
  type ModelKind,
} from '@/lib/constants';
import { mayCarryKey, type GenerationAudience, type ModelTransport } from '@/lib/domain/models';
import type { GenerationCallContext } from '@/lib/domain/model-calls';
import { openCredential } from '@/lib/infra/crypto/credentials';
import { modelFetch } from '@/lib/infra/connectors/address';
import { db, schema } from '@/lib/infra/db';
import { loggedLanguageModel, recordModelCall } from '@/lib/infra/ai/usage';
import { embedInBatches, embeddingTokenBound } from '@/lib/infra/ai/embedding-batches';
import { modelCostTarget, prepareProviderCall, providerWork } from '@/lib/infra/ai/provider-meter';

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

const cache = new Map<string, { at: number; endpoint: ModelEndpoint }>();

/** Called after the console changes an entry, so this instance does not wait out the minute. */
export function forgetModelCache(): void {
  cache.clear();
}

export async function endpointFor(kind: ModelKind, now = Date.now(), audience: GenerationAudience = 'free'): Promise<ModelEndpoint> {
  const plan = kind === 'generation' && audience === 'plan';
  const cacheKey = plan ? 'generation:plan' : kind;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < MODEL_CACHE_MS) return cached.endpoint;
  const [row] = await db()
    .select()
    .from(schema.modelConfig)
    .where(and(eq(schema.modelConfig.kind, kind), eq(plan ? schema.modelConfig.enabledPlan : schema.modelConfig.enabled, true)))
    .limit(1);
  const endpoint = row ? await consoleEndpoint(row) : environmentEndpoint(kind);
  cache.set(cacheKey, { at: now, endpoint });
  return endpoint;
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

export function languageModel(endpoint: ModelEndpoint, context: GenerationCallContext = {}): LanguageModel {
  const model =
    endpoint.transport === 'gateway' ? gatewayFor(endpoint).languageModel(endpoint.model) : compatible(endpoint).chatModel(endpoint.model);
  return loggedLanguageModel(model, { ...context, model: endpoint.model, configId: endpoint.configId, configName: endpoint.name, transport: endpoint.transport, baseUrl: endpoint.baseUrl });
}

export function embeddingModel(endpoint: ModelEndpoint): EmbeddingModel {
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

export async function modelFor(kind: 'generation', audience?: GenerationAudience, context?: GenerationCallContext): Promise<{ model: LanguageModel; endpoint: ModelEndpoint }>;
export async function modelFor(kind: 'embedding'): Promise<{ model: EmbeddingModel; endpoint: ModelEndpoint }>;
export async function modelFor(kind: 'generation' | 'embedding', audience: GenerationAudience = 'free', context: GenerationCallContext = {}) {
  const endpoint = await endpointFor(kind, Date.now(), audience);
  return kind === 'generation'
    ? { model: languageModel(endpoint, { ...context, audience }), endpoint }
    : { model: embeddingModel(endpoint), endpoint };
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
export async function embedTexts(texts: string[], explicit?: ModelEndpoint): Promise<{ vectors: number[][]; endpoint: ModelEndpoint }> {
  const endpoint = explicit ?? (await endpointFor('embedding'));
  const model = embeddingModel(endpoint);
  const { embeddings, tokens } = await embedInBatches(model, texts, { timeoutMs: Math.max(endpoint.timeoutMs, 30_000), maxRetries: 2 });
  recordModelCall({ kind: 'embedding', model: endpoint.model, configId: endpoint.configId, inputTokens: tokens });
  return { vectors: embeddings.map(toColumn), endpoint };
}
