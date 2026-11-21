/**
 * One request over a kind's list of entries (lib/domain/model-failover.ts):
 * try them in order, skip cooling ones, and move on when an error says
 * another model could succeed. Each attempt is the entry's own logged and
 * metered model, so `model_call` keeps one row per attempt, priced by the
 * model that made it.
 *
 * A stream switches only before its first piece of content: once the asker
 * has seen text, an error ends the answer as it did before.
 */
import type { EmbeddingModel, LanguageModel, TranscriptionModel } from 'ai';
import { attemptOrder, classifyModelFailure, switches, type ChainEntry } from '@/lib/domain/model-failover';
import { healthSnapshot, reportFailure, reportSuccess } from '@/lib/infra/ai/model-health';
import type { ModelEndpoint } from '@/lib/infra/ai/models';

/* `@ai-sdk/provider` is not a direct dependency: the v4 shapes, from the `ai` unions. */
export type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;
export type EmbeddingModelV4 = Extract<EmbeddingModel, { specificationVersion: 'v4' }>;
export type TranscriptionModelV4 = Extract<TranscriptionModel, { specificationVersion: 'v4' }>;

export interface Link<M> {
  endpoint: ModelEndpoint;
  /** The entry's place in its list; null for the environment's model. */
  position: number | null;
  model: M;
}

/** The per-attempt timer: the entry's `timeoutMs`, never on the last candidate (which has the whole request's budget, as before). */
class AttemptTimer {
  private readonly controller = new AbortController();
  private handle: ReturnType<typeof setTimeout> | null;
  fired = false;
  constructor(ms: number) {
    this.handle = setTimeout(() => {
      this.fired = true;
      this.controller.abort(Object.assign(new Error(`attempt timed out after ${ms} ms`), { name: 'TimeoutError' }));
    }, ms);
  }
  get signal(): AbortSignal { return this.controller.signal; }
  disarm(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = null;
  }
}

function joined(caller: AbortSignal | undefined, timer: AttemptTimer | null): AbortSignal | undefined {
  if (!timer) return caller;
  return caller ? AbortSignal.any([caller, timer.signal]) : timer.signal;
}

const subject = (endpoint: ModelEndpoint) => ({ configId: endpoint.configId, kind: endpoint.kind, name: endpoint.name, model: endpoint.model });

/**
 * Runs `attempt` on each candidate in turn until one succeeds. Errors that
 * are the request's own (bad parameters, the caller's abort) are thrown at
 * once; the last candidate's error is thrown when all fail.
 */
export async function tryInOrder<M, T>(
  links: readonly Link<M>[],
  caller: AbortSignal | undefined,
  attempt: (link: Link<M>, signal: AbortSignal | undefined, timer: AttemptTimer | null) => Promise<T>,
  served?: (link: Link<M>) => void,
): Promise<T> {
  const now = new Date();
  const entries: ChainEntry<Link<M>>[] = links.map((link, index) => ({ configId: link.endpoint.configId ?? `environment:${index}`, position: link.position ?? index, value: link }));
  const order = links.length > 1 ? attemptOrder(entries, await healthSnapshot(now), now).map((entry) => entry.value) : [...links];
  let lastError: unknown;
  for (const [index, link] of order.entries()) {
    const last = index === order.length - 1;
    const timer = last ? null : new AttemptTimer(link.endpoint.timeoutMs);
    try {
      const result = await attempt(link, joined(caller, timer), timer);
      void reportSuccess(subject(link.endpoint)).catch(() => undefined);
      served?.(link);
      return result;
    } catch (error) {
      const failure = classifyModelFailure(error, { callerAborted: Boolean(caller?.aborted), timedOut: Boolean(timer?.fired) });
      if (!switches(failure)) throw error;
      lastError = error;
      await reportFailure(subject(link.endpoint), failure).catch(() => undefined);
      if (last) break;
      const next = order[index + 1]!.endpoint;
      console.warn(JSON.stringify({ event: 'model_failover', kind: link.endpoint.kind, from: link.endpoint.configId, fromModel: link.endpoint.model, to: next.configId, toModel: next.model, reason: failure.kind, status: failure.status }));
    } finally {
      timer?.disarm();
    }
  }
  throw lastError;
}

