/**
 * Private posts (私密提问, design 稿 2): the question a user asks Rees they
 * chose, seen by nobody else -- what a private conversation used to be, now
 * a post (lib/domain/post.ts).
 *
 *   1. Asking (`publishPrivatePost`): the author picks 1..5 Rees (the
 *      composer suggests up to three, `suggestPrivateRees`). No review: the
 *      post is `published` at once, `visibility = 'private'`. Billing is a
 *      private question's (answer.ts `holdQuestion`): every chosen Ree with
 *      ready knowledge holds the base fee -- the author's own Rees too -- and
 *      someone else's paid Ree its query fee, all in one transaction with the
 *      post. A price above the one the author was shown refuses it
 *      (`price_changed`), a short balance too (`insufficient_credits`), and
 *      nothing is saved. There are no requests to agree to.
 *   2. `processPrivatePost` (after the response) has each Ree answer and
 *      settles each answer with posts.ts `closeAnswer`, then `finishPost`.
 *   3. Follow-ups (`askPrivateFollowup`): only the author, no review. They go
 *      to the Rees @-mentioned or added (加 Ree, up to `PRIVATE_POST_MAX_REES`
 *      distinct Rees in the thread), else to the thread's relevant Rees --
 *      and when none is close enough to the most relevant one anyway: the
 *      author asked, so someone answers. Charged when sent, at the prices
 *      shown, like the first round.
 *   4. Owner actions: 置顶, 归档, 重命名 (`updatePrivatePost`), 转为公开
 *      (`convertToPublic`: a new public post, reviewed with the answers it
 *      copies), and 没帮助 on an answer (`setAnswerUnhelpful`).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { InsufficientCredits } from '@/lib/domain/credits';
import { isUuid, likePattern } from '@/lib/domain/list';
import {
  FOLLOWUP_POST_MAX,
  POST_CANDIDATES,
  POST_DAILY_LIMIT,
  POST_DUPLICATE_WINDOW_MS,
  POST_MIN_SIMILARITY,
  AI_ANSWER_FEE,
  POST_TITLE_MAX,
  PRIVATE_POST_MAX_REES,
  PRIVATE_POST_SUGGESTIONS,
  followupInputError,
  postDayStart,
  postInputError,
  type PrivateReeOption,
} from '@/lib/domain/post';
import { redact } from '@/lib/domain/public-qa';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { db, schema, type Tx } from '@/lib/infra/db';
import { maxCostFor, readyRees } from '@/lib/services/grounded-answer';
import { embedQuestion, type QuestionVector } from '@/lib/services/retrieval';
import { balanceOf, placeHold } from '@/lib/services/credits';
import { publicRee, searchRees } from '@/lib/services/explore';
import { finishFollowup, followupAnswerInput, passageMatcher, privateThreadRees, type FollowupMatcher } from '@/lib/services/post-followups';
import { closeAnswer, finishPost, firstRound, groundedAnswer, ownPrivatePost, privateAnswerShown, shownAnswer, shownFollowupOf, takesPosts, type AnswerOne, type AnswerResult } from '@/lib/services/posts';
import { grantTaskReward } from '@/lib/services/task-rewards';
import { answerWithAi, type AiAnswerer } from '@/lib/services/ai-answers';
import { parsePostImages, postSubject } from '@/lib/domain/post-images';
import { attachImages, checkedImages, hasSameImages, imagesReadableFor, copyImages, ensureImageText, imageParts, type ImageDescriber } from '@/lib/services/post-images';
import { ceilingFor } from '@/lib/services/rate-limit-settings';

const { post, postAnswer: answer, postAnswerVote: vote, postAnswerFeedback: feedback, postFollowup: followup, ree } = schema;

/* ------------------------------------------------------------------ Rees */

interface AskableRee {
  id: string;
  name: string;
  category: string;
  ownerId: string;
  queryFee: number;
}

/** Rees this user may ask privately: any public Ree, or one of their own (public or not), never a deleted one; in the order given. */
async function askableRees(userId: string, ids: readonly string[]): Promise<AskableRee[]> {
  if (ids.length === 0) return [];
  const rows = await db()
    .select({ id: ree.id, name: ree.name, category: ree.category, ownerId: ree.ownerId, queryFee: ree.queryFee })
    .from(ree)
    .where(and(inArray(ree.id, [...ids]), isNull(ree.deletedAt), or(publicRee(), eq(ree.ownerId, userId))));
  return ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is AskableRee => Boolean(row));
}

/** What one answer of each Ree costs this user now: the base fee, plus someone else's query fee. */
export type PriceList = { reeId: string; price: number }[];

