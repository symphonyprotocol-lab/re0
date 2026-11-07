/**
 * Sharing a Ree (`/s/[slug]`): only a public Ree has a share page; a visit
 * is recorded once per visitor every 30 minutes and never for the owner; a
 * conversion needs the visitor's own conversation holding the Ree and
 * counts once; the statistics read both for a period.
 */
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const conversations = await import('@/lib/services/conversations');
const share = await import('@/lib/services/share');
const { reeStatistics, statisticsQuery } = await import('@/lib/services/statistics');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');

async function person() {
  const subject = uniqueName('s');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function reeOf(ownerId: string, isPublic = true) {
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Share').slice(0, 40), description: 'A companion for sharing.', category: 'business', isPublic, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
  return row!;
}

describeWithDb('share page', () => {
  it('records visits for public Rees only, once per visitor in 30 minutes, never for the owner', async () => {
    const owner = await person();
    const visitor = await person();
    const ree = await reeOf(owner);
    const hidden = await reeOf(owner, false);
    const browser = randomUUID();
    const now = new Date();

    expect(await share.recordShareVisit({ slug: hidden.slug, visitorId: browser, userId: null, ip: null }, now)).toBe('not_found');
    expect(await share.recordShareVisit({ slug: 'no-such-ree-here', visitorId: browser, userId: null, ip: null }, now)).toBe('not_found');
    expect(await share.recordShareVisit({ slug: ree.slug, visitorId: browser, userId: null, ip: '203.0.113.7' }, now)).toBe('recorded');
    expect(await share.recordShareVisit({ slug: ree.slug, visitorId: browser, userId: null, ip: '203.0.113.7' }, new Date(now.getTime() + 5 * 60_000))).toBe('repeat');
    expect(await share.recordShareVisit({ slug: ree.slug, visitorId: browser, userId: visitor, ip: null }, new Date(now.getTime() + 31 * 60_000))).toBe('recorded');
    expect(await share.recordShareVisit({ slug: ree.slug, visitorId: randomUUID(), userId: owner, ip: null }, now)).toBe('owner');
    expect(await share.recordShareVisit({ slug: ree.slug.toUpperCase(), visitorId: randomUUID(), userId: null, ip: null }, now)).toBe('recorded');

    const stats = await share.shareStatistics(ree.id, null);
    expect(stats).toEqual({ visits: 3, visitors: 2, conversations: 0, rate: 0 });

    // A Ree taken down (which also turns it private) has no share page any more.
    await db().update(schema.ree).set({ isPublic: false, moderatedAt: new Date() }).where(eq(schema.ree.id, ree.id));
    expect(await share.recordShareVisit({ slug: ree.slug, visitorId: randomUUID(), userId: null, ip: null })).toBe('not_found');
  });

  it('counts a conversion only for the visitor’s own conversation holding the Ree, once', async () => {
    const owner = await person();
    const visitor = await person();
    const stranger = await person();
    const ree = await reeOf(owner);
    const other = await reeOf(owner);
    const browser = randomUUID();
    await share.recordShareVisit({ slug: ree.slug, visitorId: browser, userId: visitor, ip: null });

    const withRee = await conversations.createConversation(visitor, { reeIds: [ree.id] });
    const withoutRee = await conversations.createConversation(visitor, { reeIds: [other.id] });
    const strangers = await conversations.createConversation(stranger, { reeIds: [ree.id] });
    const owners = await conversations.createConversation(owner, { reeIds: [ree.id] });

    expect(await share.recordShareConversion({ slug: ree.slug, visitorId: browser, userId: visitor, conversationId: withoutRee.id })).toBe('not_found');
    expect(await share.recordShareConversion({ slug: ree.slug, visitorId: browser, userId: visitor, conversationId: strangers.id })).toBe('not_found');
    expect(await share.recordShareConversion({ slug: ree.slug, visitorId: browser, userId: visitor, conversationId: 'not-a-uuid' })).toBe('not_found');
    expect(await share.recordShareConversion({ slug: ree.slug, visitorId: browser, userId: owner, conversationId: owners.id })).toBe('owner');
    expect(await share.recordShareConversion({ slug: ree.slug, visitorId: browser, userId: visitor, conversationId: withRee.id })).toBe('recorded');
    expect(await share.recordShareConversion({ slug: ree.slug, visitorId: browser, userId: visitor, conversationId: withRee.id })).toBe('repeat');

    // Joining an existing conversation from the share page counts too.
    await conversations.addParticipant(visitor, withoutRee.id, ree.id);
    expect(await share.recordShareConversion({ slug: ree.slug, visitorId: browser, userId: visitor, conversationId: withoutRee.id })).toBe('recorded');

    expect(await share.shareStatistics(ree.id, null)).toEqual({ visits: 1, visitors: 1, conversations: 2, rate: 100 });
    expect(await share.shareStatistics(other.id, null)).toEqual({ visits: 0, visitors: 0, conversations: 0, rate: null });

    // The Ree's statistics page carries the same figures, scoped to its period.
    const all = await reeStatistics(ree.id, statisticsQuery({ period: 'all' }), { withIncome: true });
    expect(all.share).toMatchObject({ visits: 1, conversations: 2 });
    const today = await reeStatistics(ree.id, statisticsQuery({ period: 'day' }), { withIncome: true });
    expect(today.share).toMatchObject({ visits: 1, conversations: 2 });
  });
});