type StreamPart = Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;
/** Parts that carry nothing the asker sees: held back, and an error after them still switches. */
const BEFORE_CONTENT = new Set<string>(['stream-start', 'response-metadata', 'text-start', 'reasoning-start']);

/** A language model over a list: what `modelFor('generation')` hands every caller. `response.modelId` names the model that answered. */
export function failoverLanguageModel(links: readonly Link<LanguageModelV4>[]): LanguageModelV4 {
  const head = links[0]!;
  return {
    specificationVersion: 'v4',
    provider: head.model.provider,
    modelId: head.endpoint.model,
    supportedUrls: head.model.supportedUrls,
    async doGenerate(options) {
      return tryInOrder(links, options.abortSignal, async (link, abortSignal) => {
        const result = await link.model.doGenerate({ ...options, abortSignal });
        return { ...result, response: { ...result.response, modelId: link.endpoint.model } };
      });
    },
    async doStream(options) {
      return tryInOrder(links, options.abortSignal, async (link, abortSignal, timer) => {
        const result = await link.model.doStream({ ...options, abortSignal });
        const reader = result.stream.getReader();
        const modelId = link.endpoint.model;
        const named = (part: StreamPart): StreamPart => (part.type === 'response-metadata' ? { ...part, modelId } : part);
        /* Held until the first piece of content: until then an error still moves on to the next model. */
        const head: StreamPart[] = [];
        let done = false;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) { done = true; break; }
            const part = next.value;
            if (part.type === 'error') throw part.error instanceof Error ? part.error : Object.assign(new Error('stream error'), { cause: part.error });
            head.push(named(part));
            if (!BEFORE_CONTENT.has(part.type)) break;
          }
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
        timer?.disarm();
        if (!head.some((part) => part.type === 'response-metadata')) {
          head.splice(head[0]?.type === 'stream-start' ? 1 : 0, 0, { type: 'response-metadata', modelId });
        }
        const stream = new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of head) controller.enqueue(part);
            if (done) controller.close();
          },
          async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(named(next.value));
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return { ...result, stream };
      });
    },
  };
}

/**
 * An embedding model over a list of entries of the same model (the same
 * vector space; `addToChain` refuses anything else), batch by batch.
 */
export function failoverEmbeddingModel(links: readonly Link<EmbeddingModelV4>[], served?: (link: Link<EmbeddingModelV4>) => void): EmbeddingModelV4 {
  const head = links[0]!;
  return {
    specificationVersion: 'v4',
    provider: head.model.provider,
    modelId: head.endpoint.model,
    /* Every batch must fit whichever entry takes it. */
    maxEmbeddingsPerCall: Promise.all(links.map((link) => link.model.maxEmbeddingsPerCall)).then((limits) => {
      const known = limits.filter((limit): limit is number => typeof limit === 'number');
      return known.length > 0 ? Math.min(...known) : undefined;
    }),
    supportsParallelCalls: Promise.all(links.map((link) => link.model.supportsParallelCalls)).then((all) => all.every(Boolean)),
    async doEmbed(options) {
      return tryInOrder(links, options.abortSignal, (link, abortSignal) => Promise.resolve(link.model.doEmbed({ ...options, abortSignal })), served);
    },
  };
}

export function failoverTranscriptionModel(links: readonly Link<TranscriptionModelV4>[], served?: (link: Link<TranscriptionModelV4>) => void): TranscriptionModelV4 {
  const head = links[0]!;
  return {
    specificationVersion: 'v4',
    provider: head.model.provider,
    modelId: head.endpoint.model,
    async doGenerate(options) {
      return tryInOrder(links, options.abortSignal, (link, abortSignal) => Promise.resolve(link.model.doGenerate({ ...options, abortSignal })), served);
    },
  };
}
