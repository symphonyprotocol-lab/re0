/**
 * Retrieval over a scope of assets: a channel, or a workspace's assets.
 * agent-first-proposal.md 3.7, 7.2 (`search_context`), 8.2.
 *
 * Same order as one asset's read (architecture.md 9.2), widened from one to a
 * group:
 *
 *   fix the caller-visible live assets in the scope (visibility before
 *   recall) -> apply the workspace policy -> reserve one call -> one ranked
 *   recall across every pinned version -> commit on a non-empty result
 *
 * Metering is "whoever asks pays" (proposal 8.2): an authenticated caller's
 * own workspace reserves and is charged one Call when anything comes back;
 * nothing is charged on an empty result; an anonymous caller reserves
 * nothing, writes no usage event and is attributed to no workspace -- the
 * anonymous rate limit at the door is what bounds it. The scope's owner never
 * pays for a visitor.
 *
 * No model is called here, ever (proposal 7.7): the result is chunks with
 * their citations, assets, versions and anchors.
 *
 * `meter: false` leaves the seat to the caller: A2A `ask` holds its own,
 * weighted one (plans/weighted-call.ts) around retrieval and generation and
 * decides afterwards what the answer cost (proposal 8.2).
 */
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { AppError, httpStatusFor } from '@/contracts/errors';
import type { ChunkResult } from '@/contracts/schemas';
import { commitCall, recordRequestLog, releaseCall, reserveCall, type ReservedCall } from '@/lib/application/plans';
import { pinPolicy, policyIsOpen, policyVerdicts } from '@/lib/application/policies';
import { activeRetrievalSettings } from '@/lib/application/administration/manage-retrieval-config';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import type { CallerContext } from './index';
import { defaultRetrievalDependencies, type RetrievalDependencies } from './query-docs';
import { rankAcross, type RankScopeMember } from './rank';
import { visibleTo } from './resolve-asset';
import { assertUnderSubscriberCap } from '@/lib/application/channels/subscriptions';

export type SearchScope =
  | { kind: 'channel'; channelId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'assets'; assetIds: string[] };

export interface ScopedSource {
  assetId: string;
  publicId: string;
  title: string;
  version: string;
  versionId: string;
}

export interface ScopeSearchResult {
  chunks: (ChunkResult & { asset: ScopedSource })[];
  /** How many assets the caller could see in the scope -- zero means nothing was searched. */
  searchedAssets: number;
  /** One Call when the caller is a workspace and something came back; else zero. */
  callsUsed: number;
  requestId: string;
}

export const SCOPE_OPERATION = 'search_context';

export interface SearchScopeInput {
  scope: SearchScope;
  query: string;
  maxTokens: number;
  /** False when the caller holds the seat itself; true by default. */
  meter?: boolean;
  /** What the request log calls this read; `search_context` by default. */
  operation?: string;
}

export async function searchScope(
  caller: CallerContext,
  input: SearchScopeInput,
  dependencies: RetrievalDependencies = defaultRetrievalDependencies(),
): Promise<ScopeSearchResult> {
  const startedAt = Date.now();
  const log = (statusCode: number, returnedTokens: number | null) =>
    recordRequestLog({
      workspaceId: caller.workspaceId,
      requestId: caller.requestId,
      operation: input.operation ?? SCOPE_OPERATION,
      assetPublicId: null,
      entrypoint: caller.entrypoint ?? 'a2a',
      statusCode,
      latencyMs: Date.now() - startedAt,
      returnedTokens,
      apiKeyId: caller.apiKeyId,
    }).catch(() => {});

  try {
    const result = await searchScopeInner(caller, input, dependencies, startedAt);
    await log(200, result.chunks.reduce((total, chunk) => total + chunk.tokens, 0));
    return result;
  } catch (error) {
    await log(error instanceof AppError ? httpStatusFor(error.code) : 500, null);
    throw error;
  }
}

