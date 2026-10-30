/**
 * Retrieval within one library. architecture.md 9.2, and the order is the
 * contract: authorize and pin the version, reserve one call, then recall --
 * never the other way around.
 *
 *   resolve library (alias-aware) -> enforce visibility -> pin ready version
 *   -> reserve one call -> FTS + vector recall within library + version
 *   -> reciprocal-rank fusion -> dedupe and safety filter -> trim to maxTokens
 *   -> commit the usage event
 *
 * Vector recall is an exact scan of the pinned version's rows (architecture.md
 * 9.1: no chunk-level ANN index exists, deliberately), so recall is full and
 * the cost is bounded by the version, not the platform. The keyword half uses
 * the text-search configuration frozen on the version, so query stemming
 * always matches how the chunks were indexed.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import type { ChunkResult, QueryDocsInput, QueryDocsOutput } from '@/contracts/schemas';
import { isQueryable } from '@/lib/domain';
import { libraryIdCandidates } from '@/lib/domain/library';
import {
  commitCall,
  recordRequestLog,
  releaseCall,
  reserveCall,
  type ReservedCall,
} from '@/lib/application/plans';
import { httpStatusFor } from '@/contracts/errors';
import { pinPolicy, policyIsOpen, policyVerdictFor } from '@/lib/application/policies';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { sharedWithEveryone } from '@/lib/application/channels/visibility';
import type { EmbeddingAdapter, RerankAdapter } from '@/lib/infrastructure/ai/providers';
import type { CallerContext } from './index';
import { rankChunks } from './rank';
import type { RetrievalConfidence } from '@/lib/domain/routing';
import { sha256Hex } from '@/lib/domain/ingestion';
import {
  cacheSetTagged,
  retrievalCache,
  type RetrievalCache,
} from '@/lib/infrastructure/cache/redis';
import {
  activeRetrievalSettings,
  type ActiveRetrievalSettings,
} from '@/lib/application/administration/manage-retrieval-config';
import { modelAdapters } from '@/lib/application/administration/manage-model-config';

export interface RetrievalDependencies {
  /**
   * Awaited: both models are console configuration now (`provider_model_config`),
   * so the default resolves a row and opens its credential. A test's
   * synchronous fake still satisfies this -- awaiting a plain value is
   * awaiting a resolved promise.
   */
  embeddings(): EmbeddingAdapter | Promise<EmbeddingAdapter>;
  rerank(): RerankAdapter | Promise<RerankAdapter>;
  cache(): RetrievalCache;
  configured():
    | { embeddings: boolean; rerank: boolean }
    | Promise<{ embeddings: boolean; rerank: boolean }>;
  /**
   * The tunables in force: recall widths, fusion constant, rerank window,
   * cache TTL (lib/domain/retrieval-config.ts). Read per request so a console
   * save applies to the next call. Optional so a test that injects the rest
   * keeps working against the stored configuration.
   */
  settings?(): Promise<ActiveRetrievalSettings>;
}

/**
 * A fresh set per call: the model seams share one resolution of the
 * configuration rows (`modelAdapters`), which belongs to one request and
 * must not outlive it -- a module-level set would pin the first request's
 * models, keys and all, for the life of the process.
 */
export function defaultRetrievalDependencies(): RetrievalDependencies {
  return {
    ...modelAdapters(),
    cache: retrievalCache,
    settings: activeRetrievalSettings,
  };
}

/**
 * Participates in every cache key (architecture.md 9.4), together with the
 * id of the configuration row in force: fusion, dedupe and trim *code* is
 * versioned here, and the *numbers* it runs with are versioned by the row.
 * Bump on any change to the retrieval pipeline's behaviour.
 */
export const RETRIEVAL_CONFIG_VERSION = 're0-retrieval-2';

/**
 * The contract's output plus what the retrieval learned about its own fit
 * (lib/domain/routing.ts). Not part of /v1: the REST and MCP entries hand
 * out `QueryDocsOutput`, and only the playground -- which has to decide
 * whether to call a model on these passages -- reads the confidence. Null
 * on a cache entry written before the confidence existed.
 */
