/**
 * Visitor asks on the share page (lib/services/visitor-asks.ts): off by
 * default; on, a signed-out visitor's question is a public post by 访客,
 * answered by that Ree alone, its base fee held from the owner when asked
 * and settled or given back with the answer. Every limit -- per visitor
 * (fingerprint and cookie), per address, the owner's daily total -- and
 * the owner's balance refuse before anything is held or counted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName, uniqueWord } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { ProcessDeps } from '@/lib/services/posts';
import type { Visitor } from '@/lib/services/visitor-asks';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let token: string | undefined;
const later: (() => unknown)[] = [];
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 're0_session' && token ? { value: token } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: (task: () => unknown) => void later.push(task) }));

const { createSession, sessionTokenHash } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const posts = await import('@/lib/services/posts');
const visitorAsks = await import('@/lib/services/visitor-asks');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE } = await import('@/lib/constants');
const { VISITOR_ASK_NOTE } = await import('@/lib/domain/visitor-ask');
const askRoute = await import('@/app/api/share/[slug]/ask/route');
const { answersByOthers, reeCards } = await import('@/lib/services/explore');
const { publicReeBySlug } = await import('@/lib/services/public-rees');
const { computeRanks } = await import('@/lib/services/rank');
const { savedCounts } = await import('@/lib/services/statistics');
const { roleMetrics } = await import('@/lib/services/roles');
const followups = await import('@/lib/services/post-followups');
const reeRoute = await import('@/app/api/rees/[id]/route');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await fake?.close();
});

async function user(prefix: string, credits = 0) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return { userId };
}

/** Requests from now on are signed in as this user. */
async function signIn(userId: string) {
  token = crypto.randomUUID();
  await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId, expiresAt: new Date(Date.now() + 60_000) });
}

/** A public Ree whose owner has `credits`, visitor asks as given (off unless `perVisitor` is). */
async function shared(credits: number, settings: { perVisitor?: number; perDay?: number | null; queryFee?: number } = {}) {
  const owner = await user('va-owner', credits);
  await rees.saveDraft(owner.userId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(owner.userId);
  await db()
    .update(schema.ree)
    .set({ isPublic: true, isPublished: true, queryFee: settings.queryFee ?? 0, ...(settings.perVisitor ? { visitorAsks: true, visitorAsksPerVisitor: settings.perVisitor, visitorAsksPerDay: settings.perDay ?? null } : {}) })
    .where(eq(schema.ree.id, ree.id));
  return { ownerId: owner.userId, reeId: ree.id, slug: ree.slug };
}

let visitors = 0;
/** A browser: its own fingerprint, cookie and (unless given) address. */
function browser(ip?: string): Visitor {
  visitors += 1;
  const n = visitors;
  return { fingerprint: n.toString(16).padStart(64, 'a'), visitorId: crypto.randomUUID(), ip: ip ?? `198.51.${Math.floor(n / 250) % 250}.${(n % 250) + 1}` };
}

const QUESTION = 'When are refunds issued to the original payment method?';
const approve = async () => ({ publish: true });
const refuse = async () => ({ publish: false });
const answered: ProcessDeps['answerOne'] = async () => ({ state: 'answered', text: 'Within 14 days [1].', citations: [], model: 'stub' });

async function postRow(id: string) {
  const [row] = await db().select().from(schema.post).where(eq(schema.post.id, id));
  return row!;
}

async function ownerEntries(ownerId: string) {
  return db().select({ reason: schema.creditEntry.reason, delta: schema.creditEntry.delta, note: schema.creditEntry.note, reeId: schema.creditEntry.reeId }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, ownerId), like(schema.creditEntry.reason, 'query_%'))).orderBy(schema.creditEntry.createdAt);
}

async function ask(slug: string, who = browser(), question = `${QUESTION} ${uniqueWord('ask')}`) {
  return visitorAsks.askAsVisitor(slug, { question, lang: 'en' }, who);
}

