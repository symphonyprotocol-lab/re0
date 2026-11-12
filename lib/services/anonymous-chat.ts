/**
 * Anonymous chat with free Rees (beyond 4). A signed-out visitor may ask a
 * public, published Ree whose query fee is 0 on its public page, up to
 * `ANONYMOUS_ROUNDS_PER_DAY` answered questions per UTC day.
 *
 * - Eligibility is read from the Ree on every request: raising its fee, or
 *   making it private, ends anonymous chat with it at once.
 * - A question counts under several keys at once: the browser fingerprint
 *   and the httpOnly anonymous-id cookie (each at the visitor's daily
 *   limit), so clearing one does not reset the count; the client address,
 *   IPv6 by /64 (`ANONYMOUS_IP_ROUNDS_PER_DAY`), the only key a script
 *   cannot make up, so a request without one is refused; and the Ree and
 *   the platform (`ANONYMOUS_REE_ROUNDS_PER_DAY`,
 *   `ANONYMOUS_PLATFORM_ROUNDS_PER_DAY`), which bound what anonymous
 *   answers cost however many addresses ask. Only HMACs of the visitor's
 *   values are stored, under a key derived from AUTH_SECRET for this alone.
 * - A round and an attempt are reserved on every key before any model is
 *   called, with a conditional upsert that never lets a key pass either
 *   limit, however many requests race. A question that gets no answer and
 *   showed no text (no ready knowledge, out of scope, declined before
 *   writing, a failure before any text) gives the round back, never the
 *   attempt (`ANONYMOUS_ATTEMPTS_FACTOR`), so refunds cannot be farmed.
 *   Once any text was shown the round counts, whatever follows it.
 * - Nothing of the exchange is stored with a user: no conversation, no
 *   message, no hold or ledger entry. The visitor's browser keeps the
 *   transcript and sends recent turns back as context. Each answer leaves one
 *   `anonymous_answer` row so the owner's statistics count it -- and the
 *   share page's figures, when it was asked there by a browser that visited
 *   the share page (the same rule as a share conversion).
 * - The public page `/r/[slug]` and the share page `/s/[slug]` use the same
 *   endpoint and the same daily rounds.
 * - The platform bears the model cost of these answers (the base fee a
 *   signed-in asker would pay is not charged to anyone).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import {
  ANONYMOUS_ATTEMPTS_FACTOR,
  ANONYMOUS_IP_ROUNDS_PER_DAY,
  ANONYMOUS_PLATFORM_ROUNDS_PER_DAY,
  ANONYMOUS_REE_ROUNDS_PER_DAY,
  ANONYMOUS_ROUNDS_PER_DAY,
} from '@/lib/constants';
import { citationSnapshots } from '@/lib/domain/answer';
import { anonymousDay, ipBucket, type AnonymousScope, type AnonymousTurn } from '@/lib/domain/anonymous-chat';
import { TEXT_META_KEY, textPartId, type AnonymousQuota, type ReeOutcome, type ReeUIMessage } from '@/lib/domain/chat-message';
import { withoutMentions } from '@/lib/domain/conversation';
import { isUuid } from '@/lib/domain/list';
import { authSecret } from '@/lib/infra/crypto/secrets';
import { hmacSha256 } from '@/lib/infra/crypto/tokens';
import { db, schema } from '@/lib/infra/db';
import { readyRees, safe, streamGroundedAnswer, type Emit } from '@/lib/services/answer';
import { embedQuestion, retrieve } from '@/lib/services/chat';
import { publicRee } from '@/lib/services/explore';
import { generationForUser } from '@/lib/services/generation';
import { questionRewriter } from '@/lib/services/question-rewrite';
import type { Ree } from '@/lib/services/rees';

/* ------------------------------------------------------------ eligibility */

