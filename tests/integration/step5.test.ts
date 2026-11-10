/**
 * Acceptance (8.4 step 5), against the database: the verification threshold
 * is checked on the server; approval, revocation and official changes write
 * `user.role`, the audit and a notice; making a user official is refused
 * during a payout and closes a pending request without the wait; the
 * console's lists filter, page and export the same rows at scale with
 * formulas defused; credit adjustments never go negative; takedown makes a
 * Ree private and unpublishable; statistics count on UTC+8 boundaries; the
 * embedding switch keeps the old vectors in use until it completes and
 * leaves the old model on failure; invited administrators enrol once.
 */
import { WELCOME_CREDITS } from '@/lib/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { consoleAdministrator } from '../fixtures/console-administrator';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession, resolveSession } = await import('@/lib/services/auth');
const { db, schema } = await import('@/lib/infra/db');
const roles = await import('@/lib/services/roles');
const notices = await import('@/lib/services/notices');
const adminUsers = await import('@/lib/services/admin-users');
const adminRees = await import('@/lib/services/admin-rees');
const adminAudit = await import('@/lib/services/admin-audit');
const administrators = await import('@/lib/services/admin-administrators');
const admin = await import('@/lib/services/admin');
const statistics = await import('@/lib/services/statistics');
const adminPurchases = await import('@/lib/services/admin-purchases');
const reembed = await import('@/lib/services/reembed');
const models = await import('@/lib/services/models');
const reesService = await import('@/lib/services/rees');
const profile = await import('@/lib/services/profile');
const { forgetModelCache, endpointFor } = await import('@/lib/infra/ai/models');
const { usersView, auditView, reesView, verificationsView, purchasesView } = await import('@/lib/domain/admin-lists');
const { toCsv } = await import('@/lib/domain/csv');
const { USERS_CSV } = await import('@/lib/http/admin-lists');
const { totpCounter } = await import('@/lib/domain/totp');
const { balanceOf } = await import('@/lib/services/credits');

const DAY = 24 * 60 * 60 * 1000;
let fake: FakeOpenAi;

beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

async function newUser(name = 'Owner', createdAt = new Date()): Promise<string> {
  const subject = uniqueName('s5');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: name, avatarUrl: null }, 'zh', '/', createdAt);
  await db().update(schema.user).set({ createdAt }).where(eq(schema.user.id, userId));
  return userId;
}

async function newAdministrator(role: 'owner' | 'administrator' = 'administrator'): Promise<string> {
  const [row] = await db()
    .insert(schema.administrator)
    .values({ name: 'Reviewer', email: `${uniqueName('admin')}@example.test`, role, passwordHash: 'x', totpSecretCipher: 'x' })
    .returning({ id: schema.administrator.id });
  return row!.id;
}

const vector = (seed: number) => Array.from({ length: 1536 }, (_, index) => (index === seed % 1536 ? 1 : 0));

async function publicRee(ownerId: string, options: { ready?: number; isPublic?: boolean } = {}) {
  const [ree] = await db()
    .insert(schema.ree)
    .values({ ownerId, name: uniqueName('ree'), slug: uniqueName('slug'), isPublic: options.isPublic ?? true, isPublished: options.isPublic ?? true, category: 'technology' })
    .returning();
  for (let index = 0; index < (options.ready ?? 0); index += 1) {
    const [k] = await db()
      .insert(schema.knowledge)
      .values({ reeId: ree!.id, kind: 'text', title: `Source ${index}`, originalTitle: `Source ${index}`, status: 'ready', content: `content ${index}` })
      .returning({ id: schema.knowledge.id });
    await db().insert(schema.chunk).values({ knowledgeId: k!.id, reeId: ree!.id, ordinal: 0, content: `passage about topic ${index}`, embedding: vector(index) });
  }
  return ree!;
}

