/** One durable row per provider attempt, including retries, errors and cancelled streams. */
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { generationCost, type CallStatus, type CostBasis, type GenerationCallContext } from '@/lib/domain/model-calls';
import { type ProviderRate } from '@/lib/domain/provider-cost';
import { gatewayGenerationPricing } from '@/lib/infra/ai/gateway-generation-pricing';
import { db, schema } from '@/lib/infra/db';
import { configuredProviderRate, providerPrices } from '@/lib/services/provider-pricing';

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type StreamPart = Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;
type Usage = Extract<StreamPart, { type: 'finish' }>['usage'];

export interface ModelCallRecord extends GenerationCallContext {
  kind: typeof schema.modelCall.$inferInsert.kind; model: string; configId: string | null; configName?: string;
  inputTokens?: number; outputTokens?: number; seconds?: number;
  status?: CallStatus; durationMs?: number; usageKnown?: boolean; endpoint?: string;
  requestId?: string; errorCode?: string; createdAt?: Date;
  costUsd?: string | null; costBasis?: CostBasis; rate?: ProviderRate; priceRevision?: string;
}

export async function recordModelCall(call: ModelCallRecord): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await db().insert(schema.modelCall).values({
      ...call,
      inputTokens: Math.max(0, Math.round(call.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.round(call.outputTokens ?? 0)),
      seconds: Math.max(0, Math.round(call.seconds ?? 0)),
    });
  } catch { console.warn('model call log failed'); }
}

interface Call extends GenerationCallContext {
  model: string; configId: string | null; configName?: string;
  transport?: string; baseUrl?: string | null;
}
function safeEndpoint(call: Call): string | undefined {
  try {
    const url = new URL(call.transport === 'gateway' ? 'https://ai-gateway.vercel.sh/v1' : call.baseUrl ?? '');
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.replace(/\/+$/, '');
  } catch { return undefined; }
}
async function pricing(call: Call, endpoint: string | undefined): Promise<{ rate?: ProviderRate; priceRevision?: string; estimated?: boolean }> {
  if (!endpoint) return {};
  // Gateway pricing is always supplied by Gateway, never by a manual override or static table.
  if (call.transport === 'gateway') return await gatewayGenerationPricing(call.model) ?? {};
  try {
    const prices = await providerPrices();
    const rate = configuredProviderRate(prices, { service: 'generation', endpoint, model: call.model });
    if (rate) return { rate, priceRevision: prices.revision };
  } catch { /* Reporting must never prevent generation. */ }
  return {};
}
const aborted = (error: unknown) => error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
// Store a controlled error category, since provider messages can contain credentials or request bodies.
const failure = (error: unknown): { status: CallStatus; errorCode: string } => ({ status: aborted(error) ? 'aborted' : 'failed', errorCode: aborted(error) ? 'request_aborted' : 'provider_error' });

export function loggedLanguageModel(model: LanguageModelV4, call: Call): LanguageModelV4 {
  async function attempt() {
    const endpoint = safeEndpoint(call);
    // Looked up alongside the provider call, never before it: the price only matters to the log row.
    const pending = pricing(call, endpoint).catch(() => ({}) as Awaited<ReturnType<typeof pricing>>);
    const started = new Date();
    let saved: Promise<void> | undefined;
    return (status: CallStatus, usage?: Usage, metadata?: unknown, requestId?: string, errorCode?: string) => {
      const durationMs = Math.min(2_147_483_647, Math.max(0, Date.now() - started.getTime()));
      saved ??= pending.then((price) => recordModelCall({
        kind: 'generation', model: call.model, configId: call.configId, configName: call.configName,
        userId: call.userId, audience: call.audience, purpose: call.purpose ?? 'other',
        status, endpoint, requestId, errorCode, createdAt: started, durationMs,
        inputTokens: usage?.inputTokens.total, outputTokens: usage?.outputTokens.total,
        usageKnown: usage?.inputTokens.total !== undefined && usage.outputTokens.total !== undefined,
        ...generationCost({ gateway: call.transport === 'gateway', metadata, rate: price.rate, estimated: price.estimated, usage: { inputTokens: usage?.inputTokens.total, outputTokens: usage?.outputTokens.total } }),
        rate: price.rate, priceRevision: price.priceRevision,
      }));
      return saved;
    };
  }
  return wrapLanguageModel({ model, middleware: {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const save = await attempt();
      try {
        const result = await doGenerate();
        const status = result.finishReason.unified === 'error' ? 'failed' : 'succeeded';
        await save(status, result.usage, result.providerMetadata, result.response?.id ?? result.response?.headers?.['x-request-id'], status === 'failed' ? 'provider_error' : undefined);
        return result;
      } catch (error) {
        const state = failure(error);
        await save(state.status, undefined, undefined, undefined, state.errorCode);
        throw error;
      }
    },
    wrapStream: async ({ doStream }) => {
      const save = await attempt();
      try {
        const result = await doStream();
        const reader = result.stream.getReader();
        let usage: Usage | undefined;
        let metadata: unknown;
        let requestId = result.response?.headers?.['x-request-id'];
        let finished = false;
        let errorCode: string | undefined;
        let status: CallStatus = 'succeeded';
        const stream = new ReadableStream<StreamPart>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                await save(finished || errorCode ? status : 'aborted', usage, metadata, requestId, errorCode ?? (finished ? undefined : 'incomplete_stream'));
                controller.close(); return;
              }
              const part = next.value;
              if (part.type === 'response-metadata') requestId = part.id ?? requestId;
              if (part.type === 'error') { const state = failure(part.error); status = state.status; errorCode = state.errorCode; }
              if (part.type === 'finish') {
                finished = true; usage = part.usage; metadata = part.providerMetadata;
                if (part.finishReason.unified === 'error') { status = 'failed'; errorCode = 'provider_error'; }
              }
              controller.enqueue(part);
            } catch (error) {
              const state = failure(error);
              await save(state.status, usage, metadata, requestId, state.errorCode);
              controller.error(error);
            }
          },
          async cancel(reason) {
            try { await reader.cancel(reason); }
            finally { await save(finished ? status : 'aborted', usage, metadata, requestId, finished ? errorCode : 'request_aborted'); }
          },
        });
        return { ...result, stream };
      } catch (error) {
        const state = failure(error);
        await save(state.status, undefined, undefined, undefined, state.errorCode);
        throw error;
      }
    },
  } }) as LanguageModelV4;
}
