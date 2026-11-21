/**
 * The Ree page's public Q&A (lib/services/public-qa.ts; shown from posts
 * since v5, public-qa-sync.ts): what visitors published before is kept,
 * redacted, and shown once moderation passes (nothing adds to it since the
 * anonymous chat and the conversations went); the owner's switch, pin and
 * hide; helpful votes; reports hiding an answer and an administrator
 * restoring it; and explore's counts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const qa = await import('@/lib/services/public-qa');
const { reeCards } = await import('@/lib/services/explore');
const { computeRanks } = await import('@/lib/services/rank');
const privatePosts = await import('@/lib/services/private-posts');
const { PUBLIC_QA_REPORT_THRESHOLD } = await import('@/lib/domain/public-qa');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { consoleAdministrator } = await import('../fixtures/console-administrator');

const QUESTION = 'When are refunds issued to the original payment method?';
const base = 'http://localhost:3000';

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await fake?.close();
});

async function user(prefix: string) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  return userId;
}

/** A public, published, free Ree with ready knowledge about refunds. */
async function publicRee() {
  const ownerId = await user('qa-owner');
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: 'Refund desk', category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, {
    kind: 'text',
    title: 'Refund policy',
    content: 'Refunds are issued to the original payment method within 14 days of the request. The refund goes back to the card or account that paid.',
  });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true }).where(eq(schema.ree.id, ree.id));
  return { ownerId, reeId: ree.id };
}

/**
 * A visitor's published Q&A as #158 left them (visitors no longer publish
 * since 2026-11-19, but what they published stays): a snapshot, redacted on
 * the way in, then reviewed -- 'skipped' when the Ree takes no public answers.
 */
async function visitorPublished(reeId: string, question: string): Promise<string> {
  const citation = { index: 1, knowledgeId: crypto.randomUUID(), title: 'Refund policy', kind: 'text' as const, locator: {} as never, excerpt: 'Refunds are issued to the original payment method within 14 days.' };
  const id = await qa.keepSnapshot({ reeId, source: 'anonymous', question, answer: 'Refunds go back to the original payment method within 14 days [1].', citations: [citation], lang: 'en' });
  if (!id) return 'skipped';
  const status = await qa.moderateSnapshot(id);
  return status === 'gone' ? 'pending' : status;
}

async function rowsOf(reeId: string) {
  return db().select().from(schema.reePublicQa).where(eq(schema.reePublicQa.reeId, reeId));
}

