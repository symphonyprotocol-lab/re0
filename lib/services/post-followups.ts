/**
 * 追问: follow-ups under a public post (design draft 1, approved
 * 2026-11-20; lib/domain/post.ts).
 *
 *   1. Asking (`askFollowup`): any signed-in reader of a visible post --
 *      its author or anyone else -- asks on under it. It may @ Rees, but
 *      only ones that answered the post's first round (and still take
 *      posts). Like a post it is redacted, starts `pending`, needs one base
 *      fee of balance, counts against daily limits and is idempotent.
 *   2. `processFollowup` runs after the response (and from the posts sweep):
 *      - the question is reviewed like a post's; refused → `rejected`;
 *      - answerers come from the first round only: the @-mentioned ones,
 *        whatever their relevance; without an @, every first-round Ree whose
 *        nearest passage reaches `POST_MIN_SIMILARITY`;
 *      - billing is the first round's, charged to whoever asked (谁问谁出钱):
 *        each free Ree (and the asker's own) holds one base fee and
 *        answers; a paid Ree of someone else waits as a request only the
 *        asker sees and agrees to (`agreePaidAnswer`, posts.ts);
 *      - each Ree answers from its own knowledge, with the post's question,
 *        its own earlier answers and the earlier follow-ups' questions as
 *        the exchange so far -- never another Ree's answer.
 *   3. Reading (`threadFor`): the post's page lists published follow-ups,
 *      oldest first, with their shown answers; the asker also sees their own
 *      pending, refused and hidden ones, their requests and what they spent.
 *      A hidden follow-up is one line for everyone else, its answers hidden.
 *   4. Its asker deletes it; three reporters hide it (the post's rule).
 *
 * On a public post no Ree answered, follow-ups under its AI answer
 * (继续问 AI, `ai_only`) are public follow-ups like these -- reviewed,
 * counted, seen by all -- that the AI alone answers, charged to whoever
 * asked (ai-answers.ts).
 *
 * A follow-up's answers are `post_answer` rows with `followup_id` set: the
 * post's own figures (answers, the summary, the Ree pages) stay first-round
 * only (`firstRound`, posts.ts).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { InsufficientCredits } from '@/lib/domain/credits';
import { isUuid } from '@/lib/domain/list';
import {
  FOLLOWUP_DAILY_LIMIT,
  FOLLOWUP_MAX_MENTIONS,
  FOLLOWUP_POST_DAILY_LIMIT,
  FOLLOWUP_POST_MAX,
  POST_ANSWERING_STALE_MS,
  POST_DUPLICATE_WINDOW_MS,
  POST_MIN_SIMILARITY,
  POST_QUOTE_NOTICE_MERGE_MS,
  POST_REPORT_THRESHOLD,
  POST_SWEEP_CONCURRENCY,
  POST_WAITING_STALE_MS,
  followupInputError,
  postDayStart,
  type FollowupCandidate,
  type FollowupView,
} from '@/lib/domain/post';
import { PUBLIC_QA_MODERATION_ATTEMPTS, redact } from '@/lib/domain/public-qa';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { db, schema, type Executor } from '@/lib/infra/db';
import { maxCostFor } from '@/lib/services/grounded-answer';
import { embedQuestion, type QuestionVector } from '@/lib/services/retrieval';
import { aiAnswersFor, aiFollowupsOpen, aiRoundKey, answerWithAi, type AiAnswerer } from '@/lib/services/ai-answers';
import { balanceOf, releaseHold } from '@/lib/services/credits';
import { nearestPassages, publicRee } from '@/lib/services/explore';
import { notify } from '@/lib/services/notices';
import { modelJudge, type Judge } from '@/lib/services/public-qa';
import { postSubject } from '@/lib/domain/post-images';
import {
  answersFor,
  answerView,
  closeAnswer,
  firstRound,
  groundedAnswer,
  holdBaseFee,
  paidRequestsFor,
  shownAnswer,
  spentOn,
  takesPosts,
  unvotedBy,
  visiblePost,
  votedBy,
  type AnswerOne,
  type AnswerResult,
  type PostRow,
} from '@/lib/services/posts';
import { ceilingFor } from '@/lib/services/rate-limit-settings';

const { post, postAnswer: answer, postFollowup: followup, postFollowupReport: followupReport, ree, user, notice } = schema;

/** A follow-up anyone may read: published and not deleted by its asker (a 继续问 AI included). */
export function shownFollowup(): SQL {
  return and(eq(followup.status, 'published'), isNull(followup.deletedAt))!;
}

/* ------------------------------------------------------------ candidates */

export interface FirstRoundRee {
  reeId: string;
  slug: string;
  name: string;
  avatar: string | null;
  color: string;
  ownerId: string;
  queryFee: number;
}