/** The Ree when a signed-out visitor may ask it now: public, published, not taken down or deleted, and free to ask. */
export async function freeReeForAnonymous(reeId: string): Promise<Ree | null> {
  if (!isUuid(reeId)) return null;
  const [row] = await db()
    .select()
    .from(schema.ree)
    .where(and(eq(schema.ree.id, reeId), publicRee(), eq(schema.ree.queryFee, 0)))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ quota */

export interface QuotaKey {
  /** `fp:`, `id:` or `ip:` and the HMAC of the value; `ree:<id>` for a Ree; `all:` for the platform. */
  hash: string;
  scope: AnonymousScope;
  /** Rounds per day. */
  limit: number;
  /** Attempts per day: rounds taken, given back or not. */
  attempts: number;
}

let derivedKey: Promise<string> | null = null;

/** A key for these HMACs only, so the stored values say nothing under any other use of AUTH_SECRET. */
function quotaKey(): Promise<string> {
  derivedKey ??= hmacSha256(authSecret(), 're0:anonymous-chat-quota:v1');
  return derivedKey;
}

export async function quotaKeyHash(kind: 'fp' | 'id' | 'ip', value: string): Promise<string> {
  return `${kind}:${await hmacSha256(await quotaKey(), `${kind}:${value}`)}`;
}

function key(hash: string, scope: AnonymousScope, limit: number): QuotaKey {
  return { hash, scope, limit, attempts: limit * ANONYMOUS_ATTEMPTS_FACTOR };
}

/**
 * Every key one question counts under: the visitor's fingerprint and
 * anonymous id, their address (IPv6 by /64), the Ree and the platform. The
 * address is required -- without it only keys the client makes up would be
 * left -- so the route refuses a request that has none.
 */
export async function visitorKeys(visitor: { fingerprint: string; anonymousId: string; ip: string; reeId: string }): Promise<QuotaKey[]> {
  return [
    key(await quotaKeyHash('fp', visitor.fingerprint), 'visitor', ANONYMOUS_ROUNDS_PER_DAY),
    key(await quotaKeyHash('id', visitor.anonymousId), 'visitor', ANONYMOUS_ROUNDS_PER_DAY),
    key(await quotaKeyHash('ip', ipBucket(visitor.ip)), 'network', ANONYMOUS_IP_ROUNDS_PER_DAY),
    key(`ree:${visitor.reeId}`, 'ree', ANONYMOUS_REE_ROUNDS_PER_DAY),
    key('all:', 'platform', ANONYMOUS_PLATFORM_ROUNDS_PER_DAY),
  ];
}

interface Counted {
  rounds: number;
  attempts: number;
}

/** How many more questions a key takes today: the fewer of its rounds and its attempts left. */
function left(key: QuotaKey, counted: Counted | undefined): number {
  return Math.max(0, Math.min(key.limit - (counted?.rounds ?? 0), key.attempts - (counted?.attempts ?? 0)));
}

/**
 * What the visitor sees: their own rounds left (the fewer of their keys'),
 * and `blocked` when their network's limit or the Ree's or platform's has
 * none left, however many they have.
 */
function quotaOf(keys: readonly QuotaKey[], counts: ReadonlyMap<string, Counted>): AnonymousQuota {
  const of = (scopes: AnonymousScope[]) => keys.filter((key) => scopes.includes(key.scope));
  const remaining = Math.min(ANONYMOUS_ROUNDS_PER_DAY, ...of(['visitor']).map((key) => left(key, counts.get(key.hash))));
  const full = (scopes: AnonymousScope[]) => of(scopes).some((key) => left(key, counts.get(key.hash)) === 0);
  return { limit: ANONYMOUS_ROUNDS_PER_DAY, remaining, blocked: full(['ree', 'platform']) ? 'capacity' : full(['network']) ? 'network' : null };
}

/** Today's rounds left, without taking one. */
export async function anonymousQuota(keys: readonly QuotaKey[], now = new Date()): Promise<AnonymousQuota> {
  const rows = await db()
    .select({ hash: schema.anonymousChatQuota.keyHash, rounds: schema.anonymousChatQuota.rounds, attempts: schema.anonymousChatQuota.attempts })
    .from(schema.anonymousChatQuota)
    .where(and(inArray(schema.anonymousChatQuota.keyHash, keys.map((key) => key.hash)), eq(schema.anonymousChatQuota.day, anonymousDay(now))));
  return quotaOf(keys, new Map(rows.map((row) => [row.hash, row])));
}

export type RoundReservation =
  | { ok: true; day: string; keys: readonly QuotaKey[]; quota: AnonymousQuota }
  | { ok: false; scope: AnonymousScope; quota: AnonymousQuota };

class QuotaFull extends Error {
  constructor(readonly scope: AnonymousScope) {
    super(`anonymous ${scope} limit reached`);
  }
}

/**
 * Takes one round and one attempt on every key, or none, in one
 * transaction. A key's counts rise only while both are below its limits
 * (`on conflict ... where rounds < limit and attempts < limit`), so no
 * number of concurrent requests takes a key past them; a full key returns
 * no row and rolls the others back, and its scope says which limit refused
 * the question. Keys are taken in one global order, so requests that share
 * a key (an address, a Ree, the platform) wait for each other instead of
 * deadlocking, and two requests of one visitor never each take half and
 * refuse each other.
 */
export async function reserveRound(keys: readonly QuotaKey[], now = new Date()): Promise<RoundReservation> {
  const day = anonymousDay(now);
  const ordered = [...keys].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  try {
    const counts = await db().transaction(async (tx) => {
      const taken = new Map<string, Counted>();
      for (const key of ordered) {
        const result = await tx.execute(sql`
          insert into anonymous_chat_quota (key_hash, day, rounds, attempts) values (${key.hash}, ${day}, 1, 1)
          on conflict (key_hash, day) do update
            set rounds = anonymous_chat_quota.rounds + 1, attempts = anonymous_chat_quota.attempts + 1, updated_at = now()
            where anonymous_chat_quota.rounds < ${key.limit} and anonymous_chat_quota.attempts < ${key.attempts}
          returning rounds, attempts`);
        const row = result.rows[0] as Partial<Counted> | undefined;
        if (typeof row?.rounds !== 'number' || typeof row.attempts !== 'number') throw new QuotaFull(key.scope);
        taken.set(key.hash, { rounds: row.rounds, attempts: row.attempts });
      }
      return taken;
    });
    return { ok: true, day, keys, quota: quotaOf(keys, counts) };
  } catch (error) {
    if (!(error instanceof QuotaFull)) throw error;
    const quota = await anonymousQuota(keys, now).catch(() => ({ limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: 0, blocked: null }));
    const blocked = error.scope === 'network' ? 'network' : error.scope === 'visitor' ? quota.blocked : 'capacity';
    return { ok: false, scope: error.scope, quota: { ...quota, remaining: error.scope === 'visitor' ? 0 : quota.remaining, blocked } };
  }
}

/**
 * Gives one round back on these keys, on the day it was taken (a question
 * asked just before midnight UTC). The attempt stays taken.
 */
export async function releaseRound(keys: readonly QuotaKey[], day: string): Promise<void> {
  if (keys.length === 0) return;
  await db()
    .update(schema.anonymousChatQuota)
    .set({ rounds: sql`greatest(${schema.anonymousChatQuota.rounds} - 1, 0)`, updatedAt: new Date() })
    .where(and(inArray(schema.anonymousChatQuota.keyHash, keys.map((key) => key.hash)), eq(schema.anonymousChatQuota.day, day)));
}

/** Past days, cleared hourly by `/api/cron/rank` (on its own, before the ranking); yesterday stays a little longer for a request still in flight at midnight. */
export async function clearAnonymousQuota(now = new Date()): Promise<void> {
  await db().delete(schema.anonymousChatQuota).where(sql`${schema.anonymousChatQuota.day} < ${anonymousDay(new Date(now.getTime() - 86_400_000))}`);
}

/* ----------------------------------------------------------------- answer */

export interface AnonymousQuestion {
  ree: Ree;
  question: string;
  /** Earlier turns from the visitor's browser (anonymousHistory): context only, never evidence. */
  history: AnonymousTurn[];
  lang: 'zh' | 'en';
  /** Asked on the share page by a browser that visited it (share.ts `shareVisitorFor`): the answer counts there too. */
  shareVisitorId?: string | null;
}

function outcome(reeId: string, partial: Partial<ReeOutcome>): ReeOutcome {
  return { reeId, messageId: null, noAnswer: false, reason: null, cost: 0, citations: [], model: null, failed: false, vote: null, ...partial };
}

/**
 * One anonymous question, start to finish, reported through `emit` as the
 * signed-in flow reports one Ree's part. Answers whether the round counts:
 * whenever any text was shown -- an answer, a reply that ended on the
 * no-answer sentinel, or a failure part-way.
 */
export async function runAnonymousQuestion({ ree, question, history, lang, shareVisitorId = null }: AnonymousQuestion, emit: Emit): Promise<boolean> {
  const subject = withoutMentions(question, [ree.name]) || question;
  const ready = await readyRees([ree.id]);
  if (!ready.has(ree.id)) {
    emit({ type: 'outcome', outcome: outcome(ree.id, { noAnswer: true, reason: 'no_sources' }) });
    return false;
  }
  let shown = false;
  let model: string | null = null;
  try {
    const found = await retrieve(ree.id, subject, await embedQuestion(subject), { rewrite: questionRewriter(null, subject) });
    if (!found.evidence) {
      emit({ type: 'outcome', outcome: outcome(ree.id, { noAnswer: true, reason: 'out_of_scope' }) });
      return false;
    }
    const generation = await generationForUser(null, 'answer');
    model = generation.endpoint.model;
    console.info(`anonymous answer ree=${ree.id} model=${model} passages=${found.passages.length} best=${found.bestSimilarity?.toFixed(3) ?? '-'}`);
    const { declined, text } = await streamGroundedAnswer({ generation, ree, lang, subject, passages: found.passages, turns: history }, (event) => {
      if (event.type === 'text-delta') shown = true;
      emit(event);
    });
    if (declined) {
      emit({ type: 'outcome', outcome: outcome(ree.id, { noAnswer: true, reason: 'out_of_scope', model }) });
      /* Text already shown counts, whatever sentinel followed it: a short answer ending on one is not a free question. */
      return shown;
    }
    await db()
      .insert(schema.anonymousAnswer)
      .values({ reeId: ree.id, shareVisitorId })
      .catch((error: unknown) => console.warn(`anonymous answer ree=${ree.id} not counted: ${error instanceof Error ? error.message : 'unknown'}`));
    emit({ type: 'outcome', outcome: outcome(ree.id, { citations: citationSnapshots(text, found.passages), model }) });
    return true;
  } catch (error) {
    console.warn(`anonymous answer ree=${ree.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    emit({ type: 'outcome', outcome: outcome(ree.id, { failed: true, model }) });
    return shown;
  }
}

/**
 * The web: one question as a `useChat` UI message stream, with the
 * reserved round given back when it does not count, and the rounds left
 * as the last part.
 */
export function anonymousAnswerResponse(input: AnonymousQuestion, reservation: Extract<RoundReservation, { ok: true }>, headers?: HeadersInit): Response {
  const stream = createUIMessageStream<ReeUIMessage>({
    execute: async ({ writer }) => {
      const write = safe(writer);
      const { ree } = input;
      write({ type: 'start', messageId: `${randomUUID()}-replies` });
      write({ type: 'data-ree', id: ree.id, data: { reeId: ree.id } });
      let counts = false;
      try {
        counts = await runAnonymousQuestion(input, (event) => {
          switch (event.type) {
            case 'text-start':
              return write({ type: 'text-start', id: textPartId(event.reeId), providerMetadata: { [TEXT_META_KEY]: { reeId: event.reeId } } });
            case 'text-delta':
              return write({ type: 'text-delta', id: textPartId(event.reeId), delta: event.delta });
            case 'text-end':
              return write({ type: 'text-end', id: textPartId(event.reeId) });
            case 'outcome':
              return write({ type: 'data-outcome', id: `outcome-${event.outcome.reeId}`, data: event.outcome });
            default:
              return undefined;
          }
        });
      } finally {
        if (!counts) {
          await releaseRound(reservation.keys, reservation.day).catch((error: unknown) =>
            console.error(`anonymous round not given back: ${error instanceof Error ? error.message : 'unknown'}`),
          );
        }
      }
      const quota = counts ? reservation.quota : await anonymousQuota(reservation.keys).catch(() => reservation.quota);
      write({ type: 'data-quota', id: 'quota', data: quota });
      write({ type: 'finish' });
    },
    onError: () => 'answer_failed',
  });
  return createUIMessageStreamResponse({ stream, headers });
}
