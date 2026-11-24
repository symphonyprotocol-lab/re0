import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { channelNameOf, extractHashtags } from '@/lib/domain/hashtags';
import { likePattern } from '@/lib/domain/list';
import { db, schema, type Executor } from '@/lib/infra/db';
import { visiblePost } from '@/lib/services/posts';

const { channel, postChannel, post } = schema;

/** The Channel tab's page size. */
export const CHANNEL_PAGE_SIZE = 30;

/** One channel as the Channel tab lists it: its visible posts and when the newest was published. */
export interface ChannelSummary {
  name: string;
  posts: number;
  lastPostAt: string | null;
}

export interface ChannelPage {
  items: ChannelSummary[];
  /** An offset, as 为你推荐's: the ranking moves as posts come and go. */
  next: string | null;
}

/**
 * Files a public post under the channels its question and detail tag
 * (lib/domain/hashtags.ts), in the transaction that writes the post: a
 * channel nobody used yet is made there, by this author. Two posts making
 * the same channel at once both end up in the one row (`on conflict`).
 */
export async function fileUnderChannels(tx: Executor, postId: string, createdBy: string | null, ...texts: (string | null | undefined)[]): Promise<string[]> {
  const names = extractHashtags(...texts);
  if (names.length === 0) return names;
  await tx
    .insert(channel)
    .values(names.map((name) => ({ name, createdBy })))
    .onConflictDoNothing({ target: channel.name });
  const rows = await tx.select({ id: channel.id }).from(channel).where(inArray(channel.name, names));
  await tx
    .insert(postChannel)
    .values(rows.map((row) => ({ postId, channelId: row.id })))
    .onConflictDoNothing();
  return names;
}

/** A visible post in the channel: what every count and list here is about. */
function inChannel(): SQL {
  return and(eq(postChannel.channelId, channel.id), visiblePost())!;
}

/** What the Channel tab's search looks for: a name, with or without its `#`, folded as names are. */
function searchOf(q: string | null | undefined): string | null {
  const folded = (q ?? '').normalize('NFKC').toLowerCase().replace(/^[#＃]+/u, '').trim().slice(0, 64);
  return folded || null;
}

/**
 * The Channel tab: channels with at least one visible post, the busiest
 * first (visible posts, then the newest post), searched by name (`q`).
 * Counted as it is read, so a post taken down, rejected or trashed is out
 * of its channels at once.
 */
export async function listChannels(options: { q?: string | null; cursor?: string | null; size?: number } = {}): Promise<ChannelPage> {
  const size = options.size ?? CHANNEL_PAGE_SIZE;
  const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
  const q = searchOf(options.q);
  const search = q ? sql`${channel.name} ilike ${likePattern(q)}` : undefined;
  const posts = sql<number>`count(*)::int`;
  const last = sql<Date | string | null>`max(${post.publishedAt})`;
  const rows = await db()
    .select({ name: channel.name, posts, last })
    .from(channel)
    .innerJoin(postChannel, eq(postChannel.channelId, channel.id))
    .innerJoin(post, eq(post.id, postChannel.postId))
    .where(and(inChannel(), search))
    .groupBy(channel.id)
    /* An exact match first while searching: `#travel` finds travel before travel-tips. */
    .orderBy(...(q ? [desc(sql`${channel.name} = ${q}`)] : []), desc(posts), sql`${last} desc nulls last`, asc(channel.name))
    .limit(size + 1)
    .offset(offset);
  return {
    items: rows.slice(0, size).map((row) => ({ name: row.name, posts: row.posts, lastPostAt: row.last ? new Date(row.last).toISOString() : null })),
    next: rows.length > size ? String(offset + size) : null,
  };
}

/** A channel by its name as written in a URL (folded as names are), with its visible posts; null when nobody ever used the tag. */
export async function getChannel(name: string): Promise<{ id: string; name: string; posts: number; createdAt: string } | null> {
  const folded = channelNameOf(name);
  if (!folded) return null;
  const [row] = await db()
    .select({
      id: channel.id,
      name: channel.name,
      createdAt: channel.createdAt,
      posts: sql<number>`(select count(*)::int from ${postChannel} join ${post} on ${post.id} = ${postChannel.postId} where ${inChannel()})`,
    })
    .from(channel)
    .where(eq(channel.name, folded))
    .limit(1);
  return row ? { id: row.id, name: row.name, posts: row.posts, createdAt: row.createdAt.toISOString() } : null;
}

/** The channel id a feed is narrowed to, or null when there is no such channel. */
export async function channelIdOf(name: string): Promise<string | null> {
  const folded = channelNameOf(name);
  if (!folded) return null;
  const [row] = await db().select({ id: channel.id }).from(channel).where(eq(channel.name, folded)).limit(1);
  return row?.id ?? null;
}

/** The channels each of these posts is filed under, in name order: what their text links. */
export async function channelsFor(postIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (postIds.length === 0) return out;
  const rows = await db()
    .select({ postId: postChannel.postId, name: channel.name })
    .from(postChannel)
    .innerJoin(channel, eq(channel.id, postChannel.channelId))
    .where(inArray(postChannel.postId, postIds))
    .orderBy(asc(channel.name));
  for (const row of rows) out.set(row.postId, [...(out.get(row.postId) ?? []), row.name]);
  return out;
}

/** Channels for the sitemap: only those with a visible post, with their newest post's time. */
export async function indexableChannels(limit = 5000): Promise<{ name: string; at: Date }[]> {
  const last = sql<Date | string>`max(${post.publishedAt})`;
  const rows = await db()
    .select({ name: channel.name, at: last })
    .from(channel)
    .innerJoin(postChannel, eq(postChannel.channelId, channel.id))
    .innerJoin(post, eq(post.id, postChannel.postId))
    .where(inChannel())
    .groupBy(channel.id)
    .orderBy(desc(sql`count(*)`), asc(channel.name))
    .limit(limit);
  return rows.map((row) => ({ name: row.name, at: new Date(row.at) }));
}
