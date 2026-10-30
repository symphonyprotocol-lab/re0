/**
 * Finding channels by topic: platform-level routing (agent-first-proposal.md
 * 3.7, 7.2 `find_channels`; architecture.md 9.6).
 *
 * Two paths, fused by reciprocal rank, over public channels only:
 *
 *   1. content -- the asset router (resolve-asset.ts: profile FTS, profile
 *      ANN, rare terms, with its evidence admission) run with anonymous
 *      visibility, so only assets shared with everyone can route; each
 *      admitted asset votes for the channel it is in;
 *   2. channel  -- the channel's own aggregate profile terms, title and
 *      description, for a question that names what a channel is about.
 *
 * Visibility comes before routing: an unlisted asset, a private channel or a
 * paid asset never contributes, whoever asks. No model is called.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { CallerContext } from '@/lib/application/retrieval';
import { resolveAsset } from '@/lib/application/retrieval/resolve-asset';
import { routingTokens } from '@/lib/domain/profile';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { readChannelProfile } from './profile';

const RRF_K = 60;
const CHANNEL_TEXT_LIMIT = 20;
export const FIND_CHANNELS_DEFAULT = 5;
export const FIND_CHANNELS_MAX = 20;

export interface FoundChannel {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  ownerHandle: string | null;
  /** The owning workspace; null for the platform's channel. */
  workspaceId: string | null;
  isPlatform: boolean;
  /** Assets in the channel that matched, best first, by public id and title. */
  matchedAssets: { publicId: string; title: string }[];
  /** Query terms the channel's profile carries. */
  matchedTerms: string[];
  score: number;
}

export async function findChannels(
  caller: Pick<CallerContext, 'requestId'>,
  input: { query: string; limit?: number },
): Promise<FoundChannel[]> {
  const limit = Math.min(Math.max(1, input.limit ?? FIND_CHANNELS_DEFAULT), FIND_CHANNELS_MAX);
  const database = db();
  const tokens = routingTokens(input.query);

  /* -------------------------------------------- path 1: content, by asset */

  const routed = await resolveAsset(
    { workspaceId: null, apiKeyId: null, requestId: caller.requestId, anonymous: true },
    { query: input.query },
  );
  const assetRank = new Map(routed.results.map((result, at) => [result.assetId, at]));
  const assetTitle = new Map(routed.results.map((result) => [result.assetId, result.title]));
  const memberships =
    assetRank.size === 0
      ? []
      : await database
          .select({ publicId: schema.asset.publicId, channelId: schema.channelAsset.channelId })
          .from(schema.asset)
          .innerJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.asset.id))
          .innerJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
          .where(
            and(
              inArray(schema.asset.publicId, [...assetRank.keys()]),
              eq(schema.channel.visibility, 'public'),
              eq(schema.channel.status, 'active'),
            ),
          );

  /* ------------------------------------------- path 2: the channel itself */

  const termMatch =
    tokens.length > 0
      ? sql`${schema.channel.profile}->'terms' ?| array[${sql.join(
          tokens.map((token) => sql`${token}`),
          sql`, `,
        )}]::text[]`
      : null;
  const phrase = `%${input.query.trim().slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const textual = await database
    .select({ id: schema.channel.id })
    .from(schema.channel)
    .where(
      and(
        eq(schema.channel.visibility, 'public'),
        eq(schema.channel.status, 'active'),
        or(
          sql`${schema.channel.title} ilike ${phrase}`,
          sql`${schema.channel.description} ilike ${phrase}`,
          ...(termMatch ? [termMatch] : []),
        ),
      ),
    )
    .limit(CHANNEL_TEXT_LIMIT);

  /* ------------------------------------------------------------- fusion */

  const score = new Map<string, number>();
  const matched = new Map<string, string[]>();
  for (const membership of memberships) {
    const rank = assetRank.get(membership.publicId) ?? 0;
    score.set(membership.channelId, (score.get(membership.channelId) ?? 0) + 1 / (RRF_K + rank + 1));
    const list = matched.get(membership.channelId) ?? [];
    list.push(membership.publicId);
    matched.set(membership.channelId, list);
  }
  textual.forEach((row, at) => {
    score.set(row.id, (score.get(row.id) ?? 0) + 1 / (RRF_K + at + 1));
  });
  if (score.size === 0) return [];

  const ids = [...score.keys()];
  const details = await database
    .select({
      id: schema.channel.id,
      slug: schema.channel.slug,
      title: schema.channel.title,
      description: schema.channel.description,
      workspaceId: schema.channel.workspaceId,
      profile: schema.channel.profile,
      handle: schema.workspace.handle,
      /* A channel with nothing live is not an answer (the directory's rule, directory.ts). */
      live: sql<number>`(select count(*)::int from ${schema.channelAsset} ca
        join ${schema.asset} l on l.id = ca.asset_id
        where ca.channel_id = ${schema.channel.id} and l.lifecycle_status = 'published'
          and l.index_status = 'ready' and l.deleted_at is null)`,
    })
    .from(schema.channel)
    .leftJoin(schema.workspace, eq(schema.workspace.id, schema.channel.workspaceId))
    .where(inArray(schema.channel.id, ids));

  const tokenSet = new Set(tokens);
  return details
    .filter((row) => Number(row.live) > 0)
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      ownerHandle: row.handle ?? null,
      workspaceId: row.workspaceId,
      isPlatform: row.workspaceId === null,
      matchedAssets: (matched.get(row.id) ?? [])
        .sort((a, b) => (assetRank.get(a) ?? 0) - (assetRank.get(b) ?? 0))
        .slice(0, 5)
        .map((publicId) => ({ publicId, title: assetTitle.get(publicId) ?? publicId })),
      matchedTerms: readChannelProfile(row.profile).terms.filter((term) => tokenSet.has(term)).slice(0, 8),
      score: score.get(row.id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}
