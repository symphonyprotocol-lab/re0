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

describeWithDb('/rees counts', () => {
  it('shows the same feedback percentage as discovery, from the frozen conversation votes', async () => {
    const owner = await newUser();
    const ree = await reeRow(owner);
    const listed = async () => (await rees.listRees(owner, { q: '', visibility: 'all', sort: 'default', size: 12, page: 1 })).items[0];
    expect((await listed())!.positiveRate).toBeNull();

    /* The conversations' votes count as migration 0066 froze them, other people's only (legacy-stats.test.ts). */
    await db().insert(schema.reeLegacyStats).values({ reeId: ree.id, helpful: 0, unhelpful: 0 });
    expect((await listed())!.positiveRate).toBeNull();
    await db().update(schema.reeLegacyStats).set({ helpful: 2, unhelpful: 1 }).where(eq(schema.reeLegacyStats.reeId, ree.id));
    expect((await listed())!.positiveRate).toBe(67);
  });

  it('counts successful answers from the ledger, and paused sources as not ready', async () => {
    const owner = await newUser();
    const ree = await reeRow(owner);
    await db()
      .insert(schema.knowledge)
      .values([
        { reeId: ree.id, kind: 'text', title: 'On', originalTitle: 'On', status: 'ready', content: 'a' },
        { reeId: ree.id, kind: 'text', title: 'Paused', originalTitle: 'Paused', status: 'ready', content: 'b', enabled: false },
      ]);
    /* One answered question (settled as `query_base`) and one the Ree could not answer. */
    for (const answered of [true, false]) {
      await db()
        .insert(schema.creditEntry)
        .values({ userId: owner, reason: answered ? 'query_base' : 'query_refund', delta: answered ? 0 : 20, reeId: ree.id, refId: crypto.randomUUID() });
    }
    const listed = async () => (await rees.listRees(owner, { q: '', visibility: 'all', sort: 'answers_desc', size: 12, page: 1 })).items[0];
    expect(await listed()).toMatchObject({ sources: 2, readySources: 1, answers: 1 });

    expect(await rees.reeTotals(owner)).toMatchObject({ sources: 2, readySources: 1, answers: 1 });
    expect(await rees.reeSourceCount(ree.id)).toBe(2);
  });
});

describeWithDb('/rees batch visibility', () => {
  it('makes Rees private like a single update', async () => {
    const owner = await newUser();
    const other = await newUser();
    const a = await reeRow(owner, { isPublic: true });
    const b = await reeRow(owner, { isPublic: true });
    const already = await reeRow(owner, { isPublic: false });
    const theirs = await reeRow(other, { isPublic: true });

    const plan = await rees.setReesVisibility(owner, [a.id, b.id, already.id, theirs.id], false);
    expect(plan.changes.sort()).toEqual([a.id, b.id].sort());
    expect(plan).toMatchObject({ unchanged: [already.id], blocked: [], missing: [theirs.id] });
    const rows = await db().select({ id: schema.ree.id, isPublic: schema.ree.isPublic }).from(schema.ree).where(inArray(schema.ree.id, [a.id, b.id, theirs.id]));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.isPublic]))).toEqual({ [a.id]: false, [b.id]: false, [theirs.id]: true });
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
