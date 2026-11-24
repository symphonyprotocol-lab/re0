/**
 * The batch side of Ree 比赛 (docs/design/competitions.md 6, 11): what
 * `/api/cron/competitions` runs every minute. Every step claims a state
 * before it works on it, so a step run twice, or by two overlapping runs,
 * does the work once.
 *
 *   1. Cheap steps first: reviews of submitted competitions, the 24-hour
 *      balance reminders, locking those past their deadline (at most
 *      `COMPETITION_ACTIVE_MAX` answering or judging at once), and moving
 *      each on -- answering → judging → review → published.
 *   2. Runs that died with their function are queued again, and holds
 *      whose entry or competition is gone are given back.
 *   3. Model work within `COMPETITION_BUDGET_MS`, `COMPETITION_CONCURRENCY`
 *      at a time and `COMPETITION_MAX_INFLIGHT` across runs: answers
 *      (round-robin by question), then each answer's review, then its
 *      judgement.
 */
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  COMPETITION_ACTIVE_MAX,
  COMPETITION_ANSWER_ATTEMPTS,
  COMPETITION_ANSWER_FEE,
  COMPETITION_ANSWER_TIMEOUT_MS,
  COMPETITION_BALANCE_NOTICE_MS,
  COMPETITION_BUDGET_MS,
  COMPETITION_CONCURRENCY,
  COMPETITION_JUDGE_ATTEMPTS,
  COMPETITION_JUDGE_FEE,
  COMPETITION_MAX_INFLIGHT,
  COMPETITION_STALE_MS,
  combineRuns,
  retryDelayMs,
  withoutLeaks,
  type JudgeRun,
} from '@/lib/domain/competition';
import { InsufficientCredits } from '@/lib/domain/credits';
import { db, schema, type Tx } from '@/lib/infra/db';
import { modelCompetitionAnswer, modelCompetitionJudge, judgeModelName, type CompetitionAnswerer, type CompetitionJudge } from '@/lib/services/competition-judge';
import { openQuestions, publishCompetition, reviewCompetition, writeTotals } from '@/lib/services/competitions';
import { balanceOf, placeHold, releaseHold } from '@/lib/services/credits';
import { publicRee } from '@/lib/services/explore';
import { generationForUser } from '@/lib/services/generation';
import { notify } from '@/lib/services/notices';
import { modelJudge, type Judge } from '@/lib/services/public-qa';
import { embedQuestion, type QuestionVector } from '@/lib/services/retrieval';

const { competition: comp, competitionQuestion: question, competitionEntry: entry, competitionAnswer: answer, creditHold, ree } = schema;

const NOTE = 'competition';

export interface RunDeps {
  answerOne?: CompetitionAnswerer;
  judge?: CompetitionJudge;
  /** The review of each answer before it can be public (10); the posts' judge by default. */
  review?: Judge;
  embed?: (text: string) => Promise<QuestionVector>;
  /** The models fixed at the deadline (7.3, 8.1). */
  answerModel?: () => Promise<string>;
  judgeModel?: () => Promise<string>;
  now?: () => Date;
}

export interface RunOptions {
  budgetMs?: number;
  concurrency?: number;
}

const iso = (at: Date) => sql`${at.toISOString()}::timestamptz`;
/** What an entrant Ree is shown: the question and its detail (7.1). */
const subjectOf = (item: { question: string; detail: string }) => [item.question, item.detail].filter(Boolean).join('\n\n');

/* ------------------------------------------------------------ the deadline */

async function defaultAnswerModel(): Promise<string> {
  return (await generationForUser(null, 'competition_answer')).endpoint.model;
}

/**
 * 截止 (6.1 → `answering`, 9.3), in one transaction: entries close; a
 * closed-book competition's questions go up; the deposit is swapped for
 * one hold per entry (its payer's) and the host's judge hold; an entry
 * whose payer is short is `skipped_balance`, one whose Ree is no longer
 * public or ready is `disqualified`; each locked entry keeps its deadline
 * (the knowledge it answers from) and its Ree's system prompt, and gets
 * one queued answer per question. Then each question is embedded once.
 */
