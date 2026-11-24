/**
 * Channels (lib/services/channels.ts): a public post's `#tags` make their
 * channels in the post's own transaction, by whoever posts first; a channel
 * lists only visible posts, so review, takedown and the trash take a post
 * out at once; private posts never join one, and 转为公开 files the copy.
 */
import { describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { NextRequest } from 'next/server';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const { createSession } = await import('@/lib/services/auth');
const posts = await import('@/lib/services/posts');
const channels = await import('@/lib/services/channels');
const privatePosts = await import('@/lib/services/private-posts');
const { addGrant } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { GET: listChannelsRoute } = await import('@/app/api/channels/route');

async function user(prefix: string) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: 1_000, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

/**
 * A tag no other test uses, short enough for a channel name. Letters only:
 * publishing redacts the text before reading its tags, and a random digit
 * run (`…1036928`, 7 or more digits) or a `wx`/`qq` hint followed by digits
 * reads as a phone or WeChat number, so it would be cut out of the tag.
 */
function tag(prefix: string): string {
  const letters = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => String.fromCharCode(97 + (byte % 26)));
  return `${prefix}${letters.join('')}`;
}

async function publish(userId: string, question: string, detail = '') {
  const made = await posts.publishPost(userId, { question, detail, lang: 'en' });
  if (!made.ok) throw new Error(`not published: ${made.error}`);
  return made.id;
}

/** What review does when it passes a post, without asking a model. */
async function approve(id: string) {
  await db().update(schema.post).set({ status: 'published', publishedAt: new Date() }).where(eq(schema.post.id, id));
}

async function channelRows(names: string[]) {
  return db().select().from(schema.channel).where(inArray(schema.channel.name, names));
}

