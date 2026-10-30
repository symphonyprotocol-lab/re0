/**
 * Which channel each asset is in, for screens that show it. The rules about
 * who may see what are in visibility.ts; this only reads the facts.
 */
import { eq, inArray } from 'drizzle-orm';
import type { ChannelStatus, ChannelVisibility } from '@/lib/domain/channel';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface ChannelRef {
  id: string;
  slug: string;
  title: string;
  visibility: ChannelVisibility;
  status: ChannelStatus;
}

type Reader = Pick<ReturnType<typeof db>, 'select'>;

/** Asset id to its channel; an asset in none is simply absent. */
export async function channelsOfAssets(
  assetIds: readonly string[],
  reader: Reader = db(),
): Promise<Map<string, ChannelRef>> {
  const found = new Map<string, ChannelRef>();
  if (assetIds.length === 0) return found;
  const rows = await reader
    .select({
      assetId: schema.channelAsset.assetId,
      id: schema.channel.id,
      slug: schema.channel.slug,
      title: schema.channel.title,
      visibility: schema.channel.visibility,
      status: schema.channel.status,
    })
    .from(schema.channelAsset)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
    .where(inArray(schema.channelAsset.assetId, [...assetIds]));
  for (const { assetId, ...channel } of rows) found.set(assetId, channel);
  return found;
}

/** Whether a channel ref shows its assets to the public (proposal 6.2). */
export function isPublicChannel(channel: ChannelRef | null | undefined): boolean {
  return channel?.visibility === 'public' && channel.status === 'active';
}
