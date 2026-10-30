/**
 * The public face of channels: the directory, a channel's page, a user's
 * page, and the lookups the Agent Cards and the sitemap share.
 * agent-first-proposal.md 4.3, 6.3, 6.4, 7.1.
 *
 * What the public sees is decided once, here and in visibility.ts:
 *
 * - a channel is public when it is `public` and `active`; a private or
 *   suspended one answers like a missing one to everyone but its owner;
 * - the directory lists public channels that hold at least one live asset
 *   (published, a ready version, not deleted) -- an empty channel is not an
 *   entry yet;
 * - inside a channel, a free asset is shown in full and a paid one by title,
 *   summary and date only (proposal 6.2); the owner sees everything;
 * - a user has a public page only while they have a public channel.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { assetSight, ACTIVITY_WINDOW_DAYS, hotScores, type AssetSight, type ChannelStatus, type ChannelVisibility, type DirectorySort } from '@/lib/domain/channel';
import type { AssetAccess, AssetKind } from '@/lib/domain/asset-kind';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { activeRetrievalSettings } from '@/lib/application/administration/manage-retrieval-config';
import { subscribesTo } from './subscriptions';
import { readChannelProfile, type ChannelProfile } from './profile';

const DAY_MS = 86_400_000;
/** The directory ranks in memory; this bounds how many channels it reads to do so. */
const DIRECTORY_CANDIDATE_CAP = 2_000;
export const DIRECTORY_PAGE_SIZE = 24;

/** Live: published, with a ready current version, not a tombstone. */
const LIVE: SQL = and(
  eq(schema.asset.lifecycleStatus, 'published'),
  eq(schema.asset.indexStatus, 'ready'),
  isNotNull(schema.asset.currentVersionId),
  isNull(schema.asset.deletedAt),
)!;

const PUBLIC_CHANNEL: SQL = and(eq(schema.channel.visibility, 'public'), eq(schema.channel.status, 'active'))!;

export interface ChannelOwner {
  /** Null for the platform's own channel, and for a workspace that has no handle. */
  handle: string | null;
  name: string;
  isPlatform: boolean;
}

export interface DirectoryEntry {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  owner: ChannelOwner;
  assetCount: number;
  kinds: AssetKind[];
  lastUpdatedAt: string | null;
}

interface DirectoryFacts extends DirectoryEntry {
  lastUpdated: Date | null;
}

/** Every public, non-empty channel with what ranking and display need. */
async function directoryFacts(filter?: SQL): Promise<DirectoryFacts[]> {
  const database = db();
  const rows = await database
    .select({
      id: schema.channel.id,
      slug: schema.channel.slug,
      title: schema.channel.title,
      description: schema.channel.description,
      workspaceId: schema.channel.workspaceId,
      handle: schema.workspace.handle,
      workspaceName: schema.workspace.name,
      assetCount: sql<number>`count(${schema.asset.id})::int`,
      kinds: sql<string[]>`array_agg(distinct ${schema.asset.kind})`,
      lastUpdated: sql<Date | null>`max(greatest(${schema.channelAsset.publishedAt}, coalesce(${schema.asset.lastSuccessfulRefreshAt}, ${schema.channelAsset.publishedAt})))`,
    })
    .from(schema.channel)
    .innerJoin(schema.channelAsset, eq(schema.channelAsset.channelId, schema.channel.id))
    .innerJoin(schema.asset, and(eq(schema.asset.id, schema.channelAsset.assetId), LIVE))
    .leftJoin(schema.workspace, eq(schema.workspace.id, schema.channel.workspaceId))
    .where(and(PUBLIC_CHANNEL, filter))
    .groupBy(schema.channel.id, schema.workspace.id)
    .orderBy(desc(sql`max(${schema.channelAsset.publishedAt})`), asc(schema.channel.slug))
    .limit(DIRECTORY_CANDIDATE_CAP);

  return rows.map((row) => {
    const lastUpdated = row.lastUpdated ? new Date(row.lastUpdated) : null;
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      owner: {
        handle: row.handle ?? null,
        name: row.workspaceId ? (row.workspaceName ?? '') : 're0',
        isPlatform: row.workspaceId === null,
      },
      assetCount: Number(row.assetCount),
      kinds: ((row.kinds ?? []) as AssetKind[]).filter(Boolean).sort(),
      lastUpdated,
      lastUpdatedAt: lastUpdated?.toISOString() ?? null,
    };
  });
}

