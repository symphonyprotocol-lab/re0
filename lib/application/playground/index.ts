import type { CallerContext } from '@/lib/application/retrieval';
import {
  gatherAcrossLibraries,
  type GatheredChunk,
  type GatheredLibrary,
  type GatherLibrary,
} from '@/lib/application/retrieval/gather';
import {
  defaultRetrievalDependencies,
  type RetrievalDependencies,
} from '@/lib/application/retrieval/query-docs';
import {
  activeLlmConfig,
  activeRetrievalSettings,
  openLlmCredential,
  recordLlmCost,
  type LlmConfigRow,
} from '@/lib/application/administration';
import { hasPaidSubscription } from '@/lib/application/plans';
import type { LlmAudience } from '@/lib/domain/generation';
import {
  buildContextBlock,
  llmCostMicroUsd,
  openCitedAnswer,
  PLAYGROUND_SYSTEM_PROMPT,
} from '@/lib/domain/generation';
import { retrievalBudgetFor } from '@/lib/domain/retrieval-config';
import { llmAdapter, type LlmAdapter } from '@/lib/infrastructure/ai/llm';

/**
 * The playground is the only entry point that produces prose.
 * requirement.md 5.1, architecture.md 9.5.
 *
 * Hard rules enforced here:
 * 1. retrieval comes from the shared implementation, never a copy
 * 2. zero chunks means no model call at all
 * 3. chunks are passed as untrusted data, separated from the system prompt
 * 4. every factual claim must bind to a returned chunk; unbindable text is dropped
 * 5. model failure degrades to the chunk list, never an error page
 *
 * The answer streams, and rule 4 is what shapes how. A claim is released only
 * after `openCitedAnswer` has proved the sentence complete and this module has
 * bound its markers to chunks of this very request -- so unbindable prose is
 * never shown and then withdrawn, it is simply never sent. What the reader
 * sees appear one claim at a time is therefore the same set of claims the
 * non-streaming path would have returned at the end.
 *
 * The provider is configuration: the console's `llm_config` decides endpoint,
 * model, budgets, unit prices, declared abilities and reasoning effort, and its
 * assignment decides which entry answers trial callers and which a paid plan
 * buys; a request may still name an entry. The caller's audience -- what its
 * plan buys -- decides which entries it may be answered by. The entry is
 * resolved before retrieval,
 * because its context window is what sizes the retrieval budget -- a constant
 * there would either waste a large model's window or overflow a small one.
 * The environment holds only the credential. Every successful completion
 * appends one `llm_cost_event` -- token counts and cost, never the question or
 * the answer (9.5's cost metric). The retrieval call already metered one Call;
 * generation never meters a second.
 */

export interface PlaygroundAnswer {
  kind: 'answer' | 'no_context' | 'degraded';
  text: string | null;
  chunks: GatheredChunk[];
  libraries: GatheredLibrary[];
  citations: { claim: string; chunkId: string }[];
  requestId: string;
}

/**
 * What the generation path emits as it goes.
 *
 * `context` always comes first and carries everything the transcript can show
 * without a model: it is what the degraded and no-context outcomes render.
 * Every `claim` after it is already bound. `done` names the outcome.
 */
export type PlaygroundEvent =
  | {
      type: 'model';
      label: string;
      audience: LlmAudience;
      /** For a trial caller, the subscriber default a paid plan would answer with. */
      upgrade: string | null;
    }
  /** What the scatter-gather read, library by library, before `context`. */
  | { type: 'gather'; libraries: GatheredLibrary[] }
  | { type: 'context'; chunks: GatheredChunk[]; requestId: string }
  | { type: 'claim'; claim: string; chunkIds: string[] }
  | {
      type: 'done';
      kind: 'answer' | 'no_context' | 'degraded';
      requestId: string;
    };

export interface PlaygroundDependencies {
  /**
   * Resolves the entry to call for an audience; a slug that is unknown, off,
   * or closed to the audience resolves null.
   */
  config(slug: string | null | undefined, audience: LlmAudience): Promise<LlmConfigRow | null>;
  /** Who the caller is to the model registry: what its plan buys. */
  audience(caller: CallerContext): Promise<LlmAudience>;
  llm(config: { baseUrl: string; model: string; apiKey: string }): LlmAdapter;
  /**
   * The resolved entry's credential, opened. By id, so the key that is sent
   * belongs to the very row whose endpoint is being called even if the entry
   * is edited between the two reads.
   */
  credential(configId: string): Promise<string | null>;
  recordCost: typeof recordLlmCost;
  retrieval?: RetrievalDependencies;
}

/**
 * A workspace on a paid plan is a subscriber; a free one, or no workspace at
 * all, is a trial caller. Read per request so an upgrade applies to the
 * next question, and a lapse does too.
 */
async function audienceOf(caller: CallerContext): Promise<LlmAudience> {
  if (!caller.workspaceId) return 'trial';
  return (await hasPaidSubscription(caller.workspaceId)) ? 'subscriber' : 'trial';
}