/**
 * The Rees a follow-up may go to: those whose first-round answer is shown
 * now, and that still take posts. One whose answer was hidden, or that went
 * private or stopped taking posts, is no longer a candidate.
 */
async function firstRoundRees(postId: string): Promise<FirstRoundRee[]> {
  return db()
    .select({ reeId: ree.id, slug: ree.slug, name: ree.name, avatar: ree.avatarBlob, color: ree.color, ownerId: ree.ownerId, queryFee: ree.queryFee })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(eq(answer.postId, postId), firstRound(), shownAnswer(), takesPosts()))
    .orderBy(desc(answer.mentioned), desc(answer.helpfulCount), sql`${answer.similarity} desc nulls last`, asc(answer.createdAt));
}

/**
 * The Rees of a private post's thread (私密提问): every Ree any of its
 * answers came from, first round or follow-up, in the order they joined --
 * while it can still be asked: public, or the author's own.
 */
export async function privateThreadRees(postId: string, authorId: string): Promise<FirstRoundRee[]> {
  const rows = await db()
    .select({ reeId: ree.id, slug: ree.slug, name: ree.name, avatar: ree.avatarBlob, color: ree.color, ownerId: ree.ownerId, queryFee: ree.queryFee, joined: sql<Date>`min(${answer.createdAt})` })
    .from(answer)
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(eq(answer.postId, postId), isNull(ree.deletedAt), or(publicRee(), eq(ree.ownerId, authorId))))
    .groupBy(ree.id)
    .orderBy(sql`min(${answer.createdAt})`);
  return rows.map(({ joined: _joined, ...rest }) => rest);
}

/* ----------------------------------------------------------------- asking */

export interface FollowupInput {
  question: string;
  mentionReeIds?: readonly string[];
  lang: 'zh' | 'en';
  clientToken?: string | null;
}

export type AskOutcome =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; error: 'empty' | 'too_long' | 'not_found' | 'no_candidates' | 'mention_unavailable' | 'daily_limit' | 'post_daily_limit' | 'full' }
  | { ok: false; error: 'insufficient_credits'; balance: number; needed: number };

/**
 * Asks a follow-up under a visible post, as `pending`. On a public post no
 * Ree answered, anyone may under its AI answer -- its author once written,
 * anyone else once it passed review (继续问 AI, ai-answers.ts
 * `aiFollowupsOpen`): `ai_only`, reviewed and counted like any follow-up,
 * answered by the AI alone and paid by whoever asked. Asking costs
 * nothing -- each answer is charged on its own, to the asker -- but a
 * balance below one base fee could pay for no answer, so it is refused with
 * a top-up. Counted under an advisory lock against `FOLLOWUP_DAILY_LIMIT`,
 * `FOLLOWUP_POST_DAILY_LIMIT` (or the console's values; none for an account
 * exempt from `post`) and the post's `FOLLOWUP_POST_MAX`; the same
 * `clientToken`, or the same text under the same post within
 * `POST_DUPLICATE_WINDOW_MS`, returns the follow-up already asked.
 */
