/**
 * Public posts (v5, lib/domain/post.ts).
 *
 *   1. Publishing (`publishPost`): the question is redacted like a public
 *      answer, and in one transaction under a per-user lock the day's free
 *      posts are counted; past them `POST_FEE` is held. The post starts
 *      `pending`.
 *   2. `processPost` runs after the response (`after()`), and again from the
 *      hourly cron for a post a request did not finish:
 *      - the question is reviewed (the public Q&A's check, question only);
 *        refused → `rejected`, the fee and the free post are given back;
 *        the check failed → left pending for the cron;
 *      - the Rees are matched: the search's `POST_CANDIDATES` nearest public
 *        Rees, those whose best passage reaches `POST_MIN_SIMILARITY` and
 *        that take posts (`ree.answers_posts`, by default free Rees only),
 *        at most `POST_MAX_ANSWERS`; a mentioned Ree that takes posts comes
 *        first whatever its similarity;
 *      - each answers in parallel from its own knowledge, on the platform's
 *        model (`post_answer` calls): the platform pays, nobody earns;
 *      - `finishPost` settles: an answer settles the fee to the platform and
 *        tells the author; none gives the fee and the free post back.
 *   3. Reading: the feeds (为你推荐 / 最新 / 待回答), a post with its answers,
 *      a Ree's answered posts (the Ree page and the share page, where the
 *      copied public Q&A also lives), the author's own posts and trash, and
 *      saved posts.
 *
 * A post is shown while it is published and not in its author's trash; one
 * copied from a signed-in asker's conversation also only while that
 * conversation is out of the trash (as its Q&A was). An answer is shown
 * while it answered, nobody hid it, and its Ree is public (and, for a copied
 * Q&A, keeps public Q&A on).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { generateText } from 'ai';
import { citationSnapshots, type CitationSnapshot } from '@/lib/domain/answer';
import { InsufficientCredits } from '@/lib/domain/credits';
import { isUuid } from '@/lib/domain/list';
import {
  POST_ANSWERING_STALE_MS,
  POST_CANDIDATES,
  POST_DAILY_LIMIT,
  POST_DUPLICATE_WINDOW_MS,
  POST_FEE,
  POST_FREE_PER_DAY,
  POST_MAX_ANSWERS,
  POST_MIN_SIMILARITY,
  POST_PAGE_SIZE,
  POST_PREVIEW_CHARS,
  POST_REPORT_THRESHOLD,
  POST_SUMMARY_FEE,
  POST_SUMMARY_FREE_REWRITES,
  POST_SWEEP_BUDGET_MS,
  POST_SWEEP_CONCURRENCY,
  POST_WAITING_STALE_MS,
  postDay,
  postInputError,
  type AnswerState,
  type FeedTab,
  type PostAnswerView,
  type PostAuthor,
  type PostPage,
  type PostSource,
  type PostView,
} from '@/lib/domain/post';
import { PUBLIC_QA_MODERATION_ATTEMPTS, PUBLIC_QA_REPORT_THRESHOLD, previewOf, redact } from '@/lib/domain/public-qa';
import { cleanSynthesis, letterAnswers, synthesisInstructions, synthesisPrompt } from '@/lib/domain/synthesis';
import { db, schema } from '@/lib/infra/db';
import { readyRees, streamGroundedAnswer } from '@/lib/services/answer';
import { embedQuestion, retrieve, type QuestionVector } from '@/lib/services/chat';
import { balanceOf, placeHold, releaseHold, settleHold } from '@/lib/services/credits';
import { publicRee, searchRees } from '@/lib/services/explore';
import { generationForUser } from '@/lib/services/generation';
import { audit } from '@/lib/services/admin';
import { notify } from '@/lib/services/notices';
import { modelJudge, type Judge } from '@/lib/services/public-qa';
import { questionRewriter } from '@/lib/services/question-rewrite';

const { post, postAnswer: answer, postAnswerVote: vote, postAnswerReport: report, postSave: save, ree, user, message, conversation } = schema;

/* --------------------------------------------------------------- visibility */

/** Published, out of the author's trash, and -- copied from a conversation -- while that conversation is too. */
export function visiblePost(): SQL {
  return and(
    eq(post.status, 'published'),
    isNull(post.deletedAt),
    sql`(${post.source} <> 'conversation' or exists (
      select 1 from ${message} m join ${conversation} c on c.id = m.conversation_id
      where m.id = ${post.messageId} and c.deleted_at is null))`,
  )!;
}

/** An answer anyone may read: given, not hidden, its Ree public (and a copied Q&A's Ree keeps public Q&A on). Needs `ree` joined. */
export function shownAnswer(): SQL {
  return and(eq(answer.state, 'answered'), isNull(answer.hiddenBy), publicRee(), or(isNull(answer.legacyQaId), eq(ree.publicQaEnabled, true)))!;
}

/**
 * The post has an answer anyone may read right now -- by the answering Ree's
 * current visibility, not the count stored when the post settled -- so a
 * Ree going private or turning public Q&A off takes its posts out of the
 * answered lists and the sitemap at once.
 */
export function hasShownAnswer(): SQL {
  return sql`exists (select 1 from ${answer} sa join ${ree} on ${ree.id} = sa.ree_id
    where sa.post_id = ${post.id} and sa.state = 'answered' and sa.hidden_by is null
      and ${publicRee()} and (sa.legacy_qa_id is null or ${ree.publicQaEnabled}))`;
}

/** A Ree takes public posts: the owner's choice, or by default when it is free. */
export function takesPosts(): SQL {
  return sql`coalesce(${ree.answersPosts}, ${ree.queryFee} = 0)`;
}

/* --------------------------------------------------------------- publishing */

export interface PostInput {
  question: string;
  detail?: string;
  anonymous?: boolean;
  mentionReeId?: string | null;
  lang: 'zh' | 'en';
  /** The composer's token for this post: sending it again returns the same post. */
  clientToken?: string | null;
}

export type PublishOutcome =
  | { ok: true; id: string; charge: 'free' | 'paid' | 'none'; duplicate?: boolean }
  | { ok: false; error: 'empty' | 'too_long' | 'daily_limit' }
  | { ok: false; error: 'insufficient_credits'; balance: number; needed: number };

/** What the composer says about today: free posts left, and the fee after them. */
export async function postAllowance(userId: string, now = new Date()): Promise<{ freeLeft: number; fee: number; postedToday: number }> {
  const day = postDay(now);
  const [row] = await db()
    .select({
      free: sql<number>`count(*) filter (where ${post.freeDay} = ${day}::date)::int`,
      today: sql<number>`count(*) filter (where ${post.createdAt} >= ${day}::date)::int`,
    })
    .from(post)
    .where(and(eq(post.userId, userId), eq(post.source, 'post')));
  return { freeLeft: Math.max(0, POST_FREE_PER_DAY - (row?.free ?? 0)), fee: POST_FEE, postedToday: row?.today ?? 0 };
}

/**
 * Publishes a post as `pending`, free while the day's free posts last and
 * holding `POST_FEE` after. One user's posts are counted under an advisory
 * lock, so two at once never both take the last free one. Idempotent: the
 * same `clientToken`, or the same text within `POST_DUPLICATE_WINDOW_MS`,
 * returns the post already made (`duplicate`), holding nothing more.
 */