/**
 * The prices now, when any is above what the author was shown (`fees`, per
 * Ree: the composer's price, base fee included); null when every shown price
 * still holds. A lower price now is simply what is charged.
 */
function raisedPrices(rees: readonly AskableRee[], userId: string, fees: Record<string, unknown> | null | undefined): PriceList | null {
  const prices = rees.map((entry) => ({ reeId: entry.id, price: maxCostFor(entry, userId) }));
  const raised = prices.some(({ reeId, price }) => {
    const shown = fees?.[reeId];
    return typeof shown !== 'number' || !Number.isFinite(shown) || price > shown;
  });
  return raised ? prices : null;
}

/**
 * Writes one answer row per Ree and, for each with ready knowledge, holds
 * its base fee and (someone else's paid Ree) its query fee in the caller's
 * transaction -- settled by `closeAnswer` once it answers, given back when it
 * does not. A Ree without ready knowledge has nothing to answer from: its row
 * says so at once and nothing is held. Throws `InsufficientCredits`.
 */
async function holdAnswers(
  tx: Tx,
  userId: string,
  target: { postId: string; followupId: string | null },
  entries: readonly { ree: AskableRee; ready: boolean; similarity: number | null; mentioned: boolean }[],
  now: Date,
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    /* Apart by a millisecond each, so the thread keeps the order the author chose. */
    const [row] = await tx
      .insert(answer)
      .values({ postId: target.postId, followupId: target.followupId, reeId: entry.ree.id, similarity: entry.similarity, mentioned: entry.mentioned, state: entry.ready ? 'answering' : 'no_answer', createdAt: new Date(now.getTime() + index) })
      .returning({ id: answer.id });
    if (!entry.ready) continue;
    const fee = entry.ree.ownerId === userId ? 0 : entry.ree.queryFee;
    const baseHoldId = await placeHold(tx, { userId, kind: 'post', ledger: 'post_answer', amount: QUERY_BASE_FEE, refId: row!.id, reeId: entry.ree.id, note: 'post answer' }, now);
    const feeHoldId = fee > 0 ? await placeHold(tx, { userId, kind: 'post', ledger: 'chat_fee', amount: fee, refId: row!.id, reeId: entry.ree.id, note: entry.ree.name }, now) : null;
    await tx.update(answer).set({ baseHoldId, feeHoldId, price: QUERY_BASE_FEE + fee }).where(eq(answer.id, row!.id));
  }
}

/** The most the Rees with ready knowledge can cost: what a short balance is told it needs. */
function neededFor(entries: readonly { ree: AskableRee; ready: boolean }[], userId: string): number {
  return entries.filter((entry) => entry.ready).reduce((sum, entry) => sum + maxCostFor(entry.ree, userId), 0);
}

