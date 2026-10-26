import { z } from 'zod';
import { AppError, type ErrorCode } from '@/contracts/errors';
import type { QueryDocsInput, ResolveLibraryInput, ResolveLibraryOutput } from '@/contracts/schemas';
import { activeRetrievalSettings } from '@/lib/application/administration';
import { releaseCall, type ReservedCall } from '@/lib/application/plans';
import { resolveLibraryId, type CallerContext } from '@/lib/application/retrieval';
import {
  mergeReads,
  readConfirms,
  type GatheredLibrary,
  type GatherLibrary,
} from '@/lib/application/retrieval/gather';
import {
  commitServedCall,
  defaultRetrievalDependencies,
  queryDocsDetailed,
  type QueryDocsOptions,
  type QueryDocsResult,
  type RetrievalDependencies,
} from '@/lib/application/retrieval/query-docs';
import { containsCjk } from '@/lib/domain/cjk';
import {
  buildPlannerPrompt,
  dominantLanguageOfPassages,
  parseRewrite,
  PLANNER_LIMITS,
  PLANNER_SYSTEM_PROMPT,
  plannerPassages,
  type HistoryTurn,
} from '@/lib/domain/generation';
import { retrievalBudgetFor } from '@/lib/domain/retrieval-config';
import type { LlmAdapter, PlannerTool } from '@/lib/infrastructure/ai/llm';
import {
  answerFromContext,
  defaultPlaygroundDependencies,
  lazyCredential,
  logDegraded,
  recordUsage,
  resolveModel,
  routeQuestion,
  streamPlayground,
  type PlaygroundDependencies,
  type PlaygroundEvent,
} from './index';

/**
 * The playground as an agent. playground-agent-proposal.md, architecture.md
 * 9.5 and 9.6.
 *
 * The fixed path routes the question once and reads the top candidates with
 * the question's own words. That cannot follow a conversation -- "where do I
 * download it?" names no library -- and cannot search twice for a question
 * that needs two searches. Here a model plans instead: it calls the same
 * resolve-library-id and query-docs an MCP agent calls, as often as the
 * console's caps allow, and ends by calling `answer`.
 *
 * Two phases, and only the second one speaks:
 *
 * 1. Planning. The model may only call tools (the adapter requires a tool
 *    call on every step), and nothing it writes reaches the reader. Each
 *    read is judged by the same confirmation gate the scatter-gather uses
 *    (gather.ts `readConfirms`); only confirmed reads become evidence. An
 *    unconfirmed read is still shown to the planner, so it can change its
 *    query, but it can never be cited.
 * 2. Answering. The confirmed reads are merged by the scatter-gather's own
 *    rule (`mergeReads`) and handed to `answerFromContext` -- the same
 *    prompt, gate and binding as the fixed path. The answering call never
 *    sees the earlier turns or anything the planner wrote; the question it
 *    gets is the one typed, plus the planner's restatement labelled as help
 *    in reading it.
 *
 * The earlier turns reach the planner only, as data, to resolve what a
 * follow-up refers to. A fact from them is not evidence: rule 4 still means
 * this request's chunks, so a planner that needs one finds it again.
 *
 * One exchange is one Call, however many reads it took (requirement.md 4.2).
 * The first read reserves the seat, so quota refuses up front; later reads
 * are unmetered, as the scatter-gather's other candidates are. The seat is
 * committed against the library whose passage leads the merged context, or
 * released when nothing confirmed.
 *
 * Whenever the agent cannot run -- the switch is off, the model declares no
 * tool calling, the adapter cannot plan -- or the planner ends without one
 * confirmed read, the exchange runs the fixed path instead, with the turns,
 * so a follow-up still has the rewrite to restate it.
 */

export interface AgentInput {
  question: string;
  history: readonly HistoryTurn[];
  /** The detail page's fixed library: no resolve tool, and query_docs reads only this one. */
  pinned: { libraryId: string; title: string; version: string | null } | null;
}