export async function lockCompetition(id: string, deps: RunDeps = {}): Promise<boolean> {
  const now = (deps.now ?? (() => new Date()))();
  const answerModel = await (deps.answerModel ?? defaultAnswerModel)().catch(() => null);
  const judgeModel = await (deps.judgeModel ?? judgeModelName)().catch(() => null);
  const questions = await db().transaction(async (tx: Tx) => {
    const [row] = await tx
      .update(comp)
      .set({ status: 'answering', lockedAt: now, answerModel, judgeModel, updatedAt: now })
      .where(and(eq(comp.id, id), eq(comp.status, 'open'), lte(comp.deadlineAt, now)))
      .returning();
    if (!row) return null;
    if (row.questionMode === 'closed') await openQuestions(tx, row, now);
    const asked = await tx.select({ id: question.id, question: question.question, detail: question.detail, embedding: question.embedding }).from(question).where(eq(question.competitionId, id)).orderBy(asc(question.ordinal));
    if (row.depositHoldId) await releaseHold(tx, row.depositHoldId, { note: NOTE, ledger: 'competition_deposit' }, now);
    const fee = row.answerFee ?? COMPETITION_ANSWER_FEE;
    const entered = await tx
      .select({
        entry,
        systemPrompt: ree.systemPrompt,
        available: sql<boolean>`(${publicRee()} and ${ree.ownerId} = ${entry.userId} and exists (select 1 from ${schema.knowledge} k where k.ree_id = ${ree.id} and k.status = 'ready' and k.enabled and k.deleted_at is null))`,
      })
      .from(entry)
      .innerJoin(ree, eq(ree.id, entry.reeId))
      .where(and(eq(entry.competitionId, id), eq(entry.status, 'entered')))
      .orderBy(asc(entry.createdAt));
    let locked = 0;
    for (const { entry: item, systemPrompt, available } of entered) {
      if (!available) {
        await tx.update(entry).set({ status: 'disqualified', disqualifiedReason: 'ree_unavailable' }).where(eq(entry.id, item.id));
        continue;
      }
      const payerId = row.payer === 'host' ? row.hostId : item.userId;
      let holdId: string;
      try {
        holdId = await placeHold(tx, { userId: payerId, kind: 'competition', ledger: 'competition_answer', amount: asked.length * fee, refId: item.id, reeId: item.reeId, note: NOTE }, now);
      } catch (error) {
        if (!(error instanceof InsufficientCredits)) throw error;
        await tx.update(entry).set({ status: 'skipped_balance' }).where(eq(entry.id, item.id));
        await notify(tx, { userId: item.userId, kind: 'competition_balance_short', params: { title: row.title, slug: row.slug, needed: asked.length * fee, skipped: 1 }, refId: id });
        continue;
      }
      await tx.update(entry).set({ status: 'locked', lockedAt: now, systemPrompt, payerId, holdId }).where(eq(entry.id, item.id));
      if (asked.length) await tx.insert(answer).values(asked.map((q) => ({ competitionId: id, entryId: item.id, questionId: q.id, reeId: item.reeId, createdAt: now })));
      locked += 1;
    }
    let judgeHoldId: string | null = null;
    if (locked > 0) {
      try {
        judgeHoldId = await placeHold(tx, { userId: row.hostId, kind: 'competition', ledger: 'competition_judge', amount: asked.length * locked * (row.judgeFee ?? COMPETITION_JUDGE_FEE), refId: id, note: NOTE }, now);
      } catch (error) {
        /* The deposit covered it a moment ago; a host short now is the platform's cost. */
        if (!(error instanceof InsufficientCredits)) throw error;
      }
    }
    await tx.update(comp).set({ judgeHoldId, depositHoldId: null, entryCount: locked }).where(eq(comp.id, id));
    return asked;
  });
  if (!questions) return false;
  const embed = deps.embed ?? ((text: string) => embedQuestion(text));
  for (const item of questions) {
    if (item.embedding) continue;
    const vector = await embed(subjectOf(item)).catch(() => null);
    if (vector) await db().update(question).set({ embedding: vector }).where(eq(question.id, item.id));
  }
  return true;
}

/* ----------------------------------------------------------- moving on */

/**
 * answering → judging once no answer waits or runs (each written answer
 * then waits for its review); judging → review once nothing waits for a
 * review or a judgement (totals written, the host told, the review period
 * started); review → published when it ends.
 */
