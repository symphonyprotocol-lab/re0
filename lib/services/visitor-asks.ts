/**
 * Visitor asks on the share page (lib/domain/visitor-ask.ts says what they
 * are; docs/visitor-asks.md why).
 *
 * Asking (`askAsVisitor`), in one transaction, all or nothing:
 *   1. a question is counted under every key it falls under, each a row of
 *      `anonymous_chat_quota` for the UTC day -- the browser fingerprint and
 *      the `re0_visitor` cookie (each at the owner's per-visitor limit), the
 *      client address (IPv6 by /64, `VISITOR_ASK_NETWORK_FACTOR` times it;
 *      required, as the one key a script cannot make up), the owner's daily
 *      total when they set one, and the platform's (`visitorAsksPerDay`).
 *      Visitor keys are HMACs (`quotaKeyHash`) under the Ree, so the raw
 *      values are never stored and one Ree's count is not another's. A key's
 *      count rises only while under its limit (a conditional upsert), keys
 *      taken in one global order, so concurrent questions never pass a
 *      limit nor deadlock. Every question accepted counts, answered or not:
 *      nothing is given back, so refusals and refunds cannot be farmed;
 *   2. the base fee is held from the owner (`post_answer`, noted
 *      `VISITOR_ASK_NOTE`), or the question is refused (`owner_credits`) --
 *      the balance is never overdrawn;
 *   3. the post is written (`source = 'visitor'`, pending), with the hold
 *      and an HMAC of the cookie, so this browser can follow it.
 * Then the posts pipeline takes it (posts.ts `processPost`): reviewed like
 * any post (refused → the hold given back), answered by this Ree alone,
 * the hold moved onto the answer and settled when it answers, given back
 * when it does not (`closeAnswer`, `finishPost`). No AI general answer.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { anonymousDay, ipBucket } from '@/lib/domain/anonymous-chat';
import { InsufficientCredits } from '@/lib/domain/credits';
import { POST_DUPLICATE_WINDOW_MS, POST_PREVIEW_CHARS, postInputError } from '@/lib/domain/post';
import { plainOf, previewOf, redact } from '@/lib/domain/public-qa';
import {
  VISITOR_ASK_IP_PER_MINUTE,
  VISITOR_ASK_LIST_DAYS,
  VISITOR_ASK_LIST_MAX,
  VISITOR_ASK_NETWORK_FACTOR,
  VISITOR_ASK_NOTE,
  type VisitorAskRefusal,
  type VisitorAskState,
  type VisitorAskStatus,
  type VisitorAskView,
} from '@/lib/domain/visitor-ask';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { db, schema, type Tx } from '@/lib/infra/db';
import { quotaKeyHash } from '@/lib/services/anonymous-chat';
import { balanceOf, placeHold } from '@/lib/services/credits';
import { publicRee } from '@/lib/services/explore';
import { hitRateBucket } from '@/lib/services/rate-limit';
import { effectiveCeiling } from '@/lib/services/rate-limit-settings';

const { post, postAnswer: answer, ree } = schema;

/** What a visitor brings: the fingerprint their browser computed (lib/client/fingerprint.ts), the `re0_visitor` cookie and the client address. */
export interface Visitor {
  fingerprint: string;
  visitorId: string;
  ip: string | null;
}

/** A fingerprint as lib/client/fingerprint.ts makes one: SHA-256 hex, or the 28-character fallback. */
export function validFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{28,64}$/.test(value);
}

interface AskableRee {
  id: string;
  ownerId: string;
  name: string;
  perVisitor: number;
  perDay: number | null;
}