export type QueryDocsResult = QueryDocsOutput & {
  confidence: RetrievalConfidence | null;
  /** What committing this read as the served call would record (`commitServedCall`). */
  served: ServedCall;
  /**
   * The seat a `meter: 'deferred'` read holds, still pending: the caller
   * commits it against whichever library it decides was served, or releases
   * it. Null for every other mode.
   */
  reservation: ReservedCall | null;
};

/** One read's facts for the usage event, kept so a deferred seat can be committed against it. */
export interface ServedCall {
  libraryId: string;
  versionId: string;
  returnedTokens: number;
  latencyMs: number;
}
/** The key's policy slot for callers with no workspace and hence no policy. */
const NO_POLICY = 'p0';
/** The key's configuration slot when the defaults are in force. */
const NO_CONFIG = 'c0';

export async function queryDocs(
  caller: CallerContext,
  input: QueryDocsInput,
  dependencies: RetrievalDependencies = defaultRetrievalDependencies(),
): Promise<QueryDocsOutput> {
  const {
    confidence: _confidence,
    served: _served,
    reservation: _reservation,
    ...output
  } = await queryDocsDetailed(caller, input, dependencies);
  return output;
}

/**
 * How one retrieval is accounted for. Both modes below are for the
 * scatter-gather (retrieval/gather.ts) behind the playground, the widget and
 * showcase drafts, and never reachable from /v1 or MCP, where each call is a
 * served call.
 *
 * `meter: false`: not a served call -- no reservation, no usage event, no
 * request-log row. Every gate before the reservation (visibility, state,
 * policy) still applies, and the cache is still used.
 *
 * `meter: 'deferred'`: the seat is reserved before retrieval exactly as a
 * metered read's is, so quota still refuses up front, but it is handed back
 * pending in `reservation` rather than committed or released, even when this
 * read found nothing: one exchange is one Call, and which library served it
 * is only known once every candidate's retrieval has been judged.
 */
export interface QueryDocsOptions {
  meter?: boolean | 'deferred';
}

/** Commits a deferred seat as the call `served` describes: one usage event. */
export async function commitServedCall(
  caller: CallerContext,
  reservation: ReservedCall,
  served: ServedCall,
): Promise<void> {
  await commitCall({
    reservation,
    libraryId: served.libraryId,
    versionId: served.versionId,
    operation: 'context',
    entrypoint: entrypointOf(caller),
    statusCode: 200,
    latencyMs: served.latencyMs,
    inputTokens: null,
    returnedTokens: served.returnedTokens,
  });
}

export async function queryDocsDetailed(
  caller: CallerContext,
  input: QueryDocsInput,
  dependencies: RetrievalDependencies = defaultRetrievalDependencies(),
  options: QueryDocsOptions = {},
): Promise<QueryDocsResult> {
  const startedAt = Date.now();
  const database = db();
  const meter = options.meter ?? true;
  /*
   * The request log (architecture.md 6.3): outcome, library, latency --
   * never the query text (17.1). Awaited but best-effort: the catch keeps a
   * diary failure from failing the request it describes, and awaiting keeps
   * the write from being dropped -- a serverless function may freeze the
   * moment the response returns, so fire-and-forget writes simply vanish.
   */
  const logExit = (
    libraryPublicId: string | null,
    statusCode: number,
    returnedTokens: number | null,
  ) =>
    recordRequestLog({
      workspaceId: caller.workspaceId,
      requestId: caller.requestId,
      operation: 'query-docs',
      libraryPublicId,
      entrypoint: entrypointOf(caller),
      statusCode,
      latencyMs: Date.now() - startedAt,
      returnedTokens,
      apiKeyId: caller.apiKeyId,
    }).catch(() => {});

  try {
    const output = await queryDocsInner(caller, input, dependencies, startedAt, database, meter);
    if (meter) {
      await logExit(
        output.libraryId,
        200,
        output.chunks.reduce((total, chunk) => total + chunk.tokens, 0),
      );
    }
    return output;
  } catch (error) {
    if (meter) {
      await logExit(null, error instanceof AppError ? httpStatusFor(error.code) : 500, null);
    }
    throw error;
  }
}