/** `count` questions from `askerId` to the Ree, each answered, with feedback `up`/`down` on the first ones. */
async function questions(askerId: string, reeId: string, count: number, votes: { up: number; down: number } = { up: 0, down: 0 }, at = new Date()) {
  const [conversation] = await db().insert(schema.conversation).values({ userId: askerId, title: 'q' }).returning({ id: schema.conversation.id });
  await db().insert(schema.conversationRee).values({ conversationId: conversation!.id, reeId });
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const [asked] = await db().insert(schema.message).values({ conversationId: conversation!.id, role: 'user', content: `question ${index}`, createdAt: at }).returning({ id: schema.message.id });
    const [reply] = await db()
      .insert(schema.message)
      .values({ conversationId: conversation!.id, role: 'ree', reeId, content: `answer ${index}`, requestId: asked!.id, createdAt: at })
      .returning({ id: schema.message.id });
    ids.push(reply!.id);
  }
  for (let index = 0; index < votes.up + votes.down; index += 1) {
    await db().execute(sql`insert into ree_feedback (message_id, user_id, vote) values (${ids[index]!}, ${askerId}, ${index < votes.up ? 'up' : 'down'})`);
  }
  return { conversationId: conversation!.id, replies: ids };
}

describeWithDb('roles', () => {
  beforeAll(async () => {
    /* Step 4's table; created only when running without its migration. */
    await db().execute(sql`create table if not exists ree_feedback (message_id uuid not null, user_id uuid not null, vote text not null, created_at timestamptz not null default now())`);
  });

  it('shows what is missing and refuses a forged application', async () => {
    const userId = await newUser('New', new Date(Date.now() - 3 * DAY));
    const overview = await roles.verificationOverview(userId);
    expect(overview.access).toMatchObject({ eligible: false, reason: 'requirements' });
    expect(overview.checks.find((check) => check.key === 'registeredDays')).toMatchObject({ value: 3, missing: 11, passed: false });
    expect(overview.checks.find((check) => check.key === 'publicRees')).toMatchObject({ value: 0, missing: 1 });
    await expect(roles.applyForVerification(userId, { statement: 'please', links: [] })).rejects.toMatchObject({ code: 'requirements' });
    await expect(roles.applyForVerification(userId, { statement: '', links: [] })).rejects.toMatchObject({ code: 'statement' });
  });

  it('counts only public, live Rees, other people’s questions and other people’s feedback', async () => {
    const owner = await newUser('Owner', new Date(Date.now() - 20 * DAY));
    const asker = await newUser('Asker');
    const ree = await publicRee(owner, { ready: 5 });
    const hidden = await publicRee(owner, { ready: 3, isPublic: false });
    await questions(asker, ree.id, 100, { up: 8, down: 2 });
    await questions(owner, ree.id, 30, { up: 0, down: 30 });
    await questions(asker, hidden.id, 10);
    const metrics = await roles.roleMetrics(db(), owner);
    expect(metrics).toMatchObject({ registeredDays: 20, publicRees: 1, readySources: 5, externalQuestions: 100, helpful: 8, unhelpful: 2, helpfulRate: 0.8 });
  });

  it('approves into verified, rejects with a 30-day wait, revokes back to normal — each audited and noticed', async () => {
    const reviewer = await newAdministrator();
    const owner = await newUser('Applicant', new Date(Date.now() - 30 * DAY));
    const asker = await newUser('Asker');
    const ree = await publicRee(owner, { ready: 5 });
    await questions(asker, ree.id, 100, { up: 9, down: 1 });

    const first = await roles.applyForVerification(owner, { statement: 'I maintain sources.', links: ['https://example.com/me'] });
    expect(first.metrics.externalQuestions).toBe(100);
    await expect(roles.applyForVerification(owner, { statement: 'again', links: [] })).rejects.toMatchObject({ code: 'pending' });
    await expect(roles.decideVerification(reviewer, first.id, 'rejected', '')).rejects.toMatchObject({ code: 'reason' });
    await roles.decideVerification(reviewer, first.id, 'rejected', 'Links do not show the work.');
    const waiting = await roles.verificationOverview(owner);
    expect(waiting.access.reason).toBe('cooldown');
    expect(waiting.access.retryAt!.getTime() - Date.now()).toBeGreaterThan(29 * DAY);
    await expect(roles.decideVerification(reviewer, first.id, 'approved', '')).rejects.toMatchObject({ code: 'stale' });

    await db().update(schema.verificationRequest).set({ decidedAt: new Date(Date.now() - 31 * DAY) }).where(eq(schema.verificationRequest.id, first.id));
    const second = await roles.applyForVerification(owner, { statement: 'Second try.', links: [] });
    await roles.decideVerification(reviewer, second.id, 'approved', '');
    const [verified] = await db().select().from(schema.user).where(eq(schema.user.id, owner));
    expect(verified!.role).toBe('verified');
    expect(verified!.roleChangedAt).not.toBeNull();

    const listed = await adminUsers.listUsers(usersView({ role: 'verified', q: verified!.email }));
    expect(listed.items.map((row) => row.id)).toEqual([owner]);

    await expect(roles.changeRole(reviewer, owner, 'cancel_official', 'nope')).rejects.toMatchObject({ code: 'stale' });
    await roles.changeRole(reviewer, owner, 'revoke', 'Content copied from elsewhere.');
    const [revoked] = await db().select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, owner));
    expect(revoked!.role).toBe('normal');

    const history = await roles.roleHistory(db(), owner);
    expect(history.map((event) => [event.action, event.from, event.to])).toEqual([
      ['user.role.revoke', 'verified', 'normal'],
      ['verification.approved', 'normal', 'verified'],
    ]);
    const inbox = await notices.listNotices(owner, 1);
    expect(inbox.items.map((n) => n.kind)).toEqual(['role', 'verification', 'verification']);
    expect(inbox.unread).toBe(3);
    const audits = await adminAudit.listAudit(await consoleAdministrator(), auditView({ action: 'verification.rejected', q: owner }));
    expect(audits.total).toBe(1);
  });

  it('makes a user official only without a payout in progress, closing a pending request without the wait', async () => {
    const reviewer = await newAdministrator();
    const owner = await newUser('Platform', new Date(Date.now() - 30 * DAY));
    const asker = await newUser('Asker');
    const ree = await publicRee(owner, { ready: 5 });
    await questions(asker, ree.id, 100, { up: 5, down: 0 });
    const request = await roles.applyForVerification(owner, { statement: 'Pending one.', links: [] });

    const payoutExisted = await db().execute(sql`select to_regclass('public.payout') is not null as found`);
    if (!(payoutExisted.rows[0] as { found: boolean }).found) {
      /* Step 6 creates `payout`; the checkpoint reads it once it exists. */
      await db().execute(sql`create table payout (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text not null)`);
      await db().execute(sql`insert into payout (user_id, status) values (${owner}, 'pending')`);
      await expect(roles.changeRole(reviewer, owner, 'official', 'Platform account')).rejects.toMatchObject({ code: 'payout_pending' });
      await db().execute(sql`update payout set status = 'paid' where user_id = ${owner}`);
    }

    await roles.changeRole(reviewer, owner, 'official', 'Platform account');
    const [closed] = await db().select().from(schema.verificationRequest).where(eq(schema.verificationRequest.id, request.id));
    expect(closed).toMatchObject({ status: 'closed', closedByRoleChange: true });
    expect((await roles.verificationOverview(owner)).access.reason).toBe('role');
    await roles.changeRole(reviewer, owner, 'cancel_official', 'Back to normal');
    /* A close by role change does not start the 30-day wait. */
    expect((await roles.verificationOverview(owner)).access).toMatchObject({ eligible: true, reason: null });
    const audit = await adminAudit.listAudit(await consoleAdministrator(), auditView({ action: 'user.role.official', q: owner }));
    expect(audit.items[0]!.after).toMatchObject({ role: 'official', closedRequests: [request.id] });
  });
});