const defaultDependencies: PlaygroundDependencies = {
  config: activeLlmConfig,
  audience: audienceOf,
  llm: llmAdapter,
  credential: openLlmCredential,
  recordCost: recordLlmCost,
};

export interface PlaygroundInput {
  /**
   * The routed candidates, in routing order (architecture.md 9.6). The
   * first is the one the exchange is metered on; all are read, and the
   * confirmed ones answer together (retrieval/gather.ts).
   */
  libraries: readonly GatherLibrary[];
  question: string;
  /** Which configured model to use. Absent means the console's default. */
  modelSlug?: string | null;
}

export async function* streamPlayground(
  caller: CallerContext,
  input: PlaygroundInput,
  dependencies: PlaygroundDependencies = defaultDependencies,
): AsyncGenerator<PlaygroundEvent> {
  const startedAt = Date.now();

  /*
   * The model is resolved first because its context window sizes the
   * retrieval budget -- reading a config row is not calling a model, so rule 2
   * is untouched. With nothing configured, retrieval still runs at the default
   * budget: the degraded outcome shows chunks, and they have to be fetched.
   */
  const audience = await dependencies.audience(caller).catch((): LlmAudience => 'trial');
  const config = await dependencies.config(input.modelSlug, audience).catch(() => null);
  /* `hasCredential` rather than the key itself: this runs before retrieval,
     only to size the budget, and opening a provider secret here would mean
     holding it for the length of a retrieval that may not need it. */
  const usable = config && config.enabled && config.hasCredential ? config : null;

  if (usable) {
    /*
     * Which model answers is part of what the reader is shown: a subscriber
     * sees that the model its plan buys is the one answering, and a trial
     * caller learns what a paid plan would answer with -- when the console
     * has assigned one, and it is not the model already answering.
     */
    const subscriber =
      audience === 'trial' ? await dependencies.config(null, 'subscriber').catch(() => null) : null;
    const upgrade =
      subscriber && subscriber.slug !== usable.slug && subscriber.assignedTo.includes('subscriber')
        ? subscriber.label
        : null;
    yield {
      type: 'model',
      label: usable.label,
      audience:
        audience === 'subscriber' && usable.assignedTo.includes('subscriber')
          ? 'subscriber'
          : 'trial',
      upgrade,
    };
  }

  /*
   * The retrieval settings are read once and handed to retrieval, so the
   * budget computed here and the recall it bounds come from the same row --
   * a save landing between two reads would otherwise size one by the other.
   */
  const retrieval = dependencies.retrieval ?? defaultRetrievalDependencies();
  const settings = await (retrieval.settings ?? activeRetrievalSettings)();

  /*
   * Scatter-gather (retrieval/gather.ts): every routed candidate is read,
   * and only the ones whose own retrieval is confirmed contribute. The
   * confirmation is the stage rule 2 needs -- recall always returns
   * *something* from a library, its nearest chunks however far, and a model
   * handed thirty unrelated passages does not reliably say so; it adapts
   * them. When no library is confirmed there is no context: no model call,
   * and the reader is told nothing relevant was found.
   */
  const retrieved = await gatherAcrossLibraries(
    caller,
    {
      libraries: input.libraries,
      query: input.question,
      maxTokens: retrievalBudgetFor(usable?.maxInputTokens, settings),
    },
    { ...retrieval, settings: async () => settings },
  );
  yield { type: 'gather', libraries: retrieved.libraries };

  if (!retrieved.libraries.some((library) => library.confirmed)) {
    console.info(
      `playground no_context (no confirmed retrieval among ${retrieved.libraries.length} candidates)`,
    );
    yield { type: 'context', chunks: [], requestId: retrieved.requestId };
    yield { type: 'done', kind: 'no_context', requestId: retrieved.requestId };
    return;
  }

  yield {
    type: 'context',
    chunks: retrieved.chunks,
    requestId: retrieved.requestId,
  };

  // Rule 2: never call the model without context.
  if (retrieved.chunks.length === 0) {
    yield { type: 'done', kind: 'no_context', requestId: retrieved.requestId };
    return;
  }

  if (!usable) {
    yield { type: 'done', kind: 'degraded', requestId: retrieved.requestId };
    return;
  }

  /*
   * Chunks travel under short ordinal ids: a UUID per marker wastes the
   * model's output budget and invites transcription errors. The map back to
   * real chunk ids happens below, during binding.
   */
  const shortIds = new Map<string, string>();
  const excerpts = retrieved.chunks.map((chunk, at) => {
    const shortId = String(at + 1);
    shortIds.set(shortId, chunk.chunkId);
    return { id: shortId, text: chunk.text };
  });

  let stream;
  try {
    /* A key that cannot be opened -- sealed under a rotated secret -- reaches
       the adapter as an empty one and is refused there, which is the same
       degradation as any other unavailable provider. */
    const apiKey = (await dependencies.credential(usable.id).catch(() => null)) ?? '';
    stream = dependencies
      .llm({
        baseUrl: usable.baseUrl,
        model: usable.model,
        apiKey,
      })
      .stream({
        systemPrompt: PLAYGROUND_SYSTEM_PROMPT,
        userMessage: `${buildContextBlock(excerpts)}\n\nQuestion: ${input.question}`,
        maxOutputTokens: usable.maxOutputTokens,
        timeoutMs: usable.timeoutMs,
        /* Null for a model that does not reason -- the console cannot store an
         effort for one, so there is nothing to leak through here. */
        reasoningEffort: usable.reasoningEffort,
      });
  } catch (error) {
    // Rule 5. A provider that is down or slow is a degraded answer, not an error.
    logDegraded('llm adapter unavailable', error);
    yield { type: 'done', kind: 'degraded', requestId: retrieved.requestId };
    return;
  }

  const gate = openCitedAnswer();
  const released: PlaygroundEvent[] = [];

  /** Rule 4: a sentence keeps its place only by citing a chunk of this request. */
  function bind(segments: { text: string; refs: string[] }[]): PlaygroundEvent[] {
    const events: PlaygroundEvent[] = [];
    for (const segment of segments) {
      const chunkIds = segment.refs
        .map((ref) => shortIds.get(ref))
        .filter((id): id is string => id !== undefined);
      if (chunkIds.length === 0) continue;
      events.push({ type: 'claim', claim: segment.text, chunkIds });
    }
    return events;
  }

  let completed = false;
  try {
    for await (const delta of stream.textStream) {
      for (const event of bind(gate.push(delta))) {
        released.push(event);
        yield event;
      }
    }
    for (const event of bind(gate.flush())) {
      released.push(event);
      yield event;
    }
    completed = true;
  } catch (error) {
    /*
     * The provider died partway. Claims already released were bound before
     * they were sent, so they stay; the outcome below just stops calling the
     * answer complete when nothing survived.
     */
    logDegraded(`llm stream failed after ${released.length} bound claims`, error);
  }

  if (completed && released.length === 0) {
    logDegraded('llm completed but no sentence cited a chunk of this request', null);
  }

  /*
   * The tokens were spent whatever the binding above decided, so the cost is
   * recorded for any call that ran to completion -- best-effort (a metrics
   * write must not fail the answer it measures) but awaited, because a
   * serverless function may freeze right after responding and a write left
   * floating simply vanishes.
   */
  if (completed) {
    const usage = await stream.usage;
    await dependencies
      .recordCost({
        configId: usable.id,
        /* The metered library: the routed top candidate (gather.ts). */
        libraryPublicId: input.libraries[0]!.libraryId,
        workspaceId: caller.workspaceId,
        model: usable.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        reasoningTokens: usage.reasoningTokens,
        costMicroUsd: llmCostMicroUsd({
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          promptPriceMicro: usable.promptPriceMicro,
          completionPriceMicro: usable.completionPriceMicro,
          cachePriceMicro: usable.cachePriceMicro,
        }),
        latencyMs: Date.now() - startedAt,
      })
      .catch((error) => {
        console.error(
          `llm cost event failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
  }

  yield {
    type: 'done',
    kind: released.length > 0 ? 'answer' : 'degraded',
    requestId: retrieved.requestId,
  };
}

/**
 * Why an answer degraded, for the operator's log only.
 *
 * Rule 5 turns every provider failure into the chunk list, which is right for
 * the reader and useless for whoever has to find out whether the timeout is
 * too short or the model ignored the citation format. The reason is logged
 * without the question, the excerpts or the completion (architecture.md 17.1).
 */
function logDegraded(reason: string, error: unknown): void {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  console.error(`playground degraded (${reason})${detail}`);
}

/**
 * The whole exchange as one value.
 *
 * Kept alongside the stream because a caller that cannot stream -- a test, a
 * future non-web entry -- must not have to reimplement binding to get the same
 * answer. It collects the same events, so there is one generation path.
 */
export async function askPlayground(
  caller: CallerContext,
  input: PlaygroundInput,
  dependencies: PlaygroundDependencies = defaultDependencies,
): Promise<PlaygroundAnswer> {
  let chunks: GatheredChunk[] = [];
  let libraries: GatheredLibrary[] = [];
  let requestId = '';
  const citations: { claim: string; chunkId: string }[] = [];
  const claims: string[] = [];
  let kind: PlaygroundAnswer['kind'] = 'degraded';

  for await (const event of streamPlayground(caller, input, dependencies)) {
    if (event.type === 'model') {
      continue;
    } else if (event.type === 'gather') {
      libraries = event.libraries;
    } else if (event.type === 'context') {
      chunks = event.chunks;
      requestId = event.requestId;
    } else if (event.type === 'claim') {
      claims.push(event.claim);
      for (const chunkId of event.chunkIds) citations.push({ claim: event.claim, chunkId });
    } else {
      kind = event.kind;
      requestId = event.requestId;
    }
  }

  if (kind !== 'answer') {
    return {
      kind,
      text: null,
      chunks: kind === 'no_context' ? [] : chunks,
      libraries,
      citations: [],
      requestId,
    };
  }
  return {
    kind,
    text: claims.join(' '),
    chunks,
    libraries,
    citations,
    requestId,
  };
}
