/**
 * A2A `ask` (agent-first-proposal.md 7.2, 7.5, 7.7, 8.2): an answer with a
 * citation on every sentence, for another agent.
 *
 * It is the shared generation chain and nothing else: the scope's retrieval
 * (`searchScope`, the function `search_context` runs) and then
 * `answerFromContext` -- the playground's own answering half, with its
 * sentence gate, citation binding, FAQ shortcut and degradation to the chunk
 * list. requirement.md 5.1 holds as it does in the playground: no model on
 * zero results, only this request's chunks, every sentence bound or dropped,
 * a model failure is a chunk list and not an error.
 *
 * Metering is the caller's (proposal 8.2), and it is decided by what came
 * back, so the seat is held before retrieval and settled after generation:
 *
 * - `askCallsPerAnswer` (10) Calls are held up front, refused by quota or by
 *   the daily cap of `askDailyAnswers` (500) answers per workspace;
 * - an answer bills that many, as one `ask` usage event;
 * - an answer that degraded to the chunk list bills 1, as `search_context`
 *   would, and does not count towards the daily cap;
 * - zero results call no model and bill nothing.
 *
 * Both values are console settings (retrieval_config).
 */
import { AppError } from '@/contracts/errors';
import { activeRetrievalSettings } from '@/lib/application/administration';
import { commitCalls, releaseCalls, reserveCalls } from '@/lib/application/plans';
import type { CallerContext } from '@/lib/application/retrieval';
import type { GatheredChunk, GatheredLibrary } from '@/lib/application/retrieval/gather';
import { defaultRetrievalDependencies } from '@/lib/application/retrieval/query-docs';
import { searchScope, type ScopeSearchResult, type SearchScope } from '@/lib/application/retrieval/search-scope';
import {
  answerFromContext,
  defaultPlaygroundDependencies,
  lazyCredential,
  resolveModel,
  type PlaygroundDependencies,
} from '@/lib/application/playground';
import { retrievalBudgetFor } from '@/lib/domain/retrieval-config';

export const ASK_OPERATION = 'ask';
/** The channel twin's operation and request prefix: billed like a workbench question, never against `ask`'s cap. */
export const TWIN_OPERATION = 'twin';
export const TWIN_REQUEST_PREFIX = 'twin:';
/** Every `ask` seat's request id starts so; the daily cap counts pending seats by it. */
export const ASK_REQUEST_PREFIX = 'ask:';

export interface AskResult {
  outcome: 'answer' | 'degraded' | 'no_context';
  claims: { claim: string; chunkIds: string[] }[];
  chunks: ScopeSearchResult['chunks'];
  callsUsed: number;
  requestId: string;
}

export interface AskScopeInput {
  scope: SearchScope;
  question: string;
  /**
   * The channel's AI twin (proposal 6.3, 8.2): a signed-in reader's
   * question costs their workspace 1 Call like the workbench, with the
   * generation on the platform, and is not an A2A answer -- no daily cap,
   * and it is logged as `twin`.
   */
  twin?: boolean;
}

export async function askScope(
  caller: CallerContext,
  input: AskScopeInput,
  dependencies: PlaygroundDependencies = defaultPlaygroundDependencies,
): Promise<AskResult> {
  if (!caller.workspaceId) {
    throw new AppError('access_denied', 'ask needs an authenticated caller (a re0 API key)');
  }
  const startedAt = Date.now();
  const retrieval = dependencies.retrieval ?? defaultRetrievalDependencies();
  const settings = await (retrieval.settings ?? activeRetrievalSettings)();
  const prefix = input.twin ? TWIN_REQUEST_PREFIX : ASK_REQUEST_PREFIX;
  const requestId = caller.requestId.startsWith(prefix) ? caller.requestId : `${prefix}${caller.requestId}`;
  const asking: CallerContext = { ...caller, requestId };
  const callsPerAnswer = input.twin ? 1 : settings.askCallsPerAnswer;
  const operation = input.twin ? TWIN_OPERATION : ASK_OPERATION;

  const seat = await reserveCalls({
    workspaceId: caller.workspaceId,
    requestId,
    calls: callsPerAnswer,
    ...(input.twin
      ? {}
      : {
          daily: {
            operation: ASK_OPERATION,
            requestPrefix: ASK_REQUEST_PREFIX,
            limit: settings.askDailyAnswers,
            message: `this workspace has had its ${settings.askDailyAnswers} answers for today (UTC); retry tomorrow or use search_context`,
          },
        }),
  });

  try {
    const { usable } = await resolveModel(asking, null, dependencies);
    const maxTokens = retrievalBudgetFor(usable?.maxInputTokens, settings);
    const found = await searchScope(
      asking,
      { scope: input.scope, query: input.question, maxTokens, meter: false, operation },
      { ...retrieval, settings: async () => settings },
    );

    /* Rule 2: nothing found, no model, nothing billed. */
    if (found.chunks.length === 0) {
      await releaseCalls(seat);
      return { outcome: 'no_context', claims: [], chunks: [], callsUsed: 0, requestId };
    }

    const chunks: GatheredChunk[] = found.chunks.map(({ asset, ...chunk }) => ({
      ...chunk,
      libraryId: asset.publicId,
      libraryTitle: asset.title,
      version: asset.version,
    }));
    const libraries = librariesOf(found);
    const claims: AskResult['claims'] = [];
    let outcome: AskResult['outcome'] = 'degraded';
    for await (const event of answerFromContext(
      asking,
      {
        libraries,
        question: input.question,
        resolved: null,
        retrieved: { chunks, libraries, requestId },
        usable,
        credential: lazyCredential(usable, dependencies),
        startedAt,
      },
      dependencies,
    )) {
      if (event.type === 'claim') claims.push({ claim: event.claim, chunkIds: event.chunkIds });
      else if (event.type === 'done') outcome = event.kind;
    }

    const top = found.chunks[0]!;
    const answered = outcome === 'answer' && claims.length > 0;
    const calls = answered ? callsPerAnswer : 1;
    await commitCalls(seat, {
      calls,
      libraryId: top.asset.assetId,
      versionId: top.asset.versionId,
      /* A chunk list is a retrieval, billed and counted as one. */
      operation: answered ? operation : 'search_context',
      entrypoint: caller.entrypoint ?? 'a2a',
      latencyMs: Date.now() - startedAt,
      returnedTokens: found.chunks.reduce((total, chunk) => total + chunk.tokens, 0),
    });
    return {
      outcome: answered ? 'answer' : 'degraded',
      claims: answered ? claims : [],
      chunks: found.chunks,
      callsUsed: calls,
      requestId,
    };
  } catch (error) {
    /* §11.1: a failure of ours is not a Call served. */
    await releaseCalls(seat).catch(() => {});
    throw error;
  }
}

function librariesOf(found: ScopeSearchResult): GatheredLibrary[] {
  const byAsset = new Map<string, GatheredLibrary>();
  for (const chunk of found.chunks) {
    const known = byAsset.get(chunk.asset.publicId);
    if (known) known.chunks += 1;
    else {
      byAsset.set(chunk.asset.publicId, {
        libraryId: chunk.asset.publicId,
        title: chunk.asset.title,
        version: chunk.asset.version,
        confirmed: true,
        faqNearest: null,
        chunks: 1,
        failed: false,
        excerpts: [],
      });
    }
  }
  return [...byAsset.values()];
}
