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
  buildRewritePrompt,
  llmCostMicroUsd,
  openCitedAnswer,
  parseRewrite,
  PLAYGROUND_SYSTEM_PROMPT,
  REWRITE_LIMITS,
  REWRITE_SYSTEM_PROMPT,
  type RewriteHint,
} from '@/lib/domain/generation';
import { retrievalBudgetFor } from '@/lib/domain/retrieval-config';
import { llmAdapter, type LlmAdapter } from '@/lib/infrastructure/ai/llm';
import { FAQ_LIMITS, faqSentences, isFaqCitation } from '@/lib/domain/faq';
import { libraryRewriteHints } from './rewrite-hints';

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
 *
 * One exception path sits between retrieval and generation: rewrite on miss.
 * When no library confirms and a model is configured, the model is asked
 * once to restate the question in the corpus's language and vocabulary
 * (lib/domain/generation.ts `REWRITE_SYSTEM_PROMPT`), and retrieval runs
 * again with that query -- unmetered, since the exchange already reserved its
 * Call. The rewrite produces no facts: a retry that confirms continues into
 * the same binding as a first pass would, and one that misses is the same
 * no-context as before. It never runs without a usable model, and never on a
 * question that confirmed; its cost lands in the same ledger as generation's.
 */

export interface PlaygroundAnswer {
  kind: 'answer' | 'no_context' | 'degraded';
  text: string | null;
  chunks: GatheredChunk[];
  libraries: GatheredLibrary[];
  citations: { claim: string; chunkId: string }[];
  requestId: string;
  /** The query the context was retrieved with, when it was not the question. */
  rewrite: string | null;
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
  /**
   * The first pass missed and the retry with this query confirmed: the
   * `gather` and `context` that follow are the retry's. So a client can say
   * "searched as …". Never emitted when the retry misses too.
   */
  | { type: 'rewrite'; query: string }
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
  /** The scatter-gather itself; a test's seam around the database. */
  gather?: typeof gatherAcrossLibraries;
  /** What the rewrite is told about the libraries, by public id (rewrite-hints.ts). */
  hints?: (libraryIds: readonly string[]) => Promise<RewriteHint[]>;
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
  const gather = dependencies.gather ?? gatherAcrossLibraries;
  const maxTokens = retrievalBudgetFor(usable?.maxInputTokens, settings);
  const retrievalDependencies = { ...retrieval, settings: async () => settings };
  let retrieved = await gather(
    caller,
    { libraries: input.libraries, query: input.question, maxTokens },
    retrievalDependencies,
  );
  yield { type: 'gather', libraries: retrieved.libraries };

  /*
   * The credential is opened once, lazily, for whichever model calls follow:
   * a key that cannot be opened -- sealed under a rotated secret -- reaches
   * the adapter as an empty one and is refused there, which is the same
   * degradation as any other unavailable provider.
   */
  let apiKey: Promise<string> | null = null;
  const credential = (): Promise<string> =>
    (apiKey ??= usable
      ? dependencies.credential(usable.id).then(
          (key) => key ?? '',
          () => '',
        )
      : Promise.resolve(''));

