/**
 * The Ree page's public Q&A (lib/services/public-qa.ts; shown from posts
 * since v5, public-qa-sync.ts): a visitor's
 * first-turn answer is kept only when they asked to publish it, redacted,
 * and shown once moderation passes; a signed-in asker publishes their own
 * single-turn answer and takes it down by trashing the conversation; the
 * owner's switch, pin and hide; helpful votes; reports hiding an answer and
 * an administrator restoring it; and explore's counts.
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
const { answer } = await import('@/lib/services/answer');
const { createConversation, runBatch, updateConversation } = await import('@/lib/services/conversations');
const { ownedConversation } = await import('@/lib/services/chat');
const { reeCards } = await import('@/lib/services/explore');
const { computeRanks } = await import('@/lib/services/rank');
const { POST: anonymousPost } = await import('@/app/api/rees/[id]/anonymous-chat/route');
const { FINGERPRINT_HEADER } = await import('@/lib/domain/anonymous-chat');
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

let ipCounter = 0;
function ask(reeId: string, question: string, extra: Record<string, unknown> = {}) {
  ipCounter += 1;
  const headers = { origin: base, host: 'localhost:3000', 'content-type': 'application/json', 'x-real-ip': `203.0.113.${ipCounter % 250}`, [FINGERPRINT_HEADER]: crypto.randomUUID().replaceAll('-', '') };
  return anonymousPost(new NextRequest(`${base}/api/rees/${reeId}/anonymous-chat`, { method: 'POST', headers, body: JSON.stringify({ question, lang: 'en', ...extra }) }), { params: Promise.resolve({ id: reeId }) });
}

async function read(response: Response) {
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as { type: string; data?: Record<string, unknown> });
  return {
    shared: (events.find((event) => event.type === 'data-public')?.data as { status: string } | undefined)?.status ?? null,
    outcome: events.find((event) => event.type === 'data-outcome')?.data as { messageId: string | null } | undefined,
  };
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
  it('keeps a visitor\'s answer only when asked to publish it, redacted, and shows it once it passes review', async () => {
    const { reeId } = await publicRee();
    expect((await read(await ask(reeId, QUESTION))).shared).toBeNull();
    expect(await rowsOf(reeId)).toHaveLength(0);

    const published = await read(await ask(reeId, `${QUESTION} Reach me at lin@example.com or 138 1234 5678`, { publish: true }));
    /* The answer finishes at once; its review runs after it. */
    expect(published.shared).toBe('pending');
    await reviewed(reeId);
    const page = await qa.listPublicQa(reeId);
    expect(page?.total).toBe(1);
    expect(page?.items[0]).toMatchObject({ asker: 'visitor', pinned: false, helpful: 0 });
    expect(page?.items[0]?.question).not.toContain('lin@example.com');
    expect(page?.items[0]?.question).not.toContain('5678');
    expect(page?.items[0]?.answer).toContain('14 days');
    expect(page?.items[0]?.citations.length).toBeGreaterThan(0);

    /* A follow-up leaned on earlier turns: never kept, whatever the visitor ticked. */
    const followUp = await read(await ask(reeId, QUESTION, { publish: true, history: [{ role: 'user', content: QUESTION }, { role: 'assistant', content: 'Within 14 days [1].' }] }));
    expect(followUp.shared).toBe('skipped');
    /* No answer, nothing to publish. */
    expect((await read(await ask(reeId, 'Anything at all DECLINE', { publish: true }))).shared).toBe('skipped');
    expect(await rowsOf(reeId)).toHaveLength(1);
  });

  it('rejects what review refuses, and retries a failed review from the cron', async () => {
    const { reeId } = await publicRee();
    expect((await read(await ask(reeId, `${QUESTION} UNPUBLISHABLE`, { publish: true }))).shared).toBe('pending');
    expect((await read(await ask(reeId, `${QUESTION} MODERATION DOWN`, { publish: true }))).shared).toBe('pending');
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

  it('lets a signed-in asker publish their own single-turn answer, and takes it down with the conversation', async () => {
    const { reeId } = await publicRee();
    const askerId = await user('qa-asker');
    const strangerId = await user('qa-stranger');
    const created = await createConversation(askerId, { reeIds: [reeId], title: 'Refunds' });
    const conversation = (await ownedConversation(askerId, created.id))!;
    const [ree] = await db().select().from(schema.ree).where(eq(schema.ree.id, reeId));
    const first = await read(await answer({ userId: askerId, lang: 'en', conversation, targets: [ree!], question: QUESTION }));
    const second = await read(await answer({ userId: askerId, lang: 'en', conversation, targets: [ree!], question: QUESTION }));
    const firstId = first.outcome!.messageId!;

    expect(await qa.publishOwnAnswer(strangerId, reeId, firstId, 'en')).toBe('not_found');
    expect(await qa.publishOwnAnswer(askerId, reeId, second.outcome!.messageId!, 'en')).toBe('not_single_turn');
    const result = await qa.publishOwnAnswer(askerId, reeId, firstId, 'en');
    expect(typeof result === 'object' && result.id).toBeTruthy();
    expect(await qa.publishOwnAnswer(askerId, reeId, firstId, 'en')).toBe('already');
    expect(await qa.moderateSnapshot((result as { id: string }).id)).toBe('published');
    expect((await qa.listPublicQa(reeId))?.items[0]?.asker).toBe('user');

    await updateConversation(askerId, created.id, { trashed: true });
    expect((await qa.listPublicQa(reeId))?.total).toBe(0);
    await updateConversation(askerId, created.id, { trashed: false });
    expect((await qa.listPublicQa(reeId))?.total).toBe(1);

    /* Purging the conversation deletes the snapshot itself, question and answer text included. */
    await updateConversation(askerId, created.id, { trashed: true });
    expect(await runBatch(askerId, 'delete', [created.id])).toBe(1);
    expect(await rowsOf(reeId)).toHaveLength(0);
    /* ...and the post it was copied into (v5). */
    expect(await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.reeId, reeId))).toHaveLength(0);
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
    await read(await ask(reeId, QUESTION, { publish: true }));
    await read(await ask(reeId, 'When are refunds issued to the card that paid?', { publish: true }));
    await reviewed(reeId);
    const page = (await qa.listPublicQa(reeId))!;
    expect(page.total).toBe(2);
    const older = page.items[1]!;

    expect(await qa.ownerAct(await user('qa-other'), reeId, older.id, 'pin')).toBe(false);
    expect(await qa.ownerAct(ownerId, reeId, older.id, 'pin')).toBe(true);
    expect((await qa.listPublicQa(reeId))!.items[0]).toMatchObject({ id: older.id, pinned: true });
    expect((await qa.publicQaPicks(reeId, 1)).items[0]?.id).toBe(older.id);

    const voter = await user('qa-voter');
    expect(await qa.setHelpful(voter, reeId, older.id, true)).toEqual({ helpful: 1, voted: true });
    expect(await qa.setHelpful(voter, reeId, older.id, true)).toEqual({ helpful: 1, voted: true });
    expect((await qa.listPublicQa(reeId, { viewerId: voter }))!.items[0]?.voted).toBe(true);
    expect(await qa.setHelpful(voter, reeId, older.id, false)).toEqual({ helpful: 0, voted: false });

    await db().update(schema.ree).set({ publicQaEnabled: false }).where(eq(schema.ree.id, reeId));
    expect((await qa.listPublicQa(reeId))!.total).toBe(0);
    expect((await read(await ask(reeId, QUESTION, { publish: true }))).shared).toBe('skipped');
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
    await read(await ask(reeId, 'When are refunds issued to the account that paid?', { publish: true }));
    await reviewed(reeId);
    const other = (await qa.listPublicQa(reeId))!.items.find((item) => item.id !== left!.id)!;
    expect(await Promise.all([qa.ownerAct(ownerId, reeId, left!.id, 'pin'), qa.ownerAct(ownerId, reeId, other.id, 'pin')])).toEqual([true, true]);
    expect((await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.reeId, reeId))).filter((row) => row.pinnedAt !== null)).toHaveLength(1);
  });

  it('counts a visitor once per network however many cookies they send, and hides after enough distinct reporters', async () => {
    const { reeId } = await publicRee();
    await read(await ask(reeId, QUESTION, { publish: true }));
    await reviewed(reeId);
    const [item] = (await qa.listPublicQa(reeId))!.items;
    for (const cookie of [undefined, undefined, crypto.randomUUID()]) expect((await report(reeId, item!.id, '198.51.100.7', cookie)).status).toBe(200);
    expect((await qa.listPublicQa(reeId))!.total).toBe(1);
    expect((await db().select().from(schema.postAnswerReport).where(eq(schema.postAnswerReport.answerId, item!.id)))).toHaveLength(1);
    /* The same /64 is one network too. */
    expect((await report(reeId, item!.id, '2001:db8:1:2::1')).status).toBe(200);
    expect((await report(reeId, item!.id, '2001:db8:1:2::ffff')).status).toBe(200);
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
    await read(await ask(reeId, QUESTION, { publish: true }));
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

  it('rejects a snapshot whose last review never finished, and refuses a raised fee instead of charging it', async () => {
    const { ownerId, reeId } = await publicRee();
    const id = await qa.keepSnapshot({ reeId, source: 'anonymous', question: 'Q?', answer: 'A.', citations: [], lang: 'en' });
    await db().update(schema.reePublicQa).set({ moderationAttempts: 3, createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.reePublicQa.id, id!));
    await qa.moderatePending(async () => ({ publish: true }));
    expect((await rowsOf(reeId)).find((row) => row.id === id)?.status).toBe('rejected');

    /* The Ree page sends the fee it showed: one raised since is refused, nothing charged. */
    await db().update(schema.ree).set({ queryFee: 10 }).where(eq(schema.ree.id, reeId));
    const askerId = await user('qa-fee');
    const created = await createConversation(askerId, { reeIds: [reeId], title: 'Fees' });
    const conversation = (await ownedConversation(askerId, created.id))!;
    const [ree] = await db().select().from(schema.ree).where(eq(schema.ree.id, reeId));
    const refused = await answer({ userId: askerId, lang: 'en', conversation, targets: [ree!], question: QUESTION, seenFees: { [reeId]: 0 } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'price_changed' });
    expect(await db().select().from(schema.creditHold).where(eq(schema.creditHold.userId, askerId))).toHaveLength(0);
    expect(ownerId).not.toBe(askerId);
  });

  it('gives explore this week\'s questions and the latest answer from the hourly rank', async () => {
    const { reeId } = await publicRee();
    await read(await ask(reeId, QUESTION));
    await read(await ask(reeId, QUESTION));
    await computeRanks();
    const [card] = await reeCards([reeId], new Map(), { includeIntros: false });
    expect(card?.asked7).toBe(2);
    expect(card?.lastAnsweredAt).not.toBeNull();
  });
});