describeWithDb('console lists at scale', () => {
  it('filters, pages and exports the same rows, with formulas defused', async () => {
    const tag = uniqueName('bulk');
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      email: `${tag}-${String(index).padStart(4, '0')}@example.test`,
      name: index === 7 ? '=HYPERLINK("http://evil")' : `${tag} ${index}`,
      provider: 'github' as const,
      providerSubject: `${tag}-${index}`,
      role: (index % 4 === 0 ? 'verified' : 'normal') as 'verified' | 'normal',
      disabledAt: index % 9 === 0 ? new Date() : null,
      createdAt: new Date(Date.now() - (index % 120) * DAY),
    }));
    for (let at = 0; at < rows.length; at += 250) await db().insert(schema.user).values(rows.slice(at, at + 250));

    const view = usersView({ q: tag, role: 'verified', status: 'active', period: '90', size: '20', page: '2' });
    const page = await adminUsers.listUsers(view);
    const everything = await adminUsers.listUsers(view, { all: true });
    const expected = rows.filter((row, index) => index % 4 === 0 && index % 9 !== 0 && index % 120 < 90).length;
    expect(page.total).toBe(expected);
    expect(page.items).toHaveLength(20);
    expect(everything.items).toHaveLength(expected);
    expect(everything.items.slice(20, 40).map((row) => row.id)).toEqual(page.items.map((row) => row.id));
    const lastPage = await adminUsers.listUsers({ ...view, page: 999 });
    expect(lastPage.page).toBe(Math.ceil(expected / 20));

    const csv = toCsv(USERS_CSV.headers, (await adminUsers.listUsers(usersView({ q: tag }), { all: true })).items.map(USERS_CSV.row));
    expect(csv.startsWith('﻿"ID"')).toBe(true);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1001);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).not.toContain(`,"=HYPERLINK`);
  });
});

