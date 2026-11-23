/**
 * Public posts (v5, lib/domain/post.ts).
 *
 *   1. Publishing (`publishPost`) costs nothing: the question is redacted
 *      like a public answer and the post starts `pending`, as long as the
 *      author has at least one base fee and is under the daily limit.
 *   2. `processPost` runs after the response (`after()`), and again from the
 *      posts cron for a post a request did not finish:
 *      - the question is reviewed (the public Q&A's check, question only);
 *        refused → `rejected`, nothing was charged;
 *      - the Rees are matched: the search's `POST_CANDIDATES` nearest public
 *        Rees, those whose best passage reaches `POST_MIN_SIMILARITY` and
 *        that take posts (`ree.answers_posts`, by default free Rees only),
 *        at most `POST_MAX_ANSWERS`; a mentioned Ree that takes posts comes
 *        first whatever its similarity;
 *      - billing is per answer (2026-11-19): each free Ree of someone else
 *        holds the author's base fee, most relevant first, and answers; one
 *        the balance cannot cover, and every paid Ree, waits as a request
 *        the author agrees to (`agreePaidAnswer`). The author's own Rees hold
 *        the base fee too, only their query fee waived (2026-11-19 review);
 *        RE0's example posts charge nobody;
 *      - each answer settles its own hold: the base fee to the platform when
 *        it answered, given back when it did not.
 *   3. Reading: the feeds (为你推荐 / 最新 / 待回答), a post with its answers,
 *      a Ree's answered posts (the Ree page and the share page, where the
 *      copied public Q&A also lives), the author's own posts and trash, and
 *      saved posts.
 *
 * A post is shown while it is public, published and not in its author's
 * trash. One copied from a signed-in asker's conversation is a public post
 * like any other since the conversations went (migration 0070 deleted those
 * whose conversation was in the trash, as the purge would have). An answer is shown
 * while it answered, nobody hid it, and its Ree is public (and, for a copied
 * Q&A, keeps public Q&A on).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { generateText } from 'ai';
import { citationSnapshots, type CitationSnapshot } from '@/lib/domain/answer';
import { InsufficientCredits } from '@/lib/domain/credits';
import { isUuid } from '@/lib/domain/list';
import {
  AUTHORED_SOURCES,
  POST_ANSWERING_STALE_MS,
  POST_CANDIDATES,
  POST_DAILY_LIMIT,
  POST_DUPLICATE_WINDOW_MS,
  POST_MAX_ANSWERS,
  POST_MIN_SIMILARITY,
  POST_PAGE_SIZE,
  POST_PAID_AGREE_MAX,
  POST_PAID_ANSWER_STALE_MS,
  POST_PREVIEW_CHARS,
  POST_QUOTE_PREVIEW_CHARS,
  POST_QUOTE_NOTICE_MERGE_MS,
  POST_QUOTE_NOTICE_QUOTER_MS,
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
  type PaidRequestView,
  type PostAnswerView,
  type PostAuthor,
  type PostPage,
  type PostQuote,
  type PostSource,
  type PostView,
} from '@/lib/domain/post';
import { PUBLIC_QA_MODERATION_ATTEMPTS, PUBLIC_QA_REPORT_THRESHOLD, plainOf, previewOf, redact } from '@/lib/domain/public-qa';
import { cleanSynthesis, letterAnswers, synthesisInstructions, synthesisPrompt } from '@/lib/domain/synthesis';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { maxCostFor, readyRees, streamGroundedAnswer, type Emit } from '@/lib/services/grounded-answer';
import { embedQuestion, retrieve, type QuestionVector } from '@/lib/services/retrieval';
import { balanceOf, creditQueryFee, placeHold, releaseHold, settleHold } from '@/lib/services/credits';
import { publicRee, searchRees } from '@/lib/services/explore';
import { generationForUser } from '@/lib/services/generation';
import { audit } from '@/lib/services/admin';
import { adminAiAnswers, aiAnswersFor, aiRoundKey, answerWithAi, type AdminAiAnswer, type AiAnswerer } from '@/lib/services/ai-answers';
import { notify } from '@/lib/services/notices';
import { grantTaskReward } from '@/lib/services/task-rewards';
import { modelJudge, type Judge } from '@/lib/services/public-qa';
import { questionRewriter } from '@/lib/services/question-rewrite';

const { post, postVote, postAnswer: answer, postAnswerVote: vote, postAnswerFeedback: feedback, postAnswerReport: report, postSave: save, postFollowup: followup, ree, user } = schema;

/* --------------------------------------------------------------- visibility */

/**
 * Public, published and out of the author's trash. A private post is never
 * visible to anyone but its author, who reads it through `ownPrivatePost`.
 */
export function visiblePost(): SQL {
  return and(eq(post.visibility, 'public'), eq(post.status, 'published'), isNull(post.deletedAt))!;
}

/** The author's own private post, live (out of the trash): what they may read and act on that nobody else may. */
export function ownPrivatePost(userId: string): SQL {
  return and(eq(post.userId, userId), eq(post.visibility, 'private'), eq(post.status, 'published'), isNull(post.deletedAt))!;
}

/** A post this user may read and act on as a reader: a visible one, or their own live private one. */
export function readablePost(userId: string): SQL {
  return or(visiblePost(), ownPrivatePost(userId))!;
}

/** The author's own posts, whatever their state: the sources a signed-in author writes (not visitors', RE0's or copied Q&A). */
export function authoredBy(userId: string): SQL {
  return and(eq(post.userId, userId), inArray(post.source, [...AUTHORED_SOURCES]))!;
}

/**
 * An answer its private post's author reads: given and not hidden, whatever
 * its Ree's visibility now -- the author's own private Ree may answer them,
 * and a public Ree going private does not take back what it told them (as a
 * conversation kept its replies). Needs `post_answer`.
 */
export function privateAnswerShown(): SQL {
  return sql`(${answer.state} = 'answered' and ${answer.hiddenBy} is null and exists (select 1 from ${post} pp where pp.id = ${answer.postId} and pp.visibility = 'private'))`;
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
  return sql`(${post.visibility} = 'public' and exists (select 1 from ${answer} sa join ${ree} on ${ree.id} = sa.ree_id
    where sa.post_id = ${post.id} and sa.followup_id is null and sa.state = 'answered' and sa.hidden_by is null
      and ${publicRee()} and (sa.legacy_qa_id is null or ${ree.publicQaEnabled})))`;
}

/** An answer of the post's first round, not of a follow-up (追问): what the counts, the cards, the summary and the Ree pages are about. */
export function firstRound(): SQL {
  return isNull(answer.followupId);
}

/** A follow-up's answer is read only while its follow-up is: published and not deleted (a hidden one hides its answers). Needs `post_answer`. */
export function shownFollowupOf(): SQL {
  return sql`(${answer.followupId} is null or exists (select 1 from ${schema.postFollowup} sf where sf.id = ${answer.followupId} and sf.status = 'published' and sf.deleted_at is null))`;
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
  /** "引用提问": a visible post to quote, and optionally one of its shown answers (whose Ree is then named and answers first). */
  quotePostId?: string | null;
  quoteAnswerId?: string | null;
  lang: 'zh' | 'en';
  /** The composer's token for this post: sending it again returns the same post. */
  clientToken?: string | null;
}

export type PublishOutcome =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; error: 'empty' | 'too_long' | 'daily_limit' | 'quote_unavailable' }
  | { ok: false; error: 'insufficient_credits'; balance: number; needed: number };

/**
 * What the composer says before posting: the balance, what one free Ree's
 * answer costs and the most the automatic answers can cost (every place a
 * free Ree), and posts made today against the daily limit.
 */
export async function postAllowance(userId: string, now = new Date()): Promise<{ balance: number; baseFee: number; maxAnswers: number; maxCost: number; postedToday: number; dailyLimit: number }> {
  const day = postDay(now);
  const [row] = await db()
    .select({ today: sql<number>`count(*) filter (where ${post.createdAt} >= ${day}::date)::int` })
    .from(post)
    .where(and(eq(post.userId, userId), eq(post.source, 'post')));
  return { balance: await balanceOf(db(), userId, now), baseFee: QUERY_BASE_FEE, maxAnswers: POST_MAX_ANSWERS, maxCost: POST_MAX_ANSWERS * QUERY_BASE_FEE, postedToday: row?.today ?? 0, dailyLimit: POST_DAILY_LIMIT };
}

/**
 * Publishes a post as `pending`. Posting costs nothing -- each answer is
 * charged on its own (`processPost`) -- but a balance below one base fee
 * could pay for no answer, so it is refused with a top-up. One user's posts
 * are counted under an advisory lock against the daily limit. Idempotent: the
 * same `clientToken`, or the same text within `POST_DUPLICATE_WINDOW_MS`,
 * returns the post already made (`duplicate`).
 */
