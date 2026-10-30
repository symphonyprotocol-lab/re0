/**
 * The two read tools (agent-first-proposal.md 5.1): `list_assets` and
 * `subscription_summary`. No side effect, no confirmation, no Call.
 *
 * Both read the workspace's own rows through the same use cases the
 * Dashboard pages use, and what they return is facts the server shows as a
 * listing card -- the model gets the same facts to plan with and never
 * writes the listing itself (proposal 5.3).
 */
import type { AssetKind } from '@/lib/domain/asset-kind';
import { listWorkspaceChannels } from '@/lib/application/channels';
import { listWorkspaceAssets } from '@/lib/application/assets';
import { workspaceStorage } from '@/lib/application/plans';

export interface AssetListing {
  assets: {
    id: string;
    publicId: string;
    title: string;
    kind: AssetKind;
    access: string;
    channel: { slug: string; title: string; visibility: string } | null;
    status: string;
    building: boolean;
    version: string | null;
    updatedAt: string | null;
  }[];
  total: number;
}

export const LIST_ASSETS_MAX = 50;

export async function listAssets(
  workspaceId: string,
  filter: { kind?: unknown; unfiled?: unknown; query?: unknown } = {},
): Promise<AssetListing> {
  const rows = await listWorkspaceAssets(workspaceId);
  const query = typeof filter.query === 'string' ? filter.query.trim().toLowerCase() : '';
  const matched = rows.filter(
    (row) =>
      (typeof filter.kind !== 'string' || filter.kind === '' || row.kind === filter.kind) &&
      (filter.unfiled !== true || row.channel === null) &&
      (!query || row.title.toLowerCase().includes(query) || row.publicId.includes(query)),
  );
  return {
    total: matched.length,
    assets: matched.slice(0, LIST_ASSETS_MAX).map((row) => ({
      id: row.id,
      publicId: row.publicId,
      title: row.title,
      kind: row.kind,
      access: row.access,
      channel: row.channel ? { slug: row.channel.slug, title: row.channel.title, visibility: row.channel.visibility } : null,
      status: row.lifecycleStatus === 'published' ? row.indexStatus : row.lifecycleStatus,
      building: row.building,
      version: row.versionLabel,
      updatedAt: row.updatedAt,
    })),
  };
}

export interface SubscriptionSummary {
  channels: { slug: string; title: string; visibility: string; status: string; assets: number }[];
  /** Channel subscriptions arrive with P3a; until then no channel sells one. */
  subscriptionsOffered: false;
  subscribers: 0;
  storage: { usedBytes: number; capacityBytes: number; tier: string };
}

export async function subscriptionSummary(workspaceId: string): Promise<SubscriptionSummary> {
  const [channels, storage] = await Promise.all([listWorkspaceChannels(workspaceId), workspaceStorage(workspaceId)]);
  return {
    channels: channels.map((channel) => ({
      slug: channel.slug,
      title: channel.title,
      visibility: channel.visibility,
      status: channel.status,
      assets: channel.assetCount,
    })),
    subscriptionsOffered: false,
    subscribers: 0,
    storage: { usedBytes: storage.usedBytes, capacityBytes: storage.capacityBytes, tier: storage.tier },
  };
}
