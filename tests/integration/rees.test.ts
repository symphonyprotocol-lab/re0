/**
 * Acceptance: the three-step draft can be left and resumed and creates nothing
 * until confirmed; creation ignores legacy sources and costs no credits. `/rees` follows the list contract.
 */
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { WELCOME_CREDITS } from '@/lib/constants';
import { and, eq, inArray } from 'drizzle-orm';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const rees = await import('@/lib/services/rees');
const chat = await import('@/lib/services/chat');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');

async function newUser() {
  const subject = uniqueName('rees');
  const session = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'R', avatarUrl: null }, 'zh', '/');
  return session.userId;
}

const ready = (name: string) => ({
  ...newReeDraft(),
  name,
  category: 'technology' as const,
  tags: ['React'],
  sampleQuestions: 'What is it?',
  step: 3,
  reached: 3,
});

describeWithDb('Ree setup draft', () => {
  it('saves and resumes without creating a Ree', async () => {
    const userId = await newUser();
    await rees.saveDraft(userId, { ...newReeDraft(), name: 'Half done', step: 2, reached: 2 });
    const draft = await rees.getDraft(userId);
    expect(draft).toMatchObject({ name: 'Half done', step: 2, reached: 2 });
    const owned = await db().select().from(schema.ree).where(eq(schema.ree.ownerId, userId));
    expect(owned).toHaveLength(0);
  });

  it('refuses an incomplete draft and names the step', async () => {
    const userId = await newUser();
    await rees.saveDraft(userId, { ...ready('x'), category: '' });
    await expect(rees.createReeFromDraft(userId)).rejects.toMatchObject({ field: 'category', step: 2 });
  });

  it('creates the Ree on confirmation and clears the draft', async () => {
    const userId = await newUser();
    await rees.saveDraft(userId, ready('Created'));
    const { ree } = await rees.createReeFromDraft(userId);
    expect(ree).toMatchObject({ name: 'Created', category: 'technology', tags: ['React'], sampleQuestions: ['What is it?'], isPublic: false, isPublished: false });
    expect(await rees.getDraft(userId)).toBeNull();
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS);
  });

  it('ignores a legacy first source and creates for free even with no credits', async () => {
    const userId = await newUser();
    await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
    // Simulate a draft saved before the knowledge step was removed.
    const legacy = { ...ready('Legacy draft'), step: 4, reached: 4, source: { kind: 'document', fileName: 'a.pdf', blobPath: 'knowledge/old/a.pdf' } };
    await db().update(schema.user).set({ reeDraft: legacy }).where(eq(schema.user.id, userId));
    expect(await rees.getDraft(userId)).toMatchObject({ step: 3, reached: 3 });
    const { ree } = await rees.createReeFromDraft(userId);
    expect(ree.name).toBe('Legacy draft');
    expect(await db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, ree.id))).toHaveLength(0);
    expect(await db().select().from(schema.creditHold).where(eq(schema.creditHold.userId, userId))).toHaveLength(0);
    expect(await balanceOf(db(), userId)).toBe(0);
    expect(await rees.getDraft(userId)).toBeNull();
  });
});