/** The door the caller came through; the pre-MCP reading when unstated. */
function entrypointOf(caller: CallerContext): 'rest' | 'mcp' | 'web' | 'a2a' {
  return caller.entrypoint ?? (caller.apiKeyId ? 'rest' : 'web');
}

async function queryDocsInner(
  caller: CallerContext,
  input: QueryDocsInput,
  dependencies: RetrievalDependencies,
  startedAt: number,
  database: ReturnType<typeof db>,
  meter: boolean | 'deferred',
): Promise<QueryDocsResult> {
  const settings = await (dependencies.settings ?? activeRetrievalSettings)();

  /* -------------------------------------------- resolve, authorize, pin */

  /*
   * Which library the id names, and whether it pins a version. Nested ids and
   * pinned versions share one grammar (requirement.md 6.1:
   * `/websites/ethereum/whitepaper` is a library if one exists at that id,
   * otherwise the `whitepaper` version of `/websites/ethereum`), so every
   * reading is looked up at once and the longest library wins.
   *
   * Live rows only. A deleted library is a tombstone that keeps its public id
   * (architecture.md 8.4), and the id may since have been taken by a new
   * library; the tombstone must neither answer nor shadow it.
   */
  const candidates = libraryIdCandidates(input.libraryId);
  const candidateIds = candidates.map((candidate) => candidate.publicId);

  const found = await database
    .select(librarySelection)
    .from(schema.library)
    .where(and(inArray(schema.library.publicId, candidateIds), isNull(schema.library.deletedAt)));

  let match = candidates.find((candidate) =>
    found.some((row) => row.publicId === candidate.publicId),
  );
  let library = match ? found.find((row) => row.publicId === match!.publicId) : undefined;

  if (!library) {
    /* Redirects, read the same way: the longest old id that redirects wins. */
    const aliases = await database
      .select({
        fromPublicId: schema.libraryAlias.fromPublicId,
        libraryId: schema.libraryAlias.libraryId,
      })
      .from(schema.libraryAlias)
      .where(inArray(schema.libraryAlias.fromPublicId, candidateIds));
    match = candidates.find((candidate) =>
      aliases.some((alias) => alias.fromPublicId === candidate.publicId),
    );
    const alias = match ? aliases.find((row) => row.fromPublicId === match!.publicId) : undefined;
    if (alias) {
      [library] = await database
        .select(librarySelection)
        .from(schema.library)
        .where(and(eq(schema.library.id, alias.libraryId), isNull(schema.library.deletedAt)));
    }
  }
  const versionLabel = library ? (match?.versionLabel ?? null) : null;

  /*
   * architecture.md 5.2: an invisible asset and a nonexistent one answer
   * identically, before anything else about them is examined. Visible means
   * shared with everyone -- free in a public channel -- or the caller's own
   * (agent-first-proposal.md 6.2, channels/visibility.ts).
   */
  const visible =
    library &&
    (library.shared ||
      (caller.workspaceId !== null && library.ownerWorkspaceId === caller.workspaceId));
  if (!library || !visible) {
    throw new AppError('library_not_found', 'no such library');
  }
  if (library.lifecycleStatus === 'suspended') {
    throw new AppError('library_suspended', 'the library is suspended');
  }
  if (
    !isQueryable({
      lifecycleStatus: library.lifecycleStatus,
      indexStatus: library.indexStatus,
    }) ||
    !library.currentVersionId
  ) {
    throw new AppError('library_not_ready', 'the library has no queryable version');
  }

  /*
   * §10.2: the workspace policy is pinned and enforced before the version is
   * pinned, before anything is reserved, and before any embedding is built.
   * A refusal carries only the stable reason code. Anonymous callers have no
   * workspace and therefore no policy.
   */
  const pinnedPolicy = caller.workspaceId
    ? await pinPolicy(caller.workspaceId)
    : { versionId: null, policy: null };
  if (pinnedPolicy.policy && !policyIsOpen(pinnedPolicy.policy)) {
    const verdict = await policyVerdictFor(pinnedPolicy.policy, library.id);
    if (!verdict.allowed) {
      throw new AppError('access_rule_blocked', verdict.reason);
    }
  }

  const version = versionLabel
    ? await pinLabeledVersion(database, library.id, versionLabel)
    : await pinVersion(database, library.currentVersionId);

  /* ---------------------------------------------------------- reserve */

  /*
   * Anonymous trial traffic is admitted by the edge rate limit
   * (architecture.md 11.2) and never touches subscription quota; only an
   * authenticated workspace reserves and is metered.
   */
  const reservation =
    meter && caller.workspaceId
      ? await reserveCall({
          workspaceId: caller.workspaceId,
          requestId: caller.requestId,
        })
      : null;

  /* ----------------------------------------------------------- meter */

  /*
   * requirement.md §4.2: a call that returns nothing is not charged. The
   * seat goes back and no usage event is written -- the library answered no
   * question. Decided 2026-10-05: an empty result is
   * the catalogue's failure, not the caller's purchase. Anything else is
   * committed here, unless the caller deferred that decision.
   */
  const settle = async (
    chunks: ChunkResult[],
    confidence: RetrievalConfidence | null,
  ): Promise<QueryDocsResult> => {
    const served: ServedCall = {
      libraryId: library.id,
      versionId: version.id,
      returnedTokens: chunks.reduce((total, chunk) => total + chunk.tokens, 0),
      latencyMs: Date.now() - startedAt,
    };
    const answer = {
      libraryId: library.publicId,
      version: version.label,
      chunks,
      requestId: caller.requestId,
      confidence,
      served,
    };
    /* Deferred, empty or not: another candidate may still have served the exchange. */
    if (reservation && meter === 'deferred') {
      return { ...answer, usage: usageOf(reservation), reservation };
    }
    if (reservation && chunks.length === 0) {
      await releaseCall(reservation.reservationId);
      return { ...answer, usage: usageAfterRelease(reservation), reservation: null };
    }
    if (reservation) await commitServedCall(caller, reservation, served);
    return { ...answer, usage: usageOf(reservation), reservation: null };
  };

  try {
    /* ----------------------------------------------------------- cache */

    /*
     * architecture.md 9.4, checked only now: a hit has already passed the
     * same visibility, state and quota gates as a miss. Shared assets
     * only -- a shared version's chunks are identical for every caller, so
     * one shared entry is safe, while caching private responses would demand
     * the per-workspace encrypted partition 9.4 prescribes and is deferred
     * with it. The canonical JSON is the only cached shape; TXT derives from
     * it downstream, so one entry serves both response types. Metering runs
     * on hits exactly as on misses: a cached answer is still a served call.
     * A TTL of zero is the console switching the cache off.
     */
    const cacheable = Boolean(library.shared) && settings.cacheTtlSeconds > 0;
    const cacheKey = cacheable
      ? `ctx:pub:${version.id}:${pinnedPolicy.versionId ?? NO_POLICY}:${await sha256Hex(input.query)}:${input.maxTokens}:${RETRIEVAL_CONFIG_VERSION}:${settings.configId ?? NO_CONFIG}`
      : null;

    if (cacheKey) {
      const hit = await dependencies
        .cache()
        .get(cacheKey)
        .catch(() => null);
      if (hit) {
        let chunks: ChunkResult[] | null = null;
        let confidence: RetrievalConfidence | null = null;
        try {
          const entry = JSON.parse(hit) as {
            chunks: ChunkResult[];
            confidence?: RetrievalConfidence;
          };
          chunks = entry.chunks;
          confidence = entry.confidence ?? null;
        } catch {
          chunks = null; /* a corrupt entry is a miss, never an error */
        }
        /* A cache hit is still a served call, and it still earns. */
        if (chunks) return await settle(chunks, confidence);
      }
    }

    const { chunks, confidence } = await rankChunks(
      database,
      { libraryId: library.id, version, query: input.query, maxTokens: input.maxTokens },
      dependencies,
      settings,
    );

    /* Stored under the library's tag so a safety suspension can revoke every
       entry at once (9.4); best-effort, and never on the request's account. */
    if (cacheKey) {
      cacheSetTagged(dependencies.cache(), {
        key: cacheKey,
        value: JSON.stringify({ chunks, confidence }),
        ttlSeconds: settings.cacheTtlSeconds,
        tag: `ctxtag:${library.id}`,
      }).catch(() => {});
    }

    return await settle(chunks, confidence);
  } catch (error) {
    /*
     * §11.1: a platform failure releases the seat and writes no event. A
     * refusal thrown before this block (quota, visibility) reserved nothing.
     */
    if (reservation && !(error instanceof AppError)) {
      await releaseCall(reservation.reservationId).catch(() => {});
    }
    throw error;
  }
}

