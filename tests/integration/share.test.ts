/**
 * Sharing a Ree (`/s/[slug]`): only a public Ree has a share page; a visit
 * counts once per visitor every half hour -- concurrent beacons included --
 * never for the owner, and not before the browser holds the visitor
 * cookie; an IP is limited per Ree; a conversion needs the visitor's own
 * conversation that just took the Ree in, from a browser that visited, and
 * counts once; the statistics read both for a period.
 */
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const conversations = await import('@/lib/services/conversations');
const share = await import('@/lib/services/share');
const { reeStatistics, statisticsQuery } = await import('@/lib/services/statistics');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');

const SLOT = share.SHARE_VISIT_SLOT_SECONDS * 1_000;
/** A moment a minute into a half-hour slot, so "five minutes later" stays in it. */
const slotStart = () => new Date(Math.floor(Date.now() / SLOT) * SLOT + 60_000);

async function person() {
  const subject = uniqueName('s');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function reeOf(ownerId: string, isPublic = true) {
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Share').slice(0, 40), description: 'A companion for sharing.', category: 'business', isPublic, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  // A share page needs a published Ree; publication is its own step.
  if (isPublic) await rees.setReePublished(ownerId, ree.id, true);
  const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
  return row!;
}

const visit = (slug: string, visitorId: string, options: { userId?: string | null; ip?: string | null; fresh?: boolean } = {}, at?: Date) =>
  share.recordShareVisit({ slug, visitorId, freshVisitor: options.fresh ?? false, userId: options.userId ?? null, ip: options.ip ?? null }, at);

describeWithDb('share page', () => {
  it('records visits for public Rees only, once per visitor every half hour, never for the owner', async () => {
    const owner = await person();
    const visitor = await person();
    const ree = await reeOf(owner);
    const hidden = await reeOf(owner, false);
    const browser = randomUUID();
    const now = slotStart();

    expect(await visit(hidden.slug, browser, {}, now)).toBe('not_found');
    expect(await visit('no-such-ree-here', browser, {}, now)).toBe('not_found');
    // No cookie yet: the cookie is set, nothing is counted until it comes back.
    expect(await visit(ree.slug, browser, { fresh: true }, now)).toBe('cookie');
    expect(await visit(ree.slug, browser, {}, now)).toBe('recorded');
    expect(await visit(ree.slug, browser, {}, new Date(now.getTime() + 5 * 60_000))).toBe('repeat');
    expect(await visit(ree.slug, browser, { userId: visitor }, new Date(now.getTime() + SLOT))).toBe('recorded');
    expect(await visit(ree.slug, randomUUID(), { userId: owner }, now)).toBe('owner');
    expect(await visit(ree.slug.toUpperCase(), randomUUID(), {}, now)).toBe('recorded');

    expect(await share.shareStatistics(ree.id, null)).toEqual({ shareable: true, visits: 3, visitors: 2, conversations: 0, converted: 0, rate: 0 });
    expect((await share.shareStatistics(hidden.id, null)).shareable).toBe(false);

    // A Ree taken down (which also turns it private) has no share page any more.
    await db().update(schema.ree).set({ isPublic: false, isPublished: false, moderatedAt: new Date() }).where(eq(schema.ree.id, ree.id));
    expect(await visit(ree.slug, randomUUID())).toBe('not_found');
    expect((await share.shareStatistics(ree.id, null)).shareable).toBe(false);
  });

  it('counts concurrent beacons of one visitor once', async () => {
    const ree = await reeOf(await person());
    const browser = randomUUID();
    const now = slotStart();
    const results = await Promise.all(Array.from({ length: 5 }, () => visit(ree.slug, browser, {}, now)));
    expect(results.filter((result) => result === 'recorded')).toHaveLength(1);
    expect(results.filter((result) => result === 'repeat')).toHaveLength(4);
    expect((await share.shareStatistics(ree.id, null)).visits).toBe(1);
  });

  it('limits new visits from one IP per Ree', async () => {
    const ree = await reeOf(await person());
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
    const now = slotStart();
    for (let index = 0; index < share.SHARE_IP_PER_REE_HOUR; index += 1) expect(await visit(ree.slug, randomUUID(), { ip }, now)).toBe('recorded');
    expect(await visit(ree.slug, randomUUID(), { ip }, now)).toBe('limited');
    expect((await share.shareStatistics(ree.id, null)).visits).toBe(share.SHARE_IP_PER_REE_HOUR);
  });

  it('counts a conversion only for a visitor’s own conversation that just took the Ree in, once', async () => {
    const owner = await person();
    const visitor = await person();
    const stranger = await person();
    const ree = await reeOf(owner);
    const other = await reeOf(owner);
    const browser = randomUUID();
    const convert = (userId: string, conversationId: string, visitorId = browser, at?: Date) => share.recordShareConversion({ slug: ree.slug, visitorId, userId, conversationId }, at);

    const old = await conversations.createConversation(visitor, { reeIds: [ree.id] });
    await db()
      .update(schema.conversationRee)
      .set({ addedAt: new Date(Date.now() - 2 * 60 * 60_000) })
      .where(and(eq(schema.conversationRee.conversationId, old.id), eq(schema.conversationRee.reeId, ree.id)));
    const withRee = await conversations.createConversation(visitor, { reeIds: [ree.id] });

    // Without a visit from this browser, nothing is attributed.
    expect(await convert(visitor, withRee.id)).toBe('unattributed');
    expect(await visit(ree.slug, browser, { userId: visitor })).toBe('recorded');

    const withoutRee = await conversations.createConversation(visitor, { reeIds: [other.id] });
    const strangers = await conversations.createConversation(stranger, { reeIds: [ree.id] });
    const owners = await conversations.createConversation(owner, { reeIds: [ree.id] });

    expect(await convert(visitor, withoutRee.id)).toBe('not_found');
    expect(await convert(visitor, strangers.id)).toBe('not_found');
    expect(await convert(visitor, 'not-a-uuid')).toBe('not_found');
    expect(await convert(owner, owners.id)).toBe('owner');
    // An old conversation cannot be claimed.
    expect(await convert(visitor, old.id)).toBe('unattributed');
    // Another browser, which never opened the share page, cannot claim either.
    expect(await convert(visitor, withRee.id, randomUUID())).toBe('unattributed');
    expect(await convert(visitor, withRee.id)).toBe('recorded');
    expect(await convert(visitor, withRee.id)).toBe('repeat');

    // Joining an existing conversation from the share page counts too.
    await conversations.addParticipant(visitor, withoutRee.id, ree.id);
    expect(await convert(visitor, withoutRee.id)).toBe('recorded');

    // Two conversations from one visitor: one converted visitor, 100%.
    expect(await share.shareStatistics(ree.id, null)).toEqual({ shareable: true, visits: 1, visitors: 1, conversations: 2, converted: 1, rate: 100 });
    expect(await share.shareStatistics(other.id, null)).toEqual({ shareable: true, visits: 0, visitors: 0, conversations: 0, converted: 0, rate: null });

    // The Ree's statistics page carries the same figures, scoped to its period.
    const all = await reeStatistics(ree.id, statisticsQuery({ period: 'all' }), { withIncome: true });
    expect(all.share).toMatchObject({ visits: 1, conversations: 2, rate: 100 });
    const today = await reeStatistics(ree.id, statisticsQuery({ period: 'day' }), { withIncome: true });
    expect(today.share).toMatchObject({ visits: 1, conversations: 2 });
  });

  it('does not count a conversion in the rate when the visit fell outside the period', async () => {
    const ree = await reeOf(await person());
    const visitor = await person();
    const browser = randomUUID();
    // An hour ago is recent enough to attribute the conversion...
    expect(await visit(ree.slug, browser, { userId: visitor }, new Date(Date.now() - 60 * 60_000))).toBe('recorded');
    const conversation = await conversations.createConversation(visitor, { reeIds: [ree.id] });
    expect(await share.recordShareConversion({ slug: ree.slug, visitorId: browser, userId: visitor, conversationId: conversation.id })).toBe('recorded');
    // ...but a period holding only the conversation has no visitor to convert.
    const day = 86_400_000;
    const tomorrow = Math.floor(Date.now() / day) * day + day;
    const range = { start: Date.now() - 30 * 60_000, end: tomorrow };
    expect(await share.shareStatistics(ree.id, range)).toMatchObject({ visits: 0, visitors: 0, conversations: 1, converted: 0, rate: null });
  });
});