describeWithDb('/rees list contract and settings', () => {
  it('filters, searches, sorts and pages on the server; out-of-range pages are pulled back', async () => {
    const userId = await newUser();
    for (let i = 1; i <= 14; i += 1) {
      await rees.saveDraft(userId, { ...ready(`Ree ${i}`), isPublic: i % 2 === 0, description: i === 7 ? 'about gardening' : '' });
      const { ree } = await rees.createReeFromDraft(userId);
      if (ree.isPublic) await rees.setReePublished(userId, ree.id, true);
    }
    const all = await rees.listRees(userId, { q: '', visibility: 'all', sort: 'name_asc', size: 12, page: 1 });
    expect(all.total).toBe(14);
    expect(all.items).toHaveLength(12);
    const last = await rees.listRees(userId, { q: '', visibility: 'all', sort: 'name_asc', size: 12, page: 99 });
    expect(last.page).toBe(2);
    expect(last.items).toHaveLength(2);
    const pub = await rees.listRees(userId, { q: '', visibility: 'public', sort: 'default', size: 12, page: 1 });
    expect(pub.total).toBe(7);
    const search = await rees.listRees(userId, { q: 'garden', visibility: 'all', sort: 'default', size: 12, page: 1 });
    expect(search.items.map((item) => item.name)).toEqual(['Ree 7']);
    const totals = await rees.reeTotals(userId);
    expect(totals).toMatchObject({ rees: 14, public: 7, private: 7 });
  });

  it('updates settings with validation and deletes softly', async () => {
    const userId = await newUser();
    await rees.saveDraft(userId, ready('Editable'));
    const { ree } = await rees.createReeFromDraft(userId);
    const fields = { name: 'Renamed', description: 'd', category: 'design', tags: ['UX'], systemPrompt: '', sampleQuestions: '', queryFee: 30, isPublic: true, color: 'rose', avatarBlob: null };
    expect(await rees.updateRee(userId, ree.id, fields)).toMatchObject({ name: 'Renamed', queryFee: 30, color: 'rose', isPublic: true });
    await expect(rees.updateRee(userId, ree.id, { ...fields, queryFee: 20000 })).rejects.toMatchObject({ field: 'fee' });
    const other = await newUser();
    expect(await rees.updateRee(other, ree.id, fields)).toBeNull();
    expect(await rees.deleteRee(userId, ree.id)).toBe(true);
    expect(await rees.ownedRee(db(), userId, ree.id)).toBeNull();
    const [row] = await db().select().from(schema.ree).where(and(eq(schema.ree.id, ree.id)));
    expect(row?.deletedAt).not.toBeNull();
  });
});

async function reeRow(ownerId: string, values: { isPublic?: boolean; moderatedAt?: Date | null } = {}) {
  const [ree] = await db()
    .insert(schema.ree)
    .values({ ownerId, name: uniqueName('ree'), slug: uniqueName('slug'), category: 'technology', ...values })
    .returning();
  return ree!;
}

async function conversationWith(userId: string, reeId: string, kind: 'normal' | 'ree_test' = 'normal') {
  const [conversation] = await db()
    .insert(schema.conversation)
    .values({ userId, kind, title: 'q', reeId: kind === 'ree_test' ? reeId : null })
    .returning({ id: schema.conversation.id });
  await db().insert(schema.conversationRee).values({ conversationId: conversation!.id, reeId });
  return conversation!.id;
}

describeWithDb('/rees counts', () => {
  it('shows the same feedback percentage as discovery and excludes the owner’s votes', async () => {
    const owner = await newUser();
    const voters = await Promise.all([newUser(), newUser(), newUser()]);
    const ree = await reeRow(owner);
    const listed = async () => (await rees.listRees(owner, { q: '', visibility: 'all', sort: 'default', size: 12, page: 1 })).items[0];
    expect((await listed())!.positiveRate).toBeNull();

    const conversationId = await conversationWith(owner, ree.id, 'ree_test');
    const [answer] = await db().insert(schema.message).values({ conversationId, role: 'ree', reeId: ree.id, content: 'answer' }).returning({ id: schema.message.id });
    await db().insert(schema.reeFeedback).values({ messageId: answer!.id, userId: owner, vote: 'down' });
    expect((await listed())!.positiveRate).toBeNull();

    await db().insert(schema.reeFeedback).values(voters.map((userId, index) => ({ messageId: answer!.id, userId, vote: index < 2 ? 'up' as const : 'down' as const })));
    expect((await listed())!.positiveRate).toBe(67);
  });

  it('keeps successful answers once the test chat is cleared, and counts paused sources as not ready', async () => {
    const owner = await newUser();
    const ree = await reeRow(owner);
    await db()
      .insert(schema.knowledge)
      .values([
        { reeId: ree.id, kind: 'text', title: 'On', originalTitle: 'On', status: 'ready', content: 'a' },
        { reeId: ree.id, kind: 'text', title: 'Paused', originalTitle: 'Paused', status: 'ready', content: 'b', enabled: false },
      ]);
    const conversationId = await conversationWith(owner, ree.id, 'ree_test');
    /* One answered question (settled as `query_base`, as answer.ts writes it) and one the Ree could not answer. */
    for (const answered of [true, false]) {
      const [asked] = await db().insert(schema.message).values({ conversationId, role: 'user', content: 'question' }).returning({ id: schema.message.id });
      await db().insert(schema.message).values({ conversationId, role: 'ree', reeId: ree.id, content: answered ? 'answer' : '', noAnswer: !answered, requestId: asked!.id });
      await db()
        .insert(schema.creditEntry)
        .values({ userId: owner, reason: answered ? 'query_base' : 'query_refund', delta: answered ? 0 : 20, reeId: ree.id, refId: asked!.id });
    }
    const listed = async () => (await rees.listRees(owner, { q: '', visibility: 'all', sort: 'answers_desc', size: 12, page: 1 })).items[0];
    expect(await listed()).toMatchObject({ sources: 2, readySources: 1, answers: 1 });

    await chat.clearConversation(conversationId);
    expect(await db().select().from(schema.message).where(eq(schema.message.conversationId, conversationId))).toHaveLength(0);
    expect(await listed()).toMatchObject({ sources: 2, readySources: 1, answers: 1 });
    expect(await rees.reeTotals(owner)).toMatchObject({ sources: 2, readySources: 1, answers: 1 });
    expect(await rees.reeSourceCount(ree.id)).toBe(2);
  });
});