export async function publishPost(userId: string, input: PostInput, now = new Date()): Promise<PublishOutcome> {
  const invalid = postInputError(input.question, input.detail ?? '');
  if (invalid) return { ok: false, error: invalid };
  const question = redact(input.question.trim(), input.lang);
  const detail = redact((input.detail ?? '').trim(), input.lang);
  let mention = input.mentionReeId && isUuid(input.mentionReeId) ? input.mentionReeId : null;
  /* A quote must be something anyone can see now: a published post out of the trash, and -- quoting an answer -- an answer that is shown. */
  let quote: { kind: 'post' | 'answer'; postId: string; answerId: string | null } | null = null;
  if (input.quotePostId) {
    const quoted = await quotable(input.quotePostId, input.quoteAnswerId ?? null);
    if (!quoted) return { ok: false, error: 'quote_unavailable' };
    quote = quoted;
    /* Quoting an answer names its Ree: it answers first (one of the five). */
    if (quoted.reeId) mention = quoted.reeId;
  }
  const clientToken = input.clientToken && isUuid(input.clientToken) ? input.clientToken : null;
  const id = randomUUID();
  const day = postDay(now);
  try {
    return await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`post:${userId}`}))`);
      const [same] = await tx
        .select({ id: post.id })
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
              /* The same text quoting the same thing (or nothing): quoting something else is another post. */
              and(
                eq(post.question, question),
                eq(post.detail, detail),
                sql`${post.quotePostId} is not distinct from ${quote?.postId ?? null}::uuid`,
                sql`${post.quoteAnswerId} is not distinct from ${quote?.answerId ?? null}::uuid`,
                sql`${post.createdAt} > ${new Date(now.getTime() - POST_DUPLICATE_WINDOW_MS).toISOString()}::timestamptz`,
              ),
            ),
          ),
        )
        .orderBy(desc(post.createdAt))
        .limit(1);
      if (same) return { ok: true, id: same.id, duplicate: true } as const;
      const [counts] = await tx
        .select({ today: sql<number>`count(*) filter (where ${post.createdAt} >= ${day}::date)::int` })
        .from(post)
        .where(and(eq(post.userId, userId), eq(post.source, 'post')));
      if ((counts?.today ?? 0) >= POST_DAILY_LIMIT) return { ok: false, error: 'daily_limit' } as const;
      const balance = await balanceOf(tx, userId, now);
      if (balance < QUERY_BASE_FEE) return { ok: false, error: 'insufficient_credits', balance, needed: QUERY_BASE_FEE } as const;
      await tx.insert(post).values({
        id,
        userId,
        source: 'post',
        anonymous: input.anonymous === true,
        question,
        detail,
        lang: input.lang,
        mentionReeId: mention,
        quoteKind: quote?.kind ?? null,
        quotePostId: quote?.postId ?? null,
        quoteAnswerId: quote?.answerId ?? null,
        clientToken,
        createdAt: now,
      });
      return { ok: true, id } as const;
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, error: 'insufficient_credits', balance: await balanceOf(db(), userId), needed: QUERY_BASE_FEE };
    throw error;
  }
}

/* ------------------------------------------------------------------ quotes */

/** A post (and answer) that may be quoted now: visible, published, the answer shown. */
async function quotable(postId: string, answerId: string | null): Promise<{ kind: 'post' | 'answer'; postId: string; answerId: string | null; reeId: string | null } | null> {
  if (!isUuid(postId) || (answerId !== null && !isUuid(answerId))) return null;
  const [target] = await db().select({ id: post.id }).from(post).where(and(eq(post.id, postId), visiblePost())).limit(1);
  if (!target) return null;
  if (!answerId) return { kind: 'post', postId, answerId: null, reeId: null };
  const [quoted] = await db()
    .select({ id: answer.id, reeId: answer.reeId })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(eq(answer.id, answerId), eq(answer.postId, postId), firstRound(), shownAnswer()))
    .limit(1);
  return quoted ? { kind: 'answer', postId, answerId, reeId: quoted.reeId } : null;
}

/** The quoted question (and answer), while they can still be seen; null otherwise. */
async function quoteContext(row: { quotePostId: string | null; quoteAnswerId: string | null }): Promise<QuoteContext | null> {
  if (!row.quotePostId) return null;
  const [quoted] = await db().select({ question: post.question, detail: post.detail }).from(post).where(and(eq(post.id, row.quotePostId), visiblePost())).limit(1);
  if (!quoted) return null;
  const question = [quoted.question, quoted.detail].filter(Boolean).join('\n');
  if (!row.quoteAnswerId) return { question, answer: null };
  const [quotedAnswer] = await db()
    .select({ text: answer.text })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(eq(answer.id, row.quoteAnswerId), shownAnswer()))
    .limit(1);
  return { question, answer: quotedAnswer?.text ?? null };
}

/** Once a quoting post is public, the quoted post's author hears about it -- not when they quote themselves, and only for real posts. */
async function tellQuoted(tx: Executor, id: string, published: { userId: string | null; question: string; quotePostId: string | null } | undefined, now = new Date()): Promise<void> {
  if (!published?.quotePostId) return;
  const [quoted] = await tx.select({ userId: post.userId, source: post.source, question: post.question }).from(post).where(eq(post.id, published.quotePostId)).limit(1);
  if (!quoted?.userId || quoted.source !== 'post' || quoted.userId === published.userId) return;
  const notice = schema.notice;
  /*
   * One quoter tells one author at most once a day, whichever of their posts
   * they quote: an earlier public post of this quoter's, quoting this author,
   * within the day, already did. Matched through the posts, not the notices
   * (a folded notice points at the latest quoter only, and carries nobody's id).
   */
  if (published.userId) {
    const original = alias(post, 'quoted_original');
    const [recent] = await tx
      .select({ id: post.id })
      .from(post)
      .innerJoin(original, eq(original.id, post.quotePostId))
      .where(
        and(
          eq(post.userId, published.userId),
          ne(post.id, id),
          eq(original.userId, quoted.userId),
          inArray(post.status, ['published', 'hidden']),
          sql`${post.createdAt} > ${new Date(now.getTime() - POST_QUOTE_NOTICE_QUOTER_MS).toISOString()}::timestamptz`,
        ),
      )
      .limit(1);
    if (recent) return;
  }
  /* Quotes of one post within the hour, while unread, fold into one notice: "被引用了 N 次", pointing at the latest. */
  const [open] = await tx
    .select({ id: notice.id, params: notice.params })
    .from(notice)
    .where(
      and(
        eq(notice.userId, quoted.userId),
        eq(notice.kind, 'post_quoted'),
        isNull(notice.readAt),
        sql`${notice.params} ->> 'original' = ${published.quotePostId}`,
        sql`${notice.createdAt} > ${new Date(now.getTime() - POST_QUOTE_NOTICE_MERGE_MS).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(notice.createdAt))
    .limit(1)
    .for('update');
  if (open) {
    await tx.update(notice).set({ params: { ...open.params, count: Number(open.params.count ?? 1) + 1 }, refId: id }).where(eq(notice.id, open.id));
    return;
  }
  await notify(tx, { userId: quoted.userId, kind: 'post_quoted', params: { question: quoted.question.slice(0, 80), original: published.quotePostId, count: 1 }, refId: id });
}

/* ------------------------------------------------------------------ review */

/**
 * Reviews a pending post's question: published, rejected (nothing was
 * charged), or still pending when the check failed. A post in the trash is
 * not reviewed (`gone`): it stays pending, and once restored the sweep
 * (`processStalePosts`) reviews it -- so a post trashed while under review
 * is never published, nor pays its starter task, from the trash.
 */
