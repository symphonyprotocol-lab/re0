/**
 * An article, episode or Q&A as a reader sees it on the web
 * (agent-first-proposal.md 6.2, 6.3, 6.5-6.7).
 *
 * The sight is the one rule (`assetSight`): its owner and, in a public
 * channel, everyone for a free asset or a current subscriber for a paid one,
 * read it in full; anyone else sees a paid asset's title, summary and date
 * only -- the body, the images and the audio are never in the response, not
 * merely hidden by the page. An asset in no channel or a private one is not
 * there at all for anyone but its owner, the same as one that does not exist.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { assetSight, type AssetSight } from '@/lib/domain/channel';
import { isEditorialKind, type EditorialKind } from '@/lib/domain/editorial';
import type { AssetAccess } from '@/lib/domain/asset-kind';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { subscribesTo } from '@/lib/application/channels/subscriptions';
import { qaAsker } from '@/lib/application/questions';

export interface EditorialReading {
  id: string;
  publicId: string;
  kind: EditorialKind;
  title: string;
  summary: string | null;
  access: AssetAccess;
  sight: Exclude<AssetSight, 'none'>;
  viewerIsOwner: boolean;
  channel: { id: string; slug: string; title: string; subscriptionsEnabled: boolean } | null;
  ownerHandle: string | null;
  publishedAt: Date | null;
  versionLabel: string | null;
  live: boolean;
  /** Only for a full sight: the published text as written, with `media:` image references. */
  body: string | null;
  /** Only for a full sight: the episode's (or the Q&A's attached) audio, served through `/media/{id}`. */
  audioMediaId: string | null;
  qa: { question: string; askerName: string | null } | null;
}

export async function editorialReading(publicId: string, viewer: { workspaceId: string | null }): Promise<EditorialReading | null> {
  const [row] = await db()
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      kind: schema.asset.kind,
      title: schema.asset.title,
      description: schema.asset.description,
      access: schema.asset.access,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      lifecycleStatus: schema.asset.lifecycleStatus,
      indexStatus: schema.asset.indexStatus,
      currentVersionId: schema.asset.currentVersionId,
      versionLabel: schema.assetVersion.label,
      versionPublishedAt: schema.assetVersion.publishedAt,
      config: schema.source.config,
      channelId: schema.channel.id,
      channelSlug: schema.channel.slug,
      channelTitle: schema.channel.title,
      channelVisibility: schema.channel.visibility,
      channelStatus: schema.channel.status,
      subscriptionsEnabledAt: schema.channel.subscriptionsEnabledAt,
      channelPublishedAt: schema.channelAsset.publishedAt,
      handle: schema.workspace.handle,
    })
    .from(schema.asset)
    .innerJoin(schema.source, eq(schema.source.assetId, schema.asset.id))
    .leftJoin(schema.assetVersion, eq(schema.assetVersion.id, schema.asset.currentVersionId))
    .leftJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.asset.id))
    .leftJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
    .leftJoin(schema.workspace, eq(schema.workspace.id, schema.asset.ownerWorkspaceId))
    .where(and(eq(schema.asset.publicId, publicId), isNull(schema.asset.deletedAt)))
    .limit(1);
  if (!row || !isEditorialKind(row.kind)) return null;

  const viewerIsOwner = viewer.workspaceId !== null && row.ownerWorkspaceId === viewer.workspaceId;
  const live = row.lifecycleStatus === 'published' && row.indexStatus === 'ready' && row.currentVersionId !== null;
  /* Not live yet is its owner's preview only, like a channel stream item. */
  if (!live && !viewerIsOwner) return null;
  const channel =
    row.channelId && row.channelVisibility && row.channelStatus
      ? { visibility: row.channelVisibility, status: row.channelStatus }
      : null;
  const isSubscriber =
    !viewerIsOwner && row.access === 'paid' && row.channelId ? await subscribesTo(viewer.workspaceId, row.channelId) : false;
  const sight = assetSight({ isOwner: viewerIsOwner, isSubscriber, channel, access: row.access });
  if (sight === 'none') return null;

  const config = row.config as Record<string, unknown>;
  const full = sight === 'full';
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const body = full ? (row.kind === 'qa' ? text(config.answer) : text(config.body)) : null;
  const asker = row.kind === 'qa' ? await qaAsker(row.id) : null;
  return {
    id: row.id,
    publicId: row.publicId,
    kind: row.kind,
    title: row.title,
    summary: row.description,
    access: row.access,
    sight,
    viewerIsOwner,
    channel: row.channelId
      ? { id: row.channelId, slug: row.channelSlug!, title: row.channelTitle!, subscriptionsEnabled: row.subscriptionsEnabledAt !== null }
      : null,
    ownerHandle: row.handle,
    publishedAt: row.channelPublishedAt ?? row.versionPublishedAt ?? null,
    versionLabel: full ? (row.versionLabel ?? null) : null,
    live,
    body,
    audioMediaId: full ? text(config.audioMediaId) : null,
    qa: asker ? { question: asker.question, askerName: asker.askerName } : row.kind === 'qa' ? { question: row.title, askerName: null } : null,
  };
}
