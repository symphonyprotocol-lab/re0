/**
 * Putting a test asset where strangers can see it.
 *
 * Since P1 an asset has no visibility of its own: it is everyone's when it
 * sits free in a public, active channel and its owner's alone otherwise
 * (agent-first-proposal.md 6.2). Fixtures that used to write
 * `visibility: 'public'` call this instead. A platform asset goes into the
 * platform's own channel (migration 0062); a workspace's into a public
 * channel of that workspace, made on first use.
 */
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import { PLATFORM_CHANNEL_ID } from '@/lib/domain/channel';
import { db, schema } from '@/lib/infrastructure/postgres/client';

/** Shares one asset with everyone; returns the channel it went into. */
export async function shareInPublicChannel(assetId: string): Promise<string> {
  const database = db();
  const [asset] = await database
    .select({ owner: schema.library.ownerWorkspaceId, platform: schema.library.isPlatformLibrary })
    .from(schema.library)
    .where(eq(schema.library.id, assetId))
    .limit(1);
  if (!asset) throw new Error(`no asset ${assetId}`);
  const channelId = asset.platform || !asset.owner ? PLATFORM_CHANNEL_ID : await publicChannelOf(asset.owner);
  await database
    .insert(schema.channelAsset)
    .values({ assetId, channelId })
    .onConflictDoUpdate({ target: schema.channelAsset.assetId, set: { channelId } });
  return channelId;
}

/** The workspace's fixture public channel, created on first use. */
export async function publicChannelOf(workspaceId: string): Promise<string> {
  const database = db();
  const slug = `fixture-${workspaceId.replace(/-/g, '').slice(-12)}`;
  const [existing] = await database
    .select({ id: schema.channel.id })
    .from(schema.channel)
    .where(and(eq(schema.channel.slug, slug), eq(schema.channel.workspaceId, workspaceId)))
    .limit(1);
  if (existing) return existing.id;
  const id = uuidv7();
  await database.insert(schema.channel).values({ id, slug, workspaceId, title: 'Fixture channel' });
  return id;
}

/** Takes an asset out of any channel, as `moveAsset(..., null)` would. */
export async function unshare(assetId: string): Promise<void> {
  await db().delete(schema.channelAsset).where(eq(schema.channelAsset.assetId, assetId));
  await db().update(schema.library).set({ access: 'free' }).where(eq(schema.library.id, assetId));
}

/** Whether no row says the asset is in a channel. */
export async function inNoChannel(assetId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: schema.channelAsset.assetId })
    .from(schema.channelAsset)
    .where(eq(schema.channelAsset.assetId, assetId));
  return rows.length === 0;
}