export async function moderatePost(id: string, judge: Judge = modelJudge, now = new Date()): Promise<'published' | 'rejected' | 'pending' | 'gone'> {
  const [row] = await db()
    .update(post)
    .set({ moderationAttempts: sql`${post.moderationAttempts} + 1` })
    .where(and(eq(post.id, id), eq(post.status, 'pending'), isNull(post.deletedAt), lt(post.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS)))
    .returning({ question: post.question, detail: post.detail, attempts: post.moderationAttempts });
  if (!row) return 'gone';
  /* A new post has no answer yet and its question is reviewed alone; a private post made public (转为公开) brings its answers, reviewed with it. */
  const copied = await db().select({ text: answer.text }).from(answer).where(and(eq(answer.postId, id), firstRound(), eq(answer.state, 'answered'))).orderBy(asc(answer.createdAt));
  let verdict: boolean | null = null;
  try {
    verdict = (await judge([row.question, row.detail].filter(Boolean).join('\n\n'), copied.map((entry) => entry.text).join('\n\n'))).publish;
  } catch (error) {
    console.warn(`post ${id} review failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (verdict === null && row.attempts < PUBLIC_QA_MODERATION_ATTEMPTS) return 'pending';
  if (verdict) {
    const done = await db().transaction(async (tx) => {
      /* Trashed during the review: left pending, for the sweep once restored. */
      const [published] = await tx
        .update(post)
        .set({ status: 'published', publishedAt: now })
        .where(and(eq(post.id, id), eq(post.status, 'pending'), isNull(post.deletedAt)))
        .returning({ userId: post.userId, source: post.source, question: post.question, quotePostId: post.quotePostId });
      if (!published) return false;
      await tellQuoted(tx, id, published);
      /* 新手任务: a first post pays once it is public (a refused one never does); a private post made public counts too, once, whichever came first. */
      if (published.userId && published.source !== 'test') await grantTaskReward(tx, published.userId, 'first_post', id, now);
      return true;
    });
    return done ? 'published' : 'gone';
  }
  return (await rejectPost(id, now)) ? 'rejected' : 'gone';
}

/** A pending post refused (or whose review never finished): not public; nothing was charged. Not while in the trash (`moderatePost`). */
async function rejectPost(id: string, now: Date): Promise<boolean> {
  const rows = await db().update(post).set({ status: 'rejected', answerState: 'done', answeredAt: now }).where(and(eq(post.id, id), eq(post.status, 'pending'), isNull(post.deletedAt))).returning({ id: post.id });
  return rows.length > 0;
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

/** `excludePaid`: a post with no author to agree (RE0's example posts) takes free Rees only. */
export type Matcher = (input: { question: string; mentionReeId: string | null; authorId: string | null; excludePaid?: boolean }) => Promise<Match>;

/** The search's nearest public Rees, kept when close enough and taking posts; the mentioned one first. */
export const searchMatcher: Matcher = async ({ question, mentionReeId, excludePaid }) => {
  const vector = await embedQuestion(question);
  const hits = await searchRees({ question, vector, limit: POST_CANDIDATES });
  const ids = [...new Set([...(mentionReeId ? [mentionReeId] : []), ...hits.map((hit) => hit.reeId)])];
  const open = ids.length
    ? new Set((await db().select({ id: ree.id }).from(ree).where(and(inArray(ree.id, ids), publicRee(), takesPosts(), excludePaid ? eq(ree.queryFee, 0) : undefined))).map((row) => row.id))
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

/** `turns`: the exchange so far, for a follow-up (追问): the post's question and this Ree's own answers, nobody else's. */
/** `emit`: the answer's text as it is written (MCP's progress); posts are never streamed to a page. */
export type AnswerOne = (input: { reeId: string; subject: string; lang: 'zh' | 'en'; vector: QuestionVector | null; context?: QuoteContext | null; turns?: { role: 'user' | 'assistant'; content: string }[]; emit?: Emit }) => Promise<AnswerResult>;

/** What a quoting post brings to its answers: the quoted question, and the quoted answer when an answer was quoted. Context only, never evidence. */
export interface QuoteContext {
  question: string;
  answer: string | null;
}

/** One Ree's answer from its own knowledge, on the platform's model; never streamed to anyone. */
export const groundedAnswer: AnswerOne = async ({ reeId, subject, lang, vector, context, turns: earlier, emit }) => {
  const [target] = await db().select().from(ree).where(eq(ree.id, reeId)).limit(1);
  if (!target || !(await readyRees([reeId])).has(reeId)) return { state: 'no_answer', model: null };
  let model: string | null = null;
  try {
    const found = await retrieve(reeId, subject, vector ?? (await embedQuestion(subject)), { rewrite: questionRewriter(null, subject) });
    if (!found.evidence) return { state: 'no_answer', model: null };
    const generation = await generationForUser(null, 'post_answer');
    model = generation.endpoint.model;
    /* A quoted answer is the conversation so far; a quoted post, the question before this one. */
    const turns: { role: 'user' | 'assistant'; content: string }[] = earlier ?? (context?.answer
      ? [{ role: 'user', content: context.question }, { role: 'assistant', content: context.answer }]
      : []);
    const asked = context && !context.answer ? `${subject}\n\n(${context.question})` : subject;
    const { declined, text, model: answered } = await streamGroundedAnswer({ generation, ree: target, lang, subject: asked, passages: found.passages, turns }, emit ?? (() => undefined));
    model = answered;
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
  /** AI 通用回答 when no Ree answered (ai-answers.ts); the model by default. */
  aiAnswer?: AiAnswerer;
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
  /* A private post is answered by the Rees its author chose (private-posts.ts), never matched. */
  if (row.status !== 'published' || row.answerState !== 'waiting' || row.visibility === 'private') return;
  /* `answeringAt`: the sweep times a dead run from its claim, not from publishing (review S3). */
  const [claimed] = await db().update(post).set({ answerState: 'answering', answeringAt: now() }).where(and(eq(post.id, id), eq(post.answerState, 'waiting'))).returning({ id: post.id });
  if (!claimed) return;
  const subject = [row.question, row.detail].filter(Boolean).join('\n');
  /* The quote, if it can still be seen: its question also steers which Rees are asked. */
  const context = await quoteContext(row);
  try {
    const author = row.source === 'post' ? row.userId : null;
    const match = await (deps.match ?? searchMatcher)({ question: context ? `${subject}\n${context.question}` : subject, mentionReeId: row.mentionReeId, authorId: row.userId, excludePaid: !author });
    const found = match.answerers.slice(0, POST_MAX_ANSWERS);
    const categories = found.length
      ? await db().select({ id: ree.id, category: ree.category, queryFee: ree.queryFee, ownerId: ree.ownerId }).from(ree).where(inArray(ree.id, found.map((entry) => entry.reeId)))
      : [];
    /*
     * A paid Ree of someone else waits for the author to agree; without an
     * author to ask it does not take part at all. Every other Ree -- free
     * ones, and the author's own, paid or not -- holds the author's base fee
     * below, most relevant first (2026-11-19 review: own Rees pay the base
     * fee too; only an own Ree's query fee is waived, never paid to oneself).
     */
    const paidIds = new Set(categories.filter((entry) => entry.queryFee > 0 && entry.ownerId !== row!.userId).map((entry) => entry.id));
    const answerers = author ? found : found.filter((entry) => !paidIds.has(entry.reeId));
    await db()
      .update(post)
      .set({ candidates: match.candidates, skipped: match.skipped, category: categories.find((entry) => entry.id === answerers[0]?.reeId)?.category ?? null })
      .where(eq(post.id, id));
    const rows = answerers.length
      ? await db()
          .insert(answer)
          .values(answerers.map((entry) => ({ postId: id, reeId: entry.reeId, similarity: entry.similarity, mentioned: entry.mentioned, state: paidIds.has(entry.reeId) ? ('awaiting' as const) : ('answering' as const) })))
          .onConflictDoNothing()
          .returning({ id: answer.id, reeId: answer.reeId, state: answer.state })
      : [];
    /* The base fee of each charged answer, in the matcher's order (the mentioned Ree, then the closest); one the balance cannot cover waits for the author too. */
    const answering: { id: string; reeId: string }[] = [];
    for (const entry of answerers) {
      const inserted = rows.find((other) => other.reeId === entry.reeId);
      if (!inserted || inserted.state !== 'answering') continue;
      if (author !== null && !(await holdBaseFee(author, inserted.id, entry.reeId, now()))) continue;
      answering.push(inserted);
    }
    await Promise.all(
      answering.map(async (entry) => {
        let result: AnswerResult;
        try {
          result = await (deps.answerOne ?? groundedAnswer)({ reeId: entry.reeId, subject, lang: row!.lang, vector: match.vector, context });
        } catch (error) {
          console.warn(`post ${id} answer ree=${entry.reeId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
          result = { state: 'failed', model: null };
        }
        /* Only while it is still running: once the post is settled a late answer stays failed, its hold given back. */
        await closeAnswer(entry.id, result, now());
      }),
    );
  } catch (error) {
    console.warn(`post ${id} answering failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  await finishPost(id, now());
  /* No Ree answered (or will, on the author's word): the author gets an AI answer instead, at the base fee. */
  await answerWithAi(id, null, deps);
}

/**
 * Settles a post: answers still running are marked failed and their holds
 * given back, the shown answers counted, and the author told -- of the
 * answers, and of the Rees waiting for them to agree.
 */
export async function finishPost(id: string, now = new Date()): Promise<void> {
  await db().transaction(async (tx) => {
    const [target] = await tx.select().from(post).where(and(eq(post.id, id), eq(post.answerState, 'answering'))).for('update');
    if (!target) return;
    const running = await tx
      .update(answer)
      .set({ state: 'failed' })
      .where(and(eq(answer.postId, id), firstRound(), inArray(answer.state, ['queued', 'answering'])))
      .returning({ reeId: answer.reeId, baseHoldId: answer.baseHoldId, feeHoldId: answer.feeHoldId });
    for (const entry of running) {
      if (entry.baseHoldId) await releaseHold(tx, entry.baseHoldId, { reeId: entry.reeId, ledger: 'post_answer' }, now);
      if (entry.feeHoldId) await releaseHold(tx, entry.feeHoldId, { reeId: entry.reeId, ledger: 'chat_fee' }, now);
    }
    const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(answer).where(and(eq(answer.postId, id), firstRound(), eq(answer.state, 'answered')));
    const answered = counted?.n ?? 0;
    const [waiting] = await tx.select({ n: sql<number>`count(*)::int` }).from(answer).where(and(eq(answer.postId, id), firstRound(), eq(answer.state, 'awaiting')));
    const requests = waiting?.n ?? 0;
    await tx.update(post).set({ answerState: 'done', answerCount: answered, answeredAt: now }).where(eq(post.id, id));
    /* A private post's author is on its page, waiting for the answers they asked for: no notice. */
    const told = target.source === 'post' && target.visibility === 'public' ? target.userId : null;
    if (answered > 0 && told) {
      await notify(tx, { userId: told, kind: 'post_answered', params: { question: target.question.slice(0, 80), answers: answered }, refId: id });
    }
    /* One notice for all of a post's requests: paid Rees, and free ones the balance could not cover. */
    if (requests > 0 && told) {
      await notify(tx, { userId: told, kind: 'post_paid_requests', params: { question: target.question.slice(0, 80), n: requests }, refId: id });
    }
  });
}

export interface SweepOptions {
  /** How long the sweep keeps starting new work, checked before every row of every step; work already started finishes. */
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
 * Every step checks what is left of `budgetMs` before each row and hands
 * the rest on (review S2): a run near the route's limit stops between rows
 * rather than being killed in the middle of one, and the next run carries on.
 * Answers how many posts it handled.
 */
export async function processStalePosts(deps: ProcessDeps = {}, options: SweepOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  const deadline = Date.now() + (options.budgetMs ?? POST_SWEEP_BUDGET_MS);
  const left = () => deadline - Date.now();
  let handled = 0;
  for (let full = true; full && left() > 0; ) {
    const stuck = await db()
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.status, 'pending'), isNull(post.deletedAt), sql`${post.moderationAttempts} >= ${PUBLIC_QA_MODERATION_ATTEMPTS}`, lt(post.createdAt, new Date(now.getTime() - POST_ANSWERING_STALE_MS))))
      .limit(100);
    for (const row of stuck) {
      if (left() <= 0) break;
      await rejectPost(row.id, now);
      handled += 1;
    }
    full = stuck.length === 100;
  }
  if (left() > 0) handled += await sweepPaidRequests(now);
  /* Runs that died while answering, oldest claim first: each settled and given the AI answer it never got to, one post at a time. */
  for (let full = true; full && left() > 0; ) {
    const dead = await db()
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.answerState, 'answering'), sql`coalesce(${post.answeringAt}, ${post.publishedAt}) < ${new Date(now.getTime() - POST_ANSWERING_STALE_MS)}`))
      .orderBy(sql`coalesce(${post.answeringAt}, ${post.publishedAt})`)
      .limit(100);
    for (const row of dead) {
      if (left() <= 0) break;
      await finishPost(row.id, now);
      await answerWithAi(row.id, null, deps).catch((error: unknown) => console.warn(`post ${row.id} ai answer failed: ${error instanceof Error ? error.message : 'unknown'}`));
      handled += 1;
    }
    full = dead.length === 100;
  }
  /* Follow-ups (追问) the request left behind, then AI answers to review: the same steps, cheap first. */
  const followups = await import('@/lib/services/post-followups');
  if (left() > 0) handled += await followups.settleStaleFollowups(now, deps, { budgetMs: left() });
  if (left() > 0) handled += await (await import('@/lib/services/ai-answers')).sweepAiAnswers(now, deps, { budgetMs: left() });
  const waiting = await db()
    .select({ id: post.id })
    .from(post)
    .where(
      or(
        /* Not one in the trash: it is not reviewed there, and would only take a place. */
        and(eq(post.status, 'pending'), isNull(post.deletedAt), lt(post.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS), lt(post.createdAt, new Date(now.getTime() - 60_000))),
        and(eq(post.status, 'published'), eq(post.answerState, 'waiting'), lt(post.publishedAt, new Date(now.getTime() - POST_WAITING_STALE_MS))),
      ),
    )
    .orderBy(asc(post.createdAt))
    .limit(500);
  let next = 0;
  const worker = async () => {
    while (next < waiting.length && left() > 0) {
      const row = waiting[next++]!;
      await processPost(row.id, deps).catch((error: unknown) => console.warn(`post ${row.id} sweep failed: ${error instanceof Error ? error.message : 'unknown'}`));
      handled += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? POST_SWEEP_CONCURRENCY) }, worker));
  if (left() > 0) handled += await followups.processWaitingFollowups(deps, { budgetMs: left(), concurrency: options.concurrency, now });
  return handled;
}

/* ------------------------------------------------------------------ reading */

export type PostRow = typeof post.$inferSelect & { authorName: string | null; authorAvatar: string | null };

export function authorOf(row: PostRow, viewerId: string | undefined): PostAuthor {
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

export interface AnswerRow {
  id: string;
  postId: string;
  followupId: string | null;
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
  feeHoldId: string | null;
  baseHoldId: string | null;
  price: number | null;
  /** "没帮助" marks (private posts only). */
  unhelpful: number;
}

/** The first round's answers of these posts (shown, and running); `followupIds`: those follow-ups' answers instead. */
export async function answersFor(postIds: string[], followupIds?: string[]): Promise<AnswerRow[]> {
  if ((followupIds ?? postIds).length === 0) return [];
  return db()
    .select({
      id: answer.id,
      postId: answer.postId,
      followupId: answer.followupId,
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
      /* A private post's answers follow `privateAnswerShown`: its author is the only reader. */
      shown: sql<boolean>`(${shownAnswer()} or ${privateAnswerShown()})`,
      feeHoldId: answer.feeHoldId,
      baseHoldId: answer.baseHoldId,
      price: answer.price,
      unhelpful: sql<number>`(select count(*)::int from ${feedback} uf where uf.answer_id = ${answer.id})`,
    })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(user, eq(user.id, ree.ownerId))
    .where(and(followupIds ? inArray(answer.followupId, followupIds) : and(inArray(answer.postId, postIds), firstRound()), or(shownAnswer(), privateAnswerShown(), inArray(answer.state, ['queued', 'answering']))))
    .orderBy(desc(answer.mentioned), desc(answer.helpfulCount), sql`${answer.similarity} desc nulls last`, asc(answer.createdAt));
}

export async function votedBy(viewerId: string | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewerId || ids.length === 0) return new Set();
  const rows = await db().select({ id: vote.answerId }).from(vote).where(and(eq(vote.userId, viewerId), inArray(vote.answerId, ids)));
  return new Set(rows.map((row) => row.id));
}

/** The answers among these the viewer marked "没帮助". */
export async function unvotedBy(viewerId: string | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewerId || ids.length === 0) return new Set();
  const rows = await db().select({ id: feedback.answerId }).from(feedback).where(and(eq(feedback.userId, viewerId), inArray(feedback.answerId, ids)));
  return new Set(rows.map((row) => row.id));
}

async function postVotedBy(viewerId: string | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewerId || ids.length === 0) return new Set();
  const rows = await db().select({ id: postVote.postId }).from(postVote).where(and(eq(postVote.userId, viewerId), inArray(postVote.postId, ids)));
  return new Set(rows.map((row) => row.id));
}

async function savedBy(viewerId: string | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewerId || ids.length === 0) return new Set();
  const rows = await db().select({ id: save.postId }).from(save).where(and(eq(save.userId, viewerId), inArray(save.postId, ids)));
  return new Set(rows.map((row) => row.id));
}

/**
 * `own`: the viewer is the author of a private post, who alone sees what each
 * answer cost them and their "没帮助" marks (`unvoted`).
 */
export function answerView(row: AnswerRow, voted: Set<string>, whole: boolean, own: { unvoted: Set<string> } | null = null): PostAnswerView {
  /* A feed shows a plain-text excerpt (no Markdown marks); the post page renders the whole Markdown. */
  const cut = whole || row.state !== 'answered' ? { answer: row.text, truncated: false } : previewOf(plainOf(row.text), POST_PREVIEW_CHARS);
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
    paid: row.feeHoldId !== null,
    unhelpful: own ? row.unhelpful : 0,
    unvoted: own ? own.unvoted.has(row.id) : false,
    /* Charged only once answered: a hold given back cost nothing. */
    cost: own ? (row.state === 'answered' && row.baseHoldId ? (row.price ?? 0) : 0) : null,
  };
}

/**
 * Posts as a page shows them. In a feed (`whole: false`) only the top shown
 * answer comes along, cut; on the post page all of them, whole.
 */
async function viewsOf(rows: PostRow[], viewerId: string | undefined, options: { whole: boolean; onlyRee?: string }): Promise<PostView[]> {
  const ids = rows.map((row) => row.id);
  const [answers, saved, postVoted] = await Promise.all([answersFor(ids), savedBy(viewerId, ids), postVotedBy(viewerId, ids)]);
  const voted = await votedBy(viewerId, answers.map((row) => row.id));
  /* A private post is only ever read by its author (the queries above made sure). */
  const ownPrivate = new Set(rows.filter((row) => row.visibility === 'private' && viewerId && row.userId === viewerId).map((row) => row.id));
  const unvoted = ownPrivate.size ? await unvotedBy(viewerId, answers.filter((row) => ownPrivate.has(row.postId)).map((row) => row.id)) : new Set<string>();
  const [quotes, quoteCounts] = await Promise.all([quotesFor(rows, viewerId), quoteCountsFor(ids)]);
  const authorView = options.whole && viewerId && rows.length === 1 && rows[0]!.userId === viewerId && (AUTHORED_SOURCES as readonly string[]).includes(rows[0]!.source);
  /* A private post has no requests: its author chose and paid for every Ree when asking. */
  const requests = authorView && rows[0]!.visibility === 'public' ? await paidRequestsFor(rows[0]!.id, viewerId) : [];
  const spent = authorView ? await spentOn(rows[0]!.id) : null;
  /* The thread of follow-ups (追问), on the post's page only. */
  const thread = options.whole && rows.length === 1 ? await (await import('@/lib/services/post-followups')).threadFor(rows[0]!, viewerId) : null;
  /*
   * The AI answer to the first round (ai-answers.ts): the author's own, and
   * on a public post anyone's once it passed review; folded once a Ree has
   * answered.
   */
  const answeredRounds = new Set(rows.filter((row) => answers.some((entry) => entry.postId === row.id && entry.shown)).map((row) => aiRoundKey(row.id, null)));
  const ai = await aiAnswersFor(viewerId, { postIds: ids }, { whole: options.whole, answeredRounds });
  /* For its author, on the post's page: whether rewriting a stale summary is free (`freeRewrite`). */
  const rewriteFree = new Map<string, boolean>();
  for (const row of rows) {
    if (!options.whole || !viewerId || row.userId !== viewerId || row.summaryState !== 'done') continue;
    const shownIds = new Set(answers.filter((entry) => entry.postId === row.id && entry.shown).map((entry) => entry.id));
    if (summaryStale(row.summaryAnswers, shownIds)) rewriteFree.set(row.id, await freeRewrite(viewerId, row, shownIds));
  }
  return rows.map((row) => {
    const own = answers.filter((entry) => entry.postId === row.id);
    const shown = own.filter((entry) => entry.shown);
    const pending = row.answerState === 'done' ? [] : own.filter((entry) => !entry.shown);
    const picked = options.onlyRee ? shown.filter((entry) => entry.reeId === options.onlyRee) : shown;
    const listed = options.whole ? [...picked, ...pending] : picked.slice(0, 1);
    return {
      id: row.id,
      visibility: row.visibility,
      title: row.title,
      pinned: row.pinnedAt !== null,
      archived: row.archivedAt !== null,
      publishedCopyId: row.publishedCopyId,
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
      helpful: shown.reduce((sum, entry) => sum + entry.helpful, 0) + row.helpfulCount,
      voted: postVoted.has(row.id),
      saved: saved.has(row.id),
      createdAt: (row.publishedAt ?? row.createdAt).toISOString(),
      answers: listed.map((entry) => answerView(entry, voted, options.whole, ownPrivate.has(row.id) ? { unvoted } : null)),
      quote: row.quoteKind ? (quotes.get(row.id) ?? { kind: row.quoteKind, available: false }) : null,
      quotes: quoteCounts.get(row.id) ?? 0,
      summary: row.summaryState === 'done' && row.summaryContent && !summaryStale(row.summaryAnswers, new Set(shown.map((entry) => entry.id)))
        ? { state: 'done', content: row.summaryContent, sources: row.summarySources ?? [] }
        : row.summaryState === 'running' ? { state: 'running', content: '', sources: [] } : null,
      summaryStale: row.summaryState === 'done' && summaryStale(row.summaryAnswers, new Set(shown.map((entry) => entry.id))),
      summaryRewriteFree: rewriteFree.get(row.id) ?? false,
      hiddenBy: row.status === 'hidden' ? row.hiddenBy : null,
      paidRequests: requests,
      spent,
      aiAnswer: ai.get(aiRoundKey(row.id, null)) ?? null,
      followupCount: row.followupCount,
      followups: thread?.followups ?? [],
      followupCandidates: thread?.candidates ?? [],
      followupBlocked: thread?.blocked ?? null,
      followupAiOnly: thread?.aiOnly ?? false,
      deleted: row.deletedAt !== null,
    };
  });
}

/**
 * The quote cards of these posts: what each quotes, one level down, while
 * it can be seen -- the quoted post visible and, for an answer, the answer
 * shown. Anything else is left out, and the card says it is gone.
 */
async function quotesFor(rows: PostRow[], viewerId: string | undefined): Promise<Map<string, PostQuote>> {
  const quoting = rows.filter((row) => row.quoteKind && row.quotePostId);
  if (quoting.length === 0) return new Map();
  const quoted = await selectPosts(and(inArray(post.id, [...new Set(quoting.map((row) => row.quotePostId!))]), visiblePost()), [desc(post.createdAt)], quoting.length);
  const answerIds = quoting.map((row) => row.quoteAnswerId).filter((id): id is string => Boolean(id));
  const quotedAnswers = answerIds.length ? (await answersFor(quoted.map((row) => row.id))).filter((entry) => entry.shown && answerIds.includes(entry.id)) : [];
  const out = new Map<string, PostQuote>();
  for (const row of quoting) {
    const target = quoted.find((entry) => entry.id === row.quotePostId);
    const shown = row.quoteAnswerId ? quotedAnswers.find((entry) => entry.id === row.quoteAnswerId) : null;
    if (!target || (row.quoteKind === 'answer' && !shown)) continue;
    out.set(row.id, {
      kind: row.quoteKind!,
      available: true,
      postId: target.id,
      question: target.question,
      author: authorOf(target, viewerId),
      createdAt: (target.publishedAt ?? target.createdAt).toISOString(),
      answer: shown
        ? { id: shown.id, reeName: shown.name, reeSlug: shown.slug, reeAvatar: shown.avatar, reeColor: shown.color, text: previewOf(plainOf(shown.text).replace(/ ?\[\d{1,2}\]/g, ''), POST_QUOTE_PREVIEW_CHARS).answer }
        : null,
    });
  }
  return out;
}

/** Visible posts quoting each of these. */
async function quoteCountsFor(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db()
    .select({ id: post.quotePostId, n: sql<number>`count(*)::int` })
    .from(post)
    .where(and(inArray(post.quotePostId, ids), visiblePost()))
    .groupBy(post.quotePostId);
  return new Map(rows.map((row) => [row.id!, row.n]));
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
export async function listFeed(tab: FeedTab, options: { cursor?: string | null; viewerId?: string; size?: number; q?: string | null; quotesOf?: string | null } = {}): Promise<PostPage> {
  if (options.quotesOf !== undefined && options.quotesOf !== null && !isUuid(options.quotesOf)) return { items: [], next: null };
  /* The posts quoting one post are listed newest first whatever tab was asked for. */
  if (options.quotesOf) tab = 'latest';
  const size = options.size ?? POST_PAGE_SIZE;
  /* One ILIKE over the indexed expression (pg_trgm), not two over separate columns. */
  const search = options.q?.trim() ? sql`${searchable} ilike ${`%${options.q.trim().replace(/[%_\\]/g, '\\$&')}%`}` : undefined;
  if (tab === 'for_you') {
    const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
    /* The first round's answers' votes and the post's own, as the cards count them. */
    const helpful = sql`((select coalesce(sum(a.helpful_count), 0) from ${answer} a where a.post_id = ${post.id} and a.followup_id is null and a.state = 'answered' and a.hidden_by is null) + ${post.helpfulCount})`;
    const score = sql`((${helpful} * 2 + ${post.answerCount} + 1)::float / power(extract(epoch from (now() - ${post.publishedAt})) / 3600 + 2, 1.3))`;
    /* Scored over the last 30 days only (post_feed_idx narrows it by published_at), so the sort never covers the whole table. */
    const recent = sql`${post.publishedAt} > ${new Date(Date.now() - FOR_YOU_WINDOW_MS).toISOString()}::timestamptz`;
    const rows = await selectPosts(and(visiblePost(), recent, hasShownAnswer(), search), [desc(score), desc(post.id)], size + 1, offset);
    return { items: await viewsOf(rows.slice(0, size), options.viewerId, { whole: false }), next: rows.length > size ? String(offset + size) : null };
  }
  let boundary: SQL | undefined;
  if (options.cursor) {
    if (!isUuid(options.cursor)) return { items: [], next: null };
    /* Only a public post can be a cursor: a private one's id must not tell that it exists, or when it was posted. One taken down since keeps paging. */
    const [cursor] = await db().select({ at: post.publishedAt, id: post.id }).from(post).where(and(eq(post.id, options.cursor), eq(post.visibility, 'public'))).limit(1);
    if (!cursor?.at) return { items: [], next: null };
    boundary = sql`(${post.publishedAt}, ${post.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
  }
  /* The posts quoting one post: every visible one, answered or not. */
  const scope = options.quotesOf ? eq(post.quotePostId, options.quotesOf) : tab === 'unanswered' ? unanswered() : worthListing;
  const rows = await selectPosts(and(visiblePost(), scope, boundary, search), [desc(post.publishedAt), desc(post.id)], size + 1);
  return { items: await viewsOf(rows.slice(0, size), options.viewerId, { whole: false }), next: rows.length > size ? rows[size - 1]!.id : null };
}

/** How long the rail's 待回答 count is reused (review S7): a scan of every public post, on every home page, for a number nobody reads to the minute. */
export const UNANSWERED_COUNT_TTL_MS = 60_000;
let unansweredMemo: { at: number; count: Promise<number> } | null = null;

/**
 * Posts waiting for an answer, for the rail's card: counted at most once a
 * minute per server instance, concurrent renders sharing the one count. A
 * failed count is not kept.
 */
export async function unansweredCount(now = Date.now()): Promise<number> {
  if (unansweredMemo && now - unansweredMemo.at < UNANSWERED_COUNT_TTL_MS) return unansweredMemo.count;
  const memo = {
    at: now,
    count: db()
      .select({ n: sql<number>`count(*)::int` })
      .from(post)
      .where(and(visiblePost(), unanswered()))
      .then(([row]) => row?.n ?? 0),
  };
  unansweredMemo = memo;
  memo.count.catch(() => {
    if (unansweredMemo === memo) unansweredMemo = null;
  });
  return memo.count;
}

/**
 * One post: anyone may read a visible one; its author also their own
 * pending, rejected or trashed one. Null otherwise.
 */
export async function getPost(id: string, viewerId?: string): Promise<PostView | null> {
  if (!isUuid(id)) return null;
  /* The author also reads their own pending, rejected, trashed and private posts. */
  const mine = viewerId ? authoredBy(viewerId) : undefined;
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

/** A Ree as the post's link preview shows it: its name and its avatar (an image, else a color). */
export interface CoverRee {
  name: string;
  avatar: string | null;
  color: string;
}

/**
 * What a post's link preview (lib/og/post-image.tsx) and its page's Open
 * Graph tags need, in one read so the two never disagree: `private` -- only
 * its author may know it exists, so no image and no title; `gone` --
 * hidden, deleted, rejected or not yet approved, so the site's image in the
 * post's language; or the post as anyone may read it, with the Rees whose
 * answers anyone may read, in the page's order (the first one leads the
 * preview). Null for no such post.
 */
export type PostCover =
  | { state: 'private' }
  | { state: 'gone'; lang: 'zh' | 'en' }
  | { state: 'shown'; lang: 'zh' | 'en'; question: string; detail: string; answers: number; rees: CoverRee[]; first: (CoverRee & { id: string; text: string; helpful: number }) | null };

export async function postCover(id: string): Promise<PostCover | null> {
  if (!isUuid(id)) return null;
  const [row] = await db()
    .select({ visibility: post.visibility, lang: post.lang, question: post.question, detail: post.detail, visible: sql<boolean>`(${visiblePost()})` })
    .from(post)
    .where(eq(post.id, id))
    .limit(1);
  if (!row) return null;
  if (row.visibility === 'private') return { state: 'private' };
  if (!row.visible) return { state: 'gone', lang: row.lang };
  const shown = await db()
    .select({ id: answer.id, text: answer.text, helpful: answer.helpfulCount, name: ree.name, avatar: ree.avatarBlob, color: ree.color })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(eq(answer.postId, id), firstRound(), shownAnswer()))
    .orderBy(desc(answer.mentioned), desc(answer.helpfulCount), sql`${answer.similarity} desc nulls last`, asc(answer.createdAt));
  const rees = shown.map((entry) => ({ name: entry.name, avatar: entry.avatar, color: entry.color }));
  return { state: 'shown', lang: row.lang, question: row.question, detail: row.detail, answers: shown.length, rees, first: shown[0] ?? null };
}

/**
 * For the sitemap: visible posts with an answer anyone can read now, in the
 * order they were published (then by id), so a post keeps its sitemap file
 * (app/sitemap.ts) as newer ones are added. `at` is mapped through the
 * column so it arrives as a Date: a raw `sql` value comes back as Postgres
 * text (`2026-11-22 16:47:46.953+00`), which Search Console rejects as a
 * `<lastmod>`.
 */
export async function indexablePosts({ offset = 0, limit = 5000 }: { offset?: number; limit?: number } = {}): Promise<{ id: string; at: Date }[]> {
  return db()
    .select({ id: post.id, at: sql<Date>`coalesce(${post.answeredAt}, ${post.publishedAt})`.mapWith(post.publishedAt) })
    .from(post)
    .where(and(visiblePost(), hasShownAnswer()))
    .orderBy(asc(post.publishedAt), asc(post.id))
    .offset(offset)
    .limit(limit);
}

/** How many posts `indexablePosts` has in all, for the sitemap index. */
export async function indexablePostCount(): Promise<number> {
  const [{ total } = { total: 0 }] = await db().select({ total: sql<number>`count(*)::int` }).from(post).where(and(visiblePost(), hasShownAnswer()));
  return total;
}

/** 我的帖子's tabs: 全部, 公开, 私密 and 回收站. */
export type MinePostsView = 'all' | 'public' | 'private' | 'trash';

/** 私密's 筛选: text, a Ree that answered, asked since, pinned only, and archived (hidden unless asked for, then only those). */
export interface MinePostsFilter {
  q?: string | null;
  reeId?: string | null;
  since?: Date | null;
  pinned?: boolean;
  archived?: boolean;
}

/** A Ree owner's 试问 of one of their Rees (private posts, `source = 'test'`), newest first, as the post page shows them (ree-try.ts). */
export async function reeTryPosts(userId: string, reeId: string, limit: number): Promise<PostView[]> {
  const rows = await selectPosts(
    and(eq(post.userId, userId), eq(post.source, 'test'), isNull(post.deletedAt), sql`exists (select 1 from ${answer} ta where ta.post_id = ${post.id} and ta.ree_id = ${reeId})`),
    [desc(post.createdAt), desc(post.id)],
    limit,
  );
  return viewsOf(rows, userId, { whole: true });
}

/** What 我的帖子 lists: the author's posts and MCP asks; a Ree owner's 试问 stays on its Ree's test page. */
function listedMine(userId: string): SQL {
  return and(eq(post.userId, userId), inArray(post.source, ['post', 'api']))!;
}

function mineWhere(userId: string, view: MinePostsView, filter: MinePostsFilter): SQL {
  const q = filter.q?.trim();
  return and(
    listedMine(userId),
    view === 'trash' ? isNotNull(post.deletedAt) : isNull(post.deletedAt),
    view === 'public' ? eq(post.visibility, 'public') : view === 'private' ? eq(post.visibility, 'private') : undefined,
    /* An archived private post leaves the lists until the filter asks for archived ones. */
    view === 'trash' ? undefined : filter.archived ? isNotNull(post.archivedAt) : isNull(post.archivedAt),
    filter.pinned ? isNotNull(post.pinnedAt) : undefined,
    filter.since ? sql`${post.createdAt} >= ${filter.since.toISOString()}::timestamptz` : undefined,
    filter.reeId && isUuid(filter.reeId) ? sql`exists (select 1 from ${answer} fa where fa.post_id = ${post.id} and fa.ree_id = ${filter.reeId}::uuid)` : undefined,
    q ? sql`(${searchable} || ' ' || coalesce(${post.title}, '')) ilike ${`%${q.replace(/[%_\\]/g, '\\$&')}%`}` : undefined,
  )!;
}

/**
 * The author's posts (any state) of one tab, newest first, paged by offset;
 * on 私密 the pinned ones first.
 */
export async function listMyPosts(userId: string, view: MinePostsView, page = 1, size = POST_PAGE_SIZE, filter: MinePostsFilter = {}): Promise<{ items: PostView[]; total: number; page: number; size: number }> {
  const where = mineWhere(userId, view, filter);
  const [counted] = await db().select({ n: sql<number>`count(*)::int` }).from(post).where(where);
  const total = counted?.n ?? 0;
  const current = Math.max(1, Math.min(page, Math.max(1, Math.ceil(total / size))));
  const order = view === 'private' ? [sql`${post.pinnedAt} desc nulls last`, desc(post.createdAt), desc(post.id)] : [desc(post.createdAt), desc(post.id)];
  const rows = await selectPosts(where, order, size, (current - 1) * size);
  return { items: await viewsOf(rows, userId, { whole: false }), total, page: current, size };
}

/** How many posts each tab has, for the tabs (archived private posts left out, as the lists leave them out). */
export async function myPostCounts(userId: string): Promise<{ all: number; public: number; private: number; trash: number }> {
  const [row] = await db()
    .select({
      all: sql<number>`count(*) filter (where ${post.deletedAt} is null and ${post.archivedAt} is null)::int`,
      public: sql<number>`count(*) filter (where ${post.deletedAt} is null and ${post.visibility} = 'public')::int`,
      private: sql<number>`count(*) filter (where ${post.deletedAt} is null and ${post.visibility} = 'private' and ${post.archivedAt} is null)::int`,
      trash: sql<number>`count(*) filter (where ${post.deletedAt} is not null)::int`,
    })
    .from(post)
    .where(listedMine(userId));
  return { all: row?.all ?? 0, public: row?.public ?? 0, private: row?.private ?? 0, trash: row?.trash ?? 0 };
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
    .where(and(eq(post.id, id), authoredBy(userId), trashed ? isNull(post.deletedAt) : isNotNull(post.deletedAt)))
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

/**
 * The shown answer, locked, for the actions below. `voterId`: a vote, which
 * a private post's author may also cast on its answers (nobody else may);
 * without it (a report) only a public post's answer is found.
 */
async function lockShown(tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0], id: string, reeId?: string, voterId?: string) {
  const [row] = await tx
    .select({ id: answer.id, reeId: answer.reeId, ownerId: ree.ownerId, postAuthorId: post.userId })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(post, eq(post.id, answer.postId))
    .where(
      and(
        eq(answer.id, id),
        reeId ? eq(answer.reeId, reeId) : undefined,
        voterId ? or(and(shownAnswer(), visiblePost()), and(privateAnswerShown(), ownPrivatePost(voterId)))! : and(shownAnswer(), visiblePost()),
        shownFollowupOf(),
      ),
    )
    .for('update', { of: answer });
  return row ?? null;
}

/**
 * "有帮助", once per signed-in user; the new count, or null when the answer
 * is not shown. `taskReward`: the first-helpful starter task this paid (0
 * for none) -- only for someone else's content: not an answer of the
 * voter's own Ree, nor any answer under the voter's own post (private or
 * anonymous ones included). Those votes count all the same.
 */
export async function setAnswerHelpful(userId: string, id: string, on: boolean, reeId?: string): Promise<{ helpful: number; voted: boolean; taskReward: number } | null> {
  if (!isUuid(id)) return null;
  return db().transaction(async (tx) => {
    const shown = await lockShown(tx, id, reeId, userId);
    if (!shown) return null;
    /* 有帮助 and 没帮助 (a private post's answers only) exclude each other. */
    if (on) await tx.delete(feedback).where(and(eq(feedback.answerId, id), eq(feedback.userId, userId)));
    const changed = on
      ? await tx.insert(vote).values({ answerId: id, userId }).onConflictDoNothing().returning({ id: vote.answerId })
      : await tx.delete(vote).where(and(eq(vote.answerId, id), eq(vote.userId, userId))).returning({ id: vote.answerId });
    const [row] = changed.length
      ? await tx.update(answer).set({ helpfulCount: sql`greatest(${answer.helpfulCount} + ${on ? 1 : -1}, 0)` }).where(eq(answer.id, id)).returning({ helpful: answer.helpfulCount })
      : await tx.select({ helpful: answer.helpfulCount }).from(answer).where(eq(answer.id, id));
    const taskReward = on && changed.length && shown.ownerId !== userId && shown.postAuthorId !== userId ? await grantTaskReward(tx, userId, 'first_helpful', id) : 0;
    return { helpful: row!.helpful, voted: on, taskReward };
  });
}

/**
 * "有帮助" on a post itself, once per signed-in user, its author included
 * (as on answers); only while anyone can see it. Answers what the cards
 * show -- the post's own votes added to its first-round answers' shown ones
 * -- or null when the post is not shown; `taskReward` as `setAnswerHelpful`,
 * not for the voter's own post.
 */
export async function setPostHelpful(userId: string, id: string, on: boolean): Promise<{ helpful: number; voted: boolean; taskReward: number } | null> {
  if (!isUuid(id)) return null;
  return db().transaction(async (tx) => {
    const [target] = await tx.select({ id: post.id, userId: post.userId }).from(post).where(and(eq(post.id, id), visiblePost())).for('update');
    if (!target) return null;
    const changed = on
      ? await tx.insert(postVote).values({ postId: id, userId }).onConflictDoNothing().returning({ id: postVote.postId })
      : await tx.delete(postVote).where(and(eq(postVote.postId, id), eq(postVote.userId, userId))).returning({ id: postVote.postId });
    const [row] = changed.length
      ? await tx.update(post).set({ helpfulCount: sql`greatest(${post.helpfulCount} + ${on ? 1 : -1}, 0)` }).where(eq(post.id, id)).returning({ own: post.helpfulCount })
      : await tx.select({ own: post.helpfulCount }).from(post).where(eq(post.id, id));
    const [answers] = await tx
      .select({ n: sql<number>`coalesce(sum(${answer.helpfulCount}), 0)::int` })
      .from(answer)
      .innerJoin(ree, eq(ree.id, answer.reeId))
      .where(and(eq(answer.postId, id), firstRound(), shownAnswer()));
    const taskReward = on && changed.length && target.userId !== userId ? await grantTaskReward(tx, userId, 'first_helpful', id) : 0;
    return { helpful: row!.own + (answers?.n ?? 0), voted: on, taskReward };
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
      const hidden = await tx.update(answer).set({ hiddenBy: 'reports', pinnedAt: null }).where(and(eq(answer.id, id), isNull(answer.hiddenBy))).returning({ id: answer.id });
      await recount(tx, row!.postId);
      if (hidden.length) await flagQuotingAnswer(tx, id);
    }
    return true;
  });
}

async function recount(tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0], postId: string): Promise<void> {
  await tx
    .update(post)
    .set({ answerCount: sql`(select count(*)::int from ${answer} a where a.post_id = ${postId} and a.followup_id is null and a.state = 'answered' and a.hidden_by is null)` })
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
      /* Never a private post's: its question is its author's alone, even to the Ree's owner. */
      .where(and(eq(answer.id, id), eq(answer.reeId, reeId), eq(answer.state, 'answered'), isNull(answer.hiddenBy), sql`exists (select 1 from ${post} op where op.id = ${answer.postId} and op.visibility = 'public')`))
      .for('update');
    if (!target) return false;
    if (action === 'hide') {
      await tx.update(answer).set({ hiddenBy: 'owner', pinnedAt: null }).where(eq(answer.id, id));
      await recount(tx, target.postId);
      await flagQuotingAnswer(tx, id);
    } else if (action === 'pin') {
      /* Pinned answers lead the Ree page, which lists first rounds only. */
      const [round] = await tx.select({ followupId: answer.followupId }).from(answer).where(eq(answer.id, id));
      if (round?.followupId) return false;
      await tx.update(answer).set({ pinnedAt: null }).where(and(eq(answer.reeId, reeId), isNotNull(answer.pinnedAt)));
      await tx.update(answer).set({ pinnedAt: new Date() }).where(eq(answer.id, id));
    } else {
      await tx.update(answer).set({ pinnedAt: null }).where(eq(answer.id, id));
    }
    return true;
  });
}