/** One tool call, as the transcript shows it: first running, then with what it found. */
export interface AgentStep {
  id: string;
  tool: 'resolve-library-id' | 'query-docs';
  query: string;
  libraryId: string | null;
  status: 'running' | 'done';
  /** Candidate ids, for resolve-library-id. */
  results: string[] | null;
  /** For query-docs: whether its passages fit the query well enough to be evidence. */
  confirmed: boolean | null;
  version: string | null;
  /** Why the call returned nothing usable: a refusal code, or the cap. */
  error: string | null;
}

export type AgentEvent =
  | PlaygroundEvent
  | { type: 'step'; step: AgentStep }
  /** The planner's restatement of a follow-up, when it differs from the question. */
  | { type: 'resolved'; question: string }
  /** The fixed path ran (agent off or fallen back): what it routed to. */
  | {
      type: 'routing';
      candidates: GatherLibrary[];
      top: { libraryId: string; title: string; version: string | null } | null;
      pinned: boolean;
    }
  /** The fixed path routed nowhere: no library to read. */
  | { type: 'no_library' };

export interface AgentDependencies extends PlaygroundDependencies {
  resolve?: (caller: CallerContext, input: ResolveLibraryInput) => Promise<ResolveLibraryOutput>;
  read?: (
    caller: CallerContext,
    input: QueryDocsInput,
    dependencies: RetrievalDependencies,
    options: QueryDocsOptions,
  ) => Promise<QueryDocsResult>;
  commit?: typeof commitServedCall;
  release?: (reservationId: string) => Promise<void>;
}

/**
 * Refusals that end the exchange rather than one read: the caller may not
 * spend anything more, whichever library the planner tries next.
 */
const EXCHANGE_REFUSALS: ReadonlySet<ErrorCode> = new Set([
  'quota_exceeded',
  'rate_limited',
  'invalid_api_key',
]);

/**
 * Whether this caller's exchange would be planned. The route asks before it
 * decides where routing happens; the agent asks again for itself and still
 * falls back if the adapter turns out unable to plan.
 */
export async function playgroundAgentOn(
  caller: CallerContext,
  dependencies: PlaygroundDependencies = defaultPlaygroundDependencies,
): Promise<boolean> {
  const retrieval = dependencies.retrieval ?? defaultRetrievalDependencies();
  const settings = await (retrieval.settings ?? activeRetrievalSettings)();
  if (settings.playgroundAgent !== 1) return false;
  const { usable } = await resolveModel(caller, null, dependencies);
  return Boolean(usable?.supportsTools);
}