export async function advanceCompetitions(deps: RunDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  let moved = 0;
  const answering = await db()
    .update(comp)
    .set({ status: 'judging', updatedAt: now })
    .where(and(eq(comp.status, 'answering'), sql`not exists (select 1 from ${answer} a where a.competition_id = ${comp.id} and a.state in ('queued', 'answering'))`))
    .returning({ id: comp.id });
  for (const row of answering) {
    await db().update(answer).set({ review: 'pending' }).where(and(eq(answer.competitionId, row.id), eq(answer.state, 'answered'), isNull(answer.review)));
    moved += 1;
  }
  const judged = await db()
    .select({ id: comp.id })
    .from(comp)
    .where(and(eq(comp.status, 'judging'), sql`not exists (select 1 from ${answer} a where a.competition_id = ${comp.id} and (a.review = 'pending' or a.judge_state in ('pending', 'running')))`));
  for (const row of judged) {
    const done = await db().transaction(async (tx) => {
      const [claimed] = await tx.select().from(comp).where(and(eq(comp.id, row.id), eq(comp.status, 'judging'))).for('update');
      if (!claimed) return false;
      const ends = new Date(now.getTime() + claimed.reviewHours * 3_600_000);
      await writeTotals(tx, row.id);
      await tx.update(comp).set({ status: 'review', reviewEndsAt: ends, updatedAt: now }).where(eq(comp.id, row.id));
      await notify(tx, { userId: claimed.hostId, kind: 'competition_review_ready', params: { title: claimed.title, slug: claimed.slug, until: ends.toISOString() }, refId: row.id });
      return true;
    });
    if (done) moved += 1;
  }
  const ended = await db().select({ id: comp.id }).from(comp).where(and(eq(comp.status, 'review'), lte(comp.reviewEndsAt, now)));
  for (const row of ended) if (await publishCompetition(row.id, now)) moved += 1;
  return moved;
}

/** The 24-hour reminder (5.2): an entrant who pays and is short of their answers hears it once. */
export async function remindBalances(deps: RunDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await db()
    .select({ entry, title: comp.title, slug: comp.slug, fee: comp.answerFee, questions: sql<number>`(select count(*)::int from ${question} where ${question.competitionId} = ${comp.id})` })
    .from(entry)
    .innerJoin(comp, eq(comp.id, entry.competitionId))
    .where(and(eq(comp.status, 'open'), eq(comp.payer, 'entrant'), lte(comp.deadlineAt, new Date(now.getTime() + COMPETITION_BALANCE_NOTICE_MS)), eq(entry.status, 'entered'), isNull(entry.remindedAt)))
    .limit(200);
  let told = 0;
  for (const row of due) {
    const needed = row.questions * (row.fee ?? COMPETITION_ANSWER_FEE);
    const short = (await balanceOf(db(), row.entry.userId, now)) < needed;
    await db().transaction(async (tx) => {
      const claimed = await tx.update(entry).set({ remindedAt: now }).where(and(eq(entry.id, row.entry.id), isNull(entry.remindedAt))).returning({ id: entry.id });
      if (claimed.length && short) {
        await notify(tx, { userId: row.entry.userId, kind: 'competition_balance_short', params: { title: row.title, slug: row.slug, needed }, refId: row.entry.competitionId });
        told += 1;
      }
    });
  }
  return told;
}

/**
 * Runs that died with their function: an answer or a judgement running
 * past `COMPETITION_STALE_MS` is queued again, or given up after its
 * attempts (0 points, nothing charged). A review whose last attempt never
 * finished is refused, never public unreviewed.
 */
export async function sweepStale(deps: RunDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const before = new Date(now.getTime() - COMPETITION_STALE_MS);
  const answers = await db()
    .update(answer)
    .set({ state: sql`case when ${answer.attempts} >= ${COMPETITION_ANSWER_ATTEMPTS} then 'failed' else 'queued' end`, nextAttemptAt: now })
    .where(and(eq(answer.state, 'answering'), lt(answer.startedAt, before)))
    .returning({ id: answer.id });
  const judges = await db()
    .update(answer)
    .set({ judgeState: sql`case when ${answer.judgeAttempts} >= ${COMPETITION_JUDGE_ATTEMPTS} then 'failed' else 'pending' end` })
    .where(and(eq(answer.judgeState, 'running'), lt(answer.judgeStartedAt, before)))
    .returning({ id: answer.id });
  const reviews = await db()
    .update(answer)
    .set({ review: 'rejected', judgeState: null })
    .where(and(eq(answer.review, 'pending'), gte(answer.reviewAttempts, COMPETITION_JUDGE_ATTEMPTS), lt(answer.answeredAt, before)))
    .returning({ id: answer.id });
  return answers.length + judges.length + reviews.length;
}