describeWithDb('/rees batch visibility', () => {
  it('makes Rees private like a single update: out of other people’s conversations, the owner’s stay', async () => {
    const owner = await newUser();
    const other = await newUser();
    const a = await reeRow(owner, { isPublic: true });
    const b = await reeRow(owner, { isPublic: true });
    const already = await reeRow(owner, { isPublic: false });
    const theirs = await reeRow(other, { isPublic: true });
    const othersChat = await conversationWith(other, a.id);
    const ownChat = await conversationWith(owner, a.id);

    const plan = await rees.setReesVisibility(owner, [a.id, b.id, already.id, theirs.id], false);
    expect(plan.changes.sort()).toEqual([a.id, b.id].sort());
    expect(plan).toMatchObject({ unchanged: [already.id], blocked: [], missing: [theirs.id] });
    const rows = await db().select({ id: schema.ree.id, isPublic: schema.ree.isPublic }).from(schema.ree).where(inArray(schema.ree.id, [a.id, b.id, theirs.id]));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.isPublic]))).toEqual({ [a.id]: false, [b.id]: false, [theirs.id]: true });
    expect(await db().select().from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, othersChat))).toHaveLength(0);
    expect(await db().select().from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, ownChat))).toHaveLength(1);
  });

  it('skips a taken-down Ree when going public and lists the selection for "选中全部结果"', async () => {
    const owner = await newUser();
    const down = await reeRow(owner, { isPublic: false, moderatedAt: new Date() });
    const hidden = await reeRow(owner, { isPublic: false });
    const plan = await rees.setReesVisibility(owner, [down.id, hidden.id], true);
    expect(plan).toMatchObject({ changes: [hidden.id], blocked: [down.id], unchanged: [], missing: [] });
    const [still] = await db().select({ isPublic: schema.ree.isPublic }).from(schema.ree).where(eq(schema.ree.id, down.id));
    expect(still!.isPublic).toBe(false);

    const selection = await rees.reeSelection(owner, { q: '', visibility: 'all' });
    expect(selection.map((ree) => ree.id).sort()).toEqual([down.id, hidden.id].sort());
    expect(selection.find((ree) => ree.id === down.id)).toMatchObject({ moderated: true, isPublic: false });
    const listed = await rees.listRees(owner, { q: '', visibility: 'private', sort: 'default', size: 12, page: 1 });
    expect(listed.items.map((ree) => ree.id)).toEqual([down.id]);
    expect(listed.items[0]!.moderatedAt).not.toBeNull();
  });
});