export async function publishPost(userId: string, input: PostInput, now = new Date()): Promise<PublishOutcome> {
  const invalid = postInputError(input.question, input.detail ?? '');
  if (invalid) return { ok: false, error: invalid };
  const question = redact(input.question.trim(), input.lang);
  const detail = redact((input.detail ?? '').trim(), input.lang);
  const mention = input.mentionReeId && isUuid(input.mentionReeId) ? input.mentionReeId : null;
  const clientToken = input.clientToken && isUuid(input.clientToken) ? input.clientToken : null;
  const id = randomUUID();
  const day = postDay(now);
  try {
    return await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`post:${userId}`}))`);
      const [same] = await tx
        .select({ id: post.id, charge: post.charge })
        .from(post)
        .where(
          and(
            eq(post.userId, userId),
            eq(post.source, 'post'),
            /* Only a live post: one trashed, rejected or taken down is not what this submit meant. */
            inArray(post.status, ['pending', 'published']),
            isNull(post.deletedAt),
            or(
              clientToken ? eq(post.clientToken, clientToken) : undefined,
              and(eq(post.question, question), eq(post.detail, detail), sql`${post.createdAt} > ${new Date(now.getTime() - POST_DUPLICATE_WINDOW_MS).toISOString()}::timestamptz`),
            ),
          ),
        )
        .orderBy(desc(post.createdAt))
        .limit(1);
      if (same) return { ok: true, id: same.id, charge: same.charge, duplicate: true } as const;
      const [counts] = await tx
        .select({
          free: sql<number>`count(*) filter (where ${post.freeDay} = ${day}::date)::int`,
          today: sql<number>`count(*) filter (where ${post.createdAt} >= ${day}::date)::int`,
        })
        .from(post)
        .where(and(eq(post.userId, userId), eq(post.source, 'post')));
      if ((counts?.today ?? 0) >= POST_DAILY_LIMIT) return { ok: false, error: 'daily_limit' } as const;
      const free = (counts?.free ?? 0) < POST_FREE_PER_DAY;
      const holdId = free ? null : await placeHold(tx, { userId, kind: 'post', amount: POST_FEE, refId: id, note: 'post' }, now);
      await tx.insert(post).values({
        id,
        userId,
        source: 'post',
        anonymous: input.anonymous === true,
        question,
        detail,
        lang: input.lang,
        mentionReeId: mention,
        charge: free ? 'free' : 'paid',
        holdId,
        freeDay: free ? day : null,
        clientToken,
        createdAt: now,
      });
      return { ok: true, id, charge: free ? 'free' : 'paid' } as const;
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, error: 'insufficient_credits', balance: await balanceOf(db(), userId), needed: POST_FEE };
    throw error;
  }
}

/* ------------------------------------------------------------------ review */

/** Reviews a pending post's question: published, rejected (fee and free post given back), or still pending when the check failed. */
export async function moderatePost(id: string, judge: Judge = modelJudge, now = new Date()): Promise<'published' | 'rejected' | 'pending' | 'gone'> {
  const [row] = await db()
    .update(post)
    .set({ moderationAttempts: sql`${post.moderationAttempts} + 1` })
    .where(and(eq(post.id, id), eq(post.status, 'pending'), lt(post.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS)))
    .returning({ question: post.question, detail: post.detail, attempts: post.moderationAttempts });
  if (!row) return 'gone';
  let verdict: boolean | null = null;
  try {
    verdict = (await judge([row.question, row.detail].filter(Boolean).join('\n\n'), '(No answer yet: review the question alone.)')).publish;
  } catch (error) {
    console.warn(`post ${id} review failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (verdict === null && row.attempts < PUBLIC_QA_MODERATION_ATTEMPTS) return 'pending';
  if (verdict) {
    await db().update(post).set({ status: 'published', publishedAt: now }).where(and(eq(post.id, id), eq(post.status, 'pending')));
    return 'published';
  }
  await rejectPost(id, now);
  return 'rejected';
}

/** A pending post refused (or whose review never finished): not public, the fee and the free post given back. */
async function rejectPost(id: string, now: Date): Promise<void> {
  await db().transaction(async (tx) => {
    const [target] = await tx.select({ holdId: post.holdId }).from(post).where(and(eq(post.id, id), eq(post.status, 'pending'))).for('update');
    if (!target) return;
    if (target.holdId) await releaseHold(tx, target.holdId, { note: 'post' }, now);
    await tx.update(post).set({ status: 'rejected', answerState: 'done', freeDay: null, answeredAt: now }).where(eq(post.id, id));
  });
}

/* ---------------------------------------------------------------- matching */

export interface Answerer {
  reeId: string;
  similarity: number | null;
  mentioned: boolean;
}

export interface Match {
  answerers: Answerer[];
  candidates: number;
  skipped: number;
  vector: QuestionVector | null;
}

export type Matcher = (input: { question: string; mentionReeId: string | null; authorId: string | null }) => Promise<Match>;

/** The search's nearest public Rees, kept when close enough and taking posts; the mentioned one first. */
export const searchMatcher: Matcher = async ({ question, mentionReeId }) => {
  const vector = await embedQuestion(question);
  const hits = await searchRees({ question, vector, limit: POST_CANDIDATES });
  const ids = [...new Set([...(mentionReeId ? [mentionReeId] : []), ...hits.map((hit) => hit.reeId)])];
  const open = ids.length
    ? new Set((await db().select({ id: ree.id }).from(ree).where(and(inArray(ree.id, ids), publicRee(), takesPosts()))).map((row) => row.id))
    : new Set<string>();
  const answerers: Answerer[] = [];
  if (mentionReeId && open.has(mentionReeId)) answerers.push({ reeId: mentionReeId, similarity: hits.find((hit) => hit.reeId === mentionReeId)?.similarity ?? null, mentioned: true });
  let skipped = 0;
  for (const hit of hits) {
    if (hit.reeId === mentionReeId && answerers.length) continue;
    if (answerers.length < POST_MAX_ANSWERS && hit.similarity >= POST_MIN_SIMILARITY && open.has(hit.reeId)) answerers.push({ reeId: hit.reeId, similarity: hit.similarity, mentioned: false });
    else skipped += 1;
  }
  return { answerers, candidates: hits.length, skipped, vector };
};

/* ---------------------------------------------------------------- answering */

export type AnswerResult = { state: 'answered'; text: string; citations: CitationSnapshot[]; model: string | null } | { state: 'no_answer' | 'failed'; model: string | null };

export type AnswerOne = (input: { reeId: string; subject: string; lang: 'zh' | 'en'; vector: QuestionVector | null }) => Promise<AnswerResult>;

