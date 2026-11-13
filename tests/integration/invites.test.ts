import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { resetRewardSettings, TEST_DATABASE_URL, uniqueName } from './setup';
import { db, schema } from '@/lib/infra/db';
import { INVITE_DEFAULTS } from '@/lib/constants';
import { beginOAuth, completeOAuth, createSession, type IdentityAdapter } from '@/lib/services/auth';
import { balanceOf, creditQueryFee, placeHold, settleHold } from '@/lib/services/credits';
import { payoutFunding } from '@/lib/services/payout-funding';
import * as callback from '@/app/api/auth/[provider]/callback/route';
import { HANDSHAKE_COOKIE } from '@/lib/http/cookies';
import { NextRequest } from 'next/server';
import { ensureInviteCode, inviteLanding, inviteOverview, invitePanel, rewardSettings, saveRewardSettings, userInvites } from '@/lib/services/invites';
import { dismissTaskGuide, taskGuide } from '@/lib/services/task-rewards';
import { setReePublished } from '@/lib/services/rees';
import { addReeComment } from '@/lib/services/ree-comments';
import { holdQuestion } from '@/lib/services/answer';
import { testConversation } from '@/lib/services/chat';
import type { Administrator } from '@/lib/services/admin';
import { checkIn, checkInStatus } from '@/lib/services/check-in';
import { checkInDay } from '@/lib/domain/invites';
import { payoutStanding, requestPayout, setPaypalEmail, withdrawable } from '@/lib/services/payouts';
import * as kyc from '@/lib/services/kyc';
import { PAYOUT_MIN_CREDITS } from '@/lib/constants';
import { reportingDate } from '@/lib/domain/statistics';

vi.mock('@/lib/infra/blob-access', () => ({
  blobInfo: async () => ({ size: 200_000, contentType: 'image/png' }),
  signedReadUrl: async (pathname: string) => ({ url: `https://blob.test/${pathname}`, expiresAt: new Date(Date.now() + 60_000) }),
  listByPrefix: async () => ({ blobs: [], cursor: null }),
}));

function kycForm(userId: string) {
  return {
    legalName: 'Mei Lin',
    country: 'Malaysia',
    documentKind: 'passport',
    documentLast4: '2048',
    documentExpires: reportingDate(Date.now() + 365 * 86_400_000),
    taxForm: 'W-8BEN',
    declared: true,
    consent: true,
    documentBlob: `kyc/${userId}/${randomUUID()}.png`,
    selfieBlob: `kyc/${userId}/${randomUUID()}.png`,
  };
}

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const profile = (subject: string) => ({
  provider: 'github' as const,
  subject,
  handle: subject,
  email: `${subject}@example.test`,
  displayName: subject.slice(0, 20),
  avatarUrl: null,
});
const signUp = (name: string, invite?: unknown) => createSession(profile(uniqueName(name)), 'en', '/rees', new Date(), { invite });

const ON = {
  invitesEnabled: true,
  withdrawableInvites: 1_000,
  inviteCredits: 5_000,
  firstReeCredits: 2_500,
  firstQuestionCredits: 1_000,
  firstCommentCredits: 1_000,
  checkInCredits: 1_500,
  checkInMaxDays: 30,
  checkInWindowMonths: 3,
};