/**
 * One page of the directory, and how many entries there are.
 *
 * 热门 ranks by `lib/domain/channel.ts` `hotScores` with the console's
 * weights; 最近更新 by the latest publication or refresh. Subscriptions and
 * revenue are never inputs (proposal 6.4). The slug closes both orders, so a
 * page boundary never hides or repeats an entry.
 */
export async function listChannelDirectory(input: {
  sort: DirectorySort;
  limit?: number;
  offset?: number;
  now?: Date;
}): Promise<{ entries: DirectoryEntry[]; total: number }> {
  const now = input.now ?? new Date();
  const facts = await directoryFacts();
  let ordered: DirectoryFacts[];
  if (input.sort === 'recent') {
    ordered = [...facts].sort(
      (a, b) =>
        (b.lastUpdated?.getTime() ?? 0) - (a.lastUpdated?.getTime() ?? 0) || a.slug.localeCompare(b.slug),
    );
  } else {
    const [activity, quality, settings] = await Promise.all([
      activityOf(facts.map((entry) => entry.id), now),
      qualityOf(facts.map((entry) => entry.id)),
      activeRetrievalSettings(),
    ]);
    const scores = hotScores(
      facts.map((entry) => ({
        id: entry.id,
        activity: activity.get(entry.id) ?? { users: 0, workspaces: 0, anonymous: 0 },
        lastUpdatedAt: entry.lastUpdated,
        scores: quality.get(entry.id) ?? [],
      })),
      now,
      {
        activityBps: settings.channelActivityBps,
        freshnessBps: settings.channelFreshnessBps,
        qualityBps: settings.channelQualityBps,
        halfLifeDays: settings.channelHalfLifeDays,
      },
    );
    ordered = [...facts].sort(
      (a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.slug.localeCompare(b.slug),
    );
  }
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(input.limit ?? DIRECTORY_PAGE_SIZE, 100);
  return {
    entries: ordered.slice(offset, offset + limit).map(({ lastUpdated: _lastUpdated, ...entry }) => entry),
    total: ordered.length,
  };
}

/** Distinct visitors per kind in the activity window; the owner was never recorded. */
async function activityOf(channelIds: string[], now: Date) {
  const result = new Map<string, { users: number; workspaces: number; anonymous: number }>();
  if (channelIds.length === 0) return result;
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const rows = await db()
    .select({
      channelId: schema.channelVisit.channelId,
      kind: schema.channelVisit.visitorKind,
      n: sql<number>`count(distinct ${schema.channelVisit.visitorKey})::int`,
    })
    .from(schema.channelVisit)
    .where(and(inArray(schema.channelVisit.channelId, channelIds), gte(schema.channelVisit.visitedOn, since)))
    .groupBy(schema.channelVisit.channelId, schema.channelVisit.visitorKind);
  for (const row of rows) {
    const entry = result.get(row.channelId) ?? { users: 0, workspaces: 0, anonymous: 0 };
    if (row.kind === 'user') entry.users = Number(row.n);
    else if (row.kind === 'workspace') entry.workspaces = Number(row.n);
    else entry.anonymous = Number(row.n);
    result.set(row.channelId, entry);
  }
  return result;
}

/** Each live asset's newest Trust and Benchmark, grouped by channel. */
async function qualityOf(channelIds: string[]) {
  const result = new Map<string, { trust: number; benchmark: number }[]>();
  if (channelIds.length === 0) return result;
  const rows = await db()
    .select({
      channelId: schema.channelAsset.channelId,
      trust: sql<number>`coalesce((select s.trust_score from ${schema.assetScore} s where s.asset_id = ${schema.asset.id} order by s.computed_at desc limit 1), 0)`,
      benchmark: sql<number>`coalesce((select s.benchmark_score from ${schema.assetScore} s where s.asset_id = ${schema.asset.id} order by s.computed_at desc limit 1), 0)`,
    })
    .from(schema.channelAsset)
    .innerJoin(schema.asset, and(eq(schema.asset.id, schema.channelAsset.assetId), LIVE))
    .where(inArray(schema.channelAsset.channelId, channelIds));
  for (const row of rows) {
    const list = result.get(row.channelId) ?? [];
    list.push({ trust: Number(row.trust), benchmark: Number(row.benchmark) });
    result.set(row.channelId, list);
  }
  return result;
}

/* ------------------------------------------------------------ channel page */

export interface ChannelView {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  visibility: ChannelVisibility;
  status: ChannelStatus;
  workspaceId: string | null;
  owner: ChannelOwner;
  profile: ChannelProfile;
  /** True when the viewer owns the channel and sees it whatever its state. */
  viewerIsOwner: boolean;
  /** Public and active: has a card, is listed, shows to strangers. */
  isPublic: boolean;
}

export interface ChannelStreamItem {
  assetId: string;
  publicId: string;
  title: string;
  /** The summary; shown for a paid asset too (proposal 6.2). */
  description: string | null;
  kind: AssetKind;
  access: AssetAccess;
  sight: AssetSight;
  pinned: boolean;
  publishedAt: string;
  lastRefreshedAt: string | null;
  versionLabel: string | null;
  /** Source address of a source-type asset; null for a paid asset seen by summary. */
  sourceLocation: string | null;
  live: boolean;
}

/**
 * A channel by slug as the viewer may see it, or null -- for a private or
 * suspended channel, null to everyone but the owner, the same as a channel
 * that does not exist (architecture.md 5.2).
 */
export async function channelBySlug(slug: string, viewerWorkspaceId: string | null): Promise<ChannelView | null> {
  const [row] = await db()
    .select({
      id: schema.channel.id,
      slug: schema.channel.slug,
      title: schema.channel.title,
      description: schema.channel.description,
      visibility: schema.channel.visibility,
      status: schema.channel.status,
      workspaceId: schema.channel.workspaceId,
      profile: schema.channel.profile,
      handle: schema.workspace.handle,
      workspaceName: schema.workspace.name,
    })
    .from(schema.channel)
    .leftJoin(schema.workspace, eq(schema.workspace.id, schema.channel.workspaceId))
    .where(eq(schema.channel.slug, slug.toLowerCase()))
    .limit(1);
  if (!row) return null;
  const isPublic = row.visibility === 'public' && row.status === 'active';
  const viewerIsOwner = viewerWorkspaceId !== null && row.workspaceId === viewerWorkspaceId;
  if (!isPublic && !viewerIsOwner) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    workspaceId: row.workspaceId,
    owner: {
      handle: row.handle ?? null,
      name: row.workspaceId ? (row.workspaceName ?? '') : 're0',
      isPlatform: row.workspaceId === null,
    },
    profile: readChannelProfile(row.profile),
    viewerIsOwner,
    isPublic,
  };
}