const librarySelection = {
  id: schema.library.id,
  publicId: schema.library.publicId,
  /** Free in a public, active channel: readable by everyone. */
  shared: sql<boolean>`${sharedWithEveryone()}`,
  lifecycleStatus: schema.library.lifecycleStatus,
  indexStatus: schema.library.indexStatus,
  ownerWorkspaceId: schema.library.ownerWorkspaceId,
  isPlatformLibrary: schema.library.isPlatformLibrary,
  currentVersionId: schema.library.currentVersionId,
};

export interface PinnedVersion {
  id: string;
  label: string;
  searchConfig: string;
  embeddingModel: string;
  /** The width the model was asked for; see the vector leg's guard. */
  embeddingDimensions: number;
}

async function pinVersion(
  database: ReturnType<typeof db>,
  versionId: string,
): Promise<PinnedVersion> {
  const [version] = await database
    .select({
      id: schema.libraryVersion.id,
      label: schema.libraryVersion.label,
      searchConfig: schema.libraryVersion.searchConfig,
      embeddingModel: schema.libraryVersion.embeddingModel,
      embeddingDimensions: schema.libraryVersion.embeddingDimensions,
      indexStatus: schema.libraryVersion.indexStatus,
    })
    .from(schema.libraryVersion)
    .where(eq(schema.libraryVersion.id, versionId));
  if (!version || version.indexStatus !== 'ready') {
    throw new AppError('library_not_ready', 'the library has no queryable version');
  }
  return version;
}

