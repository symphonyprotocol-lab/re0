/**
 * AI 通用回答 (design draft 1, approved 2026-11-20; lib/domain/ai-answer.ts):
 * when no Ree answers a round, its asker gets one general answer.
 *
 *   1. When (`answerWithAi`, run after a round settles -- posts.ts
 *      `processPost`, private-posts.ts, post-followups.ts):
 *      - a post's first round or one follow-up, of a real post (`source =
 *        'post'`): never RE0's example posts, a Ree owner's 试问, MCP asks,
 *        or copied and visitors' Q&A;
 *      - the round is settled and no Ree has answered it, is answering, or
 *        waits for the asker to agree (a paid Ree's request card is a way to
 *        an answer with sources: the asker decides on it first, and no AI
 *        answer is made). A Ree that found nothing, failed or was declined
 *        does not count;
 *      - once per round (one row, `post_ai_answer`, unique per round).
 *   2. Billing: the asker -- the post's author for the first round, the
 *      follow-up's asker for a follow-up -- holds the base fee
 *      (`AI_ANSWER_FEE`, ledger `ai_answer`), settled to the platform once
 *      written, given back when the model fails or times out. A balance
 *      short of it makes nothing (`skipped_balance`); the asker may then
 *      generate it once by hand (`retryAiAnswer`).
 *   3. Writing: the free tier's generation model whatever the asker's Plan
 *      (the fee covers its cost, section 10), purpose `ai_answer`; the
 *      question and its detail, and for a follow-up the thread's questions
 *      and the asker's earlier AI answers -- never a Ree's answer. The text
 *      is cleaned of citation markers and redacted like a post.
 *   3a. Review (`reviewAiAnswer`, 2026-11-21): on a public post the
 *      written text is reviewed like public text (the posts' judge, with
 *      the question) before anyone but its asker reads it -- `pending`,
 *      then `passed` or `rejected`; a check that cannot run is retried by
 *      the posts sweep and given up (rejected) after
 *      `PUBLIC_QA_MODERATION_ATTEMPTS`. Rejected, it stays its asker's
 *      alone; the fee stays charged (they got the answer). A private
 *      post's is never reviewed (`review` null): only its author reads it.
 *   3b. 继续问 AI (`aiFollowupsOpen`): under the AI answer of a public post
 *      no Ree answered, anyone signed in asks on -- its author once it is
 *      written, anyone else once it passed review. Those follow-ups
 *      (`ai_only`) are public follow-ups like any other (reviewed, counted,
 *      seen by all) that go to the AI alone, at the same fee, paid by
 *      whoever asked (谁问谁出钱). Once a Ree answers the post, they fold
 *      with the first AI answer (kept, not refunded).
 *   4. Reading (`aiAnswersFor`): its asker always; on a public post anyone,
 *      visitors included, once it passed review. It is never a
 *      `post_answer`, so no Ree figure, rank, role metric, sitemap, cover
 *      or answered count reads it, and a public post with only an AI answer
 *      stays 待回答.
 */