/**
 * The channel's asset stream: pinned first, then newest publication first
 * (proposal 6.3). A stranger sees live assets only, a paid one by summary
 * unless they subscribe; the owner sees every asset with its state.
 */
export async function channelStream(
  channel: ChannelView,
  limit = 100,
  viewer: { workspaceId: string | null } = { workspaceId: null },
): Promise<ChannelStreamItem[]> {
  const isSubscriber = !channel.viewerIsOwner && (await subscribesTo(viewer.workspaceId, channel.id));
  const rows = await db()
    .select({
      assetId: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      description: schema.asset.description,
      kind: schema.asset.kind,
      access: schema.asset.access,
      lifecycleStatus: schema.asset.lifecycleStatus,
      indexStatus: schema.asset.indexStatus,
      currentVersionId: schema.asset.currentVersionId,
      lastSuccessfulRefreshAt: schema.asset.lastSuccessfulRefreshAt,
      pinnedAt: schema.channelAsset.pinnedAt,
      publishedAt: schema.channelAsset.publishedAt,
      versionLabel: schema.assetVersion.label,
      sourceLocation: sql<string | null>`(select s.location from ${schema.source} s where s.asset_id = ${schema.asset.id} order by s.id limit 1)`,
    })
    .from(schema.channelAsset)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.channelAsset.assetId))
    .leftJoin(schema.assetVersion, eq(schema.assetVersion.id, schema.asset.currentVersionId))
    .where(
      and(
        eq(schema.channelAsset.channelId, channel.id),
        isNull(schema.asset.deletedAt),
        channel.viewerIsOwner ? undefined : LIVE,
      ),
    )
    .orderBy(
      sql`${schema.channelAsset.pinnedAt} desc nulls last`,
      desc(schema.channelAsset.publishedAt),
      asc(schema.asset.publicId),
    )
    .limit(limit);

  return rows.map((row) => {
    const sight = assetSight({
      isOwner: channel.viewerIsOwner,
      isSubscriber,
      channel: { visibility: channel.visibility, status: channel.status },
      access: row.access,
    });
    const live =
      row.lifecycleStatus === 'published' && row.indexStatus === 'ready' && row.currentVersionId !== null;
    const isUpload = row.kind === 'upload';
    return {
      assetId: row.assetId,
      publicId: row.publicId,
      title: row.title,
      description: row.description,
      kind: row.kind,
      access: row.access,
      sight,
      pinned: row.pinnedAt !== null,
      publishedAt: row.publishedAt.toISOString(),
      lastRefreshedAt: row.lastSuccessfulRefreshAt?.toISOString() ?? null,
      versionLabel: sight === 'full' ? (row.versionLabel ?? null) : null,
      /* An upload's location is an object-store prefix, not an address anyone can open. */
      sourceLocation: sight === 'full' && !isUpload ? row.sourceLocation : null,
      live,
    };
  });
}