export async function askFollowup(userId: string, postId: string, input: FollowupInput, now = new Date()): Promise<AskOutcome> {
  const invalid = followupInputError(input.question);
  if (invalid) return { ok: false, error: invalid };
  if (!isUuid(postId)) return { ok: false, error: 'not_found' };
  const [target] = await db().select({ id: post.id }).from(post).where(and(eq(post.id, postId), visiblePost())).limit(1);
  if (!target) return { ok: false, error: 'not_found' };
  const candidates = await firstRoundRees(postId);
  /* No Ree in the first round: anyone asks on under its AI answer (once they can read it), and the AI answers (继续问 AI). */
  const aiOnly = candidates.length === 0 && (await aiFollowupsOpen(postId, userId));
  if (candidates.length === 0 && !aiOnly) return { ok: false, error: 'no_candidates' };
  const mentions = [...new Set((input.mentionReeIds ?? []).filter((id) => isUuid(id)))];
  if (mentions.length > FOLLOWUP_MAX_MENTIONS || mentions.some((id) => !candidates.some((entry) => entry.reeId === id))) return { ok: false, error: 'mention_unavailable' };
  const question = redact(input.question.trim(), input.lang);
  const clientToken = input.clientToken && isUuid(input.clientToken) ? input.clientToken : null;
  const id = randomUUID();
  const dayStart = postDayStart(now);
  const [dailyLimit, postDailyLimit] = await Promise.all([ceilingFor('followupsPerDay', userId), ceilingFor('followupsPerPostPerDay', userId)]);
  try {
    return await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`followup:${userId}`}))`);
      const [same] = await tx
        .select({ id: followup.id })
        .from(followup)
        .where(
          and(
            eq(followup.userId, userId),
            inArray(followup.status, ['pending', 'published']),
            isNull(followup.deletedAt),
            or(
              clientToken ? eq(followup.clientToken, clientToken) : undefined,
              and(eq(followup.postId, postId), eq(followup.question, question), sql`${followup.createdAt} > ${new Date(now.getTime() - POST_DUPLICATE_WINDOW_MS).toISOString()}::timestamptz`),
            ),
          ),
        )
        .orderBy(desc(followup.createdAt))
        .limit(1);
      if (same) return { ok: true, id: same.id, duplicate: true } as const;
      const [counts] = await tx
        .select({
          today: sql<number>`count(*)::int`,
          here: sql<number>`count(*) filter (where ${followup.postId} = ${postId})::int`,
        })
        .from(followup)
        .where(and(eq(followup.userId, userId), sql`${followup.createdAt} >= ${dayStart}::timestamptz`));
      if (dailyLimit !== null && (counts?.today ?? 0) >= dailyLimit) return { ok: false, error: 'daily_limit' } as const;
      if (postDailyLimit !== null && (counts?.here ?? 0) >= postDailyLimit) return { ok: false, error: 'post_daily_limit' } as const;
      const [thread] = await tx.select({ n: post.followupCount }).from(post).where(eq(post.id, postId));
      if ((thread?.n ?? 0) >= FOLLOWUP_POST_MAX) return { ok: false, error: 'full' } as const;
      const balance = await balanceOf(tx, userId, now);
      if (balance < QUERY_BASE_FEE) return { ok: false, error: 'insufficient_credits', balance, needed: QUERY_BASE_FEE } as const;
      /* A 继续问 AI is public like any follow-up: reviewed first, then counted (`moderateFollowup`). */
      await tx.insert(followup).values({ id, postId, userId, question, lang: input.lang, mentionReeIds: aiOnly ? [] : mentions, clientToken, aiOnly, createdAt: now });
      return { ok: true, id } as const;
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, error: 'insufficient_credits', balance: await balanceOf(db(), userId), needed: QUERY_BASE_FEE };
    throw error;
  }
}

/* ----------------------------------------------------------------- review */

/** Reviews a pending follow-up: published (the thread's count goes up, the post's author hears), rejected, or still pending when the check failed. */
export async function moderateFollowup(id: string, judge: Judge = modelJudge, now = new Date()): Promise<'published' | 'rejected' | 'pending' | 'gone'> {
  const [row] = await db()
    .update(followup)
    .set({ moderationAttempts: sql`${followup.moderationAttempts} + 1` })
    .where(and(eq(followup.id, id), eq(followup.status, 'pending'), lt(followup.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS)))
    .returning({ question: followup.question, attempts: followup.moderationAttempts });
  if (!row) return 'gone';
  let verdict: boolean | null = null;
  try {
    verdict = (await judge(row.question, '')).publish;
  } catch (error) {
    console.warn(`followup ${id} review failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (verdict === null && row.attempts < PUBLIC_QA_MODERATION_ATTEMPTS) return 'pending';
  if (verdict) {
    await db().transaction(async (tx) => {
      const [published] = await tx
        .update(followup)
        /* A 继续问 AI asked before 0072 keeps the time it was first published. */
        .set({ status: 'published', publishedAt: sql`coalesce(${followup.publishedAt}, ${now.toISOString()}::timestamptz)` })
        .where(and(eq(followup.id, id), eq(followup.status, 'pending'), isNull(followup.deletedAt)))
        .returning({ postId: followup.postId, userId: followup.userId });
      if (!published) return;
      await tx.update(post).set({ followupCount: sql`${post.followupCount} + 1` }).where(eq(post.id, published.postId));
      await tellPoster(tx, id, published, now);
    });
    return 'published';
  }
  await rejectFollowup(id, now);
  return 'rejected';
}

async function rejectFollowup(id: string, now: Date): Promise<void> {
  await db().update(followup).set({ status: 'rejected', answerState: 'done', answeredAt: now }).where(and(eq(followup.id, id), eq(followup.status, 'pending')));
}

/**
 * Once a follow-up is public, the post's author hears -- not of their own,
 * and only for real posts. Follow-ups under one post within the hour, while
 * unread, fold into one notice ("N 人追问了你的帖子").
 */