/* ---------------------------------------------------------------- paid Rees */

/** What the post's answers cost its author: the base fee and query fee of each answer given. */
export async function spentOn(postId: string, followupId: string | null = null): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`coalesce(sum(${answer.price}), 0)::int` })
    .from(answer)
    .where(and(followupId ? eq(answer.followupId, followupId) : and(eq(answer.postId, postId), firstRound()), eq(answer.state, 'answered'), isNotNull(answer.baseHoldId)));
  return row?.n ?? 0;
}

/** A Ree that may still answer a post on request: public and taking posts. Needs `ree` joined. */
const requestOpen = (): SQL => sql`(${publicRee()} and ${takesPosts()})`;
/** An answer the author agreed to that could not be given, everything returned: shown to them until dismissed. */
const refunded = (): SQL => and(inArray(answer.state, ['failed', 'no_answer']), isNotNull(answer.decidedAt), isNotNull(answer.baseHoldId))!;
/**
 * One they may agree to again: it failed (an error or a timeout) and was
 * agreed to fewer than `POST_PAID_AGREE_MAX` times. One that found no
 * answer is not tried again: the Ree has nothing on it, and each try costs
 * the platform a model call.
 */
const retryable = (): SQL => and(eq(answer.state, 'failed'), isNotNull(answer.decidedAt), isNotNull(answer.baseHoldId), lt(answer.agreements, POST_PAID_AGREE_MAX))!;