/** One Ree's answer from its own knowledge, on the platform's model; never streamed to anyone. */
export const groundedAnswer: AnswerOne = async ({ reeId, subject, lang, vector }) => {
  const [target] = await db().select().from(ree).where(eq(ree.id, reeId)).limit(1);
  if (!target || !(await readyRees([reeId])).has(reeId)) return { state: 'no_answer', model: null };
  let model: string | null = null;
  try {
    const found = await retrieve(reeId, subject, vector ?? (await embedQuestion(subject)), { rewrite: questionRewriter(null, subject) });
    if (!found.evidence) return { state: 'no_answer', model: null };
    const generation = await generationForUser(null, 'post_answer');
    model = generation.endpoint.model;
    const { declined, text } = await streamGroundedAnswer({ generation, ree: target, lang, subject, passages: found.passages, turns: [] }, () => undefined);
    if (declined || !text.trim()) return { state: 'no_answer', model };
    return { state: 'answered', text: text.trim(), citations: citationSnapshots(text, found.passages), model };
  } catch (error) {
    console.warn(`post answer ree=${reeId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { state: 'failed', model };
  }
};

export interface ProcessDeps {
  judge?: Judge;
  match?: Matcher;
  answerOne?: AnswerOne;
  now?: () => Date;
}

/**
 * Takes a post as far as it goes: review, then (once) matching and answers,
 * then the settlement. Safe to call again: each step claims its state.
 */
export async function processPost(id: string, deps: ProcessDeps = {}): Promise<void> {
  if (!isUuid(id)) return;
  const now = deps.now ?? (() => new Date());
  let [row] = await db().select().from(post).where(eq(post.id, id)).limit(1);
  if (!row) return;
  if (row.status === 'pending') {
    const status = await moderatePost(id, deps.judge, now());
    if (status !== 'published') return;
    [row] = await db().select().from(post).where(eq(post.id, id)).limit(1);
    if (!row) return;
  }
  if (row.status !== 'published' || row.answerState !== 'waiting') return;
  const [claimed] = await db().update(post).set({ answerState: 'answering' }).where(and(eq(post.id, id), eq(post.answerState, 'waiting'))).returning({ id: post.id });
  if (!claimed) return;
  const subject = [row.question, row.detail].filter(Boolean).join('\n');
  try {
    const match = await (deps.match ?? searchMatcher)({ question: subject, mentionReeId: row.mentionReeId, authorId: row.userId });
    const answerers = match.answerers.slice(0, POST_MAX_ANSWERS);
    const categories = answerers.length
      ? await db().select({ id: ree.id, category: ree.category }).from(ree).where(inArray(ree.id, answerers.map((entry) => entry.reeId)))
      : [];
    await db()
      .update(post)
      .set({ candidates: match.candidates, skipped: match.skipped, category: categories.find((entry) => entry.id === answerers[0]?.reeId)?.category ?? null })
      .where(eq(post.id, id));
    if (answerers.length) {
      await db()
        .insert(answer)
        .values(answerers.map((entry) => ({ postId: id, reeId: entry.reeId, similarity: entry.similarity, mentioned: entry.mentioned, state: 'answering' as const })))
        .onConflictDoNothing();
    }
    await Promise.all(
      answerers.map(async (entry) => {
        const result = await (deps.answerOne ?? groundedAnswer)({ reeId: entry.reeId, subject, lang: row!.lang, vector: match.vector });
        await db()
          .update(answer)
          .set(
            result.state === 'answered'
              ? { state: 'answered', text: result.text.slice(0, 20_000), citations: result.citations, model: result.model, answeredAt: now() }
              : { state: result.state, model: result.model },
          )
          /* Only while it is still running: once the post is settled a late answer stays failed, as it was counted. */
          .where(and(eq(answer.postId, id), eq(answer.reeId, entry.reeId), eq(answer.state, 'answering')));
      }),
    );
  } catch (error) {
    console.warn(`post ${id} answering failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  await finishPost(id, now());
}

/**
 * Settles a post: answers still running are marked failed, the shown
 * answers counted; with one or more the fee is settled to the platform and
 * the author told, with none the fee and the free post are given back.
 */
export async function finishPost(id: string, now = new Date()): Promise<void> {
  await db().transaction(async (tx) => {
    const [target] = await tx.select().from(post).where(and(eq(post.id, id), eq(post.answerState, 'answering'))).for('update');
    if (!target) return;
    await tx.update(answer).set({ state: 'failed' }).where(and(eq(answer.postId, id), inArray(answer.state, ['queued', 'answering'])));
    const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(answer).where(and(eq(answer.postId, id), eq(answer.state, 'answered')));
    const answered = counted?.n ?? 0;
    if (target.holdId) {
      if (answered > 0) await settleHold(tx, target.holdId, POST_FEE, { note: 'post' }, now);
      else await releaseHold(tx, target.holdId, { note: 'post' }, now);
    }
    await tx
      .update(post)
      .set({ answerState: 'done', answerCount: answered, answeredAt: now, ...(answered === 0 ? { freeDay: null } : {}) })
      .where(eq(post.id, id));
    if (answered > 0 && target.userId && target.source === 'post') {
      await notify(tx, { userId: target.userId, kind: 'post_answered', params: { question: target.question.slice(0, 80), answers: answered }, refId: id });
    }
  });
}

export interface SweepOptions {
  /** How long the sweep keeps starting new posts; work already started finishes. */
  budgetMs?: number;
  concurrency?: number;
  now?: Date;
}

/**
 * The posts sweep (`/api/cron/posts`, every 5 minutes): what a request left
 * behind, oldest first.
 *   1. Reviews that died on their last attempt are rejected (fee and free
 *      post given back) -- cheap, all of them, in batches.
 *   2. Runs that died while answering are settled with what they have --
 *      cheap, all of them.
 *   3. Reviews to retry and published posts never started are processed,
 *      `concurrency` at a time, until `budgetMs` has passed. Each claims its
 *      state first, so the request's own background work and the sweep never
 *      answer a post twice.
 * Answers how many posts it handled.
 */
export async function processStalePosts(deps: ProcessDeps = {}, options: SweepOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  const started = Date.now();
  const budget = options.budgetMs ?? POST_SWEEP_BUDGET_MS;
  let handled = 0;
  for (;;) {
    const stuck = await db()
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.status, 'pending'), sql`${post.moderationAttempts} >= ${PUBLIC_QA_MODERATION_ATTEMPTS}`, lt(post.createdAt, new Date(now.getTime() - POST_ANSWERING_STALE_MS))))
      .limit(100);
    for (const row of stuck) await rejectPost(row.id, now);
    handled += stuck.length;
    if (stuck.length < 100 || Date.now() - started > budget) break;
  }
  for (;;) {
    const dead = await db()
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.answerState, 'answering'), lt(post.publishedAt, new Date(now.getTime() - POST_ANSWERING_STALE_MS))))
      .orderBy(asc(post.publishedAt))
      .limit(100);
    for (const row of dead) await finishPost(row.id, now);
    handled += dead.length;
    if (dead.length < 100 || Date.now() - started > budget) break;
  }
  const waiting = await db()
    .select({ id: post.id })
    .from(post)
    .where(
      or(
        and(eq(post.status, 'pending'), lt(post.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS), lt(post.createdAt, new Date(now.getTime() - 60_000))),
        and(eq(post.status, 'published'), eq(post.answerState, 'waiting'), lt(post.publishedAt, new Date(now.getTime() - POST_WAITING_STALE_MS))),
      ),
    )
    .orderBy(asc(post.createdAt))
    .limit(500);
  let next = 0;
  const worker = async () => {
    while (next < waiting.length && Date.now() - started < budget) {
      const row = waiting[next++]!;
      await processPost(row.id, deps).catch((error: unknown) => console.warn(`post ${row.id} sweep failed: ${error instanceof Error ? error.message : 'unknown'}`));
      handled += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? POST_SWEEP_CONCURRENCY) }, worker));
  return handled;
}

/* ------------------------------------------------------------------ reading */

type PostRow = typeof post.$inferSelect & { authorName: string | null; authorAvatar: string | null };