/* --------------------------------------------------------------- user page */

export interface UserView {
  workspaceId: string;
  handle: string;
  name: string;
  channels: DirectoryEntry[];
}

/** A user's public page, or null when the handle is unknown or has no public channel (proposal 4.3). */
export async function userByHandle(handle: string): Promise<UserView | null> {
  const [workspace] = await db()
    .select({ id: schema.workspace.id, handle: schema.workspace.handle, name: schema.workspace.name })
    .from(schema.workspace)
    .where(eq(schema.workspace.handle, handle.toLowerCase()))
    .limit(1);
  if (!workspace?.handle) return null;
  const channels = await directoryFacts(eq(schema.channel.workspaceId, workspace.id));
  if (channels.length === 0) return null;
  return {
    workspaceId: workspace.id,
    handle: workspace.handle,
    name: workspace.name,
    channels: channels.map(({ lastUpdated: _lastUpdated, ...entry }) => entry),
  };
}

/** A workspace by handle whatever its channels, for the user Agent Card (which exists without them). */
export async function workspaceByHandle(handle: string): Promise<{ id: string; handle: string; name: string } | null> {
  const [workspace] = await db()
    .select({ id: schema.workspace.id, handle: schema.workspace.handle, name: schema.workspace.name })
    .from(schema.workspace)
    .where(eq(schema.workspace.handle, handle.toLowerCase()))
    .limit(1);
  return workspace?.handle ? { id: workspace.id, handle: workspace.handle, name: workspace.name } : null;
}

/* ----------------------------------------------------------------- sitemap */

/** Every public channel and the handles that own one, for the sitemap and its cards. */
export async function publicCardSubjects(): Promise<{
  channels: { slug: string; lastUpdatedAt: string | null }[];
  handles: string[];
}> {
  const facts = await directoryFacts();
  const handles = new Set<string>();
  for (const entry of facts) if (entry.owner.handle) handles.add(entry.owner.handle);
  return {
    channels: facts.map((entry) => ({ slug: entry.slug, lastUpdatedAt: entry.lastUpdatedAt })),
    handles: [...handles].sort(),
  };
}

/* --------------------------------------------------------------- dashboard */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One of the workspace's own channels, in the owner's view, or null. */
export async function ownedChannelView(workspaceId: string, channelId: string): Promise<ChannelView | null> {
  if (!UUID.test(channelId)) return null;
  const [row] = await db()
    .select({ slug: schema.channel.slug })
    .from(schema.channel)
    .where(and(eq(schema.channel.id, channelId), eq(schema.channel.workspaceId, workspaceId)))
    .limit(1);
  return row ? channelBySlug(row.slug, workspaceId) : null;
}