async function tellPoster(tx: Executor, id: string, asked: { postId: string; userId: string }, now: Date): Promise<void> {
  const [target] = await tx.select({ userId: post.userId, source: post.source, question: post.question }).from(post).where(eq(post.id, asked.postId)).limit(1);
  if (!target?.userId || target.source !== 'post' || target.userId === asked.userId) return;
  const [open] = await tx
    .select({ id: notice.id, params: notice.params })
    .from(notice)
    .where(
      and(
        eq(notice.userId, target.userId),
        eq(notice.kind, 'post_followup'),
        isNull(notice.readAt),
        eq(notice.refId, asked.postId),
        sql`${notice.createdAt} > ${new Date(now.getTime() - POST_QUOTE_NOTICE_MERGE_MS).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(notice.createdAt))
    .limit(1)
    .for('update');
  if (open) {
    await tx.update(notice).set({ params: { ...open.params, count: Number(open.params.count ?? 1) + 1, followup: id } }).where(eq(notice.id, open.id));
    return;
  }
  await notify(tx, { userId: target.userId, kind: 'post_followup', params: { question: target.question.slice(0, 80), count: 1, followup: id }, refId: asked.postId });
}

/* --------------------------------------------------------------- matching */

/** How close each first-round Ree's knowledge is to the follow-up (its nearest passage); `vector` is reused for the answers. */
export type FollowupMatcher = (input: { question: string; postQuestion: string; reeIds: string[] }) => Promise<{ similarity: Map<string, number>; vector: QuestionVector | null }>;

/** The follow-up read with its post's question (a follow-up alone is often too short to place), against each candidate's nearest passage. */
export const passageMatcher: FollowupMatcher = async ({ question, postQuestion, reeIds }) => {
  const vector = await embedQuestion(`${question}\n${postQuestion}`);
  const nearest = await Promise.all(reeIds.map(async (reeId) => [reeId, (await nearestPassages(vector, [reeId], 1))[0]?.similarity ?? 0] as const));
  return { similarity: new Map(nearest), vector };
};

/* -------------------------------------------------------------- answering */

/** At most this many earlier exchanges go along as context: the thread can be long, a Ree needs the recent part. */
const CONTEXT_ROUNDS = 6;
const CONTEXT_ANSWER_CHARS = 4_000;

/**
 * What one Ree is asked for a follow-up: the follow-up itself, and as the
 * exchange so far the post's question with this Ree's own first-round
 * answer, then the earlier follow-ups -- their questions, and this Ree's
 * answers where it gave one. Never another Ree's answer: each answers from
 * its own knowledge, and the round table is what puts them together.
 */
export async function followupAnswerInput(followupId: string, reeId: string): Promise<{ subject: string; lang: 'zh' | 'en'; vector: QuestionVector | null; turns: { role: 'user' | 'assistant'; content: string }[] } | null> {
  const [row] = await db().select({ followup, post }).from(followup).innerJoin(post, eq(post.id, followup.postId)).where(eq(followup.id, followupId)).limit(1);
  if (!row) return null;
  const earlier = await db()
    .select({ id: followup.id, question: followup.question })
    .from(followup)
    .where(and(eq(followup.postId, row.post.id), shownFollowup(), lt(followup.createdAt, row.followup.createdAt)))
    .orderBy(asc(followup.createdAt));
  const own = await db()
    .select({ followupId: answer.followupId, text: answer.text })
    .from(answer)
    .where(and(eq(answer.postId, row.post.id), eq(answer.reeId, reeId), eq(answer.state, 'answered'), isNull(answer.hiddenBy)));
  const ownText = (key: string | null) => own.find((entry) => entry.followupId === key)?.text.slice(0, CONTEXT_ANSWER_CHARS) ?? null;
  const exchanges: { asked: string[]; answer: string | null }[] = [{ asked: [postSubject(row.post)], answer: ownText(null) }];
  for (const entry of earlier) exchanges.push({ asked: [entry.question], answer: ownText(entry.id) });
  /* Questions this Ree did not answer join the next one it did (or the follow-up itself), so the turns alternate. */
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  let unanswered: string[] = [];
  for (const exchange of exchanges) {
    unanswered.push(...exchange.asked);
    if (!exchange.answer) continue;
    turns.push({ role: 'user', content: unanswered.join('\n\n') }, { role: 'assistant', content: exchange.answer });
    unanswered = [];
  }
  const kept = turns.slice(-CONTEXT_ROUNDS * 2);
  const subject = [...unanswered.slice(-CONTEXT_ROUNDS), row.followup.question].join('\n\n');
  return { subject, lang: row.followup.lang, vector: null, turns: kept };
}

export interface FollowupDeps {
  judge?: Judge;
  matchFollowup?: FollowupMatcher;
  answerOne?: AnswerOne;
  /** AI 通用回答 when no Ree answered the follow-up (ai-answers.ts); the model by default. */
  aiAnswer?: AiAnswerer;
  now?: () => Date;
}

/**
 * Takes a follow-up as far as it goes: review, then (once) the answerers
 * and their answers, then the settlement. Safe to call again: each step
 * claims its state.
 */
export async function processFollowup(id: string, deps: FollowupDeps = {}): Promise<void> {
  if (!isUuid(id)) return;
  const now = deps.now ?? (() => new Date());
  let [row] = await db().select().from(followup).where(eq(followup.id, id)).limit(1);
  if (!row) return;
  if (row.status === 'pending') {
    const status = await moderateFollowup(id, deps.judge, now());
    if (status !== 'published') return;
    [row] = await db().select().from(followup).where(eq(followup.id, id)).limit(1);
    if (!row) return;
  }
  if (row.status !== 'published' || row.deletedAt || row.answerState !== 'waiting') return;
  /* `answeringAt`: the sweep times a dead run from its claim, not from publishing (review S3). */
  const [claimed] = await db().update(followup).set({ answerState: 'answering', answeringAt: now() }).where(and(eq(followup.id, id), eq(followup.answerState, 'waiting'))).returning({ id: followup.id });
  if (!claimed) return;
  const asker = row.userId;
  try {
    const [target] = await db().select({ question: post.question, detail: post.detail, imageText: post.imageText }).from(post).where(eq(post.id, row.postId)).limit(1);
    /* A 继续问 AI goes to no Ree, even one brought in since it was asked: the AI answers it. */
    const candidates = row.aiOnly ? [] : await firstRoundRees(row.postId);
    const mentioned = candidates.filter((entry) => row!.mentionReeIds.includes(entry.reeId));
    /* @: only those, whatever their relevance. Otherwise every first-round Ree close enough to this follow-up. */
    const scoring = candidates.length && target ? await (deps.matchFollowup ?? passageMatcher)({ question: row.question, postQuestion: postSubject(target), reeIds: candidates.map((entry) => entry.reeId) }) : { similarity: new Map<string, number>(), vector: null };
    const chosen = row.mentionReeIds.length
      ? mentioned
      : candidates.filter((entry) => (scoring.similarity.get(entry.reeId) ?? 0) >= POST_MIN_SIMILARITY).sort((a, b) => (scoring.similarity.get(b.reeId) ?? 0) - (scoring.similarity.get(a.reeId) ?? 0));
    await db()
      .update(followup)
      .set({ candidates: row.mentionReeIds.length ? mentioned.length : candidates.length, skipped: row.mentionReeIds.length ? 0 : candidates.length - chosen.length })
      .where(eq(followup.id, id));
    /* A paid Ree of someone else waits for the asker; every other Ree holds the asker's base fee, in order. */
    const paid = new Set(chosen.filter((entry) => entry.queryFee > 0 && entry.ownerId !== asker).map((entry) => entry.reeId));
    const inserted = chosen.length
      ? await db()
          .insert(answer)
          .values(
            chosen.map((entry) => ({
              postId: row!.postId,
              followupId: id,
              reeId: entry.reeId,
              similarity: scoring.similarity.has(entry.reeId) ? scoring.similarity.get(entry.reeId)! : null,
              mentioned: row!.mentionReeIds.includes(entry.reeId),
              state: paid.has(entry.reeId) ? ('awaiting' as const) : ('answering' as const),
            })),
          )
          .onConflictDoNothing()
          .returning({ id: answer.id, reeId: answer.reeId, state: answer.state })
      : [];
    const answering: { id: string; reeId: string }[] = [];
    for (const entry of chosen) {
      const made = inserted.find((other) => other.reeId === entry.reeId);
      if (!made || made.state !== 'answering') continue;
      if (!(await holdBaseFee(asker, made.id, entry.reeId, now()))) continue;
      answering.push(made);
    }
    await Promise.all(
      answering.map(async (entry) => {
        let result: AnswerResult;
        try {
          const input = await followupAnswerInput(id, entry.reeId);
          result = input ? await (deps.answerOne ?? groundedAnswer)({ reeId: entry.reeId, ...input, vector: scoring.vector }) : { state: 'failed', model: null };
        } catch (error) {
          console.warn(`followup ${id} answer ree=${entry.reeId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
          result = { state: 'failed', model: null };
        }
        await closeAnswer(entry.id, result, now());
      }),
    );
  } catch (error) {
    console.warn(`followup ${id} answering failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  await finishFollowup(id, now());
  /* No Ree answered this follow-up (none close enough, or none could): its asker gets an AI answer, at the base fee. */
  await answerWithAi(row.postId, id, deps);
}

/**
 * Settles a follow-up: answers still running are marked failed and their
 * holds given back, and the asker told once -- of the answers, and of the
 * Rees waiting for them to agree.
 */
export async function finishFollowup(id: string, now = new Date()): Promise<void> {
  await db().transaction(async (tx) => {
    const [target] = await tx.select().from(followup).where(and(eq(followup.id, id), eq(followup.answerState, 'answering'))).for('update');
    if (!target) return;
    const running = await tx
      .update(answer)
      .set({ state: 'failed' })
      .where(and(eq(answer.followupId, id), inArray(answer.state, ['queued', 'answering'])))
      .returning({ id: answer.id, reeId: answer.reeId, baseHoldId: answer.baseHoldId, feeHoldId: answer.feeHoldId });
    for (const entry of running) {
      if (entry.baseHoldId) await releaseHold(tx, entry.baseHoldId, { reeId: entry.reeId, ledger: 'post_answer' }, now);
      if (entry.feeHoldId) await releaseHold(tx, entry.feeHoldId, { reeId: entry.reeId, ledger: 'chat_fee' }, now);
    }
    const [counted] = await tx
      .select({ answered: sql<number>`count(*) filter (where ${answer.state} = 'answered')::int`, waiting: sql<number>`count(*) filter (where ${answer.state} = 'awaiting')::int` })
      .from(answer)
      .where(eq(answer.followupId, id));
    await tx.update(followup).set({ answerState: 'done', answeredAt: now }).where(eq(followup.id, id));
    /* On a private post the asker is its author, on its page: no notice. */
    const [thread] = await tx.select({ visibility: post.visibility }).from(post).where(eq(post.id, target.postId));
    if (thread?.visibility === 'private') return;
    const question = target.question.slice(0, 80);
    if ((counted?.answered ?? 0) > 0) await notify(tx, { userId: target.userId, kind: 'followup_answered', params: { question, answers: counted!.answered, followup: id }, refId: target.postId });
    if ((counted?.waiting ?? 0) > 0) await notify(tx, { userId: target.userId, kind: 'post_paid_requests', params: { question, n: counted!.waiting }, refId: target.postId });
  });
}

/**
 * The sweep's cheap part (`processStalePosts`): reviews that died on their
 * last attempt are rejected, and runs that died while answering (timed from
 * their claim) are settled with what they have and given their AI answer.
 * `budgetMs`: checked before each row (review S2); what is left waits for
 * the next run.
 */
export async function settleStaleFollowups(now = new Date(), deps: Pick<FollowupDeps, 'aiAnswer' | 'judge'> = {}, options: { budgetMs?: number } = {}): Promise<number> {
  const deadline = Date.now() + (options.budgetMs ?? Infinity);
  let handled = 0;
  const stuck = await db()
    .select({ id: followup.id })
    .from(followup)
    .where(and(eq(followup.status, 'pending'), sql`${followup.moderationAttempts} >= ${PUBLIC_QA_MODERATION_ATTEMPTS}`, lt(followup.createdAt, new Date(now.getTime() - POST_ANSWERING_STALE_MS))))
    .limit(100);
  for (const row of stuck) {
    if (Date.now() >= deadline) return handled;
    await rejectFollowup(row.id, now);
    handled += 1;
  }
  const dead = await db()
    .select({ id: followup.id, postId: followup.postId })
    .from(followup)
    .where(and(eq(followup.answerState, 'answering'), sql`coalesce(${followup.answeringAt}, ${followup.publishedAt}) < ${new Date(now.getTime() - POST_ANSWERING_STALE_MS)}`))
    .orderBy(sql`coalesce(${followup.answeringAt}, ${followup.publishedAt})`)
    .limit(100);
  for (const row of dead) {
    if (Date.now() >= deadline) return handled;
    await finishFollowup(row.id, now);
    await answerWithAi(row.postId, row.id, deps).catch((error: unknown) => console.warn(`followup ${row.id} ai answer failed: ${error instanceof Error ? error.message : 'unknown'}`));
    handled += 1;
  }
  return handled;
}

/** The sweep's second part: reviews to retry and published follow-ups never started, `concurrency` at a time, within `budgetMs`. */
export async function processWaitingFollowups(deps: FollowupDeps = {}, options: { budgetMs: number; concurrency?: number; now?: Date }): Promise<number> {
  const now = options.now ?? new Date();
  const started = Date.now();
  const waiting = await db()
    .select({ id: followup.id })
    .from(followup)
    .where(
      and(
        isNull(followup.deletedAt),
        or(
          and(eq(followup.status, 'pending'), lt(followup.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS), lt(followup.createdAt, new Date(now.getTime() - 60_000))),
          and(eq(followup.status, 'published'), eq(followup.answerState, 'waiting'), lt(followup.publishedAt, new Date(now.getTime() - POST_WAITING_STALE_MS))),
        ),
      ),
    )
    .orderBy(asc(followup.createdAt))
    .limit(500);
  let next = 0;
  let handled = 0;
  const worker = async () => {
    while (next < waiting.length && Date.now() - started < options.budgetMs) {
      const row = waiting[next++]!;
      await processFollowup(row.id, deps).catch((error: unknown) => console.warn(`followup ${row.id} sweep failed: ${error instanceof Error ? error.message : 'unknown'}`));
      handled += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? POST_SWEEP_CONCURRENCY) }, worker));
  return handled;
}

/* ---------------------------------------------------------------- reading */

/**
 * A post's thread as its page shows it to this viewer: every published
 * follow-up, oldest first, with its shown answers (and those still being
 * written); hidden ones as one line, their answers left out. The asker also
 * gets their own pending, refused and hidden ones in full, the requests
 * waiting for them and what they spent. `candidates`: who the viewer may @
 * (signed-in readers of a visible post only).
 */
export async function threadFor(row: PostRow, viewerId: string | undefined): Promise<{ followups: FollowupView[]; candidates: FollowupCandidate[]; blocked: 'full' | null; aiOnly: boolean }> {
  const rows = await db()
    .select({ followup, name: user.name, avatar: user.avatarBlob })
    .from(followup)
    .innerJoin(user, eq(user.id, followup.userId))
    .where(
      and(
        eq(followup.postId, row.id),
        isNull(followup.deletedAt),
        viewerId ? or(inArray(followup.status, ['published', 'hidden']), eq(followup.userId, viewerId)) : inArray(followup.status, ['published', 'hidden']),
      ),
    )
    .orderBy(asc(followup.createdAt), asc(followup.id));
  const live = row.status === 'published' && !row.deletedAt;
  /* A private thread may ask every Ree already in it (private-posts.ts); a public one its first round's. */
  const firstRees = viewerId && live ? (row.visibility === 'private' ? await privateThreadRees(row.id, viewerId) : await firstRoundRees(row.id)) : [];
  const candidates: FollowupCandidate[] = firstRees.map((entry) => {
    const price = maxCostFor({ ownerId: entry.ownerId, queryFee: entry.queryFee }, viewerId!);
    return { reeId: entry.reeId, reeSlug: entry.slug, reeName: entry.name, reeAvatar: entry.avatar, reeColor: entry.color, price, paid: price > QUERY_BASE_FEE };
  });
  /* No Ree in the first round: anyone who can read its AI answer may ask on under it (继续问 AI); a visitor, once signed in. */
  const aiOnly = Boolean(live && row.visibility === 'public' && candidates.length === 0 && (await aiFollowupsOpen(row.id, viewerId)));
  const blocked = row.followupCount >= FOLLOWUP_POST_MAX ? ('full' as const) : null;
  if (rows.length === 0) return { followups: [], candidates, blocked, aiOnly };
  /* Answers only where the viewer may read them: a published follow-up for anyone, any of their own for the asker. */
  const readable = rows.filter((entry) => entry.followup.status === 'published' || entry.followup.userId === viewerId).map((entry) => entry.followup.id);
  const answers = await answersFor([], readable);
  const voted = await votedBy(viewerId, answers.map((entry) => entry.id));
  /* Only the author ever reads a private thread: their "没帮助" marks and what each answer cost. */
  const own = row.visibility === 'private' && viewerId === row.userId ? { unvoted: await unvotedBy(viewerId, answers.map((entry) => entry.id)) } : null;
  const mentionIds = [...new Set(rows.flatMap((entry) => entry.followup.mentionReeIds))];
  const named = mentionIds.length ? await db().select({ id: ree.id, name: ree.name }).from(ree).where(inArray(ree.id, mentionIds)) : [];
  const mine = rows.filter((entry) => entry.followup.userId === viewerId);
  const waitingRows = await db()
    .select({ followupId: answer.followupId, n: sql<number>`count(*)::int` })
    .from(answer)
    .where(and(inArray(answer.followupId, readable.length ? readable : [randomUUID()]), eq(answer.state, 'awaiting')))
    .groupBy(answer.followupId);
  const [requests, spent, declined] = await Promise.all([
    Promise.all(mine.map(async (entry) => [entry.followup.id, await paidRequestsFor(row.id, viewerId!, entry.followup.id)] as const)),
    Promise.all(mine.map(async (entry) => [entry.followup.id, await spentOn(row.id, entry.followup.id)] as const)),
    mine.length
      ? db()
          .select({ followupId: answer.followupId, name: ree.name })
          .from(answer)
          .innerJoin(ree, eq(ree.id, answer.reeId))
          .where(and(inArray(answer.followupId, mine.map((entry) => entry.followup.id)), eq(answer.state, 'declined')))
      : Promise.resolve([]),
  ]);
  const posterId = row.source === 'post' ? row.userId : null;
  /* The AI answers to follow-ups no Ree answered (ai-answers.ts): the viewer's own, and on a public post those that passed review; folded once a Ree has. */
  const answeredRounds = new Set(answers.filter((other) => other.shown && other.followupId).map((other) => aiRoundKey(row.id, other.followupId)));
  /* Once a Ree has answered the post, the 继续问 AI thread folds with the first AI answer (kept, not refunded). */
  if (rows.some((entry) => entry.followup.aiOnly) && (await answersFor([row.id])).some((other) => other.shown && !other.followupId)) {
    for (const entry of rows) if (entry.followup.aiOnly) answeredRounds.add(aiRoundKey(row.id, entry.followup.id));
  }
  const ai = await aiAnswersFor(viewerId, { followupIds: readable }, { whole: true, answeredRounds });
  return {
    followups: rows.map(({ followup: entry, name, avatar }) => {
      const asker = entry.userId === viewerId;
      const poster = posterId !== null && entry.userId === posterId;
      const hiddenToViewer = entry.status === 'hidden' && !asker;
      return {
        id: entry.id,
        /* The post's author stays anonymous on an anonymous post: "发帖人", no name. */
        author: { name: poster && row.anonymous ? null : name, avatar: poster && row.anonymous ? null : avatar, poster, mine: asker },
        question: hiddenToViewer ? '' : entry.question,
        mentions: hiddenToViewer ? [] : entry.mentionReeIds.map((reeId) => ({ reeId, reeName: named.find((other) => other.id === reeId)?.name ?? '' })).filter((other) => other.reeName),
        status: entry.status,
        hiddenBy: entry.status === 'hidden' ? entry.hiddenBy : null,
        answerState: entry.answerState,
        candidates: entry.candidates,
        skipped: entry.skipped,
        createdAt: (entry.publishedAt ?? entry.createdAt).toISOString(),
        answers: hiddenToViewer ? [] : answers.filter((other) => other.followupId === entry.id && (other.shown || entry.answerState !== 'done')).map((other) => answerView(other, voted, true, own)),
        awaiting: hiddenToViewer ? 0 : (waitingRows.find((other) => other.followupId === entry.id)?.n ?? 0),
        /* A private thread has no requests: its author paid for every Ree when asking. */
        paidRequests: asker && entry.status === 'published' && row.visibility === 'public' ? (requests.find(([key]) => key === entry.id)?.[1] ?? []) : [],
        declined: asker ? declined.filter((other) => other.followupId === entry.id).map((other) => other.name) : [],
        spent: asker ? (spent.find(([key]) => key === entry.id)?.[1] ?? 0) : null,
        aiAnswer: hiddenToViewer ? null : (ai.get(aiRoundKey(row.id, entry.id)) ?? null),
        aiOnly: entry.aiOnly,
      };
    }),
    candidates,
    blocked,
    aiOnly,
  };
}

/* ---------------------------------------------------------------- actions */

/**
 * The asker deletes their follow-up: gone for everyone at once, its answers
 * with it. What was settled stays settled (the answers were given); a
 * request still waiting can no longer be agreed to.
 */
export async function deleteFollowup(userId: string, id: string, now = new Date()): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [gone] = await tx
      .update(followup)
      .set({ deletedAt: now })
      .where(and(eq(followup.id, id), eq(followup.userId, userId), isNull(followup.deletedAt)))
      .returning({ postId: followup.postId, status: followup.status });
    if (!gone) return false;
    if (gone.status === 'published') await tx.update(post).set({ followupCount: sql`greatest(${post.followupCount} - 1, 0)` }).where(eq(post.id, gone.postId));
    await tx.update(answer).set({ state: 'declined', decidedAt: now }).where(and(eq(answer.followupId, id), eq(answer.state, 'awaiting')));
    return true;
  });
}

/**
 * "举报" a follow-up, signed in or not: once per reporter, and the
 * `POST_REPORT_THRESHOLD`th distinct one hides it -- and its answers -- for
 * everyone but its asker. False when it is not shown.
 */
export async function reportFollowup(id: string, reporter: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ id: followup.id, postId: followup.postId })
      .from(followup)
      .innerJoin(post, eq(post.id, followup.postId))
      .where(and(eq(followup.id, id), shownFollowup(), visiblePost()))
      .for('update', { of: followup });
    if (!target) return false;
    const added = await tx.insert(followupReport).values({ followupId: id, reporterKey: reporter }).onConflictDoNothing().returning({ id: followupReport.followupId });
    if (added.length === 0) return true;
    const [counted] = await tx.update(followup).set({ reportCount: sql`${followup.reportCount} + 1` }).where(eq(followup.id, id)).returning({ reports: followup.reportCount });
    if (counted!.reports >= POST_REPORT_THRESHOLD) {
      const hidden = await tx.update(followup).set({ status: 'hidden', hiddenBy: 'reports' }).where(and(eq(followup.id, id), eq(followup.status, 'published'))).returning({ id: followup.id });
      if (hidden.length) await tx.update(post).set({ followupCount: sql`greatest(${post.followupCount} - 1, 0)` }).where(eq(post.id, target.postId));
    }
    return true;
  });
}