/** Competition holds no entry or competition points at any more (a Ree or an account deleted): given back. */
export async function releaseOrphanHolds(deps: RunDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const orphans = await db()
    .select({ id: creditHold.id, ledger: creditHold.ledger })
    .from(creditHold)
    .where(
      and(
        eq(creditHold.kind, 'competition'),
        eq(creditHold.status, 'held'),
        lt(creditHold.createdAt, new Date(now.getTime() - COMPETITION_STALE_MS)),
        or(
          and(eq(creditHold.ledger, 'competition_answer'), sql`not exists (select 1 from ${entry} e where e.hold_id = ${creditHold.id})`),
          and(eq(creditHold.ledger, 'competition_deposit'), sql`not exists (select 1 from ${comp} c where c.deposit_hold_id = ${creditHold.id})`),
          and(eq(creditHold.ledger, 'competition_judge'), sql`not exists (select 1 from ${comp} c where c.judge_hold_id = ${creditHold.id})`),
        ),
      ),
    )
    .limit(50);
  let released = 0;
  for (const hold of orphans) {
    const ledger = hold.ledger as 'competition_answer' | 'competition_deposit' | 'competition_judge';
    if ((await db().transaction((tx) => releaseHold(tx, hold.id, { note: NOTE, ledger }, now))) !== null) released += 1;
  }
  return released;
}

/* ------------------------------------------------------------ the work */

async function inFlight(): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(answer)
    .where(or(eq(answer.state, 'answering'), eq(answer.judgeState, 'running')));
  return row?.n ?? 0;
}

/** Claims the next queued answer: competitions in deadline order, every entry's question n before anyone's n + 1 (11.1). */
async function claimAnswer(now: Date) {
  const [row] = await db()
    .update(answer)
    .set({ state: 'answering', startedAt: now, attempts: sql`${answer.attempts} + 1` })
    .where(
      sql`${answer.id} = (select a.id from ${answer} a
        join ${comp} c on c.id = a.competition_id
        join ${question} q on q.id = a.question_id
        where a.state = 'queued' and (a.next_attempt_at is null or a.next_attempt_at <= ${iso(now)}) and c.status = 'answering'
        order by c.locked_at, q.ordinal, a.entry_id
        limit 1
        for update of a skip locked)`,
    )
    .returning();
  return row ?? null;
}