function authorOf(row: PostRow, viewerId: string | undefined): PostAuthor {
  const mine = Boolean(viewerId && row.userId === viewerId);
  if (row.source === 'seed') return { kind: 'example' };
  if (row.source === 'anonymous' || row.source === 'share') return { kind: 'visitor' };
  if (row.anonymous || row.source === 'conversation' || !row.authorName) return { kind: 'hidden', mine };
  return { kind: 'user', name: row.authorName, avatar: row.authorAvatar, mine };
}

async function selectPosts(where: SQL | undefined, order: SQL[], limit: number, offset = 0): Promise<PostRow[]> {
  return (await db()
    .select({ post, authorName: user.name, authorAvatar: user.avatarBlob })
    .from(post)
    .leftJoin(user, eq(user.id, post.userId))
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset(offset)).map((row) => ({ ...row.post, authorName: row.authorName, authorAvatar: row.authorAvatar }));
}

interface AnswerRow {
  id: string;
  postId: string;
  reeId: string;
  state: AnswerState;
  text: string;
  citations: CitationSnapshot[];
  similarity: number | null;
  helpful: number;
  pinnedAt: Date | null;
  slug: string;
  name: string;
  avatar: string | null;
  color: string;
  role: string;
  shown: boolean;
}

async function answersFor(postIds: string[]): Promise<AnswerRow[]> {
  if (postIds.length === 0) return [];
  return db()
    .select({
      id: answer.id,
      postId: answer.postId,
      reeId: answer.reeId,
      state: answer.state,
      text: answer.text,
      citations: answer.citations,
      similarity: answer.similarity,
      helpful: answer.helpfulCount,
      pinnedAt: answer.pinnedAt,
      slug: ree.slug,
      name: ree.name,
      avatar: ree.avatarBlob,
      color: ree.color,
      role: user.role,
      shown: sql<boolean>`(${shownAnswer()})`,
    })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(user, eq(user.id, ree.ownerId))
    .where(and(inArray(answer.postId, postIds), or(shownAnswer(), inArray(answer.state, ['queued', 'answering']))))
    .orderBy(desc(answer.mentioned), desc(answer.helpfulCount), sql`${answer.similarity} desc nulls last`, asc(answer.createdAt));
}

async function votedBy(viewerId: string | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewerId || ids.length === 0) return new Set();
  const rows = await db().select({ id: vote.answerId }).from(vote).where(and(eq(vote.userId, viewerId), inArray(vote.answerId, ids)));
  return new Set(rows.map((row) => row.id));
}

async function savedBy(viewerId: string | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewerId || ids.length === 0) return new Set();
  const rows = await db().select({ id: save.postId }).from(save).where(and(eq(save.userId, viewerId), inArray(save.postId, ids)));
  return new Set(rows.map((row) => row.id));
}

function answerView(row: AnswerRow, voted: Set<string>, whole: boolean): PostAnswerView {
  const cut = whole || row.state !== 'answered' ? { answer: row.text, truncated: false } : previewOf(row.text, POST_PREVIEW_CHARS);
  return {
    id: row.id,
    reeId: row.reeId,
    reeSlug: row.slug,
    reeName: row.name,
    reeAvatar: row.avatar,
    reeColor: row.color,
    official: row.role === 'official',
    similarity: row.similarity === null ? null : Math.round(row.similarity * 100) / 100,
    state: row.state,
    text: cut.answer,
    truncated: cut.truncated,
    citations: row.citations,
    helpful: row.helpful,
    voted: voted.has(row.id),
    pinned: row.pinnedAt !== null,
  };
}

/**
 * Posts as a page shows them. In a feed (`whole: false`) only the top shown
 * answer comes along, cut; on the post page all of them, whole.
 */
async function viewsOf(rows: PostRow[], viewerId: string | undefined, options: { whole: boolean; onlyRee?: string }): Promise<PostView[]> {
  const ids = rows.map((row) => row.id);
  const [answers, saved] = await Promise.all([answersFor(ids), savedBy(viewerId, ids)]);
  const voted = await votedBy(viewerId, answers.map((row) => row.id));
  const followUps = options.whole && viewerId && rows.length === 1 && rows[0]!.userId === viewerId
    ? await db()
        .select({ id: conversation.id, title: conversation.title, reeName: ree.name })
        .from(conversation)
        .leftJoin(schema.conversationRee, eq(schema.conversationRee.conversationId, conversation.id))
        .leftJoin(ree, eq(ree.id, schema.conversationRee.reeId))
        .where(and(eq(conversation.postId, rows[0]!.id), eq(conversation.userId, viewerId), isNull(conversation.deletedAt)))
        .orderBy(desc(conversation.updatedAt))
    : [];
  /* For its author, on the post's page: whether rewriting a stale summary is free (`freeRewrite`). */
  const rewriteFree = new Map<string, boolean>();
  for (const row of rows) {
    if (!options.whole || !viewerId || row.userId !== viewerId || row.summaryState !== 'done') continue;
    const shownIds = new Set(answers.filter((entry) => entry.postId === row.id && entry.shown).map((entry) => entry.id));
    if (summaryStale(row.summaryAnswers, shownIds)) rewriteFree.set(row.id, await freeRewrite(viewerId, row));
  }
  return rows.map((row) => {
    const own = answers.filter((entry) => entry.postId === row.id);
    const shown = own.filter((entry) => entry.shown);
    const pending = row.answerState === 'done' ? [] : own.filter((entry) => !entry.shown);
    const picked = options.onlyRee ? shown.filter((entry) => entry.reeId === options.onlyRee) : shown;
    const listed = options.whole ? [...picked, ...pending] : picked.slice(0, 1);
    return {
      id: row.id,
      question: row.question,
      detail: row.detail,
      lang: row.lang,
      category: row.category,
      author: authorOf(row, viewerId),
      status: row.status,
      answerState: row.answerState,
      answered: shown.length,
      candidates: row.candidates,
      skipped: row.skipped,
      helpful: shown.reduce((sum, entry) => sum + entry.helpful, 0),
      saved: saved.has(row.id),
      createdAt: (row.publishedAt ?? row.createdAt).toISOString(),
      answers: listed.map((entry) => answerView(entry, voted, options.whole)),
      summary: row.summaryState === 'done' && row.summaryContent && !summaryStale(row.summaryAnswers, new Set(shown.map((entry) => entry.id)))
        ? { state: 'done', content: row.summaryContent, sources: row.summarySources ?? [] }
        : row.summaryState === 'running' ? { state: 'running', content: '', sources: [] } : null,
      summaryStale: row.summaryState === 'done' && summaryStale(row.summaryAnswers, new Set(shown.map((entry) => entry.id))),
      summaryRewriteFree: rewriteFree.get(row.id) ?? false,
      hiddenBy: row.status === 'hidden' ? row.hiddenBy : null,
      followUps: followUps.filter((entry, at, all) => all.findIndex((other) => other.id === entry.id) === at).map((entry) => ({ id: entry.id, title: entry.title, reeName: entry.reeName })),
      deleted: row.deletedAt !== null,
    };
  });
}