import { generateText } from 'ai';
import { and, asc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { aiAnswerInstructions, aiAnswerPrompt, cleanAiAnswer, type AiAnswerThread } from '@/lib/domain/ai-answer';
import { InsufficientCredits } from '@/lib/domain/credits';
import { isUuid } from '@/lib/domain/list';
import {
  AI_ANSWER_FEE,
  AI_ANSWER_MAX_OUTPUT_TOKENS,
  AI_ANSWER_PREVIEW_CHARS,
  AI_ANSWER_STALE_MS,
  AI_ANSWER_TIMEOUT_MS,
  type AiAnswerView,
} from '@/lib/domain/post';
import { plainOf, previewOf } from '@/lib/domain/public-qa';
import { modelFor } from '@/lib/infra/ai/models';
import { PUBLIC_QA_MODERATION_ATTEMPTS, PUBLIC_QA_REPORT_THRESHOLD } from '@/lib/domain/public-qa';
import { db, schema, type Tx } from '@/lib/infra/db';
import { balanceOf, placeHold, releaseHold, settleHold } from '@/lib/services/credits';
import { notify } from '@/lib/services/notices';
import { audit } from '@/lib/services/admin';
import { modelJudge, type Judge } from '@/lib/services/public-qa';

const { post, postAnswer: answer, postFollowup: followup, postAiAnswer: aiAnswer, postAiAnswerReport: aiReport } = schema;

/** The ledger's fixed note for an AI answer, read into the reader's language (components/billing/entries.tsx). */
const NOTE = 'ai answer';

/* ---------------------------------------------------------------- writing */

export interface AiAnswerInput {
  userId: string;
  question: string;
  detail: string;
  lang: 'zh' | 'en';
  thread?: AiAnswerThread;
  signal: AbortSignal;
}

/** Writes one general answer; throws when it cannot. Injectable so tests need no model. */
export type AiAnswerer = (input: AiAnswerInput) => Promise<{ text: string; model: string | null }>;

/** The free tier's generation model, whatever the asker's Plan: the base fee covers its cost, a Plan model's it would not (section 10). */
export const modelAiAnswer: AiAnswerer = async ({ userId, question, detail, lang, thread, signal }) => {
  const generation = await modelFor('generation', 'free', { userId, purpose: 'ai_answer' });
  const { text, response } = await generateText({
    model: generation.model,
    instructions: aiAnswerInstructions(lang),
    messages: [{ role: 'user', content: aiAnswerPrompt(question, detail, thread) }],
    maxOutputTokens: AI_ANSWER_MAX_OUTPUT_TOKENS,
    temperature: 0.3,
    maxRetries: 1,
    abortSignal: signal,
  });
  /* The entry that answered: a backup when the primary was out of quota (lib/infra/ai/failover.ts). */
  return { text, model: response.modelId || generation.endpoint.model };
};

export interface AiDeps {
  aiAnswer?: AiAnswerer;
  /** The review of a public post's AI answer (`reviewAiAnswer`); the posts' judge by default. */
  judge?: Judge;
  now?: () => Date;
}

/* ------------------------------------------------------------- the round */

/** A round no Ree has answered, is answering or waits on: what `answerWithAi` may answer. Needs nothing joined. */
function noReeOn(postId: string, followupId: string | null): SQL {
  return sql`not exists (select 1 from ${answer} ra where ra.post_id = ${postId}
    and ${followupId ? sql`ra.followup_id = ${followupId}::uuid` : sql`ra.followup_id is null`}
    and ra.state in ('queued', 'answering', 'answered', 'awaiting'))`;
}

/** Who asked the round and what, while it may get an AI answer: settled, of a real post anyone (or its author) still reads, no Ree in it. Null otherwise. */
async function askedRound(postId: string, followupId: string | null): Promise<{ userId: string; question: string; detail: string; lang: 'zh' | 'en'; visibility: 'public' | 'private'; postQuestion: string } | null> {
  const live = and(eq(post.id, postId), eq(post.source, 'post'), eq(post.status, 'published'), isNull(post.deletedAt), noReeOn(postId, followupId));
  if (!followupId) {
    const [row] = await db().select().from(post).where(and(live, eq(post.answerState, 'done'))).limit(1);
    if (!row?.userId) return null;
    return { userId: row.userId, question: row.question, detail: row.detail, lang: row.lang, visibility: row.visibility, postQuestion: row.question };
  }
  const [row] = await db()
    .select({ post, followup })
    .from(followup)
    .innerJoin(post, eq(post.id, followup.postId))
    .where(and(live, eq(followup.id, followupId), eq(followup.status, 'published'), isNull(followup.deletedAt), eq(followup.answerState, 'done')))
    .limit(1);
  if (!row) return null;
  return { userId: row.followup.userId, question: row.followup.question, detail: '', lang: row.followup.lang, visibility: row.post.visibility, postQuestion: [row.post.question, row.post.detail].filter(Boolean).join('\n') };
}

/**
 * For a follow-up: the post's question, the AI answer to the first round,
 * and the published follow-ups asked before this one, each with its AI
 * answer -- only AI answers the asker can read (their own, or a public
 * post's that passed review). Never a Ree's answer.
 */
async function threadOf(postId: string, followupId: string, userId: string, postQuestion: string): Promise<AiAnswerThread> {
  const [asked] = await db().select({ createdAt: followup.createdAt }).from(followup).where(eq(followup.id, followupId)).limit(1);
  const earlier = asked
    ? await db()
        .select({ id: followup.id, question: followup.question })
        .from(followup)
        .where(and(eq(followup.postId, postId), eq(followup.status, 'published'), isNull(followup.deletedAt), lt(followup.createdAt, asked.createdAt)))
        .orderBy(asc(followup.createdAt))
    : [];
  const answers = await db()
    .select({ followupId: aiAnswer.followupId, text: aiAnswer.text })
    .from(aiAnswer)
    .where(and(eq(aiAnswer.postId, postId), eq(aiAnswer.state, 'answered'), or(eq(aiAnswer.userId, userId), eq(aiAnswer.review, 'passed'))));
  const first = answers.find((entry) => entry.followupId === null);
  return {
    postQuestion,
    earlierAnswer: first?.text ?? null,
    earlierRounds: earlier.map((entry) => ({ question: entry.question, answer: answers.find((other) => other.followupId === entry.id)?.text ?? null })),
  };
}

/**
 * 继续问 AI: whether this viewer may ask on under the AI answer of this post
 * -- a real public post that is live, whose first round has its AI answer
 * written and no Ree in it (answered, answering or waiting): its author
 * (the AI answer's asker) at once, anyone else once it passed review. A
 * visitor (no `userId`) is told whether signing in would let them. Their
 * follow-ups then go to the AI alone (post-followups.ts `askFollowup`).
 * Once a Ree is brought in (请 Ree 回答) it closes, and follow-ups go to
 * the Rees again.
 */
export async function aiFollowupsOpen(postId: string, userId: string | undefined): Promise<boolean> {
  if (!isUuid(postId)) return false;
  const [row] = await db()
    .select({ id: aiAnswer.id })
    .from(aiAnswer)
    .innerJoin(post, eq(post.id, aiAnswer.postId))
    .where(
      and(
        eq(aiAnswer.postId, postId),
        isNull(aiAnswer.followupId),
        eq(aiAnswer.state, 'answered'),
        userId ? or(eq(aiAnswer.userId, userId), eq(aiAnswer.review, 'passed')) : eq(aiAnswer.review, 'passed'),
        eq(post.visibility, 'public'),
        eq(post.source, 'post'),
        eq(post.status, 'published'),
        isNull(post.deletedAt),
        noReeOn(postId, null),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Holds the fee for a row now running; a short balance leaves it
 * `skipped_balance` (nothing held). In the caller's transaction:
 * `InsufficientCredits` is thrown before any write, so it stays usable.
 */
async function holdFee(tx: Tx, id: string, userId: string, now: Date): Promise<boolean> {
  try {
    const holdId = await placeHold(tx, { userId, kind: 'post', ledger: 'ai_answer', amount: AI_ANSWER_FEE, refId: id, note: NOTE }, now);
    await tx.update(aiAnswer).set({ state: 'running', holdId, startedAt: now }).where(eq(aiAnswer.id, id));
    return true;
  } catch (error) {
    if (!(error instanceof InsufficientCredits)) throw error;
    await tx.update(aiAnswer).set({ state: 'skipped_balance', holdId: null, startedAt: null }).where(eq(aiAnswer.id, id));
    return false;
  }
}

/**
 * The round's AI answer, once, when it may have one: the row made and the
 * fee held (or skipped for the balance), then written. Safe to call again
 * and from anywhere a round settles: the row is unique per round.
 */
export async function answerWithAi(postId: string, followupId: string | null, deps: AiDeps = {}): Promise<void> {
  if (!isUuid(postId) || (followupId !== null && !isUuid(followupId))) return;
  const now = deps.now ?? (() => new Date());
  const round = await askedRound(postId, followupId);
  if (!round) return;
  const started = await db().transaction(async (tx) => {
    const [made] = await tx
      .insert(aiAnswer)
      .values({ postId, followupId, userId: round.userId, state: 'running', createdAt: now() })
      .onConflictDoNothing()
      .returning({ id: aiAnswer.id });
    if (!made) return null;
    return (await holdFee(tx, made.id, round.userId, now())) ? made.id : null;
  });
  if (started) await runAiAnswer(started, deps);
}

/** Writes a running AI answer and settles it: the fee to the platform once written, back to the asker when the model fails or runs out of time. */
export async function runAiAnswer(id: string, deps: AiDeps = {}): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const [row] = await db().select().from(aiAnswer).where(and(eq(aiAnswer.id, id), eq(aiAnswer.state, 'running'))).limit(1);
  if (!row) return;
  const round = await askedRound(row.postId, row.followupId);
  let written: { text: string; model: string | null } | null = null;
  if (round) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('ai answer timed out')), AI_ANSWER_TIMEOUT_MS);
    try {
      const thread = row.followupId ? await threadOf(row.postId, row.followupId, row.userId, round.postQuestion) : undefined;
      const answered = await Promise.race([
        (deps.aiAnswer ?? modelAiAnswer)({ userId: row.userId, question: round.question, detail: round.detail, lang: round.lang, thread, signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('ai answer timed out')), { once: true })),
      ]);
      const text = cleanAiAnswer(answered.text, round.lang);
      written = text ? { text, model: answered.model } : null;
    } catch (error) {
      console.warn(`ai answer ${id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    } finally {
      clearTimeout(timer);
    }
  }
  await closeAiAnswer(id, written, now(), round);
  /* A public post's: reviewed before anyone else reads it (the sweep retries a check that could not run). */
  if (written && round?.visibility === 'public') await reviewAiAnswer(id, deps.judge);
}

/** Settles one running AI answer, once (the row is locked and must still be running); the public post's asker hears it was written, and it waits for review. */
async function closeAiAnswer(id: string, written: { text: string; model: string | null } | null, now: Date, round: { question: string; visibility: 'public' | 'private' } | null): Promise<void> {
  await db().transaction(async (tx) => {
    const [target] = await tx.select().from(aiAnswer).where(and(eq(aiAnswer.id, id), eq(aiAnswer.state, 'running'))).for('update');
    if (!target) return;
    if (!written) {
      if (target.holdId) await releaseHold(tx, target.holdId, { note: NOTE, ledger: 'ai_answer' }, now);
      await tx.update(aiAnswer).set({ state: 'failed' }).where(eq(aiAnswer.id, id));
      return;
    }
    if (target.holdId) await settleHold(tx, target.holdId, AI_ANSWER_FEE, { note: NOTE, ledger: 'ai_answer' }, now);
    await tx
      .update(aiAnswer)
      .set({ state: 'answered', text: written.text.slice(0, 20_000), model: written.model, price: target.holdId ? AI_ANSWER_FEE : 0, answeredAt: now, review: round?.visibility === 'public' ? 'pending' : null })
      .where(eq(aiAnswer.id, id));
    /* A private post's asker is on its page, waiting: no notice (as for its Rees' answers). */
    if (round?.visibility === 'public') {
      await notify(tx, { userId: target.userId, kind: 'post_ai_answer', params: { question: round.question.slice(0, 80), followup: target.followupId }, refId: target.postId });
    }
  });
}

/* ------------------------------------------------------------ by hand */

export type AiRetryOutcome =
  | { ok: true; id: string }
  | { ok: false; error: 'not_found' | 'already' | 'answered' }
  | { ok: false; error: 'insufficient'; balance: number; needed: number };

/**
 * "生成 AI 回答 · 20 credits": an AI answer skipped for a short balance,
 * generated once by its asker after topping up. Once it leaves
 * `skipped_balance` it never comes back to it, so this works once; a balance
 * still short leaves it skipped (`insufficient`) to try again. Refused once
 * a Ree has answered the round (`answered`). The caller writes it after the
 * response (`runAiAnswer`).
 */
export async function retryAiAnswer(userId: string, postId: string, followupId: string | null, now = new Date()): Promise<AiRetryOutcome> {
  if (!isUuid(postId) || (followupId !== null && !isUuid(followupId))) return { ok: false, error: 'not_found' };
  const [row] = await db()
    .select()
    .from(aiAnswer)
    .where(and(eq(aiAnswer.postId, postId), followupId ? eq(aiAnswer.followupId, followupId) : isNull(aiAnswer.followupId), eq(aiAnswer.userId, userId)))
    .limit(1);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.state !== 'skipped_balance') return { ok: false, error: 'already' };
  if (!(await askedRound(postId, followupId))) return { ok: false, error: 'answered' };
  const held = await db().transaction(async (tx) => {
    const [locked] = await tx.select({ id: aiAnswer.id }).from(aiAnswer).where(and(eq(aiAnswer.id, row.id), eq(aiAnswer.state, 'skipped_balance'))).for('update');
    if (!locked) return 'already' as const;
    return (await holdFee(tx, row.id, userId, now)) ? ('held' as const) : ('short' as const);
  });
  if (held === 'already') return { ok: false, error: 'already' };
  if (held === 'short') return { ok: false, error: 'insufficient', balance: await balanceOf(db(), userId, now), needed: AI_ANSWER_FEE };
  return { ok: true, id: row.id };
}

/* ----------------------------------------------------------------- review */

/**
 * Reviews a written AI answer of a public post, with the question it
 * answers (the post's, or the follow-up's), by the judge public text goes
 * through: `passed` (anyone reads it), `rejected` (its asker alone, the fee
 * kept), or still `pending` when the check failed -- the sweep retries it,
 * and the last attempt rejects it.
 */
export async function reviewAiAnswer(id: string, judge: Judge = modelJudge): Promise<'passed' | 'rejected' | 'pending' | 'gone'> {
  const [row] = await db()
    .update(aiAnswer)
    .set({ reviewAttempts: sql`${aiAnswer.reviewAttempts} + 1` })
    .where(and(eq(aiAnswer.id, id), eq(aiAnswer.review, 'pending'), eq(aiAnswer.state, 'answered'), lt(aiAnswer.reviewAttempts, PUBLIC_QA_MODERATION_ATTEMPTS)))
    .returning({ postId: aiAnswer.postId, followupId: aiAnswer.followupId, text: aiAnswer.text, attempts: aiAnswer.reviewAttempts });
  if (!row) return 'gone';
  const [asked] = row.followupId
    ? await db().select({ question: followup.question, detail: sql<string>`''` }).from(followup).where(eq(followup.id, row.followupId)).limit(1)
    : await db().select({ question: post.question, detail: post.detail }).from(post).where(eq(post.id, row.postId)).limit(1);
  let verdict: boolean | null = null;
  try {
    verdict = (await judge([asked?.question ?? '', asked?.detail ?? ''].filter(Boolean).join('\n\n'), row.text)).publish;
  } catch (error) {
    console.warn(`ai answer ${id} review failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (verdict === null && row.attempts < PUBLIC_QA_MODERATION_ATTEMPTS) return 'pending';
  const review = verdict ? ('passed' as const) : ('rejected' as const);
  await db().update(aiAnswer).set({ review }).where(and(eq(aiAnswer.id, id), eq(aiAnswer.review, 'pending')));
  return review;
}

/** At most this many reviews per sweep (every 5 minutes): the backfill of 0072 drains over a few runs. */
const AI_ANSWER_REVIEW_BATCH = 50;

/**
 * The posts sweep's part: AI answers no live run finished fail, their fee
 * given back; reviews that could not run are tried again (a minute after
 * the answer, `PUBLIC_QA_MODERATION_ATTEMPTS` in all), and one whose last
 * attempt never finished is rejected -- never public unreviewed.
 */
export async function sweepAiAnswers(now = new Date(), deps: Pick<AiDeps, 'judge'> = {}, options: { budgetMs?: number } = {}): Promise<number> {
  const deadline = Date.now() + (options.budgetMs ?? Infinity);
  const stale = await db()
    .select({ id: aiAnswer.id })
    .from(aiAnswer)
    .where(and(eq(aiAnswer.state, 'running'), lt(aiAnswer.startedAt, new Date(now.getTime() - AI_ANSWER_STALE_MS))))
    .limit(100);
  for (const row of stale) await closeAiAnswer(row.id, null, now, null);
  const stuck = await db()
    .update(aiAnswer)
    .set({ review: 'rejected' })
    .where(and(eq(aiAnswer.review, 'pending'), sql`${aiAnswer.reviewAttempts} >= ${PUBLIC_QA_MODERATION_ATTEMPTS}`, lt(aiAnswer.answeredAt, new Date(now.getTime() - AI_ANSWER_STALE_MS))))
    .returning({ id: aiAnswer.id });
  const waiting = await db()
    .select({ id: aiAnswer.id })
    .from(aiAnswer)
    .where(and(eq(aiAnswer.review, 'pending'), eq(aiAnswer.state, 'answered'), lt(aiAnswer.reviewAttempts, PUBLIC_QA_MODERATION_ATTEMPTS), lt(aiAnswer.answeredAt, new Date(now.getTime() - 60_000))))
    .orderBy(asc(aiAnswer.answeredAt))
    .limit(AI_ANSWER_REVIEW_BATCH);
  /* Each review is a model call: checked against the budget before each one (review S2); the rest wait for the next run. */
  let reviewed = 0;
  for (const row of waiting) {
    if (Date.now() >= deadline) break;
    await reviewAiAnswer(row.id, deps.judge).catch((error: unknown) => console.warn(`ai answer ${row.id} review failed: ${error instanceof Error ? error.message : 'unknown'}`));
    reviewed += 1;
  }
  return stale.length + stuck.length + reviewed;
}


/* ---------------------------------------------------------------- reading */

/** Where an AI answer sits: a post's first round (`followupId` null) or one follow-up. */
export const aiRoundKey = (postId: string, followupId: string | null): string => (followupId ? `f:${followupId}` : `p:${postId}`);

/**
 * The AI answers to these rounds this viewer may read, keyed by
 * `aiRoundKey`: their own (they asked and pay), in any state; and on a
 * public post anyone's -- visitors' too -- once written and passed review.
 * A private post's, or one pending or refused review, is its asker's alone.
 * `whole`: the Markdown on the post page; otherwise a plain excerpt for a
 * feed card. `answeredRounds`: rounds a Ree has answered since, where the AI
 * answer folds. The callers pass only rounds the viewer can read.
 */
export async function aiAnswersFor(viewerId: string | undefined, rounds: { postIds?: readonly string[]; followupIds?: readonly string[] }, options: { whole: boolean; answeredRounds?: ReadonlySet<string> }): Promise<Map<string, AiAnswerView>> {
  const postIds = [...(rounds.postIds ?? [])];
  const followupIds = [...(rounds.followupIds ?? [])];
  if (postIds.length === 0 && followupIds.length === 0) return new Map();
  const shown = and(eq(post.visibility, 'public'), eq(aiAnswer.state, 'answered'), eq(aiAnswer.review, 'passed'));
  const rows = await db()
    .select({ row: aiAnswer, visibility: post.visibility })
    .from(aiAnswer)
    .innerJoin(post, eq(post.id, aiAnswer.postId))
    .where(
      and(
        viewerId ? or(eq(aiAnswer.userId, viewerId), shown) : shown,
        or(
          postIds.length ? and(inArray(aiAnswer.postId, postIds), isNull(aiAnswer.followupId)) : undefined,
          followupIds.length ? inArray(aiAnswer.followupId, followupIds) : undefined,
        ),
      ),
    );
  const out = new Map<string, AiAnswerView>();
  for (const { row, visibility } of rows) {
    const key = aiRoundKey(row.postId, row.followupId);
    /* A failed one leaves nothing to show; the round reads as it did before. */
    if (row.state === 'failed') continue;
    const mine = row.userId === viewerId;
    const cut = options.whole || row.state !== 'answered' ? { answer: row.text, truncated: false } : previewOf(plainOf(row.text), AI_ANSWER_PREVIEW_CHARS);
    out.set(key, {
      id: row.id,
      state: row.state,
      text: cut.answer,
      truncated: cut.truncated,
      vote: mine ? (row.vote ?? null) : null,
      cost: mine && row.state === 'answered' ? row.price : 0,
      retry: mine && row.state === 'skipped_balance',
      folded: options.answeredRounds?.has(key) ?? false,
      mine,
      review: row.review ?? null,
      private: visibility === 'private',
    });
  }
  return out;
}

/** 有帮助 / 没帮助 on the asker's own AI answer (nobody else's), or taken back (`null`); for its quality only, never any Ree's. */
export async function voteAiAnswer(userId: string, id: string, vote: 'helpful' | 'unhelpful' | null): Promise<{ vote: 'helpful' | 'unhelpful' | null } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db()
    .update(aiAnswer)
    .set({ vote })
    .where(and(eq(aiAnswer.id, id), eq(aiAnswer.userId, userId), eq(aiAnswer.state, 'answered')))
    .returning({ vote: aiAnswer.vote });
  return row ? { vote: row.vote ?? null } : null;
}

/**
 * Its round can be read by anyone: a public, published post out of the
 * trash, and -- a follow-up's -- a follow-up still published and not
 * deleted. Needs `post_ai_answer`.
 */
const publicRound = (): SQL =>
  sql`(exists (select 1 from ${post} rp where rp.id = ${aiAnswer.postId} and rp.visibility = 'public' and rp.status = 'published' and rp.deleted_at is null)
    and (${aiAnswer.followupId} is null or exists (select 1 from ${followup} rf where rf.id = ${aiAnswer.followupId} and rf.status = 'published' and rf.deleted_at is null)))`;

/**
 * "举报" an AI answer anyone reads (review S5), signed in or not, as a
 * Ree's answer is reported: one report per reporter (the account, or a
 * visitor's network as an HMAC). At `PUBLIC_QA_REPORT_THRESHOLD` reporters
 * it is refused -- `review` 'rejected', `hidden_by` 'reports' -- so only
 * its asker reads it again, until an administrator restores it. False when
 * there is nothing anyone else could have read.
 */
export async function reportAiAnswer(id: string, reporter: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ id: aiAnswer.id })
      .from(aiAnswer)
      .where(and(eq(aiAnswer.id, id), eq(aiAnswer.state, 'answered'), eq(aiAnswer.review, 'passed'), publicRound()))
      .for('update');
    if (!target) return false;
    const added = await tx.insert(aiReport).values({ aiAnswerId: id, reporterKey: reporter }).onConflictDoNothing().returning({ id: aiReport.aiAnswerId });
    if (added.length === 0) return true;
    const [row] = await tx.update(aiAnswer).set({ reportCount: sql`${aiAnswer.reportCount} + 1` }).where(eq(aiAnswer.id, id)).returning({ reports: aiAnswer.reportCount });
    if (row!.reports >= PUBLIC_QA_REPORT_THRESHOLD) await tx.update(aiAnswer).set({ review: 'rejected', hiddenBy: 'reports' }).where(eq(aiAnswer.id, id));
    return true;
  });
}