export async function* streamAgentPlayground(
  caller: CallerContext,
  input: AgentInput,
  dependencies: AgentDependencies = defaultPlaygroundDependencies,
): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();
  const retrieval = dependencies.retrieval ?? defaultRetrievalDependencies();
  const settings = await (retrieval.settings ?? activeRetrievalSettings)();
  const { usable, event: modelEvent } = await resolveModel(caller, null, dependencies);
  const credential = lazyCredential(usable, dependencies);

  let adapter: LlmAdapter | null = null;
  if (usable?.supportsTools && settings.playgroundAgent === 1) {
    try {
      adapter = dependencies.llm({
        baseUrl: usable.baseUrl,
        model: usable.model,
        apiKey: await credential(),
      });
    } catch (error) {
      logDegraded('planner unavailable', error);
    }
  }
  if (!usable || !adapter?.plan) {
    yield* fixedPath(caller, input, dependencies);
    return;
  }
  if (modelEvent) yield modelEvent;

  /* Retrieval reads the settings this exchange was sized by (index.ts). */
  const maxTokens = retrievalBudgetFor(usable.maxInputTokens, settings);
  const retrievalDependencies = { ...retrieval, settings: async () => settings };
  const resolve = dependencies.resolve ?? resolveLibraryId;
  const read = dependencies.read ?? queryDocsDetailed;
  const commit = dependencies.commit ?? commitServedCall;
  const release = dependencies.release ?? releaseCall;

  /* What the planner has found. Lives for this request only. */
  const reads: { library: GatherLibrary; result: QueryDocsResult; confirmed: boolean }[] = [];
  const titles = new Map<string, string>();
  for (const turn of input.history) {
    for (const library of turn.libraries ?? []) titles.set(library.libraryId, library.title);
  }
  if (input.pinned) titles.set(input.pinned.libraryId, input.pinned.title);
  const answered = new Map<string, unknown>();
  let resolves = 0;
  let queries = 0;
  let resolved: string | null = null;
  let declined = false;
  /* The exchange's one seat (module comment). An object, because the tools set it from inside their closures. */
  const metered: { seat: ReservedCall | null; settled: boolean } = { seat: null, settled: false };

  const query = z.string().trim().min(1).max(PLANNER_LIMITS.queryChars);
  const tools: PlannerTool[] = [];
  if (!input.pinned && settings.playgroundAgentResolves > 0) {
    tools.push({
      name: 'resolve_library_id',
      description:
        'Find libraries whose content matches a query. Returns candidates with their id, title, version and the page titles and terms that matched.',
      input: z.object({ query }),
      execute: async (raw) => {
        const args = raw as { query: string };
        if (resolves >= settings.playgroundAgentResolves) return { error: 'limit_reached' };
        resolves += 1;
        try {
          const output = await resolve(caller, { query: args.query });
          const candidates = output.results.slice(0, PLANNER_LIMITS.candidates);
          for (const candidate of candidates) titles.set(candidate.libraryId, candidate.title);
          return {
            results: candidates.map((candidate) => ({
              libraryId: candidate.libraryId,
              title: candidate.title,
              description: candidate.description,
              version: candidate.version,
              matchedTitles: candidate.evidence.matchedTitles.slice(0, 5),
              matchedTerms: candidate.evidence.matchedTerms.slice(0, 8),
            })),
          };
        } catch (error) {
          return refusal(error);
        }
      },
    });
  }
  tools.push({
    name: 'query_docs',
    description: input.pinned
      ? `Search the library ${input.pinned.libraryId} for passages that answer a query.`
      : 'Search one library for passages that answer a query. confirmed: false means nothing fit well enough to answer from.',
    input: z.object({ libraryId: z.string().trim().min(1).max(256), query }),
    execute: async (raw) => {
      const args = raw as { libraryId: string; query: string };
      if (input.pinned && args.libraryId !== input.pinned.libraryId) {
        return { error: 'only_the_fixed_library', libraryId: input.pinned.libraryId };
      }
      const key = `${args.libraryId}\u0000${args.query}`;
      if (answered.has(key)) return answered.get(key);
      if (queries >= settings.playgroundAgentQueries) return { error: 'limit_reached' };
      queries += 1;

      let result: QueryDocsResult;
      try {
        result = await read(
          caller,
          { libraryId: args.libraryId, query: args.query, maxTokens, format: 'json' },
          retrievalDependencies,
          /* The exchange's one seat, reserved by its first read (module comment). */
          { meter: metered.seat ? false : 'deferred' },
        );
      } catch (error) {
        return refusal(error);
      }
      if (result.reservation) metered.seat = result.reservation;

      const confirmed = readConfirms(result, containsCjk(args.query));
      const order = reads.length;
      reads.push({
        library: {
          libraryId: result.libraryId,
          title: titles.get(result.libraryId) ?? titles.get(args.libraryId) ?? result.libraryId,
        },
        result,
        confirmed,
      });
      const output = {
        libraryId: result.libraryId,
        version: result.version,
        confirmed,
        /* What the next query should be written in, when this one missed. */
        language: dominantLanguageOfPassages(result.chunks.map((chunk) => chunk.text)),
        passages: plannerPassages(
          result.chunks.map((chunk, rank) => ({
            id: `${order + 1}.${rank + 1}`,
            text: chunk.text,
            documentTitle: chunk.citation.documentTitle,
            section: chunk.citation.section,
          })),
        ),
      };
      answered.set(key, output);
      return output;
    },
  });
  tools.push({
    name: 'answer',
    description:
      'End the search. question: the visitor’s question restated so it stands on its own, in their language, adding nothing.',
    input: z.object({ question: z.string().trim().max(600) }),
    execute: async (raw) => {
      /*
       * Giving up after one miss with reads still to spend is the planner's
       * commonest failure -- a keyword query in the visitor's language
       * against an English corpus, then `answer`. Once per exchange it is
       * told no, and the loop carries on (`done: false`, llm.ts).
       */
      if (
        !declined &&
        queries < settings.playgroundAgentQueries &&
        !reads.some((entry) => entry.confirmed)
      ) {
        declined = true;
        return {
          done: false,
          error: 'nothing_confirmed_yet',
          hint: 'No search has confirmed yet. Ask query_docs again: one question naming the subject, in the language its last result gave.',
        };
      }
      resolved = parseRewrite((raw as { question: string }).question, input.question);
      return { done: true };
    },
  });

  try {
    const plan = adapter.plan({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userMessage: buildPlannerPrompt(input.question, input.history, input.pinned),
      tools,
      finishTool: 'answer',
      maxSteps: settings.playgroundAgentSteps,
      maxOutputTokens: Math.min(PLANNER_LIMITS.maxOutputTokens, usable.maxOutputTokens),
      timeoutMs: usable.timeoutMs,
      totalMs: PLANNER_LIMITS.totalMs,
      /* The planner picks tools and writes queries; it needs no deliberation. */
      reasoningEffort: usable.reasoningEffort ? 'minimal' : null,
    });

    let plannerFailed = false;
    const steps = new Map<string, AgentStep>();
    try {
      for await (const event of plan.events) {
        if (event.tool === 'answer') continue;
        if (event.type === 'call') {
          const args = (event.input ?? {}) as { query?: unknown; libraryId?: unknown };
          const step: AgentStep = {
            id: event.id,
            tool: event.tool === 'resolve_library_id' ? 'resolve-library-id' : 'query-docs',
            query: typeof args.query === 'string' ? args.query : '',
            libraryId: typeof args.libraryId === 'string' ? args.libraryId : null,
            status: 'running',
            results: null,
            confirmed: null,
            version: null,
            error: null,
          };
          steps.set(event.id, step);
          yield { type: 'step', step };
        } else {
          const step = steps.get(event.id);
          if (!step) continue;
          const output = (event.output ?? {}) as {
            results?: { libraryId: string }[];
            confirmed?: boolean;
            version?: string;
            libraryId?: string;
            error?: string;
          };
          yield {
            type: 'step',
            step: {
              ...step,
              status: 'done',
              libraryId: output.libraryId ?? step.libraryId,
              results: output.results ? output.results.map((candidate) => candidate.libraryId) : null,
              confirmed: typeof output.confirmed === 'boolean' ? output.confirmed : null,
              version: output.version ?? null,
              error: output.error ?? null,
            },
          };
        }
      }
    } catch (error) {
      /* A refusal of the whole exchange is the caller's answer, not a planner failure. */
      if (error instanceof AppError && EXCHANGE_REFUSALS.has(error.code)) throw error;
      plannerFailed = true;
      logDegraded(`planner failed after ${reads.length} reads`, error);
    }

    /* The tokens were spent whatever the plan came to. */
    const usage = await plan.usage;
    const costLibrary = reads[0]?.library ?? input.pinned ?? titlesHead(titles);
    if (costLibrary && usage.promptTokens + usage.completionTokens > 0) {
      await recordUsage(dependencies, caller, { libraries: [costLibrary] }, usable, usage, startedAt);
    }

    if (!reads.some((entry) => entry.confirmed)) {
      /*
       * The planner found nothing to stand on -- it failed, read nothing, or
       * read only what did not confirm. The fixed path still might: it reads
       * the libraries the turns name, and its rewrite on a miss is shown the
       * site's language and nearest passages, which is what a planner query
       * in the wrong language was missing.
       */
      if (plannerFailed) logDegraded('planner found nothing, running the fixed path', null);
      if (metered.seat) await release(metered.seat.reservationId);
      metered.settled = true;
      yield* fixedPath(caller, input, dependencies);
      return;
    }

    const { pool, chunks, contributed } = mergeReads(
      reads.map((entry) => (entry.confirmed ? { title: entry.library.title, result: entry.result } : null)),
      maxTokens,
    );
    const lead = pool.find((entry) => chunks.includes(entry.chunk));
    if (metered.seat) {
      const served = lead ? reads[lead.order]?.result.served : undefined;
      if (served) await commit(caller, metered.seat, served);
      else await release(metered.seat.reservationId);
    }
    metered.settled = true;

    const libraries = librariesOf(reads, contributed);
    yield { type: 'gather', libraries };
    if (chunks.length === 0) {
      console.info(`playground no_context (agent, no confirmed read among ${reads.length})`);
      yield { type: 'context', chunks: [], requestId: caller.requestId };
      yield { type: 'done', kind: 'no_context', requestId: caller.requestId };
      return;
    }
    if (resolved) yield { type: 'resolved', question: resolved };

    const leadLibrary = lead ? reads[lead.order]!.library : reads[0]!.library;
    yield* answerFromContext(
      caller,
      {
        libraries: [leadLibrary],
        question: input.question,
        resolved,
        retrieved: { chunks, libraries, requestId: caller.requestId },
        usable,
        credential,
        startedAt,
      },
      dependencies,
    );
  } finally {
    /* Whatever ended the exchange early, a seat it held is not a Call it served. */
    if (metered.seat && !metered.settled) await release(metered.seat.reservationId).catch(() => {});
  }
}