/** A copied Q&A with no answer left to show says nothing; a real post waiting for answers does. */
const worthListing = sql`(${hasShownAnswer()} or ${post.source} in ('post', 'seed'))`;
/** 待回答: real posts whose answering is over with no answer anyone can read. */
const unanswered = (): SQL => and(inArray(post.source, ['post', 'seed']), eq(post.answerState, 'done'), sql`not ${hasShownAnswer()}`)!;
/** 为你推荐 ranks the answered posts of this window; older ones stay in 最新 and search. */
const FOR_YOU_WINDOW_MS = 30 * 86_400_000;
/** Question and detail as the trigram index (post_search_idx) has them. */
const searchable = sql`(${post.question} || ' ' || ${post.detail})`;

/**
 * One page of a feed. 最新 and 待回答 page by `(published_at, id)`; 为你推荐
 * ranks answered posts by helpful votes and answers, decaying with age, and
 * pages by offset (its cursor is a number).
 */
export async function listFeed(tab: FeedTab, options: { cursor?: string | null; viewerId?: string; size?: number; q?: string | null } = {}): Promise<PostPage> {
  const size = options.size ?? POST_PAGE_SIZE;
  /* One ILIKE over the indexed expression (pg_trgm), not two over separate columns. */
  const search = options.q?.trim() ? sql`${searchable} ilike ${`%${options.q.trim().replace(/[%_\\]/g, '\\$&')}%`}` : undefined;
  if (tab === 'for_you') {
    const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
    const helpful = sql`(select coalesce(sum(a.helpful_count), 0) from ${answer} a where a.post_id = ${post.id} and a.state = 'answered' and a.hidden_by is null)`;
    const score = sql`((${helpful} * 2 + ${post.answerCount} + 1)::float / power(extract(epoch from (now() - ${post.publishedAt})) / 3600 + 2, 1.3))`;
    /* Scored over the last 30 days only (post_feed_idx narrows it by published_at), so the sort never covers the whole table. */
    const recent = sql`${post.publishedAt} > ${new Date(Date.now() - FOR_YOU_WINDOW_MS).toISOString()}::timestamptz`;
    const rows = await selectPosts(and(visiblePost(), recent, hasShownAnswer(), search), [desc(score), desc(post.id)], size + 1, offset);
    return { items: await viewsOf(rows.slice(0, size), options.viewerId, { whole: false }), next: rows.length > size ? String(offset + size) : null };
  }
  let boundary: SQL | undefined;
  if (options.cursor) {
    if (!isUuid(options.cursor)) return { items: [], next: null };
    const [cursor] = await db().select({ at: post.publishedAt, id: post.id }).from(post).where(eq(post.id, options.cursor)).limit(1);
    if (!cursor?.at) return { items: [], next: null };
    boundary = sql`(${post.publishedAt}, ${post.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
  }
  const scope = tab === 'unanswered' ? unanswered() : worthListing;
  const rows = await selectPosts(and(visiblePost(), scope, boundary, search), [desc(post.publishedAt), desc(post.id)], size + 1);
  return { items: await viewsOf(rows.slice(0, size), options.viewerId, { whole: false }), next: rows.length > size ? rows[size - 1]!.id : null };
}

/** Posts waiting for an answer, for the rail's card. */
export async function unansweredCount(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(post)
    .where(and(visiblePost(), unanswered()));
  return row?.n ?? 0;
}

/**
 * One post: anyone may read a visible one; its author also their own
 * pending, rejected or trashed one. Null otherwise.
 */
export async function getPost(id: string, viewerId?: string): Promise<PostView | null> {
  if (!isUuid(id)) return null;
  const mine = viewerId ? and(eq(post.userId, viewerId), eq(post.source, 'post')) : undefined;
  const [row] = await selectPosts(and(eq(post.id, id), mine ? or(visiblePost(), mine) : visiblePost()), [desc(post.createdAt)], 1);
  if (!row) return null;
  return (await viewsOf([row], viewerId, { whole: true }))[0] ?? null;
}

/** For metadata and indexing: the question, and whether the page may be indexed (published with an answer, P11). */
export async function postMeta(id: string): Promise<{ question: string; detail: string; answered: number; lang: 'zh' | 'en' } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db()
    .select({ question: post.question, detail: post.detail, answered: sql<number>`(case when ${hasShownAnswer()} then 1 else 0 end)`, lang: post.lang })
    .from(post)
    .where(and(eq(post.id, id), visiblePost()))
    .limit(1);
  return row ?? null;
}

/** For the sitemap: visible posts with an answer anyone can read now, newest first. */
export async function indexablePosts(limit = 5000): Promise<{ id: string; at: Date }[]> {
  return db()
    .select({ id: post.id, at: sql<Date>`coalesce(${post.answeredAt}, ${post.publishedAt})` })
    .from(post)
    .where(and(visiblePost(), hasShownAnswer()))
    .orderBy(desc(post.publishedAt))
    .limit(limit);
}

export type MinePostsView = 'public' | 'trash';

/** The author's public posts (any state) or their trash, newest first, paged by offset. */
export async function listMyPosts(userId: string, view: MinePostsView, page = 1, size = POST_PAGE_SIZE): Promise<{ items: PostView[]; total: number; page: number; size: number }> {
  const where = and(eq(post.userId, userId), eq(post.source, 'post'), view === 'trash' ? isNotNull(post.deletedAt) : isNull(post.deletedAt));
  const [counted] = await db().select({ n: sql<number>`count(*)::int` }).from(post).where(where);
  const total = counted?.n ?? 0;
  const current = Math.max(1, Math.min(page, Math.max(1, Math.ceil(total / size))));
  const rows = await selectPosts(where, [desc(post.createdAt), desc(post.id)], size, (current - 1) * size);
  return { items: await viewsOf(rows, userId, { whole: false }), total, page: current, size };
}

/** How many public posts and trashed ones the author has, for the tabs. */
export async function myPostCounts(userId: string): Promise<{ public: number; trash: number }> {
  const [row] = await db()
    .select({
      public: sql<number>`count(*) filter (where ${post.deletedAt} is null)::int`,
      trash: sql<number>`count(*) filter (where ${post.deletedAt} is not null)::int`,
    })
    .from(post)
    .where(and(eq(post.userId, userId), eq(post.source, 'post')));
  return { public: row?.public ?? 0, trash: row?.trash ?? 0 };
}

/** Posts the viewer saved, newest save first. */
export async function listSavedPosts(userId: string, page = 1, size = POST_PAGE_SIZE): Promise<{ items: PostView[]; total: number; page: number; size: number }> {
  const where = and(visiblePost(), sql`exists (select 1 from ${save} s where s.post_id = ${post.id} and s.user_id = ${userId})`);
  const [counted] = await db().select({ n: sql<number>`count(*)::int` }).from(post).where(where);
  const total = counted?.n ?? 0;
  const current = Math.max(1, Math.min(page, Math.max(1, Math.ceil(total / size))));
  const order = sql`(select s.created_at from ${save} s where s.post_id = ${post.id} and s.user_id = ${userId})`;
  const rows = await selectPosts(where, [desc(order), desc(post.id)], size, (current - 1) * size);
  return { items: await viewsOf(rows, userId, { whole: false }), total, page: current, size };
}

/* ------------------------------------------------------------------ actions */

/** The author moves a post to the trash (gone for everyone else at once) or back. */
export async function setPostTrashed(userId: string, id: string, trashed: boolean, now = new Date()): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db()
    .update(post)
    .set({ deletedAt: trashed ? now : null })
    .where(and(eq(post.id, id), eq(post.userId, userId), eq(post.source, 'post'), trashed ? isNull(post.deletedAt) : isNotNull(post.deletedAt)))
    .returning({ id: post.id });
  return rows.length > 0;
}

/** Trashed posts older than 30 days go for good, with their answers. Hourly cron. */
export async function purgePostTrash(now = new Date(), limit = 500): Promise<number> {
  const old = await db().select({ id: post.id }).from(post).where(lt(post.deletedAt, new Date(now.getTime() - 30 * 86_400_000))).limit(limit);
  if (old.length === 0) return 0;
  await db().delete(post).where(inArray(post.id, old.map((row) => row.id)));
  return old.length;
}

export async function setPostSaved(userId: string, id: string, saved: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [target] = await db().select({ id: post.id }).from(post).where(and(eq(post.id, id), visiblePost())).limit(1);
  if (!target) return false;
  if (saved) await db().insert(save).values({ userId, postId: id }).onConflictDoNothing();
  else await db().delete(save).where(and(eq(save.userId, userId), eq(save.postId, id)));
  return true;
}

/** The shown answer, locked, for the actions below. */
async function lockShown(tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0], id: string, reeId?: string) {
  const [row] = await tx
    .select({ id: answer.id, reeId: answer.reeId, ownerId: ree.ownerId })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(post, eq(post.id, answer.postId))
    .where(and(eq(answer.id, id), reeId ? eq(answer.reeId, reeId) : undefined, shownAnswer(), visiblePost()))
    .for('update', { of: answer });
  return row ?? null;
}

/** "有帮助", once per signed-in user; the new count, or null when the answer is not shown. */
export async function setAnswerHelpful(userId: string, id: string, on: boolean, reeId?: string): Promise<{ helpful: number; voted: boolean } | null> {
  if (!isUuid(id)) return null;
  return db().transaction(async (tx) => {
    if (!(await lockShown(tx, id, reeId))) return null;
    const changed = on
      ? await tx.insert(vote).values({ answerId: id, userId }).onConflictDoNothing().returning({ id: vote.answerId })
      : await tx.delete(vote).where(and(eq(vote.answerId, id), eq(vote.userId, userId))).returning({ id: vote.answerId });
    const [row] = changed.length
      ? await tx.update(answer).set({ helpfulCount: sql`greatest(${answer.helpfulCount} + ${on ? 1 : -1}, 0)` }).where(eq(answer.id, id)).returning({ helpful: answer.helpfulCount })
      : await tx.select({ helpful: answer.helpfulCount }).from(answer).where(eq(answer.id, id));
    return { helpful: row!.helpful, voted: on };
  });
}

/** "举报", once per reporter; the `PUBLIC_QA_REPORT_THRESHOLD`th distinct report hides the answer until an administrator restores it. */
export async function reportAnswer(id: string, reporter: string, reeId?: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    if (!(await lockShown(tx, id, reeId))) return false;
    const added = await tx.insert(report).values({ answerId: id, reporterKey: reporter }).onConflictDoNothing().returning({ id: report.answerId });
    if (added.length === 0) return true;
    const [row] = await tx.update(answer).set({ reportCount: sql`${answer.reportCount} + 1` }).where(eq(answer.id, id)).returning({ reports: answer.reportCount, postId: answer.postId });
    if (row!.reports >= PUBLIC_QA_REPORT_THRESHOLD) {
      await tx.update(answer).set({ hiddenBy: 'reports', pinnedAt: null }).where(and(eq(answer.id, id), isNull(answer.hiddenBy)));
      await recount(tx, row!.postId);
    }
    return true;
  });
}

async function recount(tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0], postId: string): Promise<void> {
  await tx
    .update(post)
    .set({ answerCount: sql`(select count(*)::int from ${answer} a where a.post_id = ${postId} and a.state = 'answered' and a.hidden_by is null)` })
    .where(and(eq(post.id, postId), eq(post.answerState, 'done')));
}

export type OwnerAction = 'hide' | 'pin' | 'unpin';

/** The Ree's owner hides one of its answers for good, or pins one (replacing the pinned one) or unpins it. */
export async function ownerActOnAnswer(userId: string, reeId: string, id: string, action: OwnerAction): Promise<boolean> {
  if (!isUuid(reeId) || !isUuid(id)) return false;
  return db().transaction(async (tx) => {
    /* The Ree first: two pins at once take turns instead of both clearing and one tripping the one-pin index. */
    const [owned] = await tx.select({ id: ree.id }).from(ree).where(and(eq(ree.id, reeId), eq(ree.ownerId, userId), isNull(ree.deletedAt))).for('update');
    if (!owned) return false;
    const [target] = await tx
      .select({ id: answer.id, postId: answer.postId })
      .from(answer)
      .where(and(eq(answer.id, id), eq(answer.reeId, reeId), eq(answer.state, 'answered'), isNull(answer.hiddenBy)))
      .for('update');
    if (!target) return false;
    if (action === 'hide') {
      await tx.update(answer).set({ hiddenBy: 'owner', pinnedAt: null }).where(eq(answer.id, id));
      await recount(tx, target.postId);
    } else if (action === 'pin') {
      await tx.update(answer).set({ pinnedAt: null }).where(and(eq(answer.reeId, reeId), isNotNull(answer.pinnedAt)));
      await tx.update(answer).set({ pinnedAt: new Date() }).where(eq(answer.id, id));
    } else {
      await tx.update(answer).set({ pinnedAt: null }).where(eq(answer.id, id));
    }
    return true;
  });
}

/* ------------------------------------------------------------ round table */

export type SummaryOutcome =
  | 'done'
  | 'not_found'
  | 'not_enough_answers'
  | 'already'
  | 'running'
  | 'failed'
  | 'rejected'
  | { error: 'insufficient_credits'; balance: number; needed: number };

/** A written summary stands while every answer it was written from is still shown; otherwise it is stale and no longer shown. */
export function summaryStale(summaryAnswers: readonly string[] | null, shownIds: ReadonlySet<string>): boolean {
  return (summaryAnswers ?? []).some((id) => !shownIds.has(id));
}

/**
 * Whether rewriting a stale summary is free (review round 3, O-b): within
 * `POST_SUMMARY_FREE_REWRITES` for the post, and only when none of the
 * answers that dropped out belongs to a Ree the author owns -- so hiding
 * one's own answer, or toggling one's own Ree private, never buys a free
 * summary.
 */
async function freeRewrite(userId: string, target: typeof post.$inferSelect): Promise<boolean> {
  if (target.summaryRewrites >= POST_SUMMARY_FREE_REWRITES) return false;
  const used = target.summaryAnswers ?? [];
  if (used.length === 0) return true;
  const [mine] = await db()
    .select({ id: answer.id })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(inArray(answer.id, used), eq(ree.ownerId, userId)))
    .limit(1);
  return !mine;
}

/**
 * "圆桌总结" of a public post: only its author starts it, it costs
 * `POST_SUMMARY_FEE` (to the platform, like a conversation's), and once
 * written -- and passed the same review as a post -- everyone sees it.
 *
 * - A failure, or a summary the review refuses, gives the fee back.
 * - Once any answer it drew on is no longer shown (hidden, its Ree private),
 *   the summary is stale: it is not shown, and the author may write it again
 *   from the answers shown now -- free (default, see the PR) up to
 *   `POST_SUMMARY_FREE_REWRITES` times when their own Rees had no part in it
 *   (`freeRewrite`), else at the usual fee.
 * - Only the run that holds the claim writes: a run that outlived the stale
 *   window and was replaced settles nothing and writes nothing.
 */
export async function summarizePost(userId: string, id: string, lang: 'zh' | 'en', judge: Judge = modelJudge): Promise<SummaryOutcome> {
  if (!isUuid(id)) return 'not_found';
  const [target] = await db().select().from(post).where(and(eq(post.id, id), eq(post.userId, userId), eq(post.source, 'post'), visiblePost())).limit(1);
  if (!target) return 'not_found';
  const shown = await answersFor([id]).then((rows) => rows.filter((row) => row.shown));
  const stale = target.summaryState === 'done' && summaryStale(target.summaryAnswers, new Set(shown.map((row) => row.id)));
  if (target.summaryState === 'done' && !stale) return 'already';
  if (shown.length < 2) return 'not_enough_answers';
  const free = stale && (await freeRewrite(userId, target));
  const run = randomUUID();
  let claim: { holdId: string | null } | null;
  try {
    claim = await db().transaction(async (tx) => {
      const [claimed] = await tx
        .update(post)
        .set({ summaryState: 'running', summaryAt: new Date() })
        .where(
          and(
            eq(post.id, id),
            or(
              isNull(post.summaryState),
              and(eq(post.summaryState, 'running'), lt(post.summaryAt, new Date(Date.now() - POST_ANSWERING_STALE_MS))),
              stale ? eq(post.summaryState, 'done') : undefined,
            ),
          ),
        )
        .returning({ id: post.id, previous: post.summaryHoldId });
      if (!claimed) return null;
      if (claimed.previous) await releaseHold(tx, claimed.previous, { note: 'post summary', ledger: 'post_summary' });
      const hold = free ? null : await placeHold(tx, { userId, kind: 'post', ledger: 'post_summary', amount: POST_SUMMARY_FEE, refId: id, note: 'post summary' });
      /* The hold (or, free, the run id) marks the claim: a replaced run finds another one there. */
      await tx.update(post).set({ summaryHoldId: hold ?? run }).where(eq(post.id, id));
      return { holdId: hold };
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) {
      await db().update(post).set({ summaryState: null }).where(and(eq(post.id, id), eq(post.summaryState, 'running'), isNull(post.summaryHoldId)));
      return { error: 'insufficient_credits', balance: await balanceOf(db(), userId), needed: POST_SUMMARY_FEE };
    }
    throw error;
  }
  if (!claim) return 'running';
  const mark = claim.holdId ?? run;
  /* Gives the fee back and clears the claim -- only if this run still holds it. */
  const giveBack = () =>
    db().transaction(async (tx) => {
      const [mine] = await tx.select({ id: post.id }).from(post).where(and(eq(post.id, id), eq(post.summaryHoldId, mark))).for('update');
      if (claim!.holdId) await releaseHold(tx, claim!.holdId, { note: 'post summary', ledger: 'post_summary' });
      if (mine) await tx.update(post).set({ summaryState: null, summaryContent: null, summarySources: null, summaryAnswers: null, summaryHoldId: null }).where(eq(post.id, id));
    });
  const answers = letterAnswers(shown.map((row) => ({ reeId: row.reeId, messageId: row.id, reeName: row.name, text: row.text, citations: row.citations })));
  let content: string;
  let sources: ReturnType<typeof cleanSynthesis>['sources'];
  try {
    const generation = await generationForUser(userId, 'synthesis');
    const { text } = await generateText({
      model: generation.model,
      instructions: synthesisInstructions(lang),
      messages: [{ role: 'user', content: synthesisPrompt([target.question, target.detail].filter(Boolean).join('\n'), answers) }],
      maxOutputTokens: 1_500,
      temperature: 0.2,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(Math.max(generation.endpoint.timeoutMs, 30_000) * 2),
    });
    ({ content, sources } = cleanSynthesis(text, answers));
    if (!content) throw new Error('empty summary');
  } catch (error) {
    console.warn(`post ${id} summary failed: ${error instanceof Error ? error.message : 'unknown'}`);
    await giveBack();
    return 'failed';
  }
  /* The same review as the post's question: a summary is public text too. A review that cannot run counts as failed (fee back). */
  let verdict: boolean | null = null;
  try {
    verdict = (await judge([target.question, target.detail].filter(Boolean).join('\n\n'), content)).publish;
  } catch (error) {
    console.warn(`post ${id} summary review failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (verdict !== true) {
    await giveBack();
    return verdict === false ? 'rejected' : 'failed';
  }
  const written = await db().transaction(async (tx) => {
    const [mine] = await tx.select({ id: post.id }).from(post).where(and(eq(post.id, id), eq(post.summaryHoldId, mark), eq(post.summaryState, 'running'))).for('update');
    if (!mine) return false;
    if (claim!.holdId) await settleHold(tx, claim!.holdId, POST_SUMMARY_FEE, { note: 'post summary', ledger: 'post_summary' });
    await tx
      .update(post)
      .set({
        summaryState: 'done',
        summaryContent: content,
        summarySources: sources,
        summaryAnswers: answers.map((entry) => entry.messageId),
        summaryHoldId: null,
        ...(free ? { summaryRewrites: sql`${post.summaryRewrites} + 1` } : {}),
      })
      .where(eq(post.id, id));
    return true;
  });
  return written ? 'done' : 'running';
}

/* ---------------------------------------------------------------- 继续问 */

/**
 * "继续问" (P8): the post's author starts a private conversation with one
 * Ree that answered, from the post's question and that answer, linked to
 * the post. The two are written as the conversation's first exchange so the
 * next question is a follow-up; nothing is charged until it is asked, then
 * as any question. The seeded exchange is not a new question or answer:
 * the post's answers are untouched, and the two copied messages
 * (`copied_from_post`) count in no figure -- ranking, explore, verification,
 * owner statistics, the console -- and take no vote. What is asked after
 * them is an ordinary, charged question and counts like one.
 * Only the author: anyone else gets null.
 */
export async function followUpPost(userId: string, id: string, answerId: string): Promise<string | null> {
  if (!isUuid(id) || !isUuid(answerId)) return null;
  const [target] = await db()
    .select({ question: post.question, detail: post.detail, reeId: answer.reeId, text: answer.text, citations: answer.citations })
    .from(answer)
    .innerJoin(post, eq(post.id, answer.postId))
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(eq(answer.id, answerId), eq(answer.postId, id), eq(post.userId, userId), eq(post.source, 'post'), shownAnswer(), visiblePost()))
    .limit(1);
  if (!target) return null;
  return db().transaction(async (tx) => {
    const title = target.question.slice(0, 120);
    const [created] = await tx.insert(conversation).values({ userId, title, postId: id }).returning({ id: conversation.id });
    await tx.insert(schema.conversationRee).values({ conversationId: created!.id, reeId: target.reeId });
    const asked = new Date();
    const requestId = randomUUID();
    /* Copied, both: no one asked or answered them here, so they count in no figure (`copied_from_post`). */
    await tx.insert(message).values({ id: requestId, conversationId: created!.id, role: 'user', content: [target.question, target.detail].filter(Boolean).join('\n\n'), requestId, copiedFromPost: true, createdAt: asked });
    await tx.insert(message).values({ conversationId: created!.id, role: 'ree', reeId: target.reeId, content: target.text, citations: target.citations, requestId, copiedFromPost: true, createdAt: new Date(asked.getTime() + 1) });
    return created!.id;
  });
}