describeWithDb('channels', () => {
  it('makes channels from a public post’s tags, lists them once the post is visible, and drops it when trashed', async () => {
    const author = await user('ch-author');
    const travel = tag('travel');
    const food = tag('食');
    const id = await publish(author, `Where to go in Japan? #${travel.toUpperCase()}`, `Also #${food} and https://example.com/#anchor`);

    /* Made at once, by the author, in lower case; the URL's anchor is no tag. */
    const made = await channelRows([travel, food, 'anchor']);
    expect(made.map((row) => row.name).sort()).toEqual([travel, food].sort());
    expect(made.every((row) => row.createdBy === author)).toBe(true);
    const links = await db().select().from(schema.postChannel).where(eq(schema.postChannel.postId, id));
    expect(links).toHaveLength(2);

    /* Pending: the channel exists, but lists nothing yet. */
    expect((await channels.getChannel(travel))?.posts).toBe(0);
    expect((await channels.listChannels({ q: travel })).items).toEqual([]);
    expect((await posts.listFeed('latest', { channel: travel })).items).toEqual([]);

    await approve(id);
    expect((await channels.getChannel(travel.toUpperCase()))?.posts).toBe(1);
    const listed = await channels.listChannels({ q: `#${travel}` });
    expect(listed.items).toEqual([{ name: travel, posts: 1, lastPostAt: expect.any(String) }]);
    const feed = await posts.listFeed('for_you', { channel: travel });
    expect(feed.items.map((item) => item.id)).toEqual([id]);
    expect(feed.items[0]!.channels.sort()).toEqual([travel, food].sort());
    expect((await posts.getPost(id))?.channels.sort()).toEqual([travel, food].sort());

    /* The trash, a takedown: out of the channel at once. */
    expect(await posts.setPostTrashed(author, id, true)).toBe(true);
    expect((await channels.getChannel(travel))?.posts).toBe(0);
    expect((await posts.listFeed('latest', { channel: travel })).items).toEqual([]);
    expect(await posts.setPostTrashed(author, id, false)).toBe(true);
    await db().update(schema.post).set({ status: 'hidden', hiddenBy: 'admin' }).where(eq(schema.post.id, id));
    expect((await channels.listChannels({ q: travel })).items).toEqual([]);
    expect((await channels.indexableChannels()).some((row) => row.name === travel)).toBe(false);
  });

  it('puts two posts with the same new tag in one channel, made by whoever posted first', async () => {
    const [a, b] = await Promise.all([user('ch-a'), user('ch-b')]);
    const shared = tag('shared');
    const [first, second] = await Promise.all([publish(a, `First #${shared}`), publish(b, `Second #${shared}`)]);
    const rows = await channelRows([shared]);
    expect(rows).toHaveLength(1);
    expect([a, b]).toContain(rows[0]!.createdBy);
    await Promise.all([approve(first), approve(second)]);
    expect((await channels.getChannel(shared))?.posts).toBe(2);
    const feed = await posts.listFeed('latest', { channel: shared, size: 1 });
    expect(feed.items).toHaveLength(1);
    expect(feed.next).not.toBeNull();
    const rest = await posts.listFeed('latest', { channel: shared, cursor: feed.next, size: 1 });
    expect([...feed.items, ...rest.items].map((item) => item.id).sort()).toEqual([first, second].sort());
    expect((await channels.indexableChannels()).some((row) => row.name === shared)).toBe(true);
  });

  it('ranks busier channels first and pages the list', async () => {
    const author = await user('ch-rank');
    const prefix = tag('rk');
    const busy = `${prefix}busy`;
    const quiet = `${prefix}quiet`;
    for (const question of [`One #${busy}`, `Two #${busy} #${quiet}`, `Three #${busy}`]) await approve(await publish(author, question));
    const first = await channels.listChannels({ q: prefix, size: 1 });
    expect(first.items.map((item) => [item.name, item.posts])).toEqual([[busy, 3]]);
    const second = await channels.listChannels({ q: prefix, size: 1, cursor: first.next });
    expect(second.items.map((item) => [item.name, item.posts])).toEqual([[quiet, 1]]);
    expect(second.next).toBeNull();
    /* An exact name first while searching. */
    expect((await channels.listChannels({ q: quiet })).items[0]!.name).toBe(quiet);

    const response = await listChannelsRoute(new NextRequest(`http://localhost/api/channels?q=${encodeURIComponent(prefix)}`));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: { name: string }[] }).items.map((item) => item.name)).toEqual([busy, quiet]);
  });

  it('keeps private posts out of channels; 转为公开 files the public copy', async () => {
    const author = await user('ch-private');
    const secret = tag('secret');
    const made = await privatePosts.publishPrivatePost(author, { question: `Just for me #${secret}`, reeIds: [], aiOnly: true, fees: {}, lang: 'en' });
    if (!made.ok) throw new Error(`not published: ${made.error}`);
    expect(await channelRows([secret])).toEqual([]);
    expect((await posts.getPost(made.id, author))?.channels).toEqual([]);

    const copy = await privatePosts.convertToPublic(author, made.id);
    if (!copy.ok) throw new Error('not converted');
    expect((await channelRows([secret]))[0]?.createdBy).toBe(author);
    await approve(copy.id);
    expect((await posts.listFeed('latest', { channel: secret })).items.map((item) => item.id)).toEqual([copy.id]);
  });

  it('reads the tags after redaction, so a phone number never names a channel', async () => {
    const author = await user('ch-redact');
    const name = tag('call');
    const id = await publish(author, `Who can help? #${name}13812345678`);
    expect(await channelRows([`${name}13812345678`])).toEqual([]);
    expect((await posts.getPost(id, author))?.channels).toEqual([name]);
  });

  it('answers nothing for a channel nobody used, and never makes one for an invalid name', async () => {
    expect(await channels.getChannel(tag('never'))).toBeNull();
    expect(await channels.getChannel('not a name')).toBeNull();
    expect(await channels.getChannel('')).toBeNull();
    expect(await posts.listFeed('latest', { channel: tag('never') })).toEqual({ items: [], next: null });
  });
});