/**
 * The fixed path, for when the agent cannot run: the detail page's library,
 * or routing (with the follow-up fallback), then the scatter-gather.
 */
async function* fixedPath(
  caller: CallerContext,
  input: AgentInput,
  dependencies: AgentDependencies,
): AsyncGenerator<AgentEvent> {
  const routed = input.pinned
    ? {
        candidates: [{ libraryId: input.pinned.libraryId, title: input.pinned.title }],
        top: input.pinned,
      }
    : await routeQuestion(caller, input.question, input.history, dependencies.resolve);
  yield { type: 'routing', candidates: routed.candidates, top: routed.top, pinned: input.pinned !== null };
  if (!routed.top) {
    yield { type: 'no_library' };
    return;
  }
  yield* streamPlayground(
    caller,
    { libraries: routed.candidates, question: input.question, history: input.history },
    dependencies,
  );
}

/** A read's refusal as the planner sees it; refusals of the whole exchange are rethrown. */
function refusal(error: unknown): { error: string } {
  if (error instanceof AppError) {
    if (EXCHANGE_REFUSALS.has(error.code)) throw error;
    return { error: error.code };
  }
  throw error;
}

/** The first library the conversation named: what a plan that read nothing is costed against. */
function titlesHead(titles: Map<string, string>): GatherLibrary | null {
  const first = titles.entries().next();
  return first.done ? null : { libraryId: first.value[0], title: first.value[1] };
}

/** One entry per library read, as the scatter-gather reports its candidates. */
function librariesOf(
  reads: { library: GatherLibrary; result: QueryDocsResult; confirmed: boolean }[],
  contributed: Map<number, number>,
): GatheredLibrary[] {
  const byLibrary = new Map<string, GatheredLibrary>();
  reads.forEach((entry, order) => {
    const nearest = entry.confirmed ? (entry.result.confidence?.faqNearest ?? null) : null;
    const known = byLibrary.get(entry.library.libraryId);
    if (!known) {
      byLibrary.set(entry.library.libraryId, {
        libraryId: entry.library.libraryId,
        title: entry.library.title,
        version: entry.result.version,
        confirmed: entry.confirmed,
        faqNearest: nearest,
        chunks: contributed.get(order) ?? 0,
        failed: false,
        excerpts: [],
      });
      return;
    }
    known.confirmed ||= entry.confirmed;
    known.chunks += contributed.get(order) ?? 0;
    if (nearest && (!known.faqNearest || nearest.distance < known.faqNearest.distance)) {
      known.faqNearest = nearest;
    }
  });
  return [...byLibrary.values()];
}