/** Has every answer still running written and settled, then the round (or follow-up) settled. */
async function answerRunning(rows: { id: string; reeId: string }[], ask: (reeId: string) => Promise<AnswerResult>, now: () => Date): Promise<void> {
  await Promise.all(
    rows.map(async (entry) => {
      let result: AnswerResult;
      try {
        result = await ask(entry.reeId);
      } catch (error) {
        console.warn(`private answer ree=${entry.reeId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
        result = { state: 'failed', model: null };
      }
      await closeAnswer(entry.id, result, now());
    }),
  );
}

/* ---------------------------------------------------------------- asking */

export interface PrivatePostInput {
  question: string;
  detail?: string;
  /** The Rees the author chose, 1..`PRIVATE_POST_MAX_REES`. */
  reeIds: readonly string[];
  /** The price of one answer the composer showed per Ree (base fee included). */
  fees?: Record<string, unknown> | null;
  /** 只问 AI: no Ree at all, the AI answers alone (`AI_ANSWER_FEE`, ai-answers.ts). */
  aiOnly?: boolean;
  lang: 'zh' | 'en';
  clientToken?: string | null;
  /** Pathnames of the author's uploaded images, in order (lib/domain/post-images.ts). */
  images?: unknown;
}

export type PrivatePublishOutcome =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; error: 'empty' | 'too_long' | 'daily_limit' | 'no_rees' | 'too_many_rees' | 'ree_unavailable' | 'invalid_images' | 'too_many_images' | 'images_unsupported' }
  | { ok: false; error: 'price_changed'; prices: PriceList }
  | { ok: false; error: 'insufficient_credits'; balance: number; needed: number };

/**
 * Asks the chosen Rees privately: the post, its answer rows and every hold
 * in one transaction, published at once (no review). Idempotent like
 * `publishPost`: the same `clientToken`, or the same text within
 * `POST_DUPLICATE_WINDOW_MS`, returns the post already made; and counted with
 * public posts against `POST_DAILY_LIMIT` under the same lock. `source`:
 * `test` (a Ree owner's 试问) and `api` (MCP, with the key it came through)
 * are private too; they are asked again on purpose, so only their token
 * makes them a replay, never the same text.
 */
export async function publishPrivatePost(userId: string, input: PrivatePostInput, options: { source?: 'post' | 'test' | 'api'; apiKeyId?: string | null; now?: Date } = {}): Promise<PrivatePublishOutcome> {
  const now = options.now ?? new Date();
  const source = options.source ?? 'post';
  const invalid = postInputError(input.question, input.detail ?? '');
  if (invalid) return { ok: false, error: invalid };
  const ids = [...new Set(input.reeIds.filter((id) => typeof id === 'string' && isUuid(id)))];
  /* 只问 AI: the composer found no Ree and the author chose none -- a private post only the AI answers (from the composer only; 试问 and MCP always name Rees). */
  const aiOnly = input.aiOnly === true && input.reeIds.length === 0 && source === 'post';
  if (ids.length === 0 && !aiOnly) return { ok: false, error: 'no_rees' };
  if (ids.length > PRIVATE_POST_MAX_REES) return { ok: false, error: 'too_many_rees' };
  const rees = await askableRees(userId, ids);
  if (rees.length !== ids.length) return { ok: false, error: 'ree_unavailable' };
  /* 试问 and MCP carry no images: only the composer uploads them. */
  const named = source === 'post' ? parsePostImages(input.images, userId) : [];
  if (typeof named === 'string') return { ok: false, error: named };
  const images = named.length ? await checkedImages(userId, named) : [];
  if (!images) return { ok: false, error: 'invalid_images' };
  if (images.length && !(await imagesReadableFor(userId))) return { ok: false, error: 'images_unsupported' };
  const question = redact(input.question.trim(), input.lang);
  const detail = redact((input.detail ?? '').trim(), input.lang);
  const clientToken = input.clientToken && isUuid(input.clientToken) ? input.clientToken : null;
  /* A replay of a post already made is answered before the prices: it charges nothing again. */
  const replay = await sameAsk(userId, source, { question, detail, clientToken, images: images.map((image) => image.pathname) }, now);
  if (replay) return { ok: true, id: replay, duplicate: true };
  const prices = raisedPrices(rees, userId, input.fees);
  if (prices) return { ok: false, error: 'price_changed', prices };
  const ready = await readyRees(ids);
  const entries = rees.map((entry) => ({ ree: entry, ready: ready.has(entry.id), similarity: null, mentioned: true }));
  const id = randomUUID();
  const dayStart = postDayStart(now);
  const dailyLimit = await ceilingFor('postsPerDay', userId);
  try {
    return await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`post:${userId}`}))`);
      const same = await sameAsk(userId, source, { question, detail, clientToken, images: images.map((image) => image.pathname) }, now, tx);
      if (same) return { ok: true, id: same, duplicate: true } as const;
      if (source === 'post') {
        const [counts] = await tx
          .select({ today: sql<number>`count(*) filter (where ${post.createdAt} >= ${dayStart}::timestamptz)::int` })
          .from(post)
          .where(and(eq(post.userId, userId), eq(post.source, 'post')));
        if (dailyLimit !== null && (counts?.today ?? 0) >= dailyLimit) return { ok: false, error: 'daily_limit' } as const;
      }
      await tx.insert(post).values({
        id,
        userId,
        source,
        visibility: 'private',
        apiKeyId: options.apiKeyId ?? null,
        question,
        detail,
        lang: input.lang,
        category: rees[0]?.category ?? null,
        clientToken,
        status: 'published',
        publishedAt: now,
        answerState: 'answering',
        answeringAt: now,
        candidates: rees.length,
        createdAt: now,
      });
      await attachImages(tx, id, images);
      /* Asking the AI alone needs its fee in the balance now: without it nothing would answer. */
      if (aiOnly) {
        const balance = await balanceOf(tx, userId, now);
        if (balance < AI_ANSWER_FEE) throw new InsufficientCredits(AI_ANSWER_FEE, balance);
      }
      await holdAnswers(tx, userId, { postId: id, followupId: null }, entries, now);
      /* 新手任务: a first post -- private counts as public does -- pays once, after its holds; a Ree owner's 试问 is not one. */
      if (source !== 'test') await grantTaskReward(tx, userId, 'first_post', id);
      return { ok: true, id } as const;
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, error: 'insufficient_credits', balance: await balanceOf(db(), userId), needed: aiOnly ? AI_ANSWER_FEE : neededFor(entries, userId) };
    throw error;
  }
}

/** A live private post of this author's that this submit repeats: the same token, or the same text within the duplicate window. */
async function sameAsk(userId: string, source: string, ask: { question: string; detail: string; clientToken: string | null; images?: readonly string[] }, now: Date, executor: Tx | ReturnType<typeof db> = db()): Promise<string | null> {
  if (source !== 'post' && !ask.clientToken) return null;
  const [same] = await executor
    .select({ id: post.id })
    .from(post)
    .where(
      and(
        eq(post.userId, userId),
        eq(post.source, source as 'post'),
        eq(post.visibility, 'private'),
        isNull(post.deletedAt),
        or(
          ask.clientToken ? eq(post.clientToken, ask.clientToken) : undefined,
          source === 'post'
            ? and(
                eq(post.question, ask.question),
                eq(post.detail, ask.detail),
                sql`${post.createdAt} > ${new Date(now.getTime() - POST_DUPLICATE_WINDOW_MS).toISOString()}::timestamptz`,
                /* With images, the same uploads in the same order too. */
                hasSameImages(post.id, ask.images ?? []),
              )
            : undefined,
        ),
      ),
    )
    .orderBy(desc(post.createdAt))
    .limit(1);
  return same?.id ?? null;
}

export interface PrivateDeps {
  answerOne?: AnswerOne;
  matchFollowup?: FollowupMatcher;
  /** AI 通用回答 when none of the chosen Rees answered (ai-answers.ts); the model by default. */
  aiAnswer?: AiAnswerer;
  /** The images' description (post-images.ts); the model by default. */
  describe?: ImageDescriber;
  now?: () => Date;
}

/** Each chosen Ree answers the private post (after the response), each answer settled on its own, then the post. Safe to call again. */
export async function processPrivatePost(id: string, deps: PrivateDeps = {}): Promise<void> {
  if (!isUuid(id)) return;
  const now = deps.now ?? (() => new Date());
  const [row] = await db().select().from(post).where(and(eq(post.id, id), eq(post.visibility, 'private'), eq(post.answerState, 'answering'))).limit(1);
  if (!row) return;
  const running = await db().select({ id: answer.id, reeId: answer.reeId }).from(answer).where(and(eq(answer.postId, id), firstRound(), eq(answer.state, 'answering')));
  /*
   * No review, but retrieval still needs the images in words: their
   * description is written first (once). If it cannot be, the Rees still
   * answer -- they read the images themselves.
   */
  const images = await imageParts(id);
  let imageText = row.imageText;
  if (images.length && !imageText) {
    imageText = await ensureImageText(id, { images, describe: deps.describe }).catch((error: unknown) => {
      console.warn(`private post ${id} image description failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    });
  }
  const subject = postSubject({ ...row, imageText });
  await answerRunning(running, (reeId) => (deps.answerOne ?? groundedAnswer)({ reeId, subject, lang: row.lang, vector: null, images }), now);
  await finishPost(id, now());
  /* None of the chosen Rees answered (or none was chosen, 只问 AI): the author gets an AI answer, at the base fee. */
  await answerWithAi(id, null, deps);
}

/** How the composer finds Rees for a question: the search's nearest public Rees (explore.ts). */
export type ReeSearch = (question: string) => Promise<{ reeId: string; similarity: number }[]>;

const searchPublicRees: ReeSearch = async (question) => {
  const vector: QuestionVector = await embedQuestion(question);
  return searchRees({ question, vector, limit: POST_CANDIDATES });
};

/**
 * Up to `PRIVATE_POST_SUGGESTIONS` public Rees with ready knowledge close
 * enough to the question (`POST_MIN_SIMILARITY`), most relevant first, with
 * what one answer costs this user. The composer preselects them.
 */
export async function suggestPrivateRees(userId: string, question: string, search: ReeSearch = searchPublicRees): Promise<PrivateReeOption[]> {
  const text = question.trim();
  if (!text) return [];
  const hits = (await search(text)).filter((hit) => hit.similarity >= POST_MIN_SIMILARITY);
  if (hits.length === 0) return [];
  const ready = await readyRees(hits.map((hit) => hit.reeId));
  const rows = await db()
    .select({ id: ree.id, slug: ree.slug, name: ree.name, avatar: ree.avatarBlob, color: ree.color, ownerId: ree.ownerId, queryFee: ree.queryFee })
    .from(ree)
    .where(and(inArray(ree.id, hits.map((hit) => hit.reeId)), publicRee()));
  return hits
    .filter((hit) => ready.has(hit.reeId))
    .map((hit) => ({ hit, row: rows.find((row) => row.id === hit.reeId) }))
    .filter((entry): entry is { hit: (typeof hits)[number]; row: (typeof rows)[number] } => Boolean(entry.row))
    .slice(0, PRIVATE_POST_SUGGESTIONS)
    .map(({ hit, row }) => {
      const price = maxCostFor(row, userId);
      return { reeId: row.id, reeSlug: row.slug, reeName: row.name, reeAvatar: row.avatar, reeColor: row.color, price, paid: price > QUERY_BASE_FEE, similarity: Math.round(hit.similarity * 100) / 100 };
    });
}

/** Rees one picker lists. */
const PICKER_RESULTS = 20;

/**
 * The private composer's "选 Ree" and the thread's "加 Ree": Rees this user
 * may ask privately -- public ones and their own -- that have ready
 * knowledge (any other could only answer "nothing found"), matching `q` by
 * name, introduction or tag; their own first, then the most active. `ids`
 * resolves Rees named by a link (`?compose=private&rees=…`) instead, in the
 * order given; one they may not ask is left out, never revealed. `scope:
 * 'post'`: the Rees "请 Ree 回答" may ask on a public post instead.
 */
export async function privateReeOptions(userId: string, input: { q?: string | null; ids?: readonly string[]; scope?: 'private' | 'post' }): Promise<PrivateReeOption[]> {
  const ids = (input.ids ?? []).filter((id) => isUuid(id)).slice(0, PRIVATE_POST_MAX_REES);
  const q = input.q?.trim().slice(0, 200) ?? '';
  const pattern = q ? likePattern(q) : null;
  const ready = sql`exists (select 1 from ${schema.knowledge} k where k.ree_id = ${ree.id} and k.status = 'ready' and k.enabled and k.deleted_at is null)`;
  const rows = await db()
    .select({ id: ree.id, slug: ree.slug, name: ree.name, avatar: ree.avatarBlob, color: ree.color, ownerId: ree.ownerId, queryFee: ree.queryFee })
    .from(ree)
    .where(
      and(
        isNull(ree.deletedAt),
        /* "请 Ree 回答" on a public post (`scope: 'post'`): public Rees that take posts only, as a matched one would be. */
        input.scope === 'post' ? and(publicRee(), takesPosts()) : or(publicRee(), eq(ree.ownerId, userId)),
        ready,
        ids.length || input.ids ? inArray(ree.id, ids.length ? ids : [randomUUID()]) : undefined,
        pattern ? or(sql`${ree.name} ilike ${pattern}`, sql`${ree.description} ilike ${pattern}`, sql`exists (select 1 from unnest(${ree.tags}) tag where tag ilike ${pattern})`) : undefined,
      ),
    )
    .orderBy(desc(sql`${ree.ownerId} = ${userId}`), desc(sql`coalesce((${ree.rank} ->> 'activity30')::int, 0)`), desc(ree.createdAt))
    .limit(input.ids ? PRIVATE_POST_MAX_REES : PICKER_RESULTS);
  const ordered = input.ids ? ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is (typeof rows)[number] => Boolean(row)) : rows;
  return ordered.map((row) => {
    const price = maxCostFor(row, userId);
    return { reeId: row.id, reeSlug: row.slug, reeName: row.name, reeAvatar: row.avatar, reeColor: row.color, price, paid: price > QUERY_BASE_FEE, similarity: null };
  });
}

/** 我的帖子 › 私密's Ree filter: every Ree asked in the author's private posts (first round or follow-up), by name. */
export async function myPrivateReeOptions(userId: string): Promise<{ id: string; name: string }[]> {
  return db()
    .selectDistinct({ id: ree.id, name: ree.name })
    .from(answer)
    .innerJoin(post, eq(post.id, answer.postId))
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(eq(post.userId, userId), eq(post.visibility, 'private'), inArray(post.source, ['post', 'api'])))
    .orderBy(asc(ree.name));
}

/* ------------------------------------------------------------- follow-ups */

export interface PrivateFollowupInput {
  question: string;
  /** Rees of the thread (or added now) asked by name: they answer whatever their relevance. */
  mentionReeIds?: readonly string[];
  /** 加 Ree: Rees new to the thread, asked now; the thread holds at most `PRIVATE_POST_MAX_REES`. */
  addReeIds?: readonly string[];
  /** The price per Ree the composer showed (base fee included). */
  fees?: Record<string, unknown> | null;
  lang: 'zh' | 'en';
  clientToken?: string | null;
}

export type PrivateFollowupOutcome =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; error: 'empty' | 'too_long' | 'not_found' | 'no_candidates' | 'mention_unavailable' | 'ree_unavailable' | 'too_many_rees' | 'full' }
  | { ok: false; error: 'price_changed'; prices: PriceList }
  | { ok: false; error: 'insufficient_credits'; balance: number; needed: number };

/**
 * The author asks on under their private post: published at once, the
 * answerers chosen and charged when sent. Named Rees (@ and 加 Ree) answer
 * whatever their relevance; otherwise the thread's Rees close enough to the
 * follow-up do, and when none is, the closest one does. Answered after the
 * response by `processPrivateFollowup`. Anyone else: `not_found`.
 */
export async function askPrivateFollowup(userId: string, postId: string, input: PrivateFollowupInput, deps: Pick<PrivateDeps, 'matchFollowup'> & { now?: Date; apiKeyId?: string | null } = {}): Promise<PrivateFollowupOutcome> {
  const now = deps.now ?? new Date();
  const invalid = followupInputError(input.question);
  if (invalid) return { ok: false, error: invalid };
  if (!isUuid(postId)) return { ok: false, error: 'not_found' };
  const [target] = await db().select({ id: post.id, question: post.question, detail: post.detail, imageText: post.imageText, followupCount: post.followupCount }).from(post).where(and(eq(post.id, postId), ownPrivatePost(userId))).limit(1);
  if (!target) return { ok: false, error: 'not_found' };
  const question = redact(input.question.trim(), input.lang);
  const clientToken = input.clientToken && isUuid(input.clientToken) ? input.clientToken : null;
  const replay = await sameFollowup(userId, postId, question, clientToken, now);
  if (replay) return { ok: true, id: replay, duplicate: true };
  const thread = await privateThreadRees(postId, userId);
  const inThread = new Set(thread.map((entry) => entry.reeId));
  const added = [...new Set((input.addReeIds ?? []).filter((id) => isUuid(id) && !inThread.has(id)))];
  const addable = await askableRees(userId, added);
  if (addable.length !== added.length) return { ok: false, error: 'ree_unavailable' };
  if (inThread.size + added.length > PRIVATE_POST_MAX_REES) return { ok: false, error: 'too_many_rees' };
  const known = new Set([...inThread, ...added]);
  const mentions = [...new Set((input.mentionReeIds ?? []).filter((id) => isUuid(id)))];
  if (mentions.some((id) => !known.has(id))) return { ok: false, error: 'mention_unavailable' };
  const named = [...new Set([...mentions, ...added])];
  let chosenIds: string[];
  const similarity = new Map<string, number>();
  if (named.length) chosenIds = named;
  else if (thread.length === 0) {
    /* A thread no Ree is in yet (只问 AI): the follow-up goes to the AI alone, unless the author adds a Ree. */
    chosenIds = [];
  } else {
    const scoring = await (deps.matchFollowup ?? passageMatcher)({ question, postQuestion: postSubject(target), reeIds: thread.map((entry) => entry.reeId) });
    for (const [reeId, value] of scoring.similarity) similarity.set(reeId, value);
    const ranked = [...thread].sort((a, b) => (similarity.get(b.reeId) ?? 0) - (similarity.get(a.reeId) ?? 0));
    const close = ranked.filter((entry) => (similarity.get(entry.reeId) ?? 0) >= POST_MIN_SIMILARITY);
    /* The author asked: when no Ree is close enough, the closest one answers anyway (they pay only if it does). */
    chosenIds = (close.length ? close : ranked.slice(0, 1)).map((entry) => entry.reeId);
  }
  const rees = await askableRees(userId, chosenIds);
  if (rees.length !== chosenIds.length) return { ok: false, error: 'ree_unavailable' };
  const prices = raisedPrices(rees, userId, input.fees);
  if (prices) return { ok: false, error: 'price_changed', prices };
  const ready = await readyRees(chosenIds);
  const entries = rees.map((entry) => ({ ree: entry, ready: ready.has(entry.id), similarity: similarity.has(entry.id) ? similarity.get(entry.id)! : null, mentioned: named.includes(entry.id) }));
  const id = randomUUID();
  try {
    return await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`followup:${userId}`}))`);
      const same = await sameFollowup(userId, postId, question, clientToken, now, tx);
      if (same) return { ok: true, id: same, duplicate: true } as const;
      const [counted] = await tx.select({ n: post.followupCount }).from(post).where(eq(post.id, postId)).for('update');
      if ((counted?.n ?? 0) >= FOLLOWUP_POST_MAX) return { ok: false, error: 'full' } as const;
      await tx.insert(followup).values({
        id,
        postId,
        userId,
        question,
        lang: input.lang,
        mentionReeIds: named,
        clientToken,
        apiKeyId: deps.apiKeyId ?? null,
        status: 'published',
        publishedAt: now,
        answerState: 'answering',
        answeringAt: now,
        candidates: named.length ? named.length : thread.length,
        skipped: named.length ? 0 : thread.length - chosenIds.length,
        createdAt: now,
      });
      await tx.update(post).set({ followupCount: sql`${post.followupCount} + 1` }).where(eq(post.id, postId));
      await holdAnswers(tx, userId, { postId, followupId: id }, entries, now);
      return { ok: true, id } as const;
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, error: 'insufficient_credits', balance: await balanceOf(db(), userId), needed: neededFor(entries, userId) };
    throw error;
  }
}

async function sameFollowup(userId: string, postId: string, question: string, clientToken: string | null, now: Date, executor: Tx | ReturnType<typeof db> = db()): Promise<string | null> {
  const [same] = await executor
    .select({ id: followup.id })
    .from(followup)
    .where(
      and(
        eq(followup.userId, userId),
        isNull(followup.deletedAt),
        or(
          clientToken ? eq(followup.clientToken, clientToken) : undefined,
          and(eq(followup.postId, postId), eq(followup.question, question), sql`${followup.createdAt} > ${new Date(now.getTime() - POST_DUPLICATE_WINDOW_MS).toISOString()}::timestamptz`),
        ),
      ),
    )
    .orderBy(desc(followup.createdAt))
    .limit(1);
  return same?.id ?? null;
}

/** Each Ree a private follow-up went to answers, with its own exchange so far (post-followups.ts `followupAnswerInput`); then the follow-up settles. */
export async function processPrivateFollowup(id: string, deps: PrivateDeps = {}): Promise<void> {
  if (!isUuid(id)) return;
  const now = deps.now ?? (() => new Date());
  const [row] = await db()
    .select({ id: followup.id, postId: followup.postId })
    .from(followup)
    .innerJoin(post, eq(post.id, followup.postId))
    .where(and(eq(followup.id, id), eq(followup.answerState, 'answering'), eq(post.visibility, 'private')))
    .limit(1);
  if (!row) return;
  const running = await db().select({ id: answer.id, reeId: answer.reeId }).from(answer).where(and(eq(answer.followupId, id), eq(answer.state, 'answering')));
  await answerRunning(
    running,
    async (reeId) => {
      const input = await followupAnswerInput(id, reeId);
      return input ? (deps.answerOne ?? groundedAnswer)({ reeId, ...input }) : { state: 'failed', model: null };
    },
    now,
  );
  await finishFollowup(id, now());
  await answerWithAi(row.postId, id, deps);
}

/** Whether a post is private: its follow-ups then go through `askPrivateFollowup`. */
export async function isPrivatePost(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [row] = await db().select({ visibility: post.visibility }).from(post).where(eq(post.id, id)).limit(1);
  return row?.visibility === 'private';
}

/* ---------------------------------------------------------- owner actions */

export interface PrivatePostChange {
  pinned?: boolean;
  archived?: boolean;
  /** 重命名: empty or null goes back to showing the question. */
  title?: string | null;
}

/** 置顶, 归档 and 重命名 of the author's own private post (in the trash or not); null when it is not theirs or not private. */
export async function updatePrivatePost(userId: string, id: string, change: PrivatePostChange, now = new Date()): Promise<{ ok: true; pinned: boolean; archived: boolean; title: string | null } | { ok: false; error: 'not_found' | 'title_too_long' }> {
  if (!isUuid(id)) return { ok: false, error: 'not_found' };
  const set: Partial<typeof post.$inferInsert> = {};
  if (change.pinned !== undefined) set.pinnedAt = change.pinned ? now : null;
  if (change.archived !== undefined) set.archivedAt = change.archived ? now : null;
  if (change.title !== undefined) {
    const title = (change.title ?? '').trim();
    if (title.length > POST_TITLE_MAX) return { ok: false, error: 'title_too_long' };
    set.title = title || null;
  }
  const where = and(eq(post.id, id), eq(post.userId, userId), eq(post.visibility, 'private'));
  const [row] = Object.keys(set).length
    ? await db().update(post).set(set).where(where).returning({ pinnedAt: post.pinnedAt, archivedAt: post.archivedAt, title: post.title })
    : await db().select({ pinnedAt: post.pinnedAt, archivedAt: post.archivedAt, title: post.title }).from(post).where(where);
  if (!row) return { ok: false, error: 'not_found' };
  return { ok: true, pinned: row.pinnedAt !== null, archived: row.archivedAt !== null, title: row.title };
}

export type ConvertOutcome = { ok: true; id: string } | { ok: false; error: 'not_found' } | { ok: false; error: 'already'; id: string };

/**
 * 转为公开: a new public post (`pending`, anonymous if asked) with the private
 * post's question and the first round's answers its Rees may show publicly,
 * copied as given -- nothing is charged again, and the follow-ups stay
 * private. It is reviewed like any post, with the copied answers (posts.ts
 * `moderatePost`, run by the caller through `processPost`); refused, it stays
 * refused and the private post is untouched. One copy per private post.
 */
export async function convertToPublic(userId: string, id: string, options: { anonymous?: boolean } = {}, now = new Date()): Promise<ConvertOutcome> {
  if (!isUuid(id)) return { ok: false, error: 'not_found' };
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(post)
      .where(and(eq(post.id, id), ownPrivatePost(userId), inArray(post.source, ['post', 'api'])))
      .for('update');
    if (!target) return { ok: false, error: 'not_found' } as const;
    if (target.publishedCopyId) return { ok: false, error: 'already', id: target.publishedCopyId } as const;
    const given = await tx
      .select({ reeId: answer.reeId, text: answer.text, citations: answer.citations, model: answer.model, answeredAt: answer.answeredAt })
      .from(answer)
      .innerJoin(ree, eq(ree.id, answer.reeId))
      .where(and(eq(answer.postId, id), firstRound(), shownAnswer()))
      .orderBy(asc(answer.createdAt));
    const copyId = randomUUID();
    await tx.insert(post).values({
      id: copyId,
      userId,
      source: 'post',
      visibility: 'public',
      anonymous: options.anonymous === true,
      question: target.question,
      detail: target.detail,
      imageText: target.imageText,
      lang: target.lang,
      category: target.category,
      status: 'pending',
      /* Its answers are already given: nothing is matched or asked. */
      answerState: 'done',
      answeredAt: now,
      candidates: given.length,
      answerCount: given.length,
      createdAt: now,
    });
    if (given.length) {
      await tx.insert(answer).values(
        given.map((entry, index) => ({ postId: copyId, reeId: entry.reeId, state: 'answered' as const, text: entry.text, citations: entry.citations, model: entry.model, similarity: null, answeredAt: entry.answeredAt ?? now, createdAt: new Date(now.getTime() + index) })),
      );
    }
    /* The same images (the same objects), reviewed with the copy. */
    await copyImages(tx, id, copyId);
    await tx.update(post).set({ publishedCopyId: copyId }).where(eq(post.id, id));
    return { ok: true, id: copyId } as const;
  });
}

/**
 * 没帮助 on an answer of the author's own private post (nobody else may),
 * on or off; it takes back their 有帮助 on the same answer. Null when the
 * answer is not theirs to mark.
 */
export async function setAnswerUnhelpful(userId: string, answerId: string, on: boolean): Promise<{ unhelpful: number; unvoted: boolean; helpful: number; voted: boolean } | null> {
  if (!isUuid(answerId)) return null;
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ id: answer.id })
      .from(answer)
      .innerJoin(post, eq(post.id, answer.postId))
      .where(and(eq(answer.id, answerId), privateAnswerShown(), ownPrivatePost(userId), shownFollowupOf()))
      .for('update', { of: answer });
    if (!target) return null;
    if (on) {
      await tx.insert(feedback).values({ answerId, userId }).onConflictDoNothing();
      const dropped = await tx.delete(vote).where(and(eq(vote.answerId, answerId), eq(vote.userId, userId))).returning({ id: vote.answerId });
      if (dropped.length) await tx.update(answer).set({ helpfulCount: sql`greatest(${answer.helpfulCount} - 1, 0)` }).where(eq(answer.id, answerId));
    } else {
      await tx.delete(feedback).where(and(eq(feedback.answerId, answerId), eq(feedback.userId, userId)));
    }
    const [counted] = await tx
      .select({ unhelpful: sql<number>`(select count(*)::int from ${feedback} f where f.answer_id = ${answerId})`, helpful: answer.helpfulCount })
      .from(answer)
      .where(eq(answer.id, answerId));
    const [voted] = await tx.select({ id: vote.answerId }).from(vote).where(and(eq(vote.answerId, answerId), eq(vote.userId, userId)));
    return { unhelpful: counted?.unhelpful ?? 0, unvoted: on, helpful: counted?.helpful ?? 0, voted: Boolean(voted) };
  });
}