async function searchScopeInner(
  caller: CallerContext,
  input: SearchScopeInput,
  dependencies: RetrievalDependencies,
  startedAt: number,
): Promise<ScopeSearchResult> {
  const database = db();
  const settings = await (dependencies.settings ?? activeRetrievalSettings)();

  /* --------------------------------------- visibility, before any recall */

  const inScope: SQL =
    input.scope.kind === 'channel'
      ? inArray(
          schema.asset.id,
          database
            .select({ id: schema.channelAsset.assetId })
            .from(schema.channelAsset)
            .where(eq(schema.channelAsset.channelId, input.scope.channelId)),
        )
      : input.scope.kind === 'workspace'
        ? eq(schema.asset.ownerWorkspaceId, input.scope.workspaceId)
        : inArray(schema.asset.id, input.scope.assetIds.length > 0 ? input.scope.assetIds : ['00000000-0000-0000-0000-000000000000']);

  let assets = await database
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      versionId: schema.assetVersion.id,
      label: schema.assetVersion.label,
      searchConfig: schema.assetVersion.searchConfig,
      embeddingModel: schema.assetVersion.embeddingModel,
      embeddingDimensions: schema.assetVersion.embeddingDimensions,
    })
    .from(schema.asset)
    .innerJoin(
      schema.assetVersion,
      and(
        eq(schema.assetVersion.id, schema.asset.currentVersionId),
        eq(schema.assetVersion.indexStatus, 'ready'),
      ),
    )
    .where(and(inScope, visibleTo(caller)));

  /* §10.2: the caller's own access rules, at the metadata stage. */
  if (caller.workspaceId && assets.length > 0) {
    const pinned = await pinPolicy(caller.workspaceId);
    if (!policyIsOpen(pinned.policy)) {
      const verdicts = await policyVerdicts(pinned.policy, assets.map((asset) => asset.id));
      assets = assets.filter((asset) => verdicts.get(asset.id)?.allowed !== false);
    }
  }
  if (assets.length === 0) {
    return { chunks: [], searchedAssets: 0, callsUsed: 0, requestId: caller.requestId };
  }

  /* Proposal 6.10: no default caps; a creator may cap each subscriber's reads of a channel per day. */
  if (input.scope.kind === 'channel' && caller.workspaceId) {
    await assertUnderSubscriberCap(caller.workspaceId, input.scope.channelId);
  }

  /* ----------------------------------------------------------- reserve */

  const reservation: ReservedCall | null = caller.workspaceId && input.meter !== false
    ? await reserveCall({ workspaceId: caller.workspaceId, requestId: caller.requestId })
    : null;

  try {
    const members: RankScopeMember[] = assets.map((asset) => ({
      assetId: asset.id,
      version: {
        id: asset.versionId,
        searchConfig: asset.searchConfig,
        embeddingModel: asset.embeddingModel,
        embeddingDimensions: asset.embeddingDimensions,
      },
    }));
    const { chunks } = await rankAcross(
      database,
      { members, query: input.query, maxTokens: input.maxTokens },
      dependencies,
      settings,
    );

    /* requirement.md 4.2: nothing returned, nothing charged. */
    if (reservation && chunks.length === 0) {
      await releaseCall(reservation.reservationId);
    } else if (reservation) {
      const top = chunks[0]!;
      await commitCall({
        reservation,
        assetId: top.assetId,
        versionId: top.versionId,
        operation: SCOPE_OPERATION,
        entrypoint: caller.entrypoint ?? 'a2a',
        statusCode: 200,
        latencyMs: Date.now() - startedAt,
        inputTokens: null,
        returnedTokens: chunks.reduce((total, chunk) => total + chunk.tokens, 0),
      });
    }

    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    return {
      chunks: chunks.map(({ assetId, versionId: _versionId, ...chunk }) => {
        const asset = byId.get(assetId)!;
        return {
          ...chunk,
          asset: {
            assetId: asset.id,
            publicId: asset.publicId,
            title: asset.title,
            version: asset.label,
            versionId: asset.versionId,
          },
        };
      }),
      searchedAssets: assets.length,
      callsUsed: reservation && chunks.length > 0 ? 1 : 0,
      requestId: caller.requestId,
    };
  } catch (error) {
    /* §11.1: a platform failure releases the seat and writes no event. */
    if (reservation) await releaseCall(reservation.reservationId).catch(() => {});
    throw error;
  }
}