describeWithDb('invitations and starter tasks', () => {
  let admin: Administrator;
  async function configure(changes: Partial<typeof ON>) {
    const current = await rewardSettings();
    return saveRewardSettings(admin.id, { ...ON, ...changes, revision: current.revision });
  }
  const attributed = async () => (await db().select({ n: count() }).from(schema.invitation))[0]!.n;
  const entriesOf = (userId: string, reason: (typeof schema.creditEntry.$inferSelect)['reason']) =>
    db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reason, reason)));

  beforeAll(async () => {
    /* No sign-up gift here, so balances are the rewards alone. */
    await db().insert(schema.signupReward).values({ id: 1, credits: 0 }).onConflictDoUpdate({ target: schema.signupReward.id, set: { credits: 0 } });
    const [row] = await db()
      .insert(schema.administrator)
      .values({ email: `${uniqueName('invite-admin')}@example.test`, name: 'Invite admin', role: 'owner', passwordHash: 'test', totpSecretCipher: 'test' })
      .returning();
    admin = row!;
    await configure({});
  });
  afterAll(async () => {
    await db().delete(schema.signupReward);
    await resetRewardSettings();
  });

  it('defaults before the first save, and validates and serialises saves with an audit entry', async () => {
    await db().delete(schema.rewardSettings);
    expect(await rewardSettings()).toEqual({ ...INVITE_DEFAULTS, revision: 'default' });
    for (const bad of [{ withdrawableInvites: -1 }, { checkInWindowMonths: 0 }, { checkInMaxDays: 3_651 }, { inviteCredits: 0.5 }, { firstReeCredits: 100_000_001 }, { invitesEnabled: 'yes' }, { firstCommentCredits: '10' }]) {
      await expect(saveRewardSettings(admin.id, { ...ON, ...bad, revision: 'default' })).rejects.toMatchObject({ code: 'invalid_reward_settings' });
    }
    const results = await Promise.allSettled([
      saveRewardSettings(admin.id, { ...ON, revision: 'default' }),
      saveRewardSettings(admin.id, { ...ON, inviteCredits: 1, revision: 'default' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'pricing_conflict' } });
    const saved = await configure({});
    expect(await rewardSettings()).toEqual(saved);
    const entries = await db()
      .select()
      .from(schema.adminAudit)
      .where(and(eq(schema.adminAudit.action, 'rewards.update'), eq(schema.adminAudit.administratorId, admin.id)));
    const entry = entries.find((row) => (row.before as { revision?: string }).revision === 'default');
    expect(entry).toMatchObject({ target: 'rewards', before: { ...INVITE_DEFAULTS, revision: 'default' } });
  });

  it('gives every account one invite code, created with the account or on first read, safely under a race', async () => {
    const fresh = await signUp('coded');
    const [own] = await db().select().from(schema.inviteCode).where(eq(schema.inviteCode.userId, fresh.userId));
    expect(own!.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    /* An account older than invitations: no code until it is read, then one, the same for every concurrent reader. */
    const [old] = await db().insert(schema.user).values({ name: 'Old', email: 'old@example.test', provider: 'github', providerSubject: uniqueName('old') }).returning();
    const codes = await Promise.all(Array.from({ length: 5 }, () => ensureInviteCode(db(), old!.id)));
    expect(new Set(codes).size).toBe(1);
    expect(await db().select().from(schema.inviteCode).where(eq(schema.inviteCode.userId, old!.id))).toHaveLength(1);
  });

  it('attributes a new account to its inviter in the registration and pays the inviter withdrawable credits', async () => {
    const inviter = await signUp('inviter');
    const code = await ensureInviteCode(db(), inviter.userId);
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
    expect(await inviteLanding(typed)).toMatchObject({ state: 'open', code, inviterName: expect.any(String) });
    const invitee = await signUp('invitee', typed);
    expect(invitee).toMatchObject({ created: true, invitation: 'withdrawable' });
    const [row] = await db().select().from(schema.invitation).where(eq(schema.invitation.inviteeId, invitee.userId));
    expect(row).toMatchObject({ inviterId: inviter.userId, code, rewardCredits: 5_000, withdrawable: true });

    const [entry] = await entriesOf(inviter.userId, 'invite_reward');
    expect(entry).toMatchObject({ delta: 5_000, refId: invitee.userId, reeId: null });
    const [grant] = await db().select().from(schema.creditGrant).where(eq(schema.creditGrant.id, entry!.allocations[0]!.grantId));
    expect(grant).toMatchObject({ source: 'earned', amount: 5_000, fundingPurchaseId: null, purchaseId: null });
    expect(grant!.withdrawableAt).not.toBeNull();
    expect(await withdrawable(db(), inviter.userId)).toBe(5_000);

    /* Signing in again, with this or another code, is not a second invitation. */
    const [inviteeProfile] = await db().select().from(schema.user).where(eq(schema.user.id, invitee.userId));
    const back = await createSession({ ...profile(inviteeProfile!.providerSubject), subject: inviteeProfile!.providerSubject }, 'en', '/rees', new Date(), { invite: code });
    expect(back).toMatchObject({ created: false, invitation: 'none' });
    expect(await db().select().from(schema.invitation).where(eq(schema.invitation.inviterId, inviter.userId))).toHaveLength(1);

    /* An unknown or malformed code never blocks signing up. */
    for (const bad of ['ZZZZZZZZ', 'not a code', 42]) {
      const user = await signUp('unknown-code', bad);
      expect(user).toMatchObject({ created: true, invitation: 'unknown' });
    }
    /* A disabled inviter's code no longer counts. */
    await db().update(schema.user).set({ disabledAt: new Date() }).where(eq(schema.user.id, inviter.userId));
    expect(await signUp('after-disable', code)).toMatchObject({ invitation: 'unknown' });
    await db().update(schema.user).set({ disabledAt: null }).where(eq(schema.user.id, inviter.userId));

    const panel = await invitePanel(inviter.userId);
    expect(panel).toMatchObject({ code, state: 'open', total: 1, earnedWithdrawable: 5_000, earnedGift: 0, inviteCredits: 5_000, withdrawableOpen: true });
    expect(panel.invitees).toHaveLength(1);
    expect(await userInvites(admin, invitee.userId)).toMatchObject({ invitedBy: { id: inviter.userId, code }, invited: 0 });
    expect(await userInvites(admin, inviter.userId)).toMatchObject({ invitedBy: null, invited: 1, credits: 5_000, code });
  });

  it('carries the invite through the OAuth round trip', async () => {
    const inviter = await signUp('oauth-inviter');
    const code = await ensureInviteCode(db(), inviter.userId);
    const subject = uniqueName('oauth-invitee');
    let state = '';
    const adapter: IdentityAdapter = {
      authorizeUrl: (input) => {
        state = input.state;
        return 'https://provider.example.test/authorize';
      },
      exchange: async () => profile(subject),
    };
    const started = await beginOAuth({ provider: 'github', returnTo: '/rees', redirectUri: 'http://localhost/cb', invite: code.toLowerCase(), adapter });
    const result = await completeOAuth({ provider: 'github', code: 'code', state, sealedHandshake: started.handshake, redirectUri: 'http://localhost/cb', lang: 'en', adapter });
    expect(result).toMatchObject({ created: true, invitation: 'withdrawable' });
    expect(await db().select().from(schema.invitation).where(eq(schema.invitation.inviteeId, result.userId))).toHaveLength(1);
  });

  it('pays exactly the quota of withdrawable invite rewards under concurrent sign-ups, and gift credits after it', async () => {
    const inviter = await signUp('quota-inviter');
    const code = await ensureInviteCode(db(), inviter.userId);
    const counts = async () => {
      const [row] = await db().select({ all: count(), withdrawable: sql<number>`count(*) filter (where withdrawable)::int` }).from(schema.invitation);
      return { all: row!.all, withdrawable: row!.withdrawable };
    };
    const before = await counts();
    await configure({ withdrawableInvites: before.withdrawable + 3 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => signUp(`quota-${index}`, code)));
    /* Every one is attributed and paid; exactly three withdrawable. */
    expect(results.every((result) => result.created)).toBe(true);
    expect(results.filter((result) => result.invitation === 'withdrawable')).toHaveLength(3);
    expect(results.filter((result) => result.invitation === 'gift')).toHaveLength(5);
    expect(await counts()).toEqual({ all: before.all + 8, withdrawable: before.withdrawable + 3 });
    expect(await entriesOf(inviter.userId, 'invite_reward')).toHaveLength(3);
    expect(await entriesOf(inviter.userId, 'invite_reward_gift')).toHaveLength(5);
    expect(await balanceOf(db(), inviter.userId)).toBe(8 * 5_000);
    /* A payout can draw only on the three withdrawable ones. */
    expect(await withdrawable(db(), inviter.userId)).toBe(3 * 5_000);
    await expect(
      db().transaction((tx) => placeHold(tx, { userId: inviter.userId, kind: 'payout', amount: 3 * 5_000 + 1, refId: randomUUID(), sources: ['earned'], withdrawableOnly: true })),
    ).rejects.toThrow();
    const panel = await invitePanel(inviter.userId);
    expect(panel).toMatchObject({ total: 8, earnedWithdrawable: 15_000, earnedGift: 25_000, withdrawableOpen: false, state: 'open' });
    expect(panel.invitees.filter((invitee) => invitee.withdrawable)).toHaveLength(3);
    expect(await inviteLanding(code)).toMatchObject({ state: 'open' });

    /* Lowering the quota changes nothing already paid; raising it converts nothing, and pays the next ones withdrawable again. */
    await configure({ withdrawableInvites: 1 });
    expect(await signUp('below-quota', code)).toMatchObject({ created: true, invitation: 'gift' });
    expect(await withdrawable(db(), inviter.userId)).toBe(3 * 5_000);
    await configure({ withdrawableInvites: before.withdrawable + 4 });
    expect(await withdrawable(db(), inviter.userId)).toBe(3 * 5_000);
    expect(await signUp('raised-quota', code)).toMatchObject({ invitation: 'withdrawable' });
    expect(await withdrawable(db(), inviter.userId)).toBe(4 * 5_000);

    /* Switched off: sign-ups go on, unattributed and unpaid. */
    await configure({ invitesEnabled: false });
    expect(await inviteLanding(code)).toMatchObject({ state: 'closed' });
    expect(await signUp('closed', code)).toMatchObject({ created: true, invitation: 'closed' });
    expect((await counts()).all).toBe(before.all + 10);

    /* An invite reward of 0 still attributes, pays nothing, and uses no withdrawable place. */
    await configure({ inviteCredits: 0, withdrawableInvites: 1_000_000 });
    const unpaid = await signUp('unpaid', code);
    expect(unpaid.invitation).toBe('unpaid');
    const [row] = await db().select().from(schema.invitation).where(eq(schema.invitation.inviteeId, unpaid.userId));
    expect(row).toMatchObject({ rewardCredits: 0, withdrawable: false });

    const overview = await inviteOverview(admin);
    expect(overview).toMatchObject({ attributed: before.all + 11, withdrawableUsed: before.withdrawable + 4, state: 'open' });
    expect(overview.inviters.find((entry) => entry.id === inviter.userId)).toMatchObject({ invited: 11, credits: 50_000 });
    await configure({});
  });

  it('puts withdrawable invite rewards through every payout gate, with no maturity wait', async () => {
    const reviewer = admin.id;
    const inviter = await signUp('payout-inviter');
    const code = await ensureInviteCode(db(), inviter.userId);
    const record = await kyc.submitKyc(inviter.userId, kycForm(inviter.userId));
    await kyc.decideKyc(reviewer, record.id, 'verified', { matched: true });
    await setPaypalEmail(inviter.userId, 'inviter@example.com');
    /* A paypal address set on the first try is not on hold. */
    const quota = (await db().select({ n: sql<number>`count(*) filter (where withdrawable)::int` }).from(schema.invitation))[0]!.n;
    await configure({ withdrawableInvites: quota + 10, inviteCredits: PAYOUT_MIN_CREDITS / 2 });
    await signUp('payout-invitee-1', code);
    expect(await withdrawable(db(), inviter.userId)).toBe(PAYOUT_MIN_CREDITS / 2);
    /* Below the minimum: refused like any other earnings. */
    expect((await payoutStanding(inviter.userId)).stage).toBe('threshold');
    await expect(requestPayout(inviter.userId, PAYOUT_MIN_CREDITS / 2)).rejects.toMatchObject({ code: 'below_minimum' });
    /* At the minimum, at once: no maturity period. */
    await signUp('payout-invitee-2', code);
    expect((await payoutStanding(inviter.userId)).stage).toBe('eligible');
    const payout = await requestPayout(inviter.userId, PAYOUT_MIN_CREDITS);
    expect(payout).toMatchObject({ credits: PAYOUT_MIN_CREDITS, status: 'pending' });
    expect(await withdrawable(db(), inviter.userId)).toBe(0);
    await configure({});
  });

  it('keeps the invite on every failed or cancelled OAuth callback, so a retry still counts it', async () => {
    const inviter = await signUp('callback-inviter');
    const code = await ensureInviteCode(db(), inviter.userId);
    const adapter: IdentityAdapter = { authorizeUrl: () => 'https://provider.example.test/authorize', exchange: async () => profile(uniqueName('never')) };
    const started = await beginOAuth({ provider: 'github', returnTo: '/rees', redirectUri: 'http://localhost/cb', invite: code, adapter });
    const call = (query: string, sealed: string | null = started.handshake) =>
      callback.GET(
        new NextRequest(`http://localhost:3000/api/auth/github/callback?${query}`, { headers: sealed ? { cookie: `${HANDSHAKE_COOKIE}=${sealed}` } : {} }),
        { params: Promise.resolve({ provider: 'github' }) },
      );
    for (const [query, error] of [
      ['error=access_denied', 'oauth_canceled'],
      ['error=server_error', 'oauth_failed'],
      ['code=x&state=not-the-state', 'oauth_failed'],
    ] as const) {
      const location = new URL((await call(query)).headers.get('location')!);
      expect(location.pathname).toBe('/login');
      expect(Object.fromEntries(location.searchParams)).toEqual({ error, invite: code });
    }
    /* No handshake (or one without an invite): the plain error, nothing invented. */
    expect(new URL((await call('error=access_denied', null)).headers.get('location')!).search).toBe('?error=oauth_canceled');
    /* Back on the login page with the code, the retry attributes as usual. */
    expect(await signUp('callback-retry', code)).toMatchObject({ invitation: 'withdrawable' });
  });

  it('shows invite-funded money in the payout review: drawn directly, and after a query fee', async () => {
    const quota = (await db().select({ n: sql<number>`count(*) filter (where withdrawable)::int` }).from(schema.invitation))[0]!.n;
    await configure({ withdrawableInvites: quota + 10, inviteCredits: 600_000 });
    const verified = async (name: string) => {
      const user = await signUp(name);
      const record = await kyc.submitKyc(user.userId, kycForm(user.userId));
      await kyc.decideKyc(admin.id, record.id, 'verified', { matched: true });
      await setPaypalEmail(user.userId, `${uniqueName(name)}@example.com`);
      return user;
    };

    /* Directly: the inviter's payout draws only on the invitation reward. */
    const inviter = await verified('funding-inviter');
    await signUp('funding-invitee', await ensureInviteCode(db(), inviter.userId));
    const direct = await requestPayout(inviter.userId, PAYOUT_MIN_CREDITS);
    const seen = (await payoutFunding(admin, direct.id, inviter.userId)).summary;
    expect(seen).toMatchObject({ drawn: PAYOUT_MIN_CREDITS, drawnInvite: PAYOUT_MIN_CREDITS, traced: 0, ownerInvited: 1 });
    expect(seen.flags).toContain('invite_funded');

    /* One hop: an invited account's withdrawable reward pays another owner's query fee; that owner's payout is invite-funded, not purchased. */
    const spender = await signUp('funding-spender');
    await signUp('funding-spender-invitee', await ensureInviteCode(db(), spender.userId));
    const owner = await verified('funding-owner');
    const [ree] = await db().insert(schema.ree).values({ ownerId: owner.userId, name: 'Hop', slug: uniqueName('hop'), queryFee: 10_000, isPublic: true, isPublished: true }).returning();
    const [conversation] = await db().insert(schema.conversation).values({ userId: spender.userId }).returning();
    const [question] = await db().insert(schema.message).values({ conversationId: conversation!.id, role: 'user', content: 'question' }).returning();
    const holdId = await db().transaction((tx) => placeHold(tx, { userId: spender.userId, kind: 'chat', ledger: 'chat_fee', amount: 600_000, refId: question!.id, reeId: ree!.id }));
    const replyId = randomUUID();
    await db().transaction(async (tx) => {
      const paid = await settleHold(tx, holdId, 600_000, { reeId: ree!.id, note: ree!.name, ledger: 'chat_fee' });
      await creditQueryFee(tx, { ownerId: owner.userId, reeId: ree!.id, reeName: ree!.name, replyId, allocations: paid!.chargedAllocations });
      await tx.insert(schema.message).values({ id: replyId, conversationId: conversation!.id, role: 'ree', reeId: ree!.id, content: 'answer', requestId: question!.id, costCredits: 600_000 });
    });
    const [earned] = await db().select().from(schema.creditGrant).where(and(eq(schema.creditGrant.userId, owner.userId), eq(schema.creditGrant.source, 'earned')));
    expect(earned).toMatchObject({ amount: 600_000, inviteFunded: true });
    /* Withdrawable on the usual terms: after the maturity period. */
    expect(await withdrawable(db(), owner.userId)).toBe(0);
    await db().update(schema.creditGrant).set({ withdrawableAt: new Date(Date.now() - 1_000) }).where(eq(schema.creditGrant.id, earned!.id));
    const hop = await requestPayout(owner.userId, 600_000);
    const review = (await payoutFunding(admin, hop.id, owner.userId)).summary;
    expect(review).toMatchObject({ drawn: 600_000, traced: 600_000, drawnInvite: 600_000, payers: 1 });
    expect(review.sources).toMatchObject({ invite: 600_000, paid: 0 });
    expect(review.flags).toContain('invite_funded');
    await configure({});
  });

  it('opens the check-in window for three calendar months from a month-end sign-up', async () => {
    await configure({});
    for (const [created, lastIn, firstOut] of [
      ['2026-11-30T04:00:00Z', '2027-02-28T03:59:59Z', '2027-02-28T04:00:00Z'],
      ['2027-01-31T04:00:00Z', '2027-04-30T03:59:59Z', '2027-04-30T04:00:00Z'],
    ] as const) {
      const user = await createSession(profile(uniqueName('month-end')), 'en', '/rees', new Date(created));
      expect((await checkInStatus(user.userId, new Date(created))).windowEndsAt.toISOString()).toBe(new Date(firstOut).toISOString());
      expect(await checkIn(user.userId, new Date(lastIn))).toMatchObject({ ok: true });
      expect(await checkIn(user.userId, new Date(new Date(firstOut).getTime() + 86_400_000))).toMatchObject({ ok: false, reason: 'expired' });
    }
  });

  it('pays one check-in per UTC+8 day, up to the maximum, within the window, as gift credits', async () => {
    await configure({ checkInCredits: 1_500, checkInMaxDays: 3, checkInWindowMonths: 3 });
    /* 2026-03-01 15:59:59Z is 23:59:59 that day in UTC+8; one second later is the next day there. */
    const created = new Date('2026-03-01T10:00:00Z');
    const user = await createSession(profile(uniqueName('checker')), 'en', '/rees', created);
    const late = new Date('2026-03-01T15:59:59Z');
    const next = new Date('2026-03-01T16:00:00Z');
    expect(checkInDay(late)).toBe('2026-03-01');
    expect(checkInDay(next)).toBe('2026-03-02');

    const first = await Promise.all([checkIn(user.userId, late), checkIn(user.userId, late), checkIn(user.userId, new Date('2026-03-01T01:00:00Z'))]);
    expect(first.filter((result) => result.ok)).toHaveLength(1);
    expect(first.filter((result) => !result.ok).map((result) => (result.ok ? null : result.reason))).toEqual(['done_today', 'done_today']);
    expect((await checkIn(user.userId, next)).ok).toBe(true);
    expect((await checkInStatus(user.userId, next)).state).toBe('done_today');
    /* Days need not be in a row. */
    const third = await checkIn(user.userId, new Date('2026-03-10T03:00:00Z'));
    expect(third).toMatchObject({ ok: true, status: { used: 3, state: 'finished' } });
    expect(await checkIn(user.userId, new Date('2026-03-11T03:00:00Z'))).toMatchObject({ ok: false, reason: 'finished' });
    expect(await entriesOf(user.userId, 'check_in')).toHaveLength(3);
    expect(await balanceOf(db(), user.userId)).toBe(4_500);
    expect(await withdrawable(db(), user.userId)).toBe(0);

    /* Raising the maximum lets them go on; the window still ends three months after sign-up. */
    await configure({ checkInCredits: 1_500, checkInMaxDays: 30, checkInWindowMonths: 3 });
    expect(await checkIn(user.userId, new Date('2026-05-31T15:59:00Z'))).toMatchObject({ ok: true });
    expect(await checkIn(user.userId, new Date('2026-06-01T10:00:00Z'))).toMatchObject({ ok: false, reason: 'expired' });

    /* An amount of 0 turns it off. */
    const fresh = await signUp('checker-off');
    await configure({ checkInCredits: 0 });
    expect(await checkIn(fresh.userId)).toMatchObject({ ok: false, reason: 'off' });
    expect(await db().select().from(schema.checkIn).where(eq(schema.checkIn.userId, fresh.userId))).toHaveLength(0);
    expect((await taskGuide(fresh.userId)).checkIn).toBeNull();
    await configure({});
    const guide = await taskGuide(fresh.userId);
    expect(guide.checkIn).toMatchObject({ state: 'available', credits: 1_500, maxDays: 30 });
    expect((await inviteOverview(admin)).checkIns.count).toBeGreaterThanOrEqual(4);
  });

  it('pays each starter task once, as gift credits that cannot be withdrawn, even under a race', async () => {
    const owner = await signUp('tasker');
    const [ree, second] = await db()
      .insert(schema.ree)
      .values([1, 2].map((index) => ({ ownerId: owner.userId, name: `Task Ree ${index}`, slug: uniqueName('task-ree'), isPublic: true })))
      .returning();

    /* First Ree: publishing two at once pays one reward; unpublishing and publishing again pays nothing more. */
    await Promise.all([setReePublished(owner.userId, ree!.id, true), setReePublished(owner.userId, second!.id, true)]);
    await setReePublished(owner.userId, ree!.id, false);
    await setReePublished(owner.userId, ree!.id, true);
    expect(await entriesOf(owner.userId, 'task_first_ree')).toHaveLength(1);

    /* First question: two questions at once, one reward. */
    const conversation = await testConversation(owner.userId, ree!.id);
    const asks = await Promise.all([1, 2].map((index) => holdQuestion({ userId: owner.userId, lang: 'en', conversation, targets: [ree! as never], question: `Question ${index}?` })));
    expect(asks.every((ask) => ask.ok)).toBe(true);
    expect(await entriesOf(owner.userId, 'task_first_question')).toHaveLength(1);

    /* First comment: a retried request and a second comment at once, one reward. */
    const author = { id: owner.userId, name: 'Tasker', avatarBlob: null };
    const commentId = randomUUID();
    await Promise.all([
      addReeComment(ree!.id, author, { id: commentId, content: 'First!' }),
      addReeComment(ree!.id, author, { id: commentId, content: 'First!' }),
      addReeComment(ree!.id, author, { id: randomUUID(), content: 'Second' }),
    ]);
    expect(await entriesOf(owner.userId, 'task_first_comment')).toHaveLength(1);

    const rewards = await db().select().from(schema.taskReward).where(eq(schema.taskReward.userId, owner.userId));
    expect(rewards.map((row) => [row.task, row.credits]).sort()).toEqual([
      ['first_comment', 1_000],
      ['first_question', 1_000],
      ['first_ree', 2_500],
    ]);
    const grantIds = (
      await db()
        .select()
        .from(schema.creditEntry)
        .where(and(eq(schema.creditEntry.userId, owner.userId), inArray(schema.creditEntry.reason, ['task_first_ree', 'task_first_question', 'task_first_comment'])))
    ).map((entry) => entry.allocations[0]!.grantId);
    const grants = await db().select().from(schema.creditGrant).where(inArray(schema.creditGrant.id, grantIds));
    expect(grants.every((grant) => grant.source === 'welcome' && grant.withdrawableAt === null)).toBe(true);
    /* Gift credits pay for questions, but a payout can never draw on them. */
    expect(await balanceOf(db(), owner.userId)).toBe(4_500);
    expect(await withdrawable(db(), owner.userId)).toBe(0);
    await expect(
      db().transaction((tx) => placeHold(tx, { userId: owner.userId, kind: 'payout', amount: 1, refId: randomUUID(), sources: ['earned'], withdrawableOnly: true })),
    ).rejects.toThrow();

    /* A deleted comment keeps its reward and does not pay again. */
    await db().delete(schema.reeComment).where(eq(schema.reeComment.userId, owner.userId));
    await addReeComment(ree!.id, author, { id: randomUUID(), content: 'Again' });
    expect(await entriesOf(owner.userId, 'task_first_comment')).toHaveLength(1);

    /* Every task done, but check-ins are still to be had: the guide stays until they are finished or it is dismissed. */
    const guide = await taskGuide(owner.userId);
    expect(guide.items.every((item) => item.done)).toBe(true);
    expect(guide).toMatchObject({ visible: true, checkIn: { state: 'available' } });
    await configure({ checkInCredits: 0 });
    expect((await taskGuide(owner.userId)).visible).toBe(false);
    await configure({});
  });

  it('reads amounts at the time of the action: 0 pays nothing and leaves the task open for later', async () => {
    await configure({ firstCommentCredits: 0, firstQuestionCredits: 3_333 });
    const user = await signUp('later');
    const [owner] = await db().insert(schema.user).values({ name: 'Owner', email: 'owner@example.test', provider: 'github', providerSubject: uniqueName('owner') }).returning();
    const [ree] = await db().insert(schema.ree).values({ ownerId: owner!.id, name: 'Public Ree', slug: uniqueName('public-ree'), isPublic: true, isPublished: true }).returning();
    const author = { id: user.userId, name: 'Later', avatarBlob: null };

    const before = await taskGuide(user.userId);
    expect(before.visible).toBe(true);
    expect(before.items.map((item) => item.key)).toEqual(['signup', 'first_ree', 'first_question']);
    expect(before.items.find((item) => item.key === 'first_question')).toMatchObject({ done: false, credits: 3_333 });
    expect(before.invite).toEqual({ credits: 5_000, withdrawable: true });

    await addReeComment(ree!.id, author, { id: randomUUID(), content: 'Unpaid' });
    expect(await entriesOf(user.userId, 'task_first_comment')).toHaveLength(0);
    await configure({ firstCommentCredits: 700, firstQuestionCredits: 3_333 });
    await addReeComment(ree!.id, author, { id: randomUUID(), content: 'Paid' });
    const [paid] = await entriesOf(user.userId, 'task_first_comment');
    expect(paid).toMatchObject({ delta: 700 });

    const conversation = await testConversation(user.userId, ree!.id);
    await holdQuestion({ userId: user.userId, lang: 'en', conversation, targets: [ree! as never], question: 'Does it pay?' });
    expect((await entriesOf(user.userId, 'task_first_question'))[0]).toMatchObject({ delta: 3_333 });
    expect(await balanceOf(db(), user.userId)).toBe(700 + 3_333);

    const after = await taskGuide(user.userId);
    expect(after.items.filter((item) => item.done).map((item) => item.key)).toEqual(['signup', 'first_question', 'first_comment']);
    expect(after.visible).toBe(true);
    await dismissTaskGuide(user.userId);
    expect((await taskGuide(user.userId)).visible).toBe(false);

    const overview = await inviteOverview(admin);
    expect(overview.tasks.find((row) => row.task === 'first_comment')!.accounts).toBeGreaterThanOrEqual(2);
    await configure({});
  });
});