/* ------------------------------------------------------- taking a post down */

/**
 * "举报" a post's question, signed in or not (the answers' rule): once per
 * reporter -- an account, or a visitor's network -- and the
 * `POST_REPORT_THRESHOLD`th distinct reporter hides the post everywhere
 * (feeds, its page, search, the sitemap, Ree pages, shares) until an
 * administrator restores it. Credits it settled stay settled: its answers
 * were given (default, see the PR). False when the post is not shown.
 */
export async function reportPost(id: string, reporter: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [target] = await tx.select({ id: post.id }).from(post).where(and(eq(post.id, id), visiblePost())).for('update');
    if (!target) return false;
    const added = await tx.insert(schema.postReport).values({ postId: id, reporterKey: reporter }).onConflictDoNothing().returning({ id: schema.postReport.postId });
    if (added.length === 0) return true;
    const [row] = await tx.update(post).set({ reportCount: sql`${post.reportCount} + 1` }).where(eq(post.id, id)).returning({ reports: post.reportCount });
    if (row!.reports >= POST_REPORT_THRESHOLD) await tx.update(post).set({ status: 'hidden', hiddenBy: 'reports' }).where(and(eq(post.id, id), eq(post.status, 'published')));
    return true;
  });
}

export interface AdminPost {
  id: string;
  question: string;
  source: PostSource;
  status: 'published' | 'hidden';
  hiddenBy: 'admin' | 'reports' | null;
  reports: number;
  answers: number;
  createdAt: string;
}