/** Thrown inside the hold's savepoint when the answer is no longer running: the hold is rolled back with it. */
class AnswerSettled extends Error {}

/**
 * Holds the author's base fee for one free Ree's automatic answer, in the
 * caller's transaction (a savepoint). Only while the answer is still
 * `answering`: a sweep that settled the run meanwhile (review S3) leaves
 * nothing to hold for, so the hold is rolled back and false returned.
 * Without the balance the answer waits for the author instead
 * (`awaiting`), like a paid Ree's, and false is returned.
 */
export async function holdBaseFeeIn(tx: Tx, userId: string, answerId: string, reeId: string, now: Date): Promise<boolean> {
  try {
    await tx.transaction(async (savepoint) => {
      const baseHoldId = await placeHold(savepoint, { userId, kind: 'post', ledger: 'post_answer', amount: QUERY_BASE_FEE, refId: answerId, reeId, note: 'post answer' }, now);
      const held = await savepoint
        .update(answer)
        .set({ baseHoldId, price: QUERY_BASE_FEE })
        .where(and(eq(answer.id, answerId), eq(answer.state, 'answering')))
        .returning({ id: answer.id });
      if (!held.length) throw new AnswerSettled();
    });
    return true;
  } catch (error) {
    if (error instanceof AnswerSettled) return false;
    if (!(error instanceof InsufficientCredits)) throw error;
    await tx.update(answer).set({ state: 'awaiting' }).where(and(eq(answer.id, answerId), eq(answer.state, 'answering')));
    return false;
  }
}