/** The Ree a visitor may ask on its share page now: public, and its owner lets visitors ask. */
async function askableRee(slug: string): Promise<AskableRee | null> {
  if (typeof slug !== 'string' || !slug || slug.length > 200) return null;
  const [row] = await db()
    .select({ id: ree.id, ownerId: ree.ownerId, name: ree.name, perVisitor: ree.visitorAsksPerVisitor, perDay: ree.visitorAsksPerDay })
    .from(ree)
    .where(and(eq(ree.slug, slug), publicRee(), eq(ree.visitorAsks, true)))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ quota */

type Scope = 'visitor' | 'network' | 'capacity';

interface QuotaKey {
  hash: string;
  scope: Scope;
  limit: number;
}

/** The browser's key for following its own questions: the cookie's HMAC (never the raw id). */
export function visitorKeyOf(visitorId: string): Promise<string> {
  return quotaKeyHash('id', visitorId);
}

/** Every key one question to this Ree counts under (see the head of this file). */
async function keysFor(target: AskableRee, visitor: Visitor & { ip: string }): Promise<QuotaKey[]> {
  const prefix = `va:${target.id}:`;
  const keys: QuotaKey[] = [
    { hash: prefix + (await quotaKeyHash('fp', visitor.fingerprint)), scope: 'visitor', limit: target.perVisitor },
    { hash: prefix + (await visitorKeyOf(visitor.visitorId)), scope: 'visitor', limit: target.perVisitor },
    { hash: prefix + (await quotaKeyHash('ip', ipBucket(visitor.ip))), scope: 'network', limit: target.perVisitor * VISITOR_ASK_NETWORK_FACTOR },
    { hash: 'va:all', scope: 'capacity', limit: await effectiveCeiling('visitorAsksPerDay') },
  ];
  if (target.perDay !== null) keys.push({ hash: `${prefix}all`, scope: 'capacity', limit: target.perDay });
  return keys;
}

async function countsOf(keys: readonly QuotaKey[], day: string): Promise<Map<string, number>> {
  const rows = await db()
    .select({ hash: schema.anonymousChatQuota.keyHash, rounds: schema.anonymousChatQuota.rounds })
    .from(schema.anonymousChatQuota)
    .where(and(inArray(schema.anonymousChatQuota.keyHash, keys.map((key) => key.hash)), eq(schema.anonymousChatQuota.day, day)));
  return new Map(rows.map((row) => [row.hash, row.rounds]));
}

class QuotaFull extends Error {
  constructor(readonly scope: Scope) {
    super(`visitor ask ${scope} limit reached`);
  }
}

/** Takes one question on every key, in the caller's transaction, or throws `QuotaFull` naming the first full one (the transaction then takes none). */
async function takeKeys(tx: Tx, keys: readonly QuotaKey[], day: string): Promise<void> {
  const ordered = [...keys].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  for (const key of ordered) {
    const result = await tx.execute(sql`
      insert into anonymous_chat_quota (key_hash, day, rounds, attempts) values (${key.hash}, ${day}, 1, 1)
      on conflict (key_hash, day) do update
        set rounds = anonymous_chat_quota.rounds + 1, attempts = anonymous_chat_quota.attempts + 1, updated_at = now()
        where anonymous_chat_quota.rounds < ${key.limit}
      returning rounds`);
    const row = result.rows[0] as { rounds?: unknown } | undefined;
    /* A first row for a key whose limit is below 1 cannot happen (limits are at least 1); a full key returns nothing. */
    if (typeof row?.rounds !== 'number' || row.rounds > key.limit) throw new QuotaFull(key.scope);
  }
}

/* ----------------------------------------------------------------- asking */

export type VisitorAskOutcome =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; error: VisitorAskRefusal | 'empty' | 'too_long' | 'invalid_visitor' };

/**
 * A visitor's question to the Ree whose share page this is (`slug`). Not
 * for a signed-in user (the route refuses them: they post as themselves).
 * Idempotent like a post: the same text from the same browser within
 * `POST_DUPLICATE_WINDOW_MS` returns the question already made.
 */