describeWithDb('visitor asks on the share page', () => {
  it('are off by default: refused as closed, nothing held or written', async () => {
    const ree = await shared(500);
    expect(await ask(ree.slug)).toEqual({ ok: false, error: 'closed' });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500);
    expect((await visitorAsks.visitorAskStatus(ree.slug, browser()))?.open).toBe(false);
  });

  it('publishes a 访客 post the owner pays for, answered by this Ree alone, the base fee settled on the owner', async () => {
    const ree = await shared(500, { perVisitor: 3 });
    const other = await shared(500);
    const who = browser();
    const asked = await ask(ree.slug, who);
    if (!asked.ok) throw new Error(asked.error);
    const row = await postRow(asked.id);
    expect(row).toMatchObject({ source: 'visitor', userId: null, visibility: 'public', status: 'pending', mentionReeId: ree.reeId, sponsorId: ree.ownerId });
    expect(row.visitorKey).not.toContain(who.visitorId);
    /* Held when asked. */
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - QUERY_BASE_FEE);
    let matched = false;
    await posts.processPost(asked.id, {
      judge: approve,
      match: async () => {
        matched = true;
        return { answerers: [{ reeId: other.reeId, similarity: 0.9, mentioned: false }], candidates: 1, skipped: 0, vector: null };
      },
      answerOne: answered,
    });
    /* Never matched to other Rees. */
    expect(matched).toBe(false);
    const answers = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, asked.id));
    expect(answers.map((entry) => [entry.reeId, entry.state, entry.price])).toEqual([[ree.reeId, 'answered', QUERY_BASE_FEE]]);
    expect(await postRow(asked.id)).toMatchObject({ status: 'published', answerState: 'done', answerCount: 1 });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - QUERY_BASE_FEE);
    expect(await balanceOf(db(), other.ownerId)).toBe(500);
    /* The owner's ledger says it was a visitor's question, for this Ree. */
    expect(await ownerEntries(ree.ownerId)).toEqual([
      { reason: 'query_hold', delta: -QUERY_BASE_FEE, note: VISITOR_ASK_NOTE, reeId: ree.reeId },
      { reason: 'query_base', delta: 0, note: `${VISITOR_ASK_NOTE} · charged ${QUERY_BASE_FEE} of ${QUERY_BASE_FEE}`, reeId: ree.reeId },
    ]);
    /* No AI general answer for a visitor's question. */
    expect(await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.postId, asked.id))).toEqual([]);
    /* Shown as a visitor's post, and followed by the browser that asked. */
    expect((await posts.getPost(asked.id))?.author).toEqual({ kind: 'visitor' });
    const status = await visitorAsks.visitorAskStatus(ree.slug, who);
    expect(status).toMatchObject({ open: true, limit: 3, remaining: 2, blocked: null });
    expect(status?.asked.map((entry) => [entry.id, entry.state, entry.answer])).toEqual([[asked.id, 'answered', 'Within 14 days [1].']]);
    /* Another browser sees none of it. */
    expect((await visitorAsks.visitorAskStatus(ree.slug, browser()))?.asked).toEqual([]);
  });

  it('gives the hold back when the question is refused in review, or the Ree has no answer', async () => {
    const ree = await shared(500, { perVisitor: 5 });
    const refused = await ask(ree.slug);
    const empty = await ask(ree.slug);
    if (!refused.ok || !empty.ok) throw new Error('not asked');
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - 2 * QUERY_BASE_FEE);
    await posts.processPost(refused.id, { judge: refuse, answerOne: answered });
    expect(await postRow(refused.id)).toMatchObject({ status: 'rejected' });
    await posts.processPost(empty.id, { judge: approve, answerOne: async () => ({ state: 'no_answer', model: 'stub' }) });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500);
    expect((await ownerEntries(ree.ownerId)).map((entry) => entry.reason).sort()).toEqual(['query_hold', 'query_hold', 'query_refund', 'query_refund']);
  });

  it('gives the hold back when the Ree went private before it could answer', async () => {
    const ree = await shared(500, { perVisitor: 5 });
    const asked = await ask(ree.slug);
    if (!asked.ok) throw new Error(asked.error);
    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, ree.reeId));
    await posts.processPost(asked.id, { judge: approve, answerOne: answered });
    expect(await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, asked.id))).toEqual([]);
    expect(await balanceOf(db(), ree.ownerId)).toBe(500);
  });

  it('gives the hold back when the post is taken down after review but before its Ree answered, and a restore then charges nobody', async () => {
    const ree = await shared(500, { perVisitor: 5 });
    const asked = await ask(ree.slug);
    if (!asked.ok) throw new Error(asked.error);
    /* Review publishes it; the request's background work dies before the answer, and it is taken down. */
    expect(await posts.moderatePost(asked.id, approve)).toBe('published');
    await db().update(schema.post).set({ status: 'hidden', hiddenBy: 'admin' }).where(eq(schema.post.id, asked.id));
    await posts.processPost(asked.id, { judge: approve, answerOne: answered });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - QUERY_BASE_FEE);
    /* The posts sweep's step gives it back, once. */
    expect(await posts.releaseHiddenVisitorHolds()).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(db(), ree.ownerId)).toBe(500);
    expect((await ownerEntries(ree.ownerId)).map((entry) => [entry.reason, entry.note])).toEqual([['query_hold', VISITOR_ASK_NOTE], ['query_refund', VISITOR_ASK_NOTE]]);
    await posts.releaseHiddenVisitorHolds();
    expect(await balanceOf(db(), ree.ownerId)).toBe(500);
    /* Restored, it runs, but there is nothing left to pay with: no answer, no charge. */
    await db().update(schema.post).set({ status: 'published', hiddenBy: null }).where(eq(schema.post.id, asked.id));
    await posts.processPost(asked.id, { judge: approve, answerOne: answered });
    expect(await postRow(asked.id)).toMatchObject({ answerState: 'done', answerCount: 0 });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500);
  });

  it("counts an answered visitor question in the Ree's public answers, its cards, the hourly rank and the owner's records, but not its role metrics", async () => {
    const ree = await shared(500, { perVisitor: 5 });
    const answeredOne = await ask(ree.slug);
    const unanswered = await ask(ree.slug);
    if (!answeredOne.ok || !unanswered.ok) throw new Error('not asked');
    await posts.processPost(answeredOne.id, { judge: approve, answerOne: answered });
    await posts.processPost(unanswered.id, { judge: approve, answerOne: async () => ({ state: 'no_answer', model: 'stub' }) });
    const [counted] = await db().select({ answers: answersByOthers }).from(schema.ree).where(eq(schema.ree.id, ree.reeId));
    expect(counted?.answers).toBe(1);
    expect((await reeCards([ree.reeId]))[0]?.answers).toBe(1);
    expect((await publicReeBySlug(ree.slug))?.answers).toBe(1);
    /* The hourly rank counts it like any other question: asked twice, answered once. */
    await computeRanks();
    const [ranked] = await db().select({ rank: schema.ree.rank }).from(schema.ree).where(eq(schema.ree.id, ree.reeId));
    expect(ranked?.rank).toMatchObject({ asked30: 2, answered30: 1, answersAll: 1, asked7: 2 });
    /* The owner's statistics keep it as a record on file. */
    expect((await savedCounts([ree.reeId], null)).get(ree.reeId)).toBe(1);
    /* A role is earned from questions people paid for: not the visitor's, which the owner paid... */
    expect((await roleMetrics(db(), ree.ownerId)).externalQuestions).toBe(0);
    /* ...but a follow-up a signed-in reader asks under it, and pays for, counts. */
    const reader = await user('va-follower', 500);
    const asked = await followups.askFollowup(reader.userId, answeredOne.id, { question: 'And for a gift card?', mentionReeIds: [ree.reeId], lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    await followups.processFollowup(asked.id, { judge: approve, answerOne: answered });
    expect((await roleMetrics(db(), ree.ownerId)).externalQuestions).toBe(1);
  });

  it("charges the owner's own paid Ree the base fee only, never its query fee", async () => {
    const ree = await shared(500, { perVisitor: 5, queryFee: 50 });
    const asked = await ask(ree.slug);
    if (!asked.ok) throw new Error(asked.error);
    await posts.processPost(asked.id, { judge: approve, answerOne: answered });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - QUERY_BASE_FEE);
    const [entry] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, asked.id));
    expect(entry).toMatchObject({ state: 'answered', feeHoldId: null });
  });

  it("holds a visitor to the owner's daily limit by fingerprint and by cookie, nothing held past it", async () => {
    const ree = await shared(500, { perVisitor: 2 });
    const who = browser();
    expect((await ask(ree.slug, who)).ok).toBe(true);
    expect((await ask(ree.slug, who)).ok).toBe(true);
    expect(await ask(ree.slug, who)).toEqual({ ok: false, error: 'visitor_limit' });
    /* A new cookie with the same fingerprint, or the same cookie with a new fingerprint, is still them. */
    expect(await ask(ree.slug, { ...who, visitorId: crypto.randomUUID() })).toEqual({ ok: false, error: 'visitor_limit' });
    expect(await ask(ree.slug, { ...who, fingerprint: 'f'.repeat(64) })).toEqual({ ok: false, error: 'visitor_limit' });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - 2 * QUERY_BASE_FEE);
    expect(await visitorAsks.visitorAskStatus(ree.slug, who)).toMatchObject({ remaining: 0, blocked: 'visitor_limit' });
    /* Another visitor, and the same visitor on another Ree, are counted apart. */
    expect((await ask(ree.slug)).ok).toBe(true);
    /* (From another address: this one has asked five times this minute, `VISITOR_ASK_IP_PER_MINUTE`.) */
    const elsewhere = await shared(500, { perVisitor: 1 });
    expect((await ask(elsewhere.slug, { ...who, ip: browser().ip })).ok).toBe(true);
    expect(await ask(ree.slug, who)).toEqual({ ok: false, error: 'network_limit' });
  });

  it('holds one address to three visitors’ worth a day, and refuses a request without one', async () => {
    const ree = await shared(500, { perVisitor: 1 });
    const ip = '203.0.113.77';
    for (let n = 0; n < 3; n += 1) expect((await ask(ree.slug, browser(ip))).ok).toBe(true);
    expect(await ask(ree.slug, browser(ip))).toEqual({ ok: false, error: 'network_limit' });
    expect(await ask(ree.slug, { ...browser(), ip: null })).toEqual({ ok: false, error: 'network_limit' });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - 3 * QUERY_BASE_FEE);
  });

  it("stops at the owner's daily total", async () => {
    const ree = await shared(500, { perVisitor: 5, perDay: 2 });
    expect((await ask(ree.slug)).ok).toBe(true);
    expect((await ask(ree.slug)).ok).toBe(true);
    const third = browser();
    expect(await ask(ree.slug, third)).toEqual({ ok: false, error: 'capacity' });
    expect(await visitorAsks.visitorAskStatus(ree.slug, third)).toMatchObject({ remaining: 5, blocked: 'capacity' });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - 2 * QUERY_BASE_FEE);
  });

  it("refuses when the owner's balance cannot pay, never overdrawing, and counts nothing", async () => {
    const ree = await shared(QUERY_BASE_FEE + 5, { perVisitor: 3 });
    const who = browser();
    expect((await ask(ree.slug, who)).ok).toBe(true);
    expect(await ask(ree.slug, who)).toEqual({ ok: false, error: 'owner_credits', reeId: ree.reeId });
    expect(await balanceOf(db(), ree.ownerId)).toBe(5);
    /* The refused question took no place: they still have two today, and the box says why they cannot use them. */
    expect(await visitorAsks.visitorAskStatus(ree.slug, who)).toMatchObject({ remaining: 2, blocked: 'owner_credits' });
    const written = await db().select({ id: schema.post.id }).from(schema.post).where(and(eq(schema.post.source, 'visitor'), eq(schema.post.mentionReeId, ree.reeId)));
    expect(written).toHaveLength(1);
  });

  it('publishes the same text from the same browser once', async () => {
    const ree = await shared(500, { perVisitor: 3 });
    const who = browser();
    const first = await ask(ree.slug, who, QUESTION);
    const again = await ask(ree.slug, who, QUESTION);
    if (!first.ok || !again.ok) throw new Error('not asked');
    expect(again).toEqual({ ok: true, id: first.id, duplicate: true });
    expect(await balanceOf(db(), ree.ownerId)).toBe(500 - QUERY_BASE_FEE);
  });

  describe('the route', () => {
    const request = (slug: string, body: unknown, headers: Record<string, string> = {}) =>
      new NextRequest(`http://localhost:3000/api/share/${slug}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-real-ip': '192.0.2.10', ...headers },
        body: JSON.stringify(body),
      });
    const call = (slug: string, body: unknown, headers?: Record<string, string>) => askRoute.POST(request(slug, body, headers), { params: Promise.resolve({ slug }) });

    it('asks for a visitor, sets the cookie, and runs the post after the response', async () => {
      token = undefined;
      const ree = await shared(500, { perVisitor: 3 });
      later.length = 0;
      const response = await call(ree.slug, { question: QUESTION, fingerprint: 'b'.repeat(64), lang: 'en' });
      expect(response.status).toBe(201);
      expect(response.headers.get('set-cookie')).toContain('re0_visitor=');
      expect(later).toHaveLength(1);
      const { id } = (await response.json()) as { id: string };
      expect(await postRow(id)).toMatchObject({ source: 'visitor', status: 'pending' });
    });

    it('refuses a signed-in user, another origin, a closed Ree and a missing fingerprint', async () => {
      const ree = await shared(500, { perVisitor: 3 });
      const closed = await shared(500);
      expect((await call(ree.slug, { question: QUESTION, fingerprint: 'c'.repeat(64) }, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await call(closed.slug, { question: QUESTION, fingerprint: 'c'.repeat(64) })).status).toBe(403);
      expect((await call(ree.slug, { question: QUESTION, fingerprint: 'nope' })).status).toBe(422);
      const signedIn = await user('va-reader', 100);
      await signIn(signedIn.userId);
      const response = await call(ree.slug, { question: QUESTION, fingerprint: 'c'.repeat(64) });
      token = undefined;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'signed_in' });
    });

    it("answers 402 when the owner's balance is short", async () => {
      const ree = await shared(0, { perVisitor: 3 });
      const response = await call(ree.slug, { question: QUESTION, fingerprint: 'd'.repeat(64) }, { 'x-real-ip': '192.0.2.11' });
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({ error: 'owner_credits' });
    });
  });

  describe('channels', () => {
    /* Letters only: a digit run in a tag reads as a phone number and is redacted out of it (post-channels.test.ts). */
    const tag = (prefix: string) => `${prefix}${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => String.fromCharCode(97 + (byte % 26))).join('')}`;
    const channelNamed = (name: string) => db().select().from(schema.channel).where(eq(schema.channel.name, name));
    const listed = async (name: string) => (await posts.listFeed('latest', { channel: name })).items.map((item) => item.id);

    it("files a visitor's question under a channel that exists, listed there once review publishes it", async () => {
      const ree = await shared(500, { perVisitor: 5 });
      const name = tag('garden');
      await db().insert(schema.channel).values({ name, createdBy: null });
      const asked = await ask(ree.slug, browser(), `Which roses suit clay soil? #${name}`);
      if (!asked.ok) throw new Error(asked.error);
      /* Filed at once, not listed while under review. */
      expect((await db().select().from(schema.postChannel).where(eq(schema.postChannel.postId, asked.id))).length).toBe(1);
      expect(await listed(name)).toEqual([]);
      expect(await posts.moderatePost(asked.id, approve)).toBe('published');
      expect(await listed(name)).toEqual([asked.id]);
      expect((await posts.getPost(asked.id))?.channels).toEqual([name]);
    });

    it('never makes a channel from a visitor\'s tag', async () => {
      const ree = await shared(500, { perVisitor: 5 });
      const name = tag('newtopic');
      const asked = await ask(ree.slug, browser(), `Anyone? #${name}`);
      if (!asked.ok) throw new Error(asked.error);
      expect(await channelNamed(name)).toEqual([]);
      expect(await db().select().from(schema.postChannel).where(eq(schema.postChannel.postId, asked.id))).toEqual([]);
      await posts.moderatePost(asked.id, approve);
      expect((await posts.getPost(asked.id))?.channels).toEqual([]);
    });

    it('reads the tags after redaction: a phone number in a tag is cut out before the channel is looked up', async () => {
      const ree = await shared(500, { perVisitor: 5 });
      const name = tag('call');
      await db().insert(schema.channel).values({ name, createdBy: null });
      const asked = await ask(ree.slug, browser(), `Who can help? #${name}13812345678`);
      if (!asked.ok) throw new Error(asked.error);
      expect((await postRow(asked.id)).question).not.toContain('13812345678');
      expect(await channelNamed(`${name}13812345678`)).toEqual([]);
      await posts.moderatePost(asked.id, approve);
      expect((await posts.getPost(asked.id))?.channels).toEqual([name]);
    });
  });

  describe("telling the owner when their balance turns visitors away", () => {
    const noticesOf = (ownerId: string) => db().select({ kind: schema.notice.kind, params: schema.notice.params, refId: schema.notice.refId }).from(schema.notice).where(and(eq(schema.notice.userId, ownerId), eq(schema.notice.kind, 'visitor_ask_paused')));
    const request = (slug: string, method: 'GET' | 'POST', ip: string, body?: unknown) =>
      new NextRequest(`http://localhost:3000/api/share/${slug}/ask`, {
        method,
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-real-ip': ip, 'x-re0-fp': 'e'.repeat(64) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const runLater = async () => {
      const tasks = later.splice(0);
      await Promise.all(tasks.map((task) => task()));
      return tasks.length;
    };

    it('writes one notice for many refusals in a day, through the ask and the status, however they race', async () => {
      token = undefined;
      const ree = await shared(0, { perVisitor: 5 });
      later.length = 0;
      for (let n = 0; n < 3; n += 1) {
        const response = await askRoute.POST(request(ree.slug, 'POST', `192.0.2.${40 + n}`, { question: `${QUESTION} ${n}`, fingerprint: n.toString(16).padStart(64, 'c') }), { params: Promise.resolve({ slug: ree.slug }) });
        expect(response.status).toBe(402);
      }
      /* The box's status says the same, and also tells the owner: a blocked box never sends. */
      const status = await askRoute.GET(request(ree.slug, 'GET', '192.0.2.50'), { params: Promise.resolve({ slug: ree.slug }) });
      expect(await status.json()).toMatchObject({ blocked: 'owner_credits' });
      /* Each was scheduled after its response; run together, they race. */
      expect(await runLater()).toBe(4);
      await Promise.all(Array.from({ length: 5 }, () => visitorAsks.tellOwnerVisitorsBlocked(ree.reeId)));
      const written = await noticesOf(ree.ownerId);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ refId: ree.reeId, params: { reeId: ree.reeId, fee: QUERY_BASE_FEE } });
    });

    it('writes nothing when visitor asks are off, the refusal has another cause, or the balance was topped up since', async () => {
      token = undefined;
      const off = await shared(0);
      expect(await visitorAsks.tellOwnerVisitorsBlocked(off.reeId)).toBe(false);
      later.length = 0;
      expect((await askRoute.POST(request(off.slug, 'POST', '192.0.2.60', { question: QUESTION, fingerprint: 'f'.repeat(64) }), { params: Promise.resolve({ slug: off.slug }) })).status).toBe(403);
      /* A visitor over their own limit, on a Ree whose owner can pay. */
      const paying = await shared(500, { perVisitor: 1 });
      expect((await askRoute.POST(request(paying.slug, 'POST', '192.0.2.61', { question: QUESTION, fingerprint: 'f'.repeat(64) }), { params: Promise.resolve({ slug: paying.slug }) })).status).toBe(201);
      expect((await askRoute.POST(request(paying.slug, 'POST', '192.0.2.61', { question: `${QUESTION} again`, fingerprint: 'f'.repeat(64) }), { params: Promise.resolve({ slug: paying.slug }) })).status).toBe(429);
      /* Only the accepted question's post work was scheduled; no notice task. */
      expect(later).toHaveLength(1);
      later.length = 0;
      expect(await visitorAsks.tellOwnerVisitorsBlocked(paying.reeId)).toBe(false);
      expect([...(await noticesOf(off.ownerId)), ...(await noticesOf(paying.ownerId))]).toEqual([]);
    });

    it('may tell them again on a later day', async () => {
      const ree = await shared(0, { perVisitor: 5 });
      const today = new Date();
      expect(await visitorAsks.tellOwnerVisitorsBlocked(ree.reeId, today)).toBe(true);
      expect(await visitorAsks.tellOwnerVisitorsBlocked(ree.reeId, today)).toBe(false);
      const tomorrow = new Date(today.getTime() + 86_400_000);
      expect(await visitorAsks.tellOwnerVisitorsBlocked(ree.reeId, tomorrow)).toBe(true);
      expect(await visitorAsks.tellOwnerVisitorsBlocked(ree.reeId, tomorrow)).toBe(false);
      expect(await noticesOf(ree.ownerId)).toHaveLength(2);
    });
  });

  it("saves the owner's settings with the rest of the form, checks them, and leaves them alone when not sent", async () => {
    const ree = await shared(500);
    const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.reeId));
    const form = { name: row!.name, description: row!.description, category: row!.category, tags: row!.tags, systemPrompt: row!.systemPrompt, sampleQuestions: row!.sampleQuestions, queryFee: row!.queryFee, isPublic: true, color: row!.color, avatarBlob: null };
    const patch = (body: unknown) =>
      reeRoute.PATCH(new NextRequest(`http://localhost:3000/api/rees/${ree.reeId}`, { method: 'PATCH', headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: ree.reeId }) });
    await signIn(ree.ownerId);
    const saved = await patch({ ...form, visitorAskSettings: { enabled: true, perVisitor: 7, perDay: 30 } });
    expect(saved.status).toBe(200);
    expect((await saved.json()).ree).toMatchObject({ visitorAsks: true, visitorAsksPerVisitor: 7, visitorAsksPerDay: 30 });
    const tooMany = await patch({ ...form, visitorAskSettings: { enabled: true, perVisitor: 51, perDay: null } });
    expect(tooMany.status).toBe(422);
    expect(await tooMany.json()).toMatchObject({ error: 'visitor_ask_per_visitor' });
    expect((await patch({ ...form, visitorAskSettings: { enabled: true, perVisitor: 3, perDay: 0 } })).status).toBe(422);
    /* A form without them (another client) changes nothing of them. */
    expect((await patch(form)).status).toBe(200);
    expect(await db().select({ on: schema.ree.visitorAsks, per: schema.ree.visitorAsksPerVisitor, day: schema.ree.visitorAsksPerDay }).from(schema.ree).where(eq(schema.ree.id, ree.reeId))).toEqual([{ on: true, per: 7, day: 30 }]);
    /* Empty total: none of the owner's own. */
    expect((await patch({ ...form, visitorAskSettings: { enabled: false, perVisitor: 3, perDay: '' } })).status).toBe(200);
    expect(await db().select({ on: schema.ree.visitorAsks, day: schema.ree.visitorAsksPerDay }).from(schema.ree).where(eq(schema.ree.id, ree.reeId))).toEqual([{ on: false, day: null }]);
    token = undefined;
  });
});