describeWithDb('console users', () => {
  it('adjusts Pack and Plan credits without going negative, audited and noticed', async () => {
    const reviewer = await newAdministrator();
    const userId = await newUser();
    await expect(adminUsers.adjustCredits(reviewer, userId, { bucket: 'plan', direction: 'grant', amount: 100, reason: 'goodwill' })).rejects.toMatchObject({ code: 'no_plan' });
    await adminUsers.adjustCredits(reviewer, userId, { bucket: 'pack', direction: 'grant', amount: 5_000, reason: 'support credit' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS + 5_000);
    await expect(adminUsers.adjustCredits(reviewer, userId, { bucket: 'pack', direction: 'deduct', amount: 5_001, reason: 'claw back' })).rejects.toMatchObject({ code: 'insufficient' });
    await adminUsers.adjustCredits(reviewer, userId, { bucket: 'pack', direction: 'deduct', amount: 5_000, reason: 'claw back' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS);
    /* An open debt is paid first: the notice and the audit say what the bucket actually gained. */
    await db().insert(schema.creditDebt).values({ userId, amount: 300, remaining: 300 });
    const paid = await adminUsers.adjustCredits(reviewer, userId, { bucket: 'pack', direction: 'grant', amount: 1_000, reason: 'with debt' });
    expect(paid).toMatchObject({ delta: 700, debtPaid: 300 });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS + 700);
    const [latest] = (await notices.listNotices(userId, 1)).items;
    expect(latest!.params).toMatchObject({ delta: 700, debtPaid: 300 });

    await db().insert(schema.subscription).values({
      userId,
      paddleSubscriptionId: uniqueName('sub'),
      status: 'active',
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    });
    await adminUsers.adjustCredits(reviewer, userId, { bucket: 'plan', direction: 'grant', amount: 300, reason: 'plan top-up' });
    const [plan] = await db().select().from(schema.creditGrant).where(and(eq(schema.creditGrant.userId, userId), eq(schema.creditGrant.source, 'plan')));
    expect(plan!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 19 * DAY);

    const entries = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reason, 'admin_adjust')));
    expect(entries.map((entry) => entry.delta).sort((a, b) => a - b)).toEqual([-5000, 300, 1000, 5000]);
    expect((await notices.listNotices(userId, 1)).items.filter((n) => n.kind === 'credits_adjust')).toHaveLength(4);
    expect((await adminAudit.listAudit(await consoleAdministrator(), auditView({ action: 'user.credits.adjust', q: userId }))).total).toBe(4);
  });

  it('disables (signing the user out) and restores', async () => {
    const reviewer = await newAdministrator();
    const subject = uniqueName('dis');
    const session = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'D', avatarUrl: null }, 'zh', '/');
    await adminUsers.setUserDisabled(reviewer, session.userId, true);
    expect(await resolveSession(session.sessionToken)).toBeNull();
    await expect(adminUsers.setUserDisabled(reviewer, session.userId, true)).rejects.toMatchObject({ code: 'stale' });
    await adminUsers.setUserDisabled(reviewer, session.userId, false);
    expect((await adminAudit.listAudit(await consoleAdministrator(), auditView({ q: session.userId }))).items.map((row) => row.action)).toEqual(['user.restore', 'user.disable']);
  });
});