/** `holdBaseFeeIn` in a transaction of its own. */
export async function holdBaseFee(userId: string, answerId: string, reeId: string, now: Date): Promise<boolean> {
  return db().transaction((tx) => holdBaseFeeIn(tx, userId, answerId, reeId, now));
}

/**
 * The Rees waiting for this post's author (paid ones, and free ones the
 * balance could not cover), with what agreeing costs now; those agreed to
 * and being written; and those agreed to that could not answer (refunded,
 * maybe to agree again). Only Rees that may still answer -- one gone private,
 * off posts or deleted is closed by `closeUnavailableRequests`; one that
 * turned free stays, at the base fee.
 */
export async function paidRequestsFor(postId: string, userId: string, followupId: string | null = null): Promise<PaidRequestView[]> {
  const owner = alias(user, 'paid_request_owner');
  const rows = await db()
    .select({ id: answer.id, state: answer.state, agreements: answer.agreements, similarity: answer.similarity, mentioned: answer.mentioned, reeId: ree.id, slug: ree.slug, name: ree.name, avatar: ree.avatarBlob, color: ree.color, ownerId: ree.ownerId, queryFee: ree.queryFee, ownerName: owner.name, price: answer.price })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(owner, eq(owner.id, ree.ownerId))
    .where(and(followupId ? eq(answer.followupId, followupId) : and(eq(answer.postId, postId), firstRound()), or(and(eq(answer.state, 'answering'), isNotNull(answer.baseHoldId)), and(or(eq(answer.state, 'awaiting'), refunded()), requestOpen()))))
    .orderBy(desc(answer.mentioned), sql`${answer.similarity} desc nulls last`, asc(answer.createdAt));
  return rows.map((row) => ({
      id: row.id,
      reeId: row.reeId,
      reeSlug: row.slug,
      reeName: row.name,
      reeAvatar: row.avatar,
      reeColor: row.color,
      ownerName: row.ownerName ?? '',
      similarity: row.similarity === null ? null : Math.round(row.similarity * 100) / 100,
      mentioned: row.mentioned,
      price: row.state === 'answering' ? (row.price ?? 0) : maxCostFor({ ownerId: row.ownerId, queryFee: row.queryFee }, userId),
      state:
        row.state === 'answering' ? 'answering'
        : row.state === 'awaiting' ? 'awaiting'
        : row.state === 'no_answer' ? 'no_answer'
        : row.agreements >= POST_PAID_AGREE_MAX ? 'exhausted'
        : 'refunded',
    }));
}

export type PaidAgreement =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'unavailable' | 'already' }
  | { ok: false; error: 'price_changed'; price: number }
  | { ok: false; error: 'insufficient'; balance: number; needed: number };

/**
 * The post's author agrees to a waiting Ree's answer at the price they were
 * shown: a paid Ree's base fee and query fee, or a free Ree's base fee (one
 * their balance could not cover at first), held like a private question's;
 * the answer then starts (`answerPaid`). A price now above the one shown is
 * refused with the new price, so the author confirms again; a lower one is
 * what is charged. A Ree no longer public or taking posts is closed at once.
 * Agreed already (another tab): `already`. An agreed answer that failed may
 * be agreed to again, at today's price, up to `POST_PAID_AGREE_MAX` times in
 * all; one that found no answer may not.
 */