/** The console's posts: reported or hidden ones first, then the newest; `q` searches the question. */
export async function adminPosts(options: { view?: 'reported' | 'hidden' | 'all'; q?: string | null; limit?: number } = {}): Promise<AdminPost[]> {
  const view = options.view ?? 'reported';
  const where = and(
    inArray(post.status, ['published', 'hidden']),
    view === 'reported' ? sql`${post.reportCount} > 0` : view === 'hidden' ? eq(post.status, 'hidden') : undefined,
    options.q?.trim() ? sql`${searchable} ilike ${`%${options.q.trim().replace(/[%_\\]/g, '\\$&')}%`}` : undefined,
  );
  const rows = await db()
    .select({ id: post.id, question: post.question, source: post.source, status: post.status, hiddenBy: post.hiddenBy, reports: post.reportCount, answers: post.answerCount, createdAt: post.createdAt })
    .from(post)
    .where(where)
    .orderBy(desc(post.reportCount), desc(post.createdAt))
    .limit(options.limit ?? 50);
  return rows.map((row) => ({ ...row, status: row.status as 'published' | 'hidden', createdAt: row.createdAt.toISOString() }));
}

/** An administrator hides a published post, or restores one an administrator or reports hid; either is in the management log. */
export async function adminSetPost(administratorId: string, id: string, show: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [before] = await tx.select({ status: post.status, hiddenBy: post.hiddenBy, question: post.question }).from(post).where(eq(post.id, id)).for('update');
    if (!before || before.status !== (show ? 'hidden' : 'published')) return false;
    if (show) {
      await tx.update(post).set({ status: 'published', hiddenBy: null, reportCount: 0 }).where(eq(post.id, id));
      await tx.delete(schema.postReport).where(eq(schema.postReport.postId, id));
    } else {
      await tx.update(post).set({ status: 'hidden', hiddenBy: 'admin' }).where(eq(post.id, id));
    }
    await audit(tx, { administratorId, action: show ? 'post.restore' : 'post.hide', target: id, before: { status: before.status, hiddenBy: before.hiddenBy, question: before.question.slice(0, 200) } });
    return true;
  });
}