/* ------------------------------------------------------------------ admin */

export interface AdminAiAnswer {
  id: string;
  postId: string;
  /** Under a follow-up (继续问 AI), not the post's first round. */
  followup: boolean;
  hidden: boolean;
  hiddenBy: 'reports' | 'admin' | null;
  reports: number;
}

/** The AI answers of these posts an administrator may act on: those anyone reads (passed review) and those taken down after it. */
export async function adminAiAnswers(postIds: readonly string[]): Promise<AdminAiAnswer[]> {
  if (!postIds.length) return [];
  const rows = await db()
    .select({ id: aiAnswer.id, postId: aiAnswer.postId, followupId: aiAnswer.followupId, review: aiAnswer.review, hiddenBy: aiAnswer.hiddenBy, reports: aiAnswer.reportCount })
    .from(aiAnswer)
    .where(and(inArray(aiAnswer.postId, [...postIds]), eq(aiAnswer.state, 'answered'), or(eq(aiAnswer.review, 'passed'), sql`${aiAnswer.hiddenBy} is not null`)))
    .orderBy(asc(aiAnswer.createdAt));
  return rows.map((row) => ({ id: row.id, postId: row.postId, followup: row.followupId !== null, hidden: row.hiddenBy !== null, hiddenBy: row.hiddenBy ?? null, reports: row.reports }));
}