export async function agreePaidAnswer(userId: string, id: string, shownPrice: unknown, now = new Date()): Promise<PaidAgreement> {
  if (!isUuid(id)) return { ok: false, error: 'not_found' };
  try {
    return await db().transaction(async (tx) => {
      const [target] = await tx
        .select({ id: answer.id, postId: answer.postId, state: answer.state, reeId: ree.id, reeName: ree.name, ownerId: ree.ownerId, queryFee: ree.queryFee, open: sql<boolean>`${requestOpen()}` })
        .from(answer)
        .innerJoin(post, eq(post.id, answer.postId))
        .innerJoin(ree, eq(ree.id, answer.reeId))
        .leftJoin(followup, eq(followup.id, answer.followupId))
        .where(and(eq(answer.id, id), askedBy(userId), visiblePost(), or(eq(answer.state, 'awaiting'), retryable(), and(inArray(answer.state, ['answering', 'answered']), isNotNull(answer.baseHoldId)))))
        .for('update', { of: answer });
      if (!target) return { ok: false, error: 'not_found' } as const;
      if (target.state === 'answering' || target.state === 'answered') return { ok: false, error: 'already' } as const;
      if (!target.open) {
        await tx.update(answer).set({ state: 'declined', decidedAt: now }).where(eq(answer.id, id));
        return { ok: false, error: 'unavailable' } as const;
      }
      const price = maxCostFor({ ownerId: target.ownerId, queryFee: target.queryFee }, userId);
      const shown = typeof shownPrice === 'number' && Number.isFinite(shownPrice) ? shownPrice : -1;
      if (price > shown) return { ok: false, error: 'price_changed', price } as const;
      const baseHoldId = await placeHold(tx, { userId, kind: 'post', ledger: 'post_answer', amount: QUERY_BASE_FEE, refId: id, reeId: target.reeId, note: 'post answer' }, now);
      /* The author's own paid Ree waives its query fee: nobody pays themselves. */
      const feeHoldId = target.queryFee > 0 && target.ownerId !== userId ? await placeHold(tx, { userId, kind: 'post', ledger: 'chat_fee', amount: target.queryFee, refId: id, reeId: target.reeId, note: target.reeName }, now) : null;
      await tx.update(answer).set({ state: 'answering', price, baseHoldId, feeHoldId, decidedAt: now, agreements: sql`${answer.agreements} + 1` }).where(eq(answer.id, id));
      return { ok: true } as const;
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) {
      const [row] = await db().select({ ownerId: ree.ownerId, queryFee: ree.queryFee }).from(answer).innerJoin(ree, eq(ree.id, answer.reeId)).where(eq(answer.id, id)).limit(1);
      return { ok: false, error: 'insufficient', balance: await balanceOf(db(), userId), needed: row ? maxCostFor(row, userId) : 0 };
    }
    throw error;
  }
}

/**
 * Who a request waits for: the post's author for its first round, the asker
 * for a follow-up's (谁问谁出钱) -- and only once that round is settled. Needs
 * `post` and `post_followup` joined.
 */
function askedBy(userId: string): SQL {
  return or(
    and(firstRound(), eq(post.userId, userId), eq(post.source, 'post'), eq(post.answerState, 'done')),
    and(isNotNull(answer.followupId), eq(followup.userId, userId), eq(followup.status, 'published'), isNull(followup.deletedAt), eq(followup.answerState, 'done')),
  )!;
}

export type ReeRequestOutcome =
  | { ok: true; id: string; state: 'answering' | 'awaiting' }
  | { ok: false; error: 'not_found' | 'unavailable' | 'already' | 'busy' | 'answered' };

/**
 * "请 Ree 回答" (AI 通用回答 design, 待拍板 3): on their own public post no
 * Ree answered, the author asks one public Ree that takes posts and has
 * ready knowledge to answer its first round -- the landing place of the
 * guidance's "@ 一个 Ree", since new Rees never match old posts on their
 * own. It answers at its price like a matched Ree: a free Ree (or the
 * author's own) holds the base fee and answers at once (`answerPaid`, run
 * by the caller); a paid Ree, or one the balance cannot cover, becomes a
 * request card the author agrees to (`agreePaidAnswer`). One at a time:
 * refused while another Ree is answering or waits (`busy`), once a Ree has
 * answered (`answered`), and for a Ree already asked here (`already`). The
 * AI answer stays, folded under the Ree's answer, and is not refunded.
 */
export async function requestReeAnswer(userId: string, postId: string, reeId: string, now = new Date()): Promise<ReeRequestOutcome> {
  if (!isUuid(postId) || !isUuid(reeId)) return { ok: false, error: 'not_found' };
  const [target] = await db()
    .select({ id: post.id, answerState: post.answerState, shown: sql<boolean>`${hasShownAnswer()}` })
    .from(post)
    .where(and(eq(post.id, postId), eq(post.userId, userId), eq(post.source, 'post'), visiblePost()))
    .limit(1);
  if (!target || target.answerState !== 'done') return { ok: false, error: 'not_found' };
  if (target.shown) return { ok: false, error: 'answered' };
  const [candidate] = await db().select({ id: ree.id, ownerId: ree.ownerId, queryFee: ree.queryFee }).from(ree).where(and(eq(ree.id, reeId), requestOpen())).limit(1);
  if (!candidate || !(await readyRees([reeId])).has(reeId)) return { ok: false, error: 'unavailable' };
  const paid = candidate.queryFee > 0 && candidate.ownerId !== userId;
  const made = await db().transaction(async (tx) => {
    /* The post's own lock order (as `finishPost`): two requests at once take turns. */
    await tx.select({ id: post.id }).from(post).where(eq(post.id, postId)).for('update');
    const round = await tx.select({ reeId: answer.reeId, state: answer.state }).from(answer).where(and(eq(answer.postId, postId), firstRound()));
    if (round.some((entry) => entry.reeId === reeId)) return 'already' as const;
    if (round.some((entry) => ['queued', 'answering', 'awaiting'].includes(entry.state))) return 'busy' as const;
    /* The base fee is held in this transaction: no row is left answering without one (review S1). */
    const [row] = await tx
      .insert(answer)
      .values({ postId, reeId, mentioned: true, similarity: null, state: paid ? 'awaiting' : 'answering', createdAt: now })
      .returning({ id: answer.id });
    if (paid) return { id: row!.id, state: 'awaiting' as const };
    return { id: row!.id, state: (await holdBaseFeeIn(tx, userId, row!.id, reeId, now)) ? ('answering' as const) : ('awaiting' as const) };
  });
  if (made === 'already' || made === 'busy') return { ok: false, error: made };
  return { ok: true, id: made.id, state: made.state };
}

/** The author does not want this Ree's answer: it is gone for good. Nothing was charged for it. */
export async function declinePaidAnswer(userId: string, id: string, now = new Date()): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db()
    .update(answer)
    .set({ state: 'declined', decidedAt: now })
    .where(
      and(
        eq(answer.id, id),
        or(eq(answer.state, 'awaiting'), refunded()),
        sql`(case when ${answer.followupId} is null
          then exists (select 1 from ${post} p where p.id = ${answer.postId} and p.user_id = ${userId} and p.source = 'post')
          else exists (select 1 from ${followup} f where f.id = ${answer.followupId} and f.user_id = ${userId}) end)`,
      ),
    )
    .returning({ id: answer.id });
  return rows.length > 0;
}

/**
 * The answer of a Ree the author agreed to, written like any post answer and
 * settled by `closeAnswer`.
 */