async function profileVectors(reeId: string): Promise<number> {
  const rows = await db().select({ id: schema.reeProfileVector.id }).from(schema.reeProfileVector).where(eq(schema.reeProfileVector.reeId, reeId));
  return rows.length;
}

describeWithDb('Ree takedown', () => {
  it('turns the Ree private, keeps the owner from republishing, leaves others’ conversations, notifies, and restores', async () => {
    const reviewer = await newAdministrator();
    const owner = await newUser();
    const other = await newUser();
    const ree = await publicRee(owner, { ready: 1 });
    const { conversationId } = await questions(other, ree.id, 1);
    await profile.refreshProfile(ree.id);
    expect(await profileVectors(ree.id)).toBeGreaterThan(0);
    await expect(adminRees.takeDownRee(reviewer, ree.id, 'no')).rejects.toMatchObject({ code: 'reason' });
    await adminRees.takeDownRee(reviewer, ree.id, 'Copyrighted material');
    /* Out of discovery (step 4's profile vectors exist only for public Rees). */
    expect(await profileVectors(ree.id)).toBe(0);
    const [down] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
    expect(down).toMatchObject({ isPublic: false, moderatedReason: 'Copyrighted material' });
    expect(await db().select().from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, conversationId))).toHaveLength(0);
    expect(await db().select().from(schema.message).where(eq(schema.message.conversationId, conversationId))).toHaveLength(2);

    await reesService.updateRee(owner, ree.id, { name: down!.name, description: '', category: 'technology', tags: [], systemPrompt: '', sampleQuestions: [], queryFee: 0, isPublic: true, color: 'default', avatarBlob: null });
    const [still] = await db().select({ isPublic: schema.ree.isPublic }).from(schema.ree).where(eq(schema.ree.id, ree.id));
    expect(still!.isPublic).toBe(false);
    expect((await adminRees.listAdminRees(await consoleAdministrator(), reesView({ status: 'moderated', q: ree.slug }))).total).toBe(1);

    await adminRees.restoreRee(reviewer, ree.id, 'Rights cleared');
    const [up] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
    expect(up).toMatchObject({ isPublic: true, moderatedAt: null });
    expect(await profileVectors(ree.id)).toBeGreaterThan(0);
    expect((await notices.listNotices(owner, 1)).items.map((n) => n.kind)).toEqual(['restore', 'takedown']);
    expect((await adminAudit.listAudit(await consoleAdministrator(), auditView({ action: 'ree.takedown', q: ree.id }))).total).toBe(1);
    await expect(adminRees.restoreRee(reviewer, ree.id, 'again')).rejects.toMatchObject({ code: 'stale' });
  });
});