/**
 * An administrator takes down an AI answer that passed review (review S5)
 * -- refused like a review refusal, so only its asker reads it, fee kept --
 * or restores one taken down by reports or an administrator (its reports
 * cleared). In the management log. False when it is not in that state.
 */
export async function adminSetAiAnswer(administratorId: string, id: string, show: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [before] = await tx
      .select({ postId: aiAnswer.postId, review: aiAnswer.review, hiddenBy: aiAnswer.hiddenBy, reports: aiAnswer.reportCount })
      .from(aiAnswer)
      .where(and(eq(aiAnswer.id, id), eq(aiAnswer.state, 'answered')))
      .for('update');
    if (!before) return false;
    if (show) {
      if (!before.hiddenBy) return false;
      await tx.update(aiAnswer).set({ review: 'passed', hiddenBy: null, reportCount: 0 }).where(eq(aiAnswer.id, id));
      await tx.delete(aiReport).where(eq(aiReport.aiAnswerId, id));
    } else {
      if (before.review !== 'passed') return false;
      await tx.update(aiAnswer).set({ review: 'rejected', hiddenBy: 'admin' }).where(eq(aiAnswer.id, id));
    }
    await audit(tx, { administratorId, action: show ? 'post.ai.restore' : 'post.ai.hide', target: id, before: { postId: before.postId, review: before.review, hiddenBy: before.hiddenBy, reports: before.reports } });
    return true;
  });
}