/** A visitor's published answer is reviewed after the response (here, right after it): waits until no first review is still running. */
async function reviewed(reeId: string) {
  for (let tries = 0; tries < 100; tries += 1) {
    if (!(await rowsOf(reeId)).some((row) => row.status === 'pending' && row.moderationAttempts === 0)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const { POST: reportPost } = await import('@/app/api/rees/[id]/public-qa/[qaId]/report/route');
function report(reeId: string, qaId: string, ip: string, cookie?: string) {
  const headers: Record<string, string> = { origin: base, host: 'localhost:3000', 'x-real-ip': ip };
  if (cookie) headers.cookie = `re0_anon=${cookie}`;
  return reportPost(new NextRequest(`${base}/api/rees/${reeId}/public-qa/${qaId}/report`, { method: 'POST', headers }), { params: Promise.resolve({ id: reeId, qaId }) });
}

describeWithDb('public Q&A', () => {
  it('keeps what visitors published before, redacted, once it passes review', async () => {
    const { reeId } = await publicRee();
    expect(await visitorPublished(reeId, `${QUESTION} Reach me at lin@example.com or 138 1234 5678`)).toBe('published');
    const page = await qa.listPublicQa(reeId);
    expect(page?.total).toBe(1);
    expect(page?.items[0]).toMatchObject({ asker: 'visitor', pinned: false, helpful: 0 });
    expect(page?.items[0]?.question).not.toContain('lin@example.com');
    expect(page?.items[0]?.question).not.toContain('5678');
    expect(page?.items[0]?.answer).toContain('14 days');
    expect(page?.items[0]?.citations.length).toBeGreaterThan(0);
  });

  it('rejects what review refuses, and retries a failed review from the cron', async () => {
    const { reeId } = await publicRee();
    expect((await visitorPublished(reeId, `${QUESTION} UNPUBLISHABLE`))).toBe('rejected');
    expect((await visitorPublished(reeId, `${QUESTION} MODERATION DOWN`))).toBe('pending');
    await reviewed(reeId);
    expect((await rowsOf(reeId)).map((row) => row.status).sort()).toEqual(['pending', 'rejected']);
    expect((await qa.listPublicQa(reeId))?.total).toBe(0);

    const [pending] = (await rowsOf(reeId)).filter((row) => row.status === 'pending');
    expect(pending?.moderationAttempts).toBe(1);
    await db().update(schema.reePublicQa).set({ createdAt: new Date(Date.now() - 5 * 60_000) }).where(eq(schema.reePublicQa.id, pending!.id));
    await qa.moderatePending(async () => ({ publish: true }));
    expect((await qa.listPublicQa(reeId))?.total).toBe(1);

    /* The last attempt gives up: a snapshot never checked stays unpublished. */
    const id = await qa.keepSnapshot({ reeId, source: 'anonymous', question: 'Q?', answer: 'A.', citations: [], lang: 'en' });
    const failing = async () => {
      throw new Error('down');
    };
    expect(await qa.moderateSnapshot(id!, failing)).toBe('pending');
    expect(await qa.moderateSnapshot(id!, failing)).toBe('pending');
    expect(await qa.moderateSnapshot(id!, failing)).toBe('rejected');
  });

  it('deletes a signed-in asker\'s snapshots with their account', async () => {
    const { reeId } = await publicRee();
    /* No account deletion exists yet; the foreign key makes sure it takes the text along when one does. */
    const [leaver] = await db().insert(schema.user).values({ name: 'Leaver', email: `${uniqueName('leaver')}@example.test`, provider: 'github', providerSubject: uniqueName('leaver') }).returning({ id: schema.user.id });
    await db().insert(schema.reePublicQa).values({ reeId, source: 'user', userId: leaver!.id, question: 'Q?', answer: 'A.', lang: 'en', status: 'published', publishedAt: new Date() });
    expect(await rowsOf(reeId)).toHaveLength(1);
    await db().delete(schema.user).where(eq(schema.user.id, leaver!.id));
    expect(await rowsOf(reeId)).toHaveLength(0);
  });

  it('follows the owner\'s switch, pin and hide, and counts helpful votes once per user', async () => {
    const { ownerId, reeId } = await publicRee();
    await visitorPublished(reeId, QUESTION);
    await visitorPublished(reeId, 'When are refunds issued to the card that paid?');
    await reviewed(reeId);
    const page = (await qa.listPublicQa(reeId))!;
    expect(page.total).toBe(2);
    const older = page.items[1]!;

    expect(await qa.ownerAct(await user('qa-other'), reeId, older.id, 'pin')).toBe(false);
    expect(await qa.ownerAct(ownerId, reeId, older.id, 'pin')).toBe(true);
    expect((await qa.listPublicQa(reeId))!.items[0]).toMatchObject({ id: older.id, pinned: true });
    expect((await qa.publicQaPicks(reeId, 1)).items[0]?.id).toBe(older.id);

    const voter = await user('qa-voter');
    expect(await qa.setHelpful(voter, reeId, older.id, true)).toMatchObject({ helpful: 1, voted: true });
    expect(await qa.setHelpful(voter, reeId, older.id, true)).toMatchObject({ helpful: 1, voted: true });
    expect((await qa.listPublicQa(reeId, { viewerId: voter }))!.items[0]?.voted).toBe(true);
    expect(await qa.setHelpful(voter, reeId, older.id, false)).toMatchObject({ helpful: 0, voted: false });

    await db().update(schema.ree).set({ publicQaEnabled: false }).where(eq(schema.ree.id, reeId));
    expect((await qa.listPublicQa(reeId))!.total).toBe(0);
    expect((await visitorPublished(reeId, QUESTION))).toBe('skipped');
    expect((await reeCards([reeId], new Map(), { includeIntros: false }))[0]?.publicQa).toBe(0);
    await db().update(schema.ree).set({ publicQaEnabled: true }).where(eq(schema.ree.id, reeId));
    expect((await reeCards([reeId], new Map(), { includeIntros: false }))[0]?.publicQa).toBe(2);

    expect(await qa.ownerAct(ownerId, reeId, older.id, 'hide')).toBe(true);
    expect((await qa.listPublicQa(reeId))!.items.map((item) => item.id)).not.toContain(older.id);
    /* The owner's hiding stands: an administrator cannot restore it. */
    const administrator = await consoleAdministrator();
    expect(await qa.adminSetPublicQa(administrator.id, reeId, older.id, true)).toBe(false);
    expect((await qa.listPublicQa(reeId))!.items.map((item) => item.id)).not.toContain(older.id);

    /* Two pins at once take turns: both succeed, one answer ends up pinned. */
    const [left] = (await qa.listPublicQa(reeId))!.items;
    await visitorPublished(reeId, 'When are refunds issued to the account that paid?');
    await reviewed(reeId);
    const other = (await qa.listPublicQa(reeId))!.items.find((item) => item.id !== left!.id)!;
    expect(await Promise.all([qa.ownerAct(ownerId, reeId, left!.id, 'pin'), qa.ownerAct(ownerId, reeId, other.id, 'pin')])).toEqual([true, true]);
    expect((await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.reeId, reeId))).filter((row) => row.pinnedAt !== null)).toHaveLength(1);
  });

  it('counts a visitor once per network however many cookies they send, and hides after enough distinct reporters', async () => {
    const { reeId } = await publicRee();
    await visitorPublished(reeId, QUESTION);
    await reviewed(reeId);
    const [item] = (await qa.listPublicQa(reeId))!.items;
    for (const cookie of [undefined, undefined, crypto.randomUUID()]) expect((await report(reeId, item!.id, '198.51.100.7', cookie)).status).toBe(200);
    expect((await qa.listPublicQa(reeId))!.total).toBe(1);
    expect((await db().select().from(schema.postAnswerReport).where(eq(schema.postAnswerReport.answerId, item!.id)))).toHaveLength(1);
    /* Two /64s of one /48 (one home line) are one network too. */
    expect((await report(reeId, item!.id, '2001:db8:1:2::1')).status).toBe(200);
    expect((await report(reeId, item!.id, '2001:db8:1:ff00::1')).status).toBe(200);
    expect((await qa.listPublicQa(reeId))!.total).toBe(1);
    /* No address, no report. */
    const bare = await reportPost(new NextRequest(`${base}/api/rees/${reeId}/public-qa/${item!.id}/report`, { method: 'POST', headers: { origin: base, host: 'localhost:3000' } }), { params: Promise.resolve({ id: reeId, qaId: item!.id }) });
    expect(bare.status).toBe(400);
    expect((await report(reeId, item!.id, '203.0.113.200')).status).toBe(200);
    expect((await qa.listPublicQa(reeId))!.total).toBe(0);
    expect((await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.id, item!.id)))[0]).toMatchObject({ hiddenBy: 'reports' });
  });

  it('hides an answer after enough distinct reports, until an administrator restores it', async () => {
    const { reeId } = await publicRee();
    await visitorPublished(reeId, QUESTION);
    await reviewed(reeId);
    const [item] = (await qa.listPublicQa(reeId))!.items;
    for (let index = 1; index < PUBLIC_QA_REPORT_THRESHOLD; index += 1) expect(await qa.reportPublicQa(reeId, item!.id, `anon:${index}`)).toBe(true);
    /* The same reporter again counts once. */
    expect(await qa.reportPublicQa(reeId, item!.id, 'anon:1')).toBe(true);
    expect((await qa.listPublicQa(reeId))!.total).toBe(1);
    expect(await qa.reportPublicQa(reeId, item!.id, 'user:last')).toBe(true);
    expect((await qa.listPublicQa(reeId))!.total).toBe(0);
    /* v5: the answer lives on as a post's answer (public-qa-sync.ts); that is what reports hide. */
    const [hidden] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.id, item!.id));
    expect(hidden).toMatchObject({ hiddenBy: 'reports', reportCount: PUBLIC_QA_REPORT_THRESHOLD });

    const administrator = await consoleAdministrator();
    expect((await qa.adminPublicQa(reeId))[0]).toMatchObject({ id: item!.id, status: 'hidden', reports: PUBLIC_QA_REPORT_THRESHOLD });
    expect(await qa.adminSetPublicQa(administrator.id, reeId, item!.id, true)).toBe(true);
    expect(await qa.adminSetPublicQa(administrator.id, reeId, item!.id, true)).toBe(false);
    expect((await qa.listPublicQa(reeId))!.total).toBe(1);
    const audits = await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.target, reeId));
    expect(audits.map((row) => row.action)).toContain('ree.qa.restore');
  });

  it('rejects a snapshot whose last review never finished', async () => {
    const { reeId } = await publicRee();
    const id = await qa.keepSnapshot({ reeId, source: 'anonymous', question: 'Q?', answer: 'A.', citations: [], lang: 'en' });
    await db().update(schema.reePublicQa).set({ moderationAttempts: 3, createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.reePublicQa.id, id!));
    await qa.moderatePending(async () => ({ publish: true }));
    expect((await rowsOf(reeId)).find((row) => row.id === id)?.status).toBe('rejected');

  });

  it('gives explore this week\'s questions and the latest answer from the hourly rank', async () => {
    const { reeId } = await publicRee();
    const askerId = await user('qa-week');
    for (const question of [QUESTION, `${QUESTION} And to which card?`]) {
      const made = await privatePosts.publishPrivatePost(askerId, { question, reeIds: [reeId], fees: { [reeId]: 20 }, lang: 'en' });
      if (!made.ok) throw new Error(made.error);
      await privatePosts.processPrivatePost(made.id);
    }
    await computeRanks();
    const [card] = await reeCards([reeId], new Map(), { includeIntros: false });
    expect(card?.asked7).toBe(2);
    expect(card?.lastAnsweredAt).not.toBeNull();
  });
});