describeWithDb('purchase chart', () => {
  it('sums every matching payment by UTC+8 hour, day and month, whatever the page, with the list’s filters', async () => {
    const tag = uniqueName('fin');
    const userId = await newUser(tag);
    const payment = (index: number, status: 'paid' | 'refunded' | 'chargeback', amountMinor: number, at: string) => ({
      userId,
      kind: 'pack' as const,
      paddleTransactionId: `${tag}-${index}`,
      status,
      amountMinor,
      credits: 1000,
      createdAt: new Date(at),
    });
    await db()
      .insert(schema.purchase)
      .values([
        payment(0, 'paid', 2000, '2026-10-30T15:59:59Z'),
        payment(1, 'paid', 10, '2026-10-30T16:00:00Z'),
        payment(2, 'paid', 20, '2026-10-30T16:30:00Z'),
        payment(3, 'refunded', 1000, '2026-10-31T15:59:59Z'),
        payment(4, 'paid', 4000, '2026-10-31T16:00:00Z'),
        payment(5, 'chargeback', 333, '2026-10-02T03:00:00Z'),
        ...Array.from({ length: 45 }, (_, index) => payment(10 + index, 'paid', 101, '2026-10-05T04:00:00Z')),
      ]);
    const now = new Date();

    const day = purchasesView({ q: tag, period: 'day', date: '2026-10-31' }, now);
    expect((await adminPurchases.listPurchases(await consoleAdministrator(), day)).total).toBe(3);
    const hourly = await adminPurchases.purchaseTrend(await consoleAdministrator(), day, now);
    expect(hourly.bars).toHaveLength(24);
    expect(hourly.bars[0]!.values.paid).toEqual({ count: 2, cents: 30 });
    expect(hourly.bars[23]!.values.refunded).toEqual({ count: 1, cents: 1000 });

    let reference: unknown;
    for (const size of ['20', '50', '100']) {
      const view = purchasesView({ q: tag, period: 'month', date: '2026-10-01', size, page: '2' }, now);
      const list = await adminPurchases.listPurchases(await consoleAdministrator(), view);
      const trend = await adminPurchases.purchaseTrend(await consoleAdministrator(), view, now);
      expect(list.total).toBe(50);
      expect(trend.bars).toHaveLength(31);
      expect(trend.totals).toEqual({ paid: { count: 48, cents: 2030 + 45 * 101 }, refunded: { count: 1, cents: 1000 }, chargeback: { count: 1, cents: 333 } });
      expect(trend.bars[4]!.values.paid).toEqual({ count: 45, cents: 45 * 101 });
      if (reference) expect(trend.totals).toEqual(reference);
      reference = trend.totals;
    }

    const refunded = await adminPurchases.purchaseTrend(await consoleAdministrator(), purchasesView({ q: tag, status: 'refunded', period: 'month', date: '2026-10-01' }, now), now);
    expect(refunded.totals.paid.count).toBe(0);
    expect(refunded.totals.refunded.count).toBe(1);

    const all = await adminPurchases.purchaseTrend(await consoleAdministrator(), purchasesView({ q: tag }, now), now);
    const counted = all.keys.reduce((sum, key) => sum + all.totals[key].count, 0);
    expect(counted).toBe(51);
    expect(all.missingTime).toBe(0);
    expect(all.bars.length).toBeLessThanOrEqual(24);
    const november = all.bars.find((bar) => bar.start <= Date.parse('2026-10-31T16:00:00Z') && Date.parse('2026-10-31T16:00:00Z') < bar.end)!;
    expect(november.values.paid.cents).toBeGreaterThanOrEqual(4000);
  });
});

describeWithDb('statistics', () => {
  it('counts answers and income inside UTC+8 day, week and month boundaries', async () => {
    const owner = await newUser();
    const asker = await newUser();
    const ree = await publicRee(owner, { ready: 2 });
    const entry = (at: string, reason: 'query_base' | 'query_fee_earned', delta: number, userId: string) =>
      db().insert(schema.creditEntry).values({ userId, reason, delta, reeId: ree.id, refId: crypto.randomUUID(), createdAt: new Date(at) });
    /* 2026-12-31 23:59 and 2027-01-01 00:00 in UTC+8. */
    await entry('2026-12-31T15:59:00Z', 'query_base', 0, asker);
    await entry('2026-12-31T16:00:00Z', 'query_base', 0, asker);
    await entry('2026-12-31T16:00:00Z', 'query_fee_earned', 50, owner);
    await entry('2026-11-30T16:30:00Z', 'query_base', 0, asker);

    const at = (params: Record<string, string>) => statistics.reeStatistics(ree.id, statistics.statisticsQuery(params, new Date('2027-01-10T00:00:00Z')), { withIncome: true });
    expect((await at({ period: 'day', date: '2026-12-31' })).answers).toBe(1);
    expect((await at({ period: 'day', date: '2027-01-01' })).answers).toBe(1);
    expect((await at({ period: 'month', date: '2026-12-05' })).answers).toBe(2);
    expect((await at({ period: 'month', date: '2027-01-05' })).income).toBe(50);
    /* Monday 2026-12-28 to Sunday 2027-01-03. */
    expect((await at({ period: 'week', date: '2027-01-02' })).answers).toBe(2);
    expect((await at({ period: 'custom', start: '2026-12-01', end: '2026-12-01' })).answers).toBe(1);
    const all = await at({});
    expect(all).toMatchObject({ answers: 3, income: 50, sources: { total: 2, ready: 2 } });
    expect(all.trend).toBeNull();
    const day = await at({ period: 'day', date: '2027-01-01' });
    expect(day.trend!.bars).toHaveLength(24);
    expect(day.trend!.bars[0]!.value).toBe(1);
    const hidden = await statistics.reeStatistics(ree.id, statistics.statisticsQuery({ view: 'income' }), { withIncome: false });
    expect(hidden).toMatchObject({ income: 0, incomeList: null, query: { view: 'answers' } });
  });
});