/** One entrant Ree's answer to one question, from its knowledge as of the deadline under its system prompt then. */
async function runAnswer(row: typeof answer.$inferSelect, deps: RunDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const [context] = await db()
    .select({ lockedAt: entry.lockedAt, systemPrompt: entry.systemPrompt, entryStatus: entry.status, question: question.question, detail: question.detail, embedding: question.embedding, lang: comp.lang })
    .from(entry)
    .innerJoin(question, eq(question.id, row.questionId))
    .innerJoin(comp, eq(comp.id, row.competitionId))
    .where(eq(entry.id, row.entryId))
    .limit(1);
  let result: Awaited<ReturnType<CompetitionAnswerer>> = { state: 'failed', model: null };
  if (context && context.entryStatus === 'locked' && context.lockedAt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('competition answer timed out')), COMPETITION_ANSWER_TIMEOUT_MS);
    try {
      result = await Promise.race([
        (deps.answerOne ?? modelCompetitionAnswer)({ reeId: row.reeId, subject: subjectOf(context), lang: context.lang, vector: context.embedding, asOf: context.lockedAt, systemPrompt: context.systemPrompt ?? '', signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('competition answer timed out')), { once: true })),
      ]);
    } catch (error) {
      console.warn(`competition answer ${row.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      result = { state: 'failed', model: null };
    } finally {
      clearTimeout(timer);
    }
  }
  const at = now();
  await db().transaction(async (tx) => {
    const [current] = await tx.select({ state: answer.state, attempts: answer.attempts }).from(answer).where(eq(answer.id, row.id)).for('update');
    if (current?.state !== 'answering') return;
    if (result.state === 'answered') {
      await tx.update(answer).set({ state: 'answered', text: result.text.slice(0, 20_000), citations: result.citations, model: result.model, answeredAt: at }).where(eq(answer.id, row.id));
      await tx.update(entry).set({ answered: sql`${entry.answered} + 1` }).where(eq(entry.id, row.entryId));
    } else if (result.state === 'no_answer') {
      await tx.update(answer).set({ state: 'no_answer', model: result.model, answeredAt: at }).where(eq(answer.id, row.id));
    } else if (current.attempts >= COMPETITION_ANSWER_ATTEMPTS || context?.entryStatus !== 'locked') {
      await tx.update(answer).set({ state: 'failed', model: result.model }).where(eq(answer.id, row.id));
    } else {
      await tx.update(answer).set({ state: 'queued', model: result.model, nextAttemptAt: new Date(at.getTime() + retryDelayMs(current.attempts)) }).where(eq(answer.id, row.id));
    }
  });
}

/** Claims the next answer waiting for its review (counting an attempt), skipping those this run already tried. */
async function claimReview(tried: ReadonlySet<string>) {
  const skip = tried.size ? sql`and a.id not in (${sql.join([...tried].map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const [row] = await db()
    .update(answer)
    .set({ reviewAttempts: sql`${answer.reviewAttempts} + 1` })
    .where(
      sql`${answer.id} = (select a.id from ${answer} a join ${comp} c on c.id = a.competition_id
        where a.review = 'pending' and a.state = 'answered' and a.review_attempts < ${COMPETITION_JUDGE_ATTEMPTS} and c.status = 'judging' ${skip}
        order by c.locked_at, a.id limit 1 for update of a skip locked)`,
    )
    .returning();
  return row ?? null;
}

/**
 * An answer's review (10), as an AI answer's (ai-answers.ts
 * `reviewAiAnswer`): passed, it waits for its judgement; refused, it scores
 * 0 and is never public (its fee is kept: the Ree answered). A check that
 * cannot run is tried again; the last attempt refuses it.
 */
async function runReview(row: typeof answer.$inferSelect, deps: RunDeps): Promise<void> {
  const [asked] = await db().select({ question: question.question, detail: question.detail }).from(question).where(eq(question.id, row.questionId)).limit(1);
  let verdict: boolean | null = null;
  try {
    verdict = (await (deps.review ?? modelJudge)(subjectOf(asked ?? { question: '', detail: '' }), row.text)).publish;
  } catch (error) {
    console.warn(`competition answer ${row.id} review failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (verdict === null && row.reviewAttempts < COMPETITION_JUDGE_ATTEMPTS) return;
  await db()
    .update(answer)
    .set(verdict ? { review: 'passed', judgeState: 'pending' } : { review: 'rejected', judgeState: null })
    .where(and(eq(answer.id, row.id), eq(answer.review, 'pending')));
}

async function claimJudge(now: Date, tried: ReadonlySet<string>) {
  const skip = tried.size ? sql`and a.id not in (${sql.join([...tried].map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const [row] = await db()
    .update(answer)
    .set({ judgeState: 'running', judgeStartedAt: now, judgeAttempts: sql`${answer.judgeAttempts} + 1` })
    .where(
      sql`${answer.id} = (select a.id from ${answer} a join ${comp} c on c.id = a.competition_id
        where a.judge_state = 'pending' and c.status = 'judging' ${skip}
        order by c.locked_at, a.id limit 1 for update of a skip locked)`,
    )
    .returning();
  return row ?? null;
}

/**
 * The AI judge on one answer (8): blind (no Ree, owner or other answer in
 * the prompt), pointwise, twice with the reference and rubric swapped, a
 * third time when the two disagree, the median kept; the score weighted
 * by the server. Runs made before a failure are kept for the next attempt;
 * after `COMPETITION_JUDGE_ATTEMPTS` it fails and the host scores it by
 * hand (Q4).
 */
async function runJudge(row: typeof answer.$inferSelect, deps: RunDeps): Promise<void> {
  const [context] = await db()
    .select({ question, weights: comp.weights, lang: comp.lang, reveal: comp.revealReference })
    .from(question)
    .innerJoin(comp, eq(comp.id, question.competitionId))
    .where(eq(question.id, row.questionId))
    .limit(1);
  if (!context) return;
  const material = { question: context.question.question, detail: context.question.detail, reference: context.question.referenceAnswer, rubric: context.question.rubric, answer: row.text, sources: row.citations };
  const runs: JudgeRun[] = [...row.aiScores];
  let combined = combineRuns(runs, context.weights);
  let failed = false;
  try {
    while (combined.needs && runs.length < 3) {
      runs.push(await (deps.judge ?? modelCompetitionJudge)({ material, swapped: runs.length % 2 === 1, lang: context.lang }));
      combined = combineRuns(runs, context.weights);
    }
  } catch (error) {
    failed = true;
    console.warn(`competition answer ${row.id} judge failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (failed || combined.score === null) {
    await db()
      .update(answer)
      .set({ aiScores: runs, judgeState: row.judgeAttempts >= COMPETITION_JUDGE_ATTEMPTS ? 'failed' : 'pending' })
      .where(and(eq(answer.id, row.id), eq(answer.judgeState, 'running')));
    return;
  }
  const rationale = context.reveal ? combined.rationale : withoutLeaks(combined.rationale, context.question.referenceAnswer);
  await db()
    .update(answer)
    .set({ aiScores: runs, aiScore: combined.score, rationale, injection: combined.injection, judgeState: 'done' })
    .where(and(eq(answer.id, row.id), eq(answer.judgeState, 'running')));
}

/** One unit of model work, or false when there is none (or too much is in flight). */
async function workOnce(deps: RunDeps, tried: Set<string>): Promise<boolean> {
  if ((await inFlight()) >= COMPETITION_MAX_INFLIGHT) return false;
  const now = (deps.now ?? (() => new Date()))();
  const queued = await claimAnswer(now);
  if (queued) {
    await runAnswer(queued, deps);
    return true;
  }
  const reviewing = await claimReview(tried);
  if (reviewing) {
    tried.add(reviewing.id);
    await runReview(reviewing, deps);
    return true;
  }
  const judging = await claimJudge(now, tried);
  if (judging) {
    tried.add(judging.id);
    await runJudge(judging, deps);
    return true;
  }
  return false;
}

export interface RunReport {
  reviewed: number;
  reminded: number;
  locked: number;
  moved: number;
  swept: number;
  orphans: number;
  work: number;
}

/** One cron run (11.1). Each step's failure is logged and the next goes on. */
export async function runCompetitions(deps: RunDeps = {}, options: RunOptions = {}): Promise<RunReport> {
  const clock = deps.now ?? (() => new Date());
  const quiet = (label: string) => (error: unknown) => {
    console.error(`competitions ${label} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return 0;
  };
  const report: RunReport = { reviewed: 0, reminded: 0, locked: 0, moved: 0, swept: 0, orphans: 0, work: 0 };
  const pending = await db().select({ id: comp.id }).from(comp).where(eq(comp.status, 'pending')).orderBy(asc(comp.submittedAt)).limit(20);
  for (const row of pending) if ((await reviewCompetition(row.id, deps.review, clock()).catch(quiet('review'))) === 'open') report.reviewed += 1;
  report.reminded = await remindBalances(deps).catch(quiet('reminders'));
  const due = await db().select({ id: comp.id }).from(comp).where(and(eq(comp.status, 'open'), lte(comp.deadlineAt, clock()))).orderBy(asc(comp.deadlineAt)).limit(COMPETITION_ACTIVE_MAX);
  for (const row of due) {
    const [{ n } = { n: 0 }] = await db().select({ n: count() }).from(comp).where(inArray(comp.status, ['answering', 'judging']));
    if (n >= COMPETITION_ACTIVE_MAX) break;
    if (await lockCompetition(row.id, deps).catch(quiet('lock'))) report.locked += 1;
  }
  report.moved += await advanceCompetitions(deps).catch(quiet('advance'));
  report.swept = await sweepStale(deps).catch(quiet('stale sweep'));
  report.orphans = await releaseOrphanHolds(deps).catch(quiet('orphan holds'));
  const deadline = Date.now() + (options.budgetMs ?? COMPETITION_BUDGET_MS);
  const tried = new Set<string>();
  const worker = async () => {
    while (Date.now() < deadline) {
      const did = await workOnce(deps, tried).catch((error: unknown) => {
        quiet('work')(error);
        return false;
      });
      if (!did) return;
      report.work += 1;
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? COMPETITION_CONCURRENCY }, worker));
  report.moved += await advanceCompetitions(deps).catch(quiet('advance'));
  return report;
}

/** Ids of answers not yet settled into a state the results read: for tests and the console's progress. */
export async function unfinishedAnswers(competitionId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(answer)
    .where(and(eq(answer.competitionId, competitionId), or(inArray(answer.state, ['queued', 'answering']), eq(answer.review, 'pending'), inArray(answer.judgeState, ['pending', 'running']))));
  return row?.n ?? 0;
}

