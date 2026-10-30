/**
 * Telling subscribers about a new post or episode (agent-first-proposal.md
 * 6.5): in-app, once, when the asset's first version goes live in a public
 * channel. An edit of a published post is a new version but not news.
 */
import { and, eq } from 'drizzle-orm';
import { isEditorialKind } from '@/lib/domain/editorial';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { activeSubscriberUsers } from '@/lib/application/channels/subscriptions';
import { notify } from '@/lib/application/notifications';

export async function notifyFirstPublication(assetId: string): Promise<number> {
  const [row] = await db()
    .select({
      kind: schema.library.kind,
      title: schema.library.title,
      publicId: schema.library.publicId,
      channelId: schema.channel.id,
      channelTitle: schema.channel.title,
    })
    .from(schema.library)
    .innerJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.library.id))
    .innerJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
    .where(and(eq(schema.library.id, assetId), eq(schema.channel.visibility, 'public'), eq(schema.channel.status, 'active')));
  if (!row || !isEditorialKind(row.kind) || row.kind === 'qa') return 0;
  const users = await activeSubscriberUsers(row.channelId);
  await notify(users, 'new_post', { assetId, publicId: row.publicId, title: row.title, kind: row.kind, channelTitle: row.channelTitle });
  return users.length;
}