describeWithDb('embedding switch', () => {
  it('keeps retrieval on the old vectors until done, falls back on failure, then switches at once', async () => {
    const reviewer = await newAdministrator();
    await db().update(schema.reembedJob).set({ status: 'failed' }).where(eq(schema.reembedJob.status, 'running'));
    await db().update(schema.modelConfig).set({ enabled: false }).where(eq(schema.modelConfig.kind, 'embedding'));
    const owner = await newUser();
    const indexed = await publicRee(owner, { ready: 3 });
    await profile.refreshProfile(indexed.id);
    expect(await profileVectors(indexed.id)).toBeGreaterThan(0);
    const [old] = await db()
      .insert(schema.modelConfig)
      .values({ name: 'old', kind: 'embedding', transport: 'openai_compatible', baseUrl: fake.baseUrl, model: 'fake-embed', enabled: true })
      .returning();
    const [broken] = await db()
      .insert(schema.modelConfig)
      .values({ name: 'broken', kind: 'embedding', transport: 'openai_compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'nothing', timeoutMs: 1000 })
      .returning();
    forgetModelCache();
    const before = await db().select({ id: schema.chunk.id, embedding: schema.chunk.embedding }).from(schema.chunk).limit(5);

    const failing = await models.activateModelConfig(reviewer, broken!.id);
    expect(failing).toMatchObject({ activated: false, reembed: true });
    await expect(models.activateModelConfig(reviewer, broken!.id)).rejects.toMatchObject({ code: 'job_running' });
    expect((await endpointFor('embedding')).configId).toBe(old!.id);
    const failed = await reembed.runReembed(30_000);
    expect(failed!.status).toBe('failed');
    expect((await endpointFor('embedding', Date.now() + 120_000)).configId).toBe(old!.id);
    expect(await db().select({ id: schema.chunk.id }).from(schema.chunk).where(isNotNull(schema.chunk.embeddingNext)).limit(1)).toHaveLength(0);

    const [next] = await db()
      .insert(schema.modelConfig)
      .values({ name: 'next', kind: 'embedding', transport: 'openai_compatible', baseUrl: fake.baseUrl, model: 'fake-embed-2' })
      .returning();
    const started = await reembed.startReembed(reviewer, next!.id);
    expect(started).toMatchObject({ status: 'running', done: 0 });
    /* The candidate is frozen while its vectors are being made. */
    await expect(models.updateModelConfig(reviewer, next!.id, { name: 'next', transport: 'openai_compatible', baseUrl: fake.baseUrl, model: 'other-embed', timeoutMs: 60000 })).rejects.toMatchObject({ code: 'locked' });
    /* Mid-job: nothing that answers has changed. */
    const unchanged = await db().select({ id: schema.chunk.id, embedding: schema.chunk.embedding }).from(schema.chunk).where(inArray(schema.chunk.id, before.map((row) => row.id)));
    expect(unchanged.map((row) => row.embedding)).toEqual(before.map((row) => row.embedding));
    const done = await reembed.runReembed(120_000);
    expect(done!.status).toBe('done');
    expect(done!.done).toBe(done!.total);
    forgetModelCache();
    expect((await endpointFor('embedding')).configId).toBe(next!.id);
    const [{ n }] = (await db().select({ n: sql<number>`count(*)::int` }).from(schema.chunk).where(isNotNull(schema.chunk.embeddingNext))) as [{ n: number }];
    expect(n).toBe(0);
    /* Step 4's profiles were rebuilt with the new model after the switch. */
    const stale = await db().select({ id: schema.reeProfileVector.id }).from(schema.reeProfileVector).where(lt(schema.reeProfileVector.updatedAt, done!.finishedAt!));
    expect(stale).toHaveLength(0);
    expect(await profileVectors(indexed.id)).toBeGreaterThan(0);
    expect((await adminAudit.listAudit(await consoleAdministrator(), auditView({ action: 'model.reembed.done' }))).total).toBeGreaterThan(0);
    expect((await adminAudit.listAudit(await consoleAdministrator(), auditView({ action: 'model.reembed.failed' }))).total).toBeGreaterThan(0);
    /* Leave the environment's model in charge for the files that follow. */
    await db().update(schema.modelConfig).set({ enabled: false }).where(eq(schema.modelConfig.kind, 'embedding'));
    forgetModelCache();
  }, 60_000);
});

describeWithDb('notices', () => {
  it('lists newest first and marks read', async () => {
    const userId = await newUser();
    await notices.notify(db(), { userId, kind: 'takedown', text: 'one', params: { ree: 'A' } });
    await notices.notify(db(), { userId, kind: 'restore', text: 'two', params: { ree: 'A' } });
    expect(await notices.unreadNotices(userId)).toBe(2);
    const listed = await notices.listNotices(userId, 1);
    expect(await notices.markNoticesRead(userId, [listed.items[0]!.id])).toBe(1);
    expect(await notices.unreadNotices(userId)).toBe(1);
    const stranger = await newUser();
    expect(await notices.markNoticesRead(stranger, 'all')).toBe(0);
    expect(await notices.markNoticesRead(userId, 'all')).toBe(1);
    expect(await notices.unreadNotices(userId)).toBe(0);
  });
});

describeWithDb('administrators', () => {
  it('invites, enrols once with password and TOTP, and disables', async () => {
    const owner = await newAdministrator('owner');
    const email = `${uniqueName('invitee')}@example.test`;
    const { id, token } = await administrators.inviteAdministrator(owner, { name: 'Invitee', email });
    await expect(administrators.inviteAdministrator(owner, { name: 'Again', email })).rejects.toMatchObject({ code: 'email_taken' });
    const challenge = await administrators.enrolmentChallenge(token);
    expect(challenge).toMatchObject({ name: 'Invitee', email });
    const code = await totpCode(challenge!.secret);
    await administrators.acceptInvite({ token, password: 'correct horse battery', sealedSecret: challenge!.sealedSecret, code });
    expect(await administrators.enrolmentChallenge(token)).toBeNull();
    const listed = (await administrators.listAdministrators(await consoleAdministrator())).find((row) => row.id === id);
    expect(listed).toMatchObject({ status: 'active', role: 'administrator' });
    await expect(administrators.disableAdministrator(id, id)).rejects.toMatchObject({ code: 'self' });
    await administrators.disableAdministrator(owner, id);
    expect((await administrators.listAdministrators(await consoleAdministrator())).find((row) => row.id === id)!.status).toBe('disabled');
    expect((await adminAudit.listAudit(await consoleAdministrator(), auditView({ action: 'admin.create', q: id }))).total).toBe(1);
    void admin;
  });
});

describeWithDb('verification queue', () => {
  it('opens on pending, oldest first', async () => {
    const view = verificationsView({});
    const list = await roles.listVerifications(view);
    const times = list.items.map((item) => item.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(list.items.every((item) => item.status === 'pending')).toBe(true);
  });
});

/** RFC 6238, computed independently of the code under test. */
async function totpCode(secret: string, at = new Date()): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secret) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  let counter = totpCounter(at);
  const message = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    message[i] = counter & 255;
    counter = Math.floor(counter / 256);
  }
  const key = await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[19]! & 15;
  const binary = ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}