/** A /owner/name/version id pins that label instead of the current pointer. */
async function pinLabeledVersion(
  database: ReturnType<typeof db>,
  libraryId: string,
  label: string,
): Promise<PinnedVersion> {
  const [version] = await database
    .select({
      id: schema.libraryVersion.id,
      label: schema.libraryVersion.label,
      searchConfig: schema.libraryVersion.searchConfig,
      embeddingModel: schema.libraryVersion.embeddingModel,
      embeddingDimensions: schema.libraryVersion.embeddingDimensions,
      indexStatus: schema.libraryVersion.indexStatus,
    })
    .from(schema.libraryVersion)
    .where(
      and(
        eq(schema.libraryVersion.libraryId, libraryId),
        eq(schema.libraryVersion.label, label),
        inArray(schema.libraryVersion.indexStatus, ['ready', 'stale']),
      ),
    );
  if (!version) {
    throw new AppError('library_not_found', 'no such version for this library');
  }
  return version;
}

/**
 * What a released seat leaves: nothing used, and the allowance the reservation
 * had already subtracted itself from given back on the same source it would
 * have been debited from.
 */
function usageAfterRelease(reservation: ReservedCall): QueryDocsOutput['usage'] {
  return {
    callsUsed: 0,
    planAllowanceRemaining:
      reservation.planAllowanceRemaining + (reservation.debitSource === 'plan' ? 1 : 0),
    addonBalanceRemaining:
      reservation.addonBalanceRemaining + (reservation.debitSource === 'addon' ? 1 : 0),
  };
}

function usageOf(reservation: ReservedCall | null): QueryDocsOutput['usage'] {
  if (!reservation) {
    return {
      callsUsed: 1,
      planAllowanceRemaining: 0,
      addonBalanceRemaining: 0,
    };
  }
  return {
    callsUsed: 1,
    planAllowanceRemaining: reservation.planAllowanceRemaining,
    addonBalanceRemaining: reservation.addonBalanceRemaining,
  };
}