/** The overview's AI answers since `since`: made (written or failed), written, what they earned the platform, and the votes. */
export async function aiAnswerStats(since: Date): Promise<{ total: number; answered: number; failed: number; skipped: number; revenue: number; helpful: number; unhelpful: number }> {
  const [row] = await db()
    .select({
      total: sql<number>`count(*) filter (where ${aiAnswer.state} in ('answered', 'failed'))::int`,
      answered: sql<number>`count(*) filter (where ${aiAnswer.state} = 'answered')::int`,
      failed: sql<number>`count(*) filter (where ${aiAnswer.state} = 'failed')::int`,
      skipped: sql<number>`count(*) filter (where ${aiAnswer.state} = 'skipped_balance')::int`,
      revenue: sql<number>`coalesce(sum(${aiAnswer.price}) filter (where ${aiAnswer.state} = 'answered'), 0)::int`,
      helpful: sql<number>`count(*) filter (where ${aiAnswer.vote} = 'helpful')::int`,
      unhelpful: sql<number>`count(*) filter (where ${aiAnswer.vote} = 'unhelpful')::int`,
    })
    .from(aiAnswer)
    .where(sql`${aiAnswer.createdAt} >= ${since.toISOString()}::timestamptz`);
  return { total: row?.total ?? 0, answered: row?.answered ?? 0, failed: row?.failed ?? 0, skipped: row?.skipped ?? 0, revenue: row?.revenue ?? 0, helpful: row?.helpful ?? 0, unhelpful: row?.unhelpful ?? 0 };
}