/* ------------------------------------------------------------- Ree pages */

/** A Ree's answered posts for its page, newest first, the pinned one first on the first page. */
export async function reeAnsweredPosts(reeId: string, options: { before?: string | null; viewerId?: string; size?: number } = {}): Promise<{ items: PostView[]; total: number; next: string | null } | null> {
  if (!isUuid(reeId)) return null;
  const size = options.size ?? 10;
  const [target] = await db().select({ id: ree.id }).from(ree).where(and(eq(ree.id, reeId), publicRee())).limit(1);
  if (!target) return null;
  const base = and(eq(answer.reeId, reeId), shownAnswer(), visiblePost())!;
  const [counted] = await db().select({ n: sql<number>`count(*)::int` }).from(answer).innerJoin(ree, eq(ree.id, answer.reeId)).innerJoin(post, eq(post.id, answer.postId)).where(base);
  let boundary: SQL | undefined;
  if (options.before) {
    if (!isUuid(options.before)) return null;
    const [cursor] = await db().select({ at: answer.answeredAt, id: answer.id }).from(answer).where(and(eq(answer.id, options.before), eq(answer.reeId, reeId))).limit(1);
    if (!cursor?.at) return { items: [], total: counted?.n ?? 0, next: null };
    boundary = sql`(${answer.answeredAt}, ${answer.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
  }
  const pick = (where: SQL | undefined, limit: number) =>
    db()
      .select({ answerId: answer.id, postId: answer.postId })
      .from(answer)
      .innerJoin(ree, eq(ree.id, answer.reeId))
      .innerJoin(post, eq(post.id, answer.postId))
      .where(and(base, where))
      .orderBy(desc(answer.answeredAt), desc(answer.id))
      .limit(limit);
  const pinned = options.before ? [] : await pick(isNotNull(answer.pinnedAt), 1);
  const rows = await pick(and(isNull(answer.pinnedAt), boundary), size + 1);
  const page = [...pinned, ...rows.slice(0, size)];
  const posts = await selectPosts(inArray(post.id, page.length ? page.map((row) => row.postId) : [randomUUID()]), [desc(post.createdAt)], page.length || 1);
  const ordered = page.map((row) => posts.find((entry) => entry.id === row.postId)).filter((row): row is PostRow => Boolean(row));
  return { items: await viewsOf(ordered, options.viewerId, { whole: false, onlyRee: reeId }), total: counted?.n ?? 0, next: rows.length > size ? rows[size - 1]!.answerId : null };
}

/** Shown answers per Ree, for the explore cards' activity line. */
export async function answeredPostCounts(reeIds: readonly string[]): Promise<Map<string, number>> {
  if (reeIds.length === 0) return new Map();
  const rows = await db()
    .select({ reeId: answer.reeId, n: sql<number>`count(*)::int` })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(post, eq(post.id, answer.postId))
    .where(and(inArray(answer.reeId, [...reeIds]), shownAnswer(), visiblePost()))
    .groupBy(answer.reeId);
  return new Map(rows.map((row) => [row.reeId, row.n]));
}

/* ------------------------------------------------------------ settings */

/** The owner turns answering public posts on or off for one of their Rees; null when it is not theirs. */
export async function setAnswersPosts(userId: string, reeId: string, on: boolean): Promise<boolean | null> {
  if (!isUuid(reeId)) return null;
  const rows = await db().update(ree).set({ answersPosts: on }).where(and(eq(ree.id, reeId), eq(ree.ownerId, userId), isNull(ree.deletedAt))).returning({ id: ree.id });
  return rows.length ? on : null;
}

export type { PostSource };