export async function answerPaid(id: string, deps: { answerOne?: AnswerOne; now?: () => Date } = {}): Promise<void> {
  if (!isUuid(id)) return;
  const now = deps.now ?? (() => new Date());
  const [row] = await db().select({ answer, post }).from(answer).innerJoin(post, eq(post.id, answer.postId)).where(and(eq(answer.id, id), eq(answer.state, 'answering'), isNotNull(answer.baseHoldId))).limit(1);
  if (!row) return;
  /* A follow-up's request is asked as that follow-up, with this Ree's own exchange so far (追问). */
  const input = row.answer.followupId
    ? await (await import('@/lib/services/post-followups')).followupAnswerInput(row.answer.followupId, row.answer.reeId)
    : { subject: [row.post.question, row.post.detail].filter(Boolean).join('\n'), lang: row.post.lang, vector: null, context: await quoteContext(row.post) };
  if (!input) return closeAnswer(id, { state: 'failed', model: null }, now());
  let result: AnswerResult;
  try {
    result = await (deps.answerOne ?? groundedAnswer)({ reeId: row.answer.reeId, ...input });
  } catch (error) {
    console.warn(`paid post answer ${id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    result = { state: 'failed', model: null };
  }
  await closeAnswer(id, result, now());
}

/**
 * Writes one answer still running and settles its holds, once (the row is
 * locked and must still be `answering`). Answered: the base fee settles to
 * the platform as a question to that Ree (`query_base`), and a paid Ree's
 * query fee to its owner as earned credits, as for a private question. No
 * answer or a failure: both holds are given back. An answer charged to
 * nobody (the author's own Ree, an example post) just writes.
 */
export async function closeAnswer(id: string, result: AnswerResult, now: Date): Promise<void> {
  await db().transaction(async (tx) => {
    const [target] = await tx
      .select({ id: answer.id, postId: answer.postId, reeId: answer.reeId, baseHoldId: answer.baseHoldId, feeHoldId: answer.feeHoldId, price: answer.price, reeName: ree.name, ownerId: ree.ownerId })
      .from(answer)
      .innerJoin(ree, eq(ree.id, answer.reeId))
      .where(and(eq(answer.id, id), eq(answer.state, 'answering')))
      .for('update', { of: answer });
    if (!target) return;
    /* The ledger shows the Ree's name, marked as a post answer ('post answer' is read into the reader's language). */
    const holds = { reeId: target.reeId, note: 'post answer' };
    if (result.state === 'answered') {
      if (target.baseHoldId) await settleHold(tx, target.baseHoldId, QUERY_BASE_FEE, { ...holds, ledger: 'post_answer' }, now);
      const paid = target.feeHoldId ? await settleHold(tx, target.feeHoldId, Math.max(0, (target.price ?? 0) - QUERY_BASE_FEE), { ...holds, ledger: 'chat_fee' }, now) : null;
      if (paid && paid.charged > 0) await creditQueryFee(tx, { ownerId: target.ownerId, reeId: target.reeId, reeName: target.reeName, replyId: id, allocations: paid.chargedAllocations }, now);
      await tx.update(answer).set({ state: 'answered', text: result.text.slice(0, 20_000), citations: result.citations, model: result.model, answeredAt: now }).where(eq(answer.id, id));
    } else {
      if (target.baseHoldId) await releaseHold(tx, target.baseHoldId, { ...holds, ledger: 'post_answer' }, now);
      if (target.feeHoldId) await releaseHold(tx, target.feeHoldId, { ...holds, ledger: 'chat_fee' }, now);
      await tx.update(answer).set({ state: result.state, model: result.model }).where(eq(answer.id, id));
    }
    await recount(tx, target.postId);
  });
}

/**
 * The sweep's part for answers on request: requests whose Ree can no longer
 * answer are closed, and answers holding a fee that no live run finished get
 * their holds back -- agreed to (the author may agree again; timed from the
 * agreement) or asked for by "请 Ree 回答" on a free Ree (timed from the
 * request, which has no agreement: review S1).
 */
export async function sweepPaidRequests(now = new Date()): Promise<number> {
  const closed = await closeUnavailableRequests(null, now);
  const stale = await db()
    .select({ id: answer.id })
    .from(answer)
    .where(and(eq(answer.state, 'answering'), isNotNull(answer.baseHoldId), sql`coalesce(${answer.decidedAt}, ${answer.createdAt}) < ${new Date(now.getTime() - POST_PAID_ANSWER_STALE_MS)}`))
    .limit(100);
  for (const row of stale) await closeAnswer(row.id, { state: 'failed', model: null }, now);
  return closed + stale.length;
}

/**
 * Requests whose Ree can no longer answer on request -- gone private, off
 * posts or deleted -- are closed (`declined`). `reeId`: one Ree, right after
 * its settings change; null: all of them (the sweep). A request agreed to at
 * the same moment is locked by the agreement and stays agreed.
 */
export async function closeUnavailableRequests(reeId: string | null, now = new Date()): Promise<number> {
  const closed = await db()
    .update(answer)
    .set({ state: 'declined', decidedAt: now })
    .where(
      and(
        or(eq(answer.state, 'awaiting'), refunded()),
        reeId ? eq(answer.reeId, reeId) : undefined,
        sql`not exists (select 1 from ${ree} where ${ree.id} = ${answer.reeId} and ${requestOpen()})`,
      ),
    )
    .returning({ id: answer.id });
  return closed.length;
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
async function freeRewrite(userId: string, target: typeof post.$inferSelect, shownIds: ReadonlySet<string>): Promise<boolean> {
  if (target.summaryRewrites >= POST_SUMMARY_FREE_REWRITES) return false;
  /* Only the answers that dropped out: one of the author's Rees still answering does not make a rewrite paid. */
  const dropped = (target.summaryAnswers ?? []).filter((id) => !shownIds.has(id));
  if (dropped.length === 0) return true;
  const [mine] = await db()
    .select({ id: answer.id })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(inArray(answer.id, dropped), eq(ree.ownerId, userId)))
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
  /* A private post's summary is its author's alone, like the post. */
  const [target] = await db().select().from(post).where(and(eq(post.id, id), authoredBy(userId), readablePost(userId))).limit(1);
  if (!target) return 'not_found';
  const shown = await answersFor([id]).then((rows) => rows.filter((row) => row.shown));
  const stale = target.summaryState === 'done' && summaryStale(target.summaryAnswers, new Set(shown.map((row) => row.id)));
  if (target.summaryState === 'done' && !stale) return 'already';
  if (shown.length < 2) return 'not_enough_answers';
  const free = stale && (await freeRewrite(userId, target, new Set(shown.map((row) => row.id))));
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
  /* The same review as the post's question: a summary is public text too. A review that cannot run counts as failed (fee back). A private post's is read by its author alone and, like the post, skips it. */
  let verdict: boolean | null = target.visibility === 'private' ? true : null;
  try {
    if (verdict === null) verdict = (await judge([target.question, target.detail].filter(Boolean).join('\n\n'), content)).publish;
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
    if (row!.reports >= POST_REPORT_THRESHOLD) {
      const hidden = await tx.update(post).set({ status: 'hidden', hiddenBy: 'reports' }).where(and(eq(post.id, id), eq(post.status, 'published'))).returning({ id: post.id });
      if (hidden.length) await flagQuoting(tx, id);
    }
    return true;
  });
}

export interface AdminPost {
  id: string;
  question: string;
  source: PostSource;
  status: 'published' | 'hidden';
  hiddenBy: 'admin' | 'reports' | null;
  /** Reports on the question itself. */
  reports: number;
  /** Reports on its Rees' answers and on its follow-ups (questions and answers): a reporter's way to flag them, shown with the post. */
  answerReports: number;
  followupReports: number;
  answers: number;
  createdAt: string;
  /** It quotes a post that was taken down, or an answer that was hidden, and waits for review. */
  quoteReview: boolean;
  /** Its AI general answers anyone reads, or taken down after review: each can be taken down or restored on its own. */
  ai: AdminAiAnswer[];
}

export const ADMIN_POST_VIEWS = ['reported', 'quotes', 'hidden', 'all'] as const;
export type AdminPostView = (typeof ADMIN_POST_VIEWS)[number];

/* Reports on a post's Ree answers, its follow-ups and their answers, and its AI answers (the question's own are `report_count`). */
/* Spelled out: in a one-table select drizzle leaves the column unqualified, and the subquery would read its own `id`. */
const postId = sql.raw('"post"."id"');
const answerReports = sql<number>`(select coalesce(sum(ra.report_count), 0) from ${answer} ra where ra.post_id = ${postId})::int`;
const followupReports = sql<number>`(select coalesce(sum(rf.report_count), 0) from ${schema.postFollowup} rf where rf.post_id = ${postId})::int`;
const aiReports = sql<number>`(select coalesce(sum(rai.report_count), 0) from ${schema.postAiAnswer} rai where rai.post_id = ${postId})::int`;
const allReports = sql<number>`(${post.reportCount} + ${answerReports} + ${followupReports} + ${aiReports})`;

/**
 * What the console lists: public posts past review (published or taken
 * down) and out of their authors' trash -- private posts are their authors'
 * alone, administrators included; a trashed one is shown to no one else.
 * `q` searches the question and its detail.
 */
function adminPostScope(q: string | null | undefined): SQL {
  return and(
    inArray(post.status, ['published', 'hidden']),
    eq(post.visibility, 'public'),
    isNull(post.deletedAt),
    q?.trim() ? sql`${searchable} ilike ${`%${q.trim().replace(/[%_\\]/g, '\\$&')}%`}` : undefined,
  )!;
}

/** Each view's filter. Reported: anything on the post was reported -- its question, a Ree's answer, a follow-up or an answer to one, an AI answer. */
function adminPostView(view: AdminPostView): SQL | undefined {
  if (view === 'reported') return sql`(${post.reportCount} > 0
    or exists (select 1 from ${answer} ra where ra.post_id = ${postId} and ra.report_count > 0)
    or exists (select 1 from ${schema.postFollowup} rf where rf.post_id = ${postId} and rf.report_count > 0)
    or exists (select 1 from ${schema.postAiAnswer} rai where rai.post_id = ${postId} and rai.report_count > 0))`;
  if (view === 'hidden') return eq(post.status, 'hidden');
  if (view === 'quotes') return isNotNull(post.quoteReviewAt);
  return undefined;
}

/** The console's posts: the most reported first, then the newest (quotes to review: the longest waiting first). */
export async function adminPosts(options: { view?: AdminPostView; q?: string | null; limit?: number } = {}): Promise<AdminPost[]> {
  const view = options.view ?? 'reported';
  const rows = await db()
    .select({ id: post.id, question: post.question, source: post.source, status: post.status, hiddenBy: post.hiddenBy, reports: post.reportCount, answerReports, followupReports, answers: post.answerCount, createdAt: post.createdAt, quoteReview: post.quoteReviewAt })
    .from(post)
    .where(and(adminPostScope(options.q), adminPostView(view)))
    .orderBy(view === 'quotes' ? asc(post.quoteReviewAt) : desc(allReports), desc(post.createdAt))
    .limit(options.limit ?? 50);
  const ai = await adminAiAnswers(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, status: row.status as 'published' | 'hidden', createdAt: row.createdAt.toISOString(), quoteReview: row.quoteReview !== null, ai: ai.filter((entry) => entry.postId === row.id) }));
}

/** How many posts each view of the console lists, for its tabs and to land on Reported only when something is. */
export async function adminPostCounts(q?: string | null): Promise<Record<AdminPostView, number>> {
  const counts = sql.join(
    ADMIN_POST_VIEWS.map((view) => {
      const filter = adminPostView(view);
      const as = sql.raw(`"${view}"`);
      return filter ? sql`count(*) filter (where ${filter})::int as ${as}` : sql`count(*)::int as ${as}`;
    }),
    sql`, `,
  );
  const result = await db().execute<Record<string, number>>(sql`select ${counts} from ${post} where ${adminPostScope(q)}`);
  const row = result.rows[0] ?? {};
  return Object.fromEntries(ADMIN_POST_VIEWS.map((view) => [view, Number(row[view] ?? 0)])) as Record<AdminPostView, number>;
}

/**
 * Posts quoting a post that was taken down or an answer that was hidden, waiting for an administrator:
 * their answers may restate what was quoted. Until reviewed they stay
 * public (default, see the PR); the console shows how many wait.
 */
export async function quoteReviewCount(): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(post).where(isNotNull(post.quoteReviewAt));
  return row?.n ?? 0;
}

/** When a post is taken down, every post quoting it waits for review. */
async function flagQuoting(tx: Executor, id: string): Promise<void> {
  await tx.update(post).set({ quoteReviewAt: new Date() }).where(and(eq(post.quotePostId, id), isNull(post.quoteReviewAt)));
}

/** When an answer is hidden -- by its owner, by reports or by an administrator -- every post quoting that answer waits for review too. */
export async function flagQuotingAnswer(tx: Executor, answerId: string): Promise<void> {
  await tx.update(post).set({ quoteReviewAt: new Date() }).where(and(eq(post.quoteAnswerId, answerId), isNull(post.quoteReviewAt)));
}

/**
 * An administrator reviews a post quoting a taken-down post or a hidden answer: `keep` lets its
 * answers stand; `hide_answers` hides every shown answer (the post itself
 * stays, its card already says the quote is gone). Either clears the flag
 * and is in the management log.
 */
export async function adminReviewQuote(administratorId: string, id: string, action: 'keep' | 'hide_answers'): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [before] = await tx.select({ question: post.question, flagged: post.quoteReviewAt }).from(post).where(eq(post.id, id)).for('update');
    if (!before?.flagged) return false;
    let hidden = 0;
    if (action === 'hide_answers') {
      const rows = await tx
        .update(answer)
        .set({ hiddenBy: 'admin', pinnedAt: null })
        .where(and(eq(answer.postId, id), eq(answer.state, 'answered'), isNull(answer.hiddenBy)))
        .returning({ id: answer.id });
      hidden = rows.length;
      await recount(tx, id);
    }
    await tx.update(post).set({ quoteReviewAt: null }).where(eq(post.id, id));
    await audit(tx, { administratorId, action: action === 'keep' ? 'post.quote.keep' : 'post.quote.hide_answers', target: id, before: { question: before.question.slice(0, 200) }, after: { hidden } });
    return true;
  });
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
      await flagQuoting(tx, id);
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
  const base = and(eq(answer.reeId, reeId), firstRound(), shownAnswer(), visiblePost())!;
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

/**
 * A share page's "大家问过的": the posts this Ree answered in their first
 * round, public ones only -- the pinned answer first, then the most helpful,
 * then the newest (as the Q&A picks were chosen) -- each card showing this
 * Ree's answer; and how many there are in all.
 */
export async function reePostPicks(reeId: string, count: number, viewerId?: string): Promise<{ items: PostView[]; total: number }> {
  if (!isUuid(reeId)) return { items: [], total: 0 };
  const base = and(eq(answer.reeId, reeId), firstRound(), shownAnswer(), visiblePost())!;
  const [counted] = await db().select({ n: sql<number>`count(*)::int` }).from(answer).innerJoin(ree, eq(ree.id, answer.reeId)).innerJoin(post, eq(post.id, answer.postId)).where(base);
  const picked = await db()
    .select({ postId: answer.postId })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(post, eq(post.id, answer.postId))
    .where(base)
    .orderBy(sql`${answer.pinnedAt} is null`, desc(answer.helpfulCount), desc(answer.answeredAt), desc(answer.id))
    .limit(count);
  if (picked.length === 0) return { items: [], total: counted?.n ?? 0 };
  const rows = await selectPosts(inArray(post.id, picked.map((row) => row.postId)), [desc(post.createdAt)], picked.length);
  const ordered = picked.map((row) => rows.find((entry) => entry.id === row.postId)).filter((row): row is PostRow => Boolean(row));
  return { items: await viewsOf(ordered, viewerId, { whole: false, onlyRee: reeId }), total: counted?.n ?? 0 };
}

/** Shown answers per Ree, for the explore cards' activity line. */
export async function answeredPostCounts(reeIds: readonly string[]): Promise<Map<string, number>> {
  if (reeIds.length === 0) return new Map();
  const rows = await db()
    .select({ reeId: answer.reeId, n: sql<number>`count(*)::int` })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(post, eq(post.id, answer.postId))
    .where(and(inArray(answer.reeId, [...reeIds]), firstRound(), shownAnswer(), visiblePost()))
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