export async function askAsVisitor(slug: string, input: { question: string; lang: 'zh' | 'en' }, visitor: Visitor, now = new Date()): Promise<VisitorAskOutcome> {
  const invalid = postInputError(input.question, '');
  if (invalid) return { ok: false, error: invalid };
  if (!validFingerprint(visitor.fingerprint) || !visitor.visitorId) return { ok: false, error: 'invalid_visitor' };
  /* Without an address only keys the client makes up would count it. */
  const ip = visitor.ip?.trim();
  if (!ip) return { ok: false, error: 'network_limit' };
  if (!(await hitRateBucket(`visitor-ask:ip:${ipBucket(ip)}`, VISITOR_ASK_IP_PER_MINUTE, 60, now))) return { ok: false, error: 'network_limit' };
  const target = await askableRee(slug);
  if (!target) return { ok: false, error: 'closed' };
  const question = redact(input.question.trim(), input.lang);
  const visitorKey = await visitorKeyOf(visitor.visitorId);
  const keys = await keysFor(target, { ...visitor, ip });
  const day = anonymousDay(now);
  const id = randomUUID();
  try {
    return await db().transaction(async (tx) => {
      /* One browser's questions to one Ree, one at a time: a double submit is the same question. */
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`visitor-ask:${target.id}:${visitorKey}`}))`);
      const [same] = await tx
        .select({ id: post.id })
        .from(post)
        .where(and(eq(post.source, 'visitor'), eq(post.mentionReeId, target.id), eq(post.visitorKey, visitorKey), eq(post.question, question), gte(post.createdAt, new Date(now.getTime() - POST_DUPLICATE_WINDOW_MS))))
        .limit(1);
      if (same) return { ok: true, id: same.id, duplicate: true } as const;
      await takeKeys(tx, keys, day);
      const holdId = await placeHold(tx, { userId: target.ownerId, kind: 'post', ledger: 'post_answer', amount: QUERY_BASE_FEE, refId: id, reeId: target.id, note: VISITOR_ASK_NOTE }, now);
      await tx.insert(post).values({
        id,
        userId: null,
        source: 'visitor',
        visibility: 'public',
        question,
        lang: input.lang,
        mentionReeId: target.id,
        sponsorId: target.ownerId,
        sponsorHoldId: holdId,
        visitorKey,
        createdAt: now,
      });
      return { ok: true, id } as const;
    });
  } catch (error) {
    if (error instanceof QuotaFull) return { ok: false, error: error.scope === 'visitor' ? 'visitor_limit' : error.scope === 'network' ? 'network_limit' : 'capacity' };
    if (error instanceof InsufficientCredits) return { ok: false, error: 'owner_credits' };
    throw error;
  }
}

/* ---------------------------------------------------------------- reading */

/** What the visitor sees of one question, from its post and this Ree's first-round answer. */
export function visitorAskState(row: { status: string; answerState: string; answer: { state: string; hidden: boolean } | null }): VisitorAskState {
  if (row.status === 'pending') return 'reviewing';
  if (row.status !== 'published') return 'rejected';
  if (row.answer?.state === 'answered' && !row.answer.hidden) return 'answered';
  if (row.answerState !== 'done' || row.answer?.state === 'answering' || row.answer?.state === 'queued') return 'answering';
  return 'no_answer';
}

/**
 * The box's state for this browser: whether the owner lets visitors ask,
 * how many questions it has left today (the fewest any of its keys leaves),
 * what stops it when something does, and its questions of the last
 * `VISITOR_ASK_LIST_DAYS` days.
 */
export async function visitorAskStatus(slug: string, visitor: Visitor, now = new Date()): Promise<VisitorAskStatus | null> {
  const [target] = await db()
    .select({ id: ree.id, ownerId: ree.ownerId, open: ree.visitorAsks, perVisitor: ree.visitorAsksPerVisitor, perDay: ree.visitorAsksPerDay })
    .from(ree)
    .where(and(eq(ree.slug, slug), publicRee()))
    .limit(1);
  if (!target) return null;
  const visitorKey = await visitorKeyOf(visitor.visitorId);
  const asked = await askedBy(target.id, visitorKey, now);
  if (!target.open) return { open: false, remaining: 0, limit: target.perVisitor, blocked: 'closed', asked };
  const ip = visitor.ip?.trim();
  const keys = validFingerprint(visitor.fingerprint) && ip ? await keysFor({ id: target.id, ownerId: target.ownerId, name: '', perVisitor: target.perVisitor, perDay: target.perDay }, { ...visitor, ip }) : null;
  if (!keys) return { open: true, remaining: target.perVisitor, limit: target.perVisitor, blocked: ip ? null : 'network_limit', asked };
  const counts = await countsOf(keys, anonymousDay(now));
  const left = (key: QuotaKey) => Math.max(0, key.limit - (counts.get(key.hash) ?? 0));
  const remaining = Math.min(target.perVisitor, ...keys.filter((key) => key.scope === 'visitor').map(left));
  const full = (scope: Scope) => keys.some((key) => key.scope === scope && left(key) === 0);
  const blocked: VisitorAskRefusal | null = remaining === 0
    ? 'visitor_limit'
    : full('capacity')
      ? 'capacity'
      : full('network')
        ? 'network_limit'
        : (await balanceOf(db(), target.ownerId, now)) < QUERY_BASE_FEE
          ? 'owner_credits'
          : null;
  return { open: true, remaining, limit: target.perVisitor, blocked, asked };
}

async function askedBy(reeId: string, visitorKey: string, now: Date): Promise<VisitorAskView[]> {
  const rows = await db()
    .select({
      id: post.id,
      question: post.question,
      status: post.status,
      answerState: post.answerState,
      createdAt: post.createdAt,
      answerStateOf: answer.state,
      hiddenBy: answer.hiddenBy,
      text: answer.text,
    })
    .from(post)
    .leftJoin(answer, and(eq(answer.postId, post.id), eq(answer.reeId, reeId), sql`${answer.followupId} is null`))
    .where(and(eq(post.source, 'visitor'), eq(post.mentionReeId, reeId), eq(post.visitorKey, visitorKey), gte(post.createdAt, new Date(now.getTime() - VISITOR_ASK_LIST_DAYS * 86_400_000))))
    .orderBy(desc(post.createdAt))
    .limit(VISITOR_ASK_LIST_MAX);
  return rows.map((row) => {
    const state = visitorAskState({ status: row.status, answerState: row.answerState, answer: row.answerStateOf ? { state: row.answerStateOf, hidden: row.hiddenBy !== null } : null });
    return {
      id: row.id,
      question: row.question,
      state,
      answer: state === 'answered' && row.text ? previewOf(plainOf(row.text), POST_PREVIEW_CHARS).answer : null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** Visitor questions to this Ree today (UTC), for its settings. */
export async function visitorAsksToday(reeId: string, now = new Date()): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(post)
    .where(and(eq(post.source, 'visitor'), eq(post.mentionReeId, reeId), gte(post.createdAt, new Date(`${anonymousDay(now)}T00:00:00Z`))));
  return row?.n ?? 0;
}