  if (!retrieved.libraries.some((library) => library.confirmed)) {
    /*
     * Rewrite on miss (module comment). Only the libraries this pass did
     * read are described to the model: a candidate whose retrieval was
     * refused is one the caller may not see into.
     */
    const rewritten = usable
      ? await rewriteOnMiss(caller, input, usable, await credential(), retrieved, dependencies)
      : null;
    const retry = rewritten
      ? await gather(
          caller,
          { libraries: input.libraries, query: rewritten, maxTokens, meter: false },
          retrievalDependencies,
        ).catch((error: unknown) => {
          logDegraded('retry retrieval failed', error);
          return null;
        })
      : null;

    if (rewritten && retry && retry.libraries.some((library) => library.confirmed)) {
      retrieved = retry;
      yield { type: 'rewrite', query: rewritten };
      yield { type: 'gather', libraries: retrieved.libraries };
    } else {
      console.info(
        `playground no_context (no confirmed retrieval among ${retrieved.libraries.length} candidates${
          rewritten ? ', after one rewrite' : ''
        })`,
      );
      yield { type: 'context', chunks: [], requestId: retrieved.requestId };
      yield { type: 'done', kind: 'no_context', requestId: retrieved.requestId };
      return;
    }
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

  /*
   * The owner wrote the answer (lib/domain/faq.ts): when the nearest chunk
   * is a FAQ document's and the question sits within `directDistance` of it,
   * the answer is that chunk, sentence by sentence, each bound to it -- no
   * model, no paraphrase of six passages, the same citation rules. This is
   * the generation layer wrapping retrieval at its tightest (9.5), and it is
   * what makes a FAQ worth writing: the recurring question comes back in a
   * fraction of the time.
   */
  const direct = directFaqAnswer(retrieved);
  if (direct) {
    for (const claim of direct) yield claim;
    yield { type: 'done', kind: 'answer', requestId: retrieved.requestId };
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
    stream = dependencies
      .llm({
        baseUrl: usable.baseUrl,
        model: usable.model,
        apiKey: await credential(),
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

  /* The tokens were spent whatever the binding above decided. */
  if (completed) {
    await recordUsage(dependencies, caller, input, usable, await stream.usage, startedAt);
  }

  yield {
    type: 'done',
    kind: released.length > 0 ? 'answer' : 'degraded',
    requestId: retrieved.requestId,
  };
}

/**
 * The rewrite call. Returns the query to retry with, or null for anything
 * else: a provider that fails or stalls, an empty or over-long reply, a
 * reply that is the question again. Every failure is the no-context the
 * exchange was headed for anyway, so none is an error.
 *
 * Bounded on purpose: a few seconds of idle clock (the entry's own if it is
 * tighter), a hard output cap, one attempt. A reasoning model is asked for
 * its least effort; the prompt wants a line back, not a deliberation. Its
 * tokens are recorded like generation's -- one more `llm_cost_event` on the
 * same library, never the question or the reply.
 */
async function rewriteOnMiss(
  caller: CallerContext,
  input: PlaygroundInput,
  usable: LlmConfigRow,
  apiKey: string,
  retrieved: { libraries: GatheredLibrary[] },
  dependencies: PlaygroundDependencies,
): Promise<string | null> {
  const startedAt = Date.now();
  const readable = retrieved.libraries.filter((library) => !library.failed);
  if (readable.length === 0) return null;

  const hints = await (dependencies.hints ?? libraryRewriteHints)(
    readable.map((library) => library.libraryId),
  ).catch((): RewriteHint[] => []);
  /* A library the reader did not find still has its title to be rewritten
     for; every one is shown the passages its own retrieval came closest to. */
  const excerptsOf = new Map(readable.map((library) => [library.libraryId, library.excerpts]));
  const described: RewriteHint[] = (
    hints.length > 0
      ? hints
      : readable.map((library) => ({
          libraryId: library.libraryId,
          title: library.title,
          description: null,
          language: null,
          documentTitles: [],
          terms: [],
          excerpts: [],
        }))
  ).map((hint) => ({
    ...hint,
    excerpts: hint.libraryId ? (excerptsOf.get(hint.libraryId) ?? []) : [],
  }));

  let text = '';
  let usage;
  try {
    const stream = dependencies
      .llm({ baseUrl: usable.baseUrl, model: usable.model, apiKey })
      .stream({
        systemPrompt: REWRITE_SYSTEM_PROMPT,
        userMessage: buildRewritePrompt(input.question, described),
        maxOutputTokens: REWRITE_LIMITS.maxOutputTokens,
        timeoutMs: Math.min(usable.timeoutMs, REWRITE_LIMITS.timeoutMs),
        reasoningEffort: usable.reasoningEffort ? 'minimal' : null,
      });
    for await (const delta of stream.textStream) {
      text += delta;
      /* The cap is on tokens; this is the same bound on a model that ignores it. */
      if (text.length > REWRITE_LIMITS.maxChars * 4) break;
    }
    usage = await stream.usage;
  } catch (error) {
    logDegraded('rewrite failed', error);
    return null;
  }

  await recordUsage(dependencies, caller, input, usable, usage, startedAt);
  return parseRewrite(text, input.question);
}

/**
 * One `llm_cost_event` for a call that ran to completion -- best-effort (a
 * metrics write must not fail the answer it measures) but awaited, because
 * a serverless function may freeze right after responding and a write left
 * floating simply vanishes.
 */
async function recordUsage(
  dependencies: PlaygroundDependencies,
  caller: CallerContext,
  input: PlaygroundInput,
  usable: LlmConfigRow,
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  },
  startedAt: number,
): Promise<void> {
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
      console.error(`llm cost event failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
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
  let rewrite: string | null = null;
  const citations: { claim: string; chunkId: string }[] = [];
  const claims: string[] = [];
  let kind: PlaygroundAnswer['kind'] = 'degraded';

  for await (const event of streamPlayground(caller, input, dependencies)) {
    if (event.type === 'model') {
      continue;
    } else if (event.type === 'rewrite') {
      rewrite = event.query;
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
      rewrite,
    };
  }
  return {
    kind,
    text: claims.join(' '),
    chunks,
    libraries,
    citations,
    requestId,
    rewrite,
  };
}

/**
 * The FAQ chunk's sentences as claims, when the question asked is the FAQ's
 * own: the top chunk is a FAQ document's, it is the nearest FAQ chunk the
 * vector leg saw, and its own distance is within `FAQ_LIMITS.directDistance`.
 * Judged by the chunk, not the library's best distance -- the fused order's
 * top chunk need not be the nearest -- and matched by chunk id, so which
 * public id the caller named the library by does not matter. Null otherwise.
 */
function directFaqAnswer(retrieved: {
  chunks: GatheredChunk[];
  libraries: GatheredLibrary[];
}): Extract<PlaygroundEvent, { type: 'claim' }>[] | null {
  const top = retrieved.chunks[0];
  if (!top || !isFaqCitation(top.citation)) return null;
  const nearest = retrieved.libraries.find((candidate) => candidate.faqNearest?.chunkId === top.chunkId)?.faqNearest;
  if (!nearest || nearest.distance > FAQ_LIMITS.directDistance) return null;
  const sentences = faqSentences(top.text);
  if (sentences.length === 0) return null;
  return sentences.map((claim) => ({ type: 'claim' as const, claim, chunkIds: [top.chunkId] }));
}
