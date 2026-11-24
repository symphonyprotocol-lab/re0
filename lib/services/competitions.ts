/**
 * Ree 比赛 (docs/design/competitions.md): everything but the batch runner
 * (lib/services/competition-run.ts) -- a host's draft, its review and
 * deposit, entries, what each viewer may read, the host's score overrides,
 * publishing the results, and the console's actions.
 *
 * Secrets (7.1): a question's `reference_answer` and `rubric` are read only
 * by `secretQuestions` -- the host's own management view and the judge.
 * Every other read selects `publicQuestionColumns`, and only returns the
 * reference after the results of a competition that reveals it.
 *
 * Money (9.3): the host's deposit is held on submitting (Pack first, Q5)
 * and swapped at the deadline, in one transaction, for one answer hold per
 * entry and the judge's hold; those settle when the results go out
 * (answered × fee, judged × fee: 多退少不补), and every hold still open is
 * given back if the competition is cancelled before then.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  COMPETITION_ACTIVE,
  COMPETITION_ACTIVE_PER_HOST,
  COMPETITION_ANSWER_FEE,
  COMPETITION_BIG_CHANGE,
  COMPETITION_DRAFTS_PER_DAY,
  COMPETITION_ENTRIES_PER_DAY,
  COMPETITION_JUDGE_FEE,
  COMPETITION_LISTED,
  COMPETITION_REASON_MAX,
  COMPETITION_RUNNING,
  COMPETITION_SCORE_EDITS_PER_MINUTE,
  COMPETITION_SCORE_NOTE_MAX,
  checkDraft,
  checkQuestions,
  combineRuns,
  deadlineProblem,
  depositOf,
  entriesMaxFor,
  entryTotal,
  finalScore,
  hostMayCancel,
  hostMayEdit,
  hostProblem,
  rankEntries,
  type CompetitionPayer,
  type CompetitionStatus,
  type CompetitionWeights,
  type EntryStatus,
  type JudgeRun,
  type QuestionMode,
} from '@/lib/domain/competition';
import { InsufficientCredits } from '@/lib/domain/credits';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { isUuid } from '@/lib/domain/list';
import { PUBLIC_QA_MODERATION_ATTEMPTS } from '@/lib/domain/public-qa';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { audit } from '@/lib/services/admin';
import { fileUnderChannel } from '@/lib/services/channels';
import { modelCompetitionJudge, type CompetitionJudge } from '@/lib/services/competition-judge';
import { balanceOf, placeHold, releaseHold, settleHold } from '@/lib/services/credits';
import { publicRee } from '@/lib/services/explore';
import { readyRees } from '@/lib/services/grounded-answer';
import { notify } from '@/lib/services/notices';
import { modelJudge, type Judge } from '@/lib/services/public-qa';
import { hitRateBucket } from '@/lib/services/rate-limit';

const { competition: comp, competitionQuestion: question, competitionEntry: entry, competitionAnswer: answer, competitionScoreLog: scoreLog, competitionReport: report, channel, postChannel, post, postAnswer, ree, user } = schema;

export type CompetitionRow = typeof comp.$inferSelect;

/** What the ledger shows next to each competition hold (read into the reader's language by the billing page). */
const NOTE = 'competition';

/* ------------------------------------------------------------------ reads */

/** A question as anyone may read it: never its reference answer or rubric (7.1). */
export const publicQuestionColumns = {
  id: question.id,
  ordinal: question.ordinal,
  question: question.question,
  detail: question.detail,
  weight: question.weight,
  postId: question.postId,
};

export interface PublicQuestion {
  id: string;
  ordinal: number;
  question: string;
  detail: string;
  weight: number;
  postId: string | null;
  /** Only after the results of a competition that reveals its references. */
  referenceAnswer?: string;
}

export async function publicQuestions(competitionId: string): Promise<PublicQuestion[]> {
  return db().select(publicQuestionColumns).from(question).where(eq(question.competitionId, competitionId)).orderBy(asc(question.ordinal));
}

/** Every column, reference and rubric included: the host's management view and the judge only. */
export async function secretQuestions(executor: Executor, competitionId: string) {
  return executor.select().from(question).where(eq(question.competitionId, competitionId)).orderBy(asc(question.ordinal));
}

/** The questions are public: an open-book competition once it opened, any once the deadline passed. */
export function questionsPublic(row: Pick<CompetitionRow, 'status' | 'questionMode'>): boolean {
  if (row.status === 'open') return row.questionMode === 'open';
  return (COMPETITION_RUNNING as readonly string[]).includes(row.status) || row.status === 'published';
}

/* ---------------------------------------------------------------- drafts */

export type DraftOutcome = { ok: true; id: string; slug: string } | { ok: false; error: string; field?: string };

async function hostAccount(userId: string): Promise<{ role: 'normal' | 'verified' | 'official'; createdAt: Date; publicRees: number } | null> {
  const [row] = await db().select({ role: user.role, createdAt: user.createdAt }).from(user).where(eq(user.id, userId)).limit(1);
  if (!row) return null;
  const [{ n } = { n: 0 }] = await db().select({ n: count() }).from(ree).where(and(eq(ree.ownerId, userId), publicRee()));
  return { ...row, publicRees: n };
}

/**
 * The competition's channel (C1): a new one, or the name of a competition
 * that was cancelled or refused and never put a post in it. Null when the
 * name is anyone else's -- a hashtag people already use, or a live
 * competition's.
 */
async function claimChannel(tx: Tx, name: string, userId: string): Promise<string | null> {
  const [made] = await tx.insert(channel).values({ name, createdBy: userId }).onConflictDoNothing({ target: channel.name }).returning({ id: channel.id });
  if (made) return made.id;
  const [free] = await tx
    .select({ id: channel.id })
    .from(channel)
    .where(
      and(
        eq(channel.name, name),
        sql`not exists (select 1 from ${postChannel} pc where pc.channel_id = ${channel.id})`,
        sql`exists (select 1 from ${comp} c where c.channel_id = ${channel.id} and c.status in ('cancelled', 'rejected'))`,
        sql`not exists (select 1 from ${comp} c where c.channel_id = ${channel.id} and c.status not in ('cancelled', 'rejected'))`,
      ),
    )
    .for('update');
  if (!free) return null;
  await tx.update(comp).set({ channelId: null }).where(eq(comp.channelId, free.id));
  return free.id;
}

/**
 * 建草稿: anyone past Q1's bar, `COMPETITION_DRAFTS_PER_DAY` a day. The
 * channel (its name the URL's slug) is claimed now, so the name is the
 * host's from the start.
 */
export async function createDraft(userId: string, input: Record<string, unknown>, now = new Date()): Promise<DraftOutcome> {
  const account = await hostAccount(userId);
  if (!account) return { ok: false, error: 'not_found' };
  const problem = hostProblem(account, now);
  if (problem) return { ok: false, error: problem };
  const checked = checkDraft(input, { entriesMax: entriesMaxFor(account.role) });
  if (!checked.ok) return checked;
  if (!(await hitRateBucket(`competition-draft:${userId}`, COMPETITION_DRAFTS_PER_DAY, 86_400, now))) return { ok: false, error: 'daily_limit' };
  const value = checked.value;
  return db().transaction(async (tx) => {
    const channelId = await claimChannel(tx, value.channel, userId);
    if (!channelId) return { ok: false as const, error: 'channel_taken', field: 'channel' };
    const [made] = await tx
      .insert(comp)
      .values({
        slug: value.channel,
        channelId,
        hostId: userId,
        title: value.title,
        description: value.description,
        lang: value.lang,
        questionMode: value.questionMode,
        payer: value.payer,
        maxEntries: value.maxEntries,
        maxEntriesPerUser: value.maxEntriesPerUser,
        weights: value.weights,
        revealReference: value.revealReference,
        deadlineAt: value.deadlineAt,
        reviewHours: value.reviewHours,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: comp.id, slug: comp.slug });
    return { ok: true as const, id: made!.id, slug: made!.slug };
  });
}

async function ownedForUpdate(tx: Tx, userId: string, id: string): Promise<CompetitionRow | null> {
  const [row] = await tx.select().from(comp).where(and(eq(comp.id, id), eq(comp.hostId, userId))).for('update');
  return row ?? null;
}

/**
 * A host's edit (5.1): a draft's settings, anything but its channel; an
 * open competition's description, or its deadline brought forward (never
 * put back, Q6) -- `closeNow` ends entries at once.
 */
export async function updateCompetition(userId: string, id: string, input: Record<string, unknown>, now = new Date()): Promise<{ ok: true } | { ok: false; error: string; field?: string }> {
  if (!isUuid(id)) return { ok: false, error: 'not_found' };
  const account = await hostAccount(userId);
  if (!account) return { ok: false, error: 'not_found' };
  return db().transaction(async (tx) => {
    const row = await ownedForUpdate(tx, userId, id);
    if (!row) return { ok: false as const, error: 'not_found' };
    if (row.status === 'draft') {
      const checked = checkDraft({ channel: row.slug, ...input }, { entriesMax: entriesMaxFor(account.role) });
      if (!checked.ok) return checked;
      if (checked.value.channel !== row.slug) return { ok: false as const, error: 'channel_fixed', field: 'channel' };
      const value = checked.value;
      await tx
        .update(comp)
        .set({ title: value.title, description: value.description, lang: value.lang, questionMode: value.questionMode, payer: value.payer, maxEntries: value.maxEntries, maxEntriesPerUser: value.maxEntriesPerUser, weights: value.weights, revealReference: value.revealReference, deadlineAt: value.deadlineAt, reviewHours: value.reviewHours, updatedAt: now })
        .where(eq(comp.id, id));
      return { ok: true as const };
    }
    if (row.status !== 'open') return { ok: false as const, error: 'locked' };
    const set: Partial<typeof comp.$inferInsert> = { updatedAt: now };
    if (typeof input.description === 'string' && hostMayEdit(row.status, 'description')) {
      const description = input.description.trim();
      if ([...description].length > 8_000) return { ok: false as const, error: 'invalid_description', field: 'description' };
      set.description = description;
    }
    if (input.closeNow === true) set.deadlineAt = now;
    else if (input.deadlineAt !== undefined) {
      const at = new Date(String(input.deadlineAt));
      if (Number.isNaN(at.getTime())) return { ok: false as const, error: 'invalid_deadline', field: 'deadlineAt' };
      if (!row.deadlineAt || at.getTime() > row.deadlineAt.getTime()) return { ok: false as const, error: 'deadline_later', field: 'deadlineAt' };
      set.deadlineAt = at.getTime() < now.getTime() ? now : at;
    }
    if (Object.keys(set).length === 1) return { ok: false as const, error: 'locked' };
    await tx.update(comp).set(set).where(eq(comp.id, id));
    return { ok: true as const };
  });
}

/** 出题: the whole set at once, while it is a draft. */
export async function setQuestions(userId: string, id: string, input: unknown, now = new Date()): Promise<{ ok: true; count: number } | { ok: false; error: string; field?: string }> {
  if (!isUuid(id)) return { ok: false, error: 'not_found' };
  const checked = checkQuestions(input);
  if (!checked.ok) return checked;
  return db().transaction(async (tx) => {
    const row = await ownedForUpdate(tx, userId, id);
    if (!row) return { ok: false as const, error: 'not_found' };
    if (!hostMayEdit(row.status, 'questions')) return { ok: false as const, error: 'locked' };
    await tx.delete(question).where(eq(question.competitionId, id));
    await tx.insert(question).values(checked.value.map((item, index) => ({ competitionId: id, ordinal: index + 1, ...item })));
    await tx.update(comp).set({ updatedAt: now }).where(eq(comp.id, id));
    return { ok: true as const, count: checked.value.length };
  });
}

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'locked' | 'no_questions' | 'no_deadline' | 'deadline_too_soon' | 'deadline_too_late' | 'too_many_active' | 'host_too_new' | 'host_needs_ree' }
  | { ok: false; error: 'insufficient'; balance: number; needed: number };

/**
 * 提交发布 (5.1 step 5, 9.3): the deposit is held -- every place answered
 * and judged -- and the prices fixed; the review then runs
 * (`reviewCompetition`, after the response and from the cron).
 */
export async function submitCompetition(userId: string, id: string, now = new Date()): Promise<SubmitOutcome> {
  if (!isUuid(id)) return { ok: false, error: 'not_found' };
  const account = await hostAccount(userId);
  if (!account) return { ok: false, error: 'not_found' };
  const problem = hostProblem(account, now);
  if (problem) return { ok: false, error: problem };
  const outcome = await db().transaction(async (tx): Promise<SubmitOutcome | { short: number }> => {
    const row = await ownedForUpdate(tx, userId, id);
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== 'draft') return { ok: false, error: 'locked' };
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(question).where(eq(question.competitionId, id));
    if (n === 0) return { ok: false, error: 'no_questions' };
    const late = deadlineProblem(row.deadlineAt, now);
    if (late) return { ok: false, error: late };
    const [{ active } = { active: 0 }] = await tx.select({ active: count() }).from(comp).where(and(eq(comp.hostId, userId), inArray(comp.status, [...COMPETITION_ACTIVE])));
    if (active >= COMPETITION_ACTIVE_PER_HOST) return { ok: false, error: 'too_many_active' };
    const deposit = depositOf(row, n, { answer: COMPETITION_ANSWER_FEE, judge: COMPETITION_JUDGE_FEE });
    let holdId: string;
    try {
      holdId = await placeHold(tx, { userId, kind: 'competition', ledger: 'competition_deposit', amount: deposit, refId: id, note: NOTE, lastingFirst: true }, now);
    } catch (error) {
      if (error instanceof InsufficientCredits) return { short: deposit };
      throw error;
    }
    await tx
      .update(comp)
      .set({ status: 'pending', depositHoldId: holdId, answerFee: COMPETITION_ANSWER_FEE, judgeFee: COMPETITION_JUDGE_FEE, moderationAttempts: 0, rejectedReason: null, submittedAt: now, updatedAt: now })
      .where(eq(comp.id, id));
    return { ok: true };
  });
  if ('short' in outcome) return { ok: false, error: 'insufficient', balance: await balanceOf(db(), userId, now), needed: outcome.short };
  return outcome;
}

/** The text a competition is reviewed by (10): its title and rules, and every question with its detail. Never the references. */
async function reviewText(row: CompetitionRow): Promise<string> {
  const questions = await publicQuestions(row.id);
  return [row.title, row.description, ...questions.map((item) => [`${item.ordinal}. ${item.question}`, item.detail].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
}

/**
 * Its questions as posts in its channel (C3), once they are public: by the
 * host, published and answered as far as the posts' pipeline is concerned
 * (`answer_state` 'done': nothing matches or answers them, 10).
 */
export async function openQuestions(tx: Tx, row: CompetitionRow, now: Date): Promise<number> {
  const waiting = await tx.select(publicQuestionColumns).from(question).where(and(eq(question.competitionId, row.id), isNull(question.postId))).orderBy(asc(question.ordinal));
  for (const item of waiting) {
    const [made] = await tx
      .insert(post)
      .values({ userId: row.hostId, source: 'competition', visibility: 'public', question: item.question, detail: item.detail, lang: row.lang, status: 'published', answerState: 'done', createdAt: now, publishedAt: now, answeredAt: now })
      .returning({ id: post.id });
    if (row.channelId) await fileUnderChannel(tx, made!.id, row.channelId);
    await tx.update(question).set({ postId: made!.id }).where(eq(question.id, item.id));
  }
  return waiting.length;
}

/**
 * The review of a submitted competition (10): its text through the judge
 * public text goes through. Passed: open (an open-book one's questions go
 * up); refused: rejected, the deposit back. A check that cannot run leaves
 * it pending for the cron, and the last attempt refuses it.
 */
export async function reviewCompetition(id: string, judge: Judge = modelJudge, now = new Date()): Promise<'open' | 'rejected' | 'pending' | 'gone'> {
  const [claimed] = await db()
    .update(comp)
    .set({ moderationAttempts: sql`${comp.moderationAttempts} + 1` })
    .where(and(eq(comp.id, id), eq(comp.status, 'pending'), lt(comp.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS)))
    .returning();
  if (!claimed) return 'gone';
  let verdict: { publish: boolean; reason?: string } | null = null;
  try {
    verdict = await judge(await reviewText(claimed), '');
  } catch (error) {
    console.warn(`competition ${id} review failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (!verdict && claimed.moderationAttempts < PUBLIC_QA_MODERATION_ATTEMPTS) return 'pending';
  const passed = verdict?.publish === true;
  return db().transaction(async (tx) => {
    const [row] = await tx.select().from(comp).where(and(eq(comp.id, id), eq(comp.status, 'pending'))).for('update');
    if (!row) return 'gone' as const;
    if (passed) {
      await tx.update(comp).set({ status: 'open', openedAt: now, updatedAt: now }).where(eq(comp.id, id));
      if (row.questionMode === 'open') await openQuestions(tx, row, now);
    } else {
      if (row.depositHoldId) await releaseHold(tx, row.depositHoldId, { note: NOTE, ledger: 'competition_deposit' }, now);
      await tx.update(comp).set({ status: 'rejected', rejectedReason: (verdict?.reason ?? 'review_failed').slice(0, COMPETITION_REASON_MAX), updatedAt: now }).where(eq(comp.id, id));
    }
    await notify(tx, { userId: row.hostId, kind: 'competition_published', params: { title: row.title, slug: row.slug, ok: passed ? 1 : 0 }, refId: id });
    return passed ? ('open' as const) : ('rejected' as const);
  });
}

/** Gives back every hold of the competition still open: the deposit, the judge's, each entry's. */
async function releaseAll(tx: Tx, row: CompetitionRow, now: Date): Promise<void> {
  if (row.depositHoldId) await releaseHold(tx, row.depositHoldId, { note: NOTE, ledger: 'competition_deposit' }, now);
  if (row.judgeHoldId) await releaseHold(tx, row.judgeHoldId, { note: NOTE, ledger: 'competition_judge' }, now);
  const held = await tx.select({ holdId: entry.holdId, reeId: entry.reeId }).from(entry).where(and(eq(entry.competitionId, row.id), isNotNull(entry.holdId)));
  for (const item of held) await releaseHold(tx, item.holdId!, { note: NOTE, ledger: 'competition_answer', reeId: item.reeId }, now);
}

/** A cancelled competition's question posts leave the site (its channel stays, with any discussion in it). */
async function hideQuestionPosts(tx: Tx, competitionId: string): Promise<void> {
  await tx
    .update(post)
    .set({ status: 'hidden', hiddenBy: 'admin' })
    .where(and(eq(post.source, 'competition'), sql`${post.id} in (select ${question.postId} from ${question} where ${question.competitionId} = ${competitionId})`));
}

async function cancelIn(tx: Tx, row: CompetitionRow, now: Date, reason: string | null): Promise<void> {
  await releaseAll(tx, row, now);
  await tx.update(comp).set({ status: 'cancelled', cancelledAt: now, cancelledReason: reason, updatedAt: now }).where(eq(comp.id, row.id));
  await tx.update(answer).set({ state: 'failed', judgeState: null }).where(and(eq(answer.competitionId, row.id), inArray(answer.state, ['queued', 'answering'])));
  await hideQuestionPosts(tx, row.id);
}

/** 取消 by its host (6.1): a draft, one in review, or an open one nobody entered; the deposit back. */
export async function cancelCompetition(userId: string, id: string, now = new Date()): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'locked' }> {
  if (!isUuid(id)) return { ok: false, error: 'not_found' };
  return db().transaction(async (tx) => {
    const row = await ownedForUpdate(tx, userId, id);
    if (!row) return { ok: false as const, error: 'not_found' as const };
    if (!hostMayCancel(row.status, row.entryCount)) return { ok: false as const, error: 'locked' as const };
    await cancelIn(tx, row, now, 'host');
    return { ok: true as const };
  });
}

/* --------------------------------------------------------------- entries */

export type EntryOutcome =
  | { ok: true; entryId: string }
  | { ok: false; error: 'not_found' | 'closed' | 'own_competition' | 'not_your_ree' | 'ree_not_ready' | 'full' | 'per_user_limit' | 'already' | 'daily_limit' }
  | { ok: false; error: 'insufficient'; balance: number; needed: number };

/**
 * 提交我的 Ree (5.2): the owner's own public Ree with ready knowledge, once
 * per competition, never in the host's own competition, within the places
 * and the per-person limit. Nothing is charged now: an entrant who pays is
 * only checked for the balance, and held at the deadline (9.3).
 */
export async function enterCompetition(userId: string, id: string, reeId: string, now = new Date()): Promise<EntryOutcome> {
  if (!isUuid(id) || !isUuid(reeId)) return { ok: false, error: 'not_found' };
  const [target] = await db().select().from(comp).where(and(eq(comp.id, id), isNull(comp.hiddenBy))).limit(1);
  if (!target) return { ok: false, error: 'not_found' };
  if (target.status !== 'open' || !target.deadlineAt || target.deadlineAt.getTime() <= now.getTime()) return { ok: false, error: 'closed' };
  if (target.hostId === userId) return { ok: false, error: 'own_competition' };
  const [mine] = await db().select({ id: ree.id }).from(ree).where(and(eq(ree.id, reeId), eq(ree.ownerId, userId), publicRee())).limit(1);
  if (!mine) return { ok: false, error: 'not_your_ree' };
  if (!(await readyRees([reeId])).has(reeId)) return { ok: false, error: 'ree_not_ready' };
  const [{ n: questions } = { n: 0 }] = await db().select({ n: count() }).from(question).where(eq(question.competitionId, id));
  const needed = questions * (target.answerFee ?? COMPETITION_ANSWER_FEE);
  if (target.payer === 'entrant') {
    const balance = await balanceOf(db(), userId, now);
    if (balance < needed) return { ok: false, error: 'insufficient', balance, needed };
  }
  if (!(await hitRateBucket(`competition-entry:${userId}`, COMPETITION_ENTRIES_PER_DAY, 86_400, now))) return { ok: false, error: 'daily_limit' };
  return db().transaction(async (tx) => {
    const [row] = await tx.select().from(comp).where(eq(comp.id, id)).for('update');
    if (!row || row.status !== 'open' || !row.deadlineAt || row.deadlineAt.getTime() <= now.getTime()) return { ok: false as const, error: 'closed' as const };
    const [existing] = await tx.select().from(entry).where(and(eq(entry.competitionId, id), eq(entry.reeId, reeId))).limit(1);
    if (existing && existing.status !== 'withdrawn') return { ok: false as const, error: 'already' as const };
    if (row.entryCount >= row.maxEntries) return { ok: false as const, error: 'full' as const };
    const [{ n: mineIn } = { n: 0 }] = await tx.select({ n: count() }).from(entry).where(and(eq(entry.competitionId, id), eq(entry.userId, userId), eq(entry.status, 'entered')));
    if (mineIn >= row.maxEntriesPerUser) return { ok: false as const, error: 'per_user_limit' as const };
    const entryId = existing
      ? (await tx.update(entry).set({ status: 'entered', userId, withdrawnAt: null, remindedAt: null, createdAt: now }).where(eq(entry.id, existing.id)).returning({ id: entry.id }))[0]!.id
      : (await tx.insert(entry).values({ competitionId: id, reeId, userId, createdAt: now }).returning({ id: entry.id }))[0]!.id;
    await tx.update(comp).set({ entryCount: sql`${comp.entryCount} + 1`, updatedAt: now }).where(eq(comp.id, id));
    return { ok: true as const, entryId };
  });
}

/** 撤回 before the deadline: nothing was charged; the place goes back. */
export async function withdrawEntry(userId: string, entryId: string, now = new Date()): Promise<boolean> {
  if (!isUuid(entryId)) return false;
  return db().transaction(async (tx) => {
    const [mine] = await tx.select().from(entry).where(and(eq(entry.id, entryId), eq(entry.userId, userId), eq(entry.status, 'entered'))).limit(1);
    if (!mine) return false;
    const [row] = await tx.select().from(comp).where(eq(comp.id, mine.competitionId)).for('update');
    if (!row || row.status !== 'open' || !row.deadlineAt || row.deadlineAt.getTime() <= now.getTime()) return false;
    const moved = await tx.update(entry).set({ status: 'withdrawn', withdrawnAt: now }).where(and(eq(entry.id, entryId), eq(entry.status, 'entered'))).returning({ id: entry.id });
    if (moved.length === 0) return false;
    await tx.update(comp).set({ entryCount: sql`greatest(${comp.entryCount} - 1, 0)`, updatedAt: now }).where(eq(comp.id, row.id));
    return true;
  });
}

/* ------------------------------------------------------------- the page */

export interface CompetitionCard {
  id: string;
  slug: string;
  title: string;
  status: CompetitionStatus;
  lang: 'zh' | 'en';
  questionMode: QuestionMode;
  deadlineAt: string | null;
  publishedAt: string | null;
  entries: number;
  maxEntries: number;
  questions: number;
  hostName: string | null;
}

export interface EntrySummary {
  id: string;
  reeId: string;
  reeName: string;
  status: string;
  mine: boolean;
}

export interface LeaderRow {
  entryId: string;
  reeId: string;
  reeName: string;
  rank: number | null;
  total: number | null;
  answered: number;
  /** Final scores by question ordinal; null for an answer not public (refused review, hidden). */
  scores: { ordinal: number; score: number; overridden: boolean }[];
  disqualified: boolean;
}

export interface CompetitionPage extends CompetitionCard {
  description: string;
  payer: CompetitionPayer;
  weights: CompetitionWeights;
  revealReference: boolean;
  reviewHours: number;
  reviewEndsAt: string | null;
  answerFee: number;
  judgeFee: number;
  channel: string | null;
  hostId: string;
  isHost: boolean;
  hidden: boolean;
  /** Null while the questions are not public (a closed-book competition before its deadline). */
  questionList: PublicQuestion[] | null;
  entryList: EntrySummary[];
  /** During answering, judging and review: how far along it is. */
  progress: { total: number; answered: number; judged: number } | null;
  leaderboard: LeaderRow[] | null;
  answerModel: string | null;
  judgeModel: string | null;
}

const cardColumns = {
  row: comp,
  hostName: user.name,
  questions: sql<number>`(select count(*)::int from ${question} where ${question.competitionId} = ${comp.id})`,
};

function cardOf(row: CompetitionRow, hostName: string | null, questions: number): CompetitionCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    lang: row.lang,
    questionMode: row.questionMode,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    entries: row.entryCount,
    maxEntries: row.maxEntries,
    questions,
    hostName,
  };
}

/** What the public may read of a competition: listed and not taken down. */
function listed(): SQL {
  return and(inArray(comp.status, [...COMPETITION_LISTED]), isNull(comp.hiddenBy))!;
}

export type CompetitionTab = 'active' | 'published';

/** `/competitions`: open and running ones (the nearest deadline first), or results (newest first). */
export async function listCompetitions(tab: CompetitionTab, options: { cursor?: string | null; size?: number } = {}): Promise<{ items: CompetitionCard[]; next: string | null }> {
  const size = options.size ?? 30;
  const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
  const where = tab === 'published' ? and(listed(), eq(comp.status, 'published')) : and(listed(), ne(comp.status, 'published'));
  const order = tab === 'published' ? [desc(comp.publishedAt), desc(comp.id)] : [asc(comp.deadlineAt), asc(comp.id)];
  const rows = await db().select(cardColumns).from(comp).innerJoin(user, eq(user.id, comp.hostId)).where(where).orderBy(...order).limit(size + 1).offset(offset);
  return { items: rows.slice(0, size).map((item) => cardOf(item.row, item.hostName, item.questions)), next: rows.length > size ? String(offset + size) : null };
}

/** The live competition by this slug (a cancelled one only when nothing live has its name). */
async function bySlug(slug: string): Promise<{ row: CompetitionRow; hostName: string | null; questions: number } | null> {
  const [found] = await db()
    .select(cardColumns)
    .from(comp)
    .innerJoin(user, eq(user.id, comp.hostId))
    .where(eq(comp.slug, slug.normalize('NFKC').toLowerCase()))
    .orderBy(sql`case when ${comp.status} in ('cancelled', 'rejected') then 1 else 0 end`, desc(comp.createdAt))
    .limit(1);
  return found ?? null;
}

/** The competition bound to this channel, for the channel page's header (C4). */
export async function competitionOfChannel(channelId: string): Promise<CompetitionCard | null> {
  const [found] = await db().select(cardColumns).from(comp).innerJoin(user, eq(user.id, comp.hostId)).where(and(eq(comp.channelId, channelId), listed())).limit(1);
  return found ? cardOf(found.row, found.hostName, found.questions) : null;
}

/** The competition a question post belongs to, for the post page's banner: its slug, title, state and the question's number. */
export async function competitionOfPost(postId: string): Promise<{ slug: string; title: string; status: CompetitionStatus; ordinal: number } | null> {
  if (!isUuid(postId)) return null;
  const [found] = await db()
    .select({ slug: comp.slug, title: comp.title, status: comp.status, ordinal: question.ordinal })
    .from(question)
    .innerJoin(comp, eq(comp.id, question.competitionId))
    .where(and(eq(question.postId, postId), isNull(comp.hiddenBy)))
    .limit(1);
  return found ?? null;
}

async function entriesOf(competitionId: string, viewerId: string | undefined, statuses: readonly EntryStatus[]): Promise<EntrySummary[]> {
  const rows = await db()
    .select({ id: entry.id, reeId: entry.reeId, reeName: ree.name, status: entry.status, userId: entry.userId })
    .from(entry)
    .innerJoin(ree, eq(ree.id, entry.reeId))
    .where(and(eq(entry.competitionId, competitionId), inArray(entry.status, [...statuses])))
    .orderBy(asc(entry.createdAt));
  return rows.map((row) => ({ id: row.id, reeId: row.reeId, reeName: row.reeName, status: row.status, mine: row.userId === viewerId }));
}

async function progressOf(competitionId: string): Promise<{ total: number; answered: number; judged: number }> {
  const [row] = await db()
    .select({
      total: count(),
      answered: sql<number>`count(*) filter (where ${answer.state} not in ('queued', 'answering'))::int`,
      judged: sql<number>`count(*) filter (where ${answer.state} <> 'answered' or ${answer.judgeState} in ('done', 'failed') or ${answer.review} = 'rejected')::int`,
    })
    .from(answer)
    .where(eq(answer.competitionId, competitionId));
  return { total: row?.total ?? 0, answered: row?.answered ?? 0, judged: row?.judged ?? 0 };
}

/** The published leaderboard (8.3): ranked entries first, then disqualified ones, with each question's final score. */
export async function leaderboardOf(competitionId: string): Promise<LeaderRow[]> {
  const entries = await db()
    .select({ id: entry.id, reeId: entry.reeId, reeName: ree.name, rank: entry.rank, total: entry.totalScore, answered: entry.answered, status: entry.status })
    .from(entry)
    .innerJoin(ree, eq(ree.id, entry.reeId))
    .where(and(eq(entry.competitionId, competitionId), inArray(entry.status, ['locked', 'disqualified'])))
    .orderBy(sql`${entry.rank} asc nulls last`, desc(entry.totalScore), asc(ree.name));
  const scores = await db()
    .select({ entryId: answer.entryId, ordinal: question.ordinal, final: answer.finalScore, host: answer.hostScore })
    .from(answer)
    .innerJoin(question, eq(question.id, answer.questionId))
    .where(eq(answer.competitionId, competitionId));
  const byEntry = new Map<string, LeaderRow['scores']>();
  for (const item of scores) byEntry.set(item.entryId, [...(byEntry.get(item.entryId) ?? []), { ordinal: item.ordinal, score: item.final ?? 0, overridden: item.host !== null }]);
  return entries
    .filter((item) => item.status === 'locked' || item.status === 'disqualified')
    .map((item) => ({ entryId: item.id, reeId: item.reeId, reeName: item.reeName, rank: item.status === 'locked' ? item.rank : null, total: item.status === 'locked' ? item.total : null, answered: item.answered, scores: (byEntry.get(item.id) ?? []).sort((a, b) => a.ordinal - b.ordinal), disqualified: item.status === 'disqualified' }));
}

/**
 * `/competitions/[slug]`: what this viewer may read (5.3, 13.3). The host
 * reads their own in any state; everyone else a listed one, not taken
 * down. Questions once public; progress while running; the leaderboard
 * once published, with the references when it reveals them.
 */
export async function getCompetition(slug: string, viewerId?: string): Promise<CompetitionPage | null> {
  const found = await bySlug(slug);
  if (!found) return null;
  const { row } = found;
  const isHost = row.hostId === viewerId;
  const shown = (COMPETITION_LISTED as readonly string[]).includes(row.status) && !row.hiddenBy;
  if (!isHost && !shown && row.status !== 'cancelled') return null;
  const published = row.status === 'published';
  const running = (COMPETITION_RUNNING as readonly string[]).includes(row.status);
  let questionList: PublicQuestion[] | null = questionsPublic(row) || isHost ? await publicQuestions(row.id) : null;
  if (questionList && published && row.revealReference) {
    const references = new Map((await db().select({ id: question.id, referenceAnswer: question.referenceAnswer }).from(question).where(eq(question.competitionId, row.id))).map((item) => [item.id, item.referenceAnswer]));
    questionList = questionList.map((item) => ({ ...item, referenceAnswer: references.get(item.id) }));
  }
  const cancelled = row.status === 'cancelled' && !isHost;
  return {
    ...cardOf(row, found.hostName, found.questions),
    description: cancelled ? '' : row.description,
    payer: row.payer,
    weights: row.weights,
    revealReference: row.revealReference,
    reviewHours: row.reviewHours,
    reviewEndsAt: row.reviewEndsAt?.toISOString() ?? null,
    answerFee: row.answerFee ?? COMPETITION_ANSWER_FEE,
    judgeFee: row.judgeFee ?? COMPETITION_JUDGE_FEE,
    channel: row.channelId ? row.slug : null,
    hostId: row.hostId,
    isHost,
    hidden: Boolean(row.hiddenBy),
    questionList: cancelled ? null : questionList,
    entryList: cancelled ? [] : await entriesOf(row.id, viewerId, running || published ? ['locked', 'disqualified'] : ['entered']),
    progress: running ? await progressOf(row.id) : null,
    leaderboard: published && !row.hiddenBy ? await leaderboardOf(row.id) : null,
    answerModel: published ? row.answerModel : null,
    judgeModel: published ? row.judgeModel : null,
  };
}

/* ---------------------------------------------------------- answer sheets */

export interface SheetAnswer {
  id: string;
  ordinal: number;
  question: string;
  state: string;
  text: string;
  citations: CitationSnapshot[];
  model: string | null;
  /** The rest only once published. */
  review: string | null;
  dimensions: { accuracy: number; completeness: number; citation: number } | null;
  aiScore: number | null;
  hostScore: number | null;
  finalScore: number | null;
  rationale: string | null;
  injection: boolean;
  /** Hidden after the results: by reports or its Ree's owner (the copied `post_answer`). */
  hidden: boolean;
  log: { actor: string; from: number | null; to: number; note: string; at: string }[];
  postId: string | null;
}

export interface EntrySheet {
  competition: { id: string; slug: string; title: string; status: CompetitionStatus };
  entry: { id: string; reeId: string; reeName: string; status: string; rank: number | null; total: number | null; answered: number; mine: boolean };
  answers: SheetAnswer[];
  /** Scores are shown (published); otherwise the entrant reads their own answers only. */
  scored: boolean;
}

const mean = (values: number[]) => (values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : 0);

/**
 * `/competitions/[slug]/entries/[entryId]`: one Ree's answers. Anyone once
 * published (an answer that failed review shows to its entrant alone);
 * before that its entrant alone, locked, without scores (5.2).
 */
export async function entrySheet(slug: string, entryId: string, viewerId?: string): Promise<EntrySheet | null> {
  if (!isUuid(entryId)) return null;
  const found = await bySlug(slug);
  if (!found || found.row.hiddenBy) return null;
  const row = found.row;
  const [item] = await db()
    .select({ entry, reeName: ree.name })
    .from(entry)
    .innerJoin(ree, eq(ree.id, entry.reeId))
    .where(and(eq(entry.id, entryId), eq(entry.competitionId, row.id), inArray(entry.status, ['locked', 'disqualified'])))
    .limit(1);
  if (!item) return null;
  const mine = item.entry.userId === viewerId;
  const published = row.status === 'published';
  if (!published && !(mine && (COMPETITION_RUNNING as readonly string[]).includes(row.status))) return null;
  const rows = await db()
    .select({ answer, ordinal: question.ordinal, question: question.question, postId: question.postId, hiddenBy: postAnswer.hiddenBy })
    .from(answer)
    .innerJoin(question, eq(question.id, answer.questionId))
    .leftJoin(postAnswer, eq(postAnswer.id, answer.postAnswerId))
    .where(eq(answer.entryId, entryId))
    .orderBy(asc(question.ordinal));
  const logs = published && rows.length
    ? await db().select().from(scoreLog).where(inArray(scoreLog.answerId, rows.map((r) => r.answer.id))).orderBy(asc(scoreLog.createdAt))
    : [];
  return {
    competition: { id: row.id, slug: row.slug, title: row.title, status: row.status },
    entry: { id: item.entry.id, reeId: item.entry.reeId, reeName: item.reeName, status: item.entry.status, rank: published ? item.entry.rank : null, total: published ? item.entry.totalScore : null, answered: item.entry.answered, mine },
    scored: published,
    answers: rows.map(({ answer: a, ordinal, question: asked, postId, hiddenBy }) => {
      const hidden = published && (Boolean(hiddenBy) || (a.review === 'rejected' && !mine));
      const runs = a.aiScores;
      return {
        id: a.id,
        ordinal,
        question: asked,
        state: a.state,
        text: hidden ? '' : a.text,
        citations: hidden ? [] : a.citations,
        model: a.model,
        review: published ? a.review : null,
        dimensions: published && runs.length ? { accuracy: mean(runs.map((run) => run.accuracy)), completeness: mean(runs.map((run) => run.completeness)), citation: mean(runs.map((run) => run.citation)) } : null,
        aiScore: published ? a.aiScore : null,
        hostScore: published ? a.hostScore : null,
        finalScore: published ? a.finalScore : null,
        rationale: published ? a.rationale : null,
        injection: published ? a.injection : false,
        hidden,
        log: logs.filter((log) => log.answerId === a.id).map((log) => ({ actor: log.actor, from: log.fromScore, to: log.toScore, note: log.note, at: log.createdAt.toISOString() })),
        postId,
      };
    }),
  };
}

/* ---------------------------------------------------------- the host's */

export interface HostQuestion extends PublicQuestion {
  referenceAnswer: string;
  rubric: string;
}

export interface HostCompetition {
  row: Omit<CompetitionRow, 'depositHoldId' | 'judgeHoldId'>;
  questions: HostQuestion[];
  entries: EntrySummary[];
  deposit: number;
}

/** The host's management view of their own competition, references and rubrics included (7.1). */
export async function hostCompetition(userId: string, id: string): Promise<HostCompetition | null> {
  if (!isUuid(id)) return null;
  const [row] = await db().select().from(comp).where(and(eq(comp.id, id), eq(comp.hostId, userId))).limit(1);
  if (!row) return null;
  const questions = await secretQuestions(db(), id);
  const { depositHoldId: _deposit, judgeHoldId: _judge, ...rest } = row;
  return {
    row: rest,
    questions: questions.map((item) => ({ id: item.id, ordinal: item.ordinal, question: item.question, detail: item.detail, weight: item.weight, postId: item.postId, referenceAnswer: item.referenceAnswer, rubric: item.rubric })),
    entries: await entriesOf(id, undefined, ['entered', 'locked', 'skipped_balance', 'disqualified', 'withdrawn']),
    deposit: depositOf(row, questions.length),
  };
}

/** `/workspace/competitions`: what the user hosts, and the competitions their Rees entered. */
export async function myCompetitions(userId: string): Promise<{ hosted: CompetitionCard[]; entered: (CompetitionCard & { entryId: string; reeName: string; entryStatus: string; rank: number | null })[] }> {
  const hosted = await db().select(cardColumns).from(comp).innerJoin(user, eq(user.id, comp.hostId)).where(eq(comp.hostId, userId)).orderBy(desc(comp.createdAt)).limit(100);
  const entered = await db()
    .select({ ...cardColumns, entryId: entry.id, reeName: ree.name, entryStatus: entry.status, rank: entry.rank })
    .from(entry)
    .innerJoin(comp, eq(comp.id, entry.competitionId))
    .innerJoin(user, eq(user.id, comp.hostId))
    .innerJoin(ree, eq(ree.id, entry.reeId))
    .where(and(eq(entry.userId, userId), ne(entry.status, 'withdrawn')))
    .orderBy(desc(entry.createdAt))
    .limit(100);
  return {
    hosted: hosted.map((item) => cardOf(item.row, item.hostName, item.questions)),
    entered: entered.map((item) => ({ ...cardOf(item.row, item.hostName, item.questions), entryId: item.entryId, reeName: item.reeName, entryStatus: item.entryStatus, rank: item.row.status === 'published' ? item.rank : null })),
  };
}

export interface ReviewAnswer {
  id: string;
  entryId: string;
  reeName: string;
  ordinal: number;
  question: string;
  state: string;
  text: string;
  citations: CitationSnapshot[];
  review: string | null;
  judgeState: string | null;
  runs: { accuracy: number; completeness: number; citation: number; injection: boolean; rationale: string }[];
  aiScore: number | null;
  hostScore: number | null;
  rationale: string | null;
  injection: boolean;
}

/** 复核 (5.1 step 8): every answer with its AI scores and rationale, by question then Ree; the host's alone, while in review. */
export async function hostReview(userId: string, id: string): Promise<{ competition: CompetitionRow; answers: ReviewAnswer[] } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db().select().from(comp).where(and(eq(comp.id, id), eq(comp.hostId, userId))).limit(1);
  if (!row || row.status !== 'review') return null;
  const rows = await db()
    .select({ answer, reeName: ree.name, ordinal: question.ordinal, question: question.question })
    .from(answer)
    .innerJoin(question, eq(question.id, answer.questionId))
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .innerJoin(entry, eq(entry.id, answer.entryId))
    .where(and(eq(answer.competitionId, id), eq(entry.status, 'locked')))
    .orderBy(asc(question.ordinal), asc(ree.name));
  return {
    competition: row,
    answers: rows.map(({ answer: a, reeName, ordinal, question: asked }) => ({
      id: a.id,
      entryId: a.entryId,
      reeName,
      ordinal,
      question: asked,
      state: a.state,
      text: a.text,
      citations: a.citations,
      review: a.review,
      judgeState: a.judgeState,
      runs: a.aiScores.map(({ accuracy, completeness, citation, injection, rationale }) => ({ accuracy, completeness, citation, injection, rationale })),
      aiScore: a.aiScore,
      hostScore: a.hostScore,
      rationale: a.rationale,
      injection: a.injection,
    })),
  };
}

export type ScoreOutcome = { ok: true; score: number } | { ok: false; error: 'not_found' | 'locked' | 'invalid_score' | 'invalid_note' | 'rate_limited' | 'not_answered' };

function checkScore(score: unknown, note: unknown): { score: number; note: string } | 'invalid_score' | 'invalid_note' {
  const value = typeof score === 'number' ? score : typeof score === 'string' && score.trim() ? Number(score) : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 10) return 'invalid_score';
  const why = typeof note === 'string' ? note.trim() : '';
  if (!why || [...why].length > COMPETITION_SCORE_NOTE_MAX) return 'invalid_note';
  return { score: Math.round(value * 10) / 10, note: why };
}

/** The override and its log row, in one transaction (12.5). */
async function writeScore(tx: Tx, answerId: string, actor: 'host' | 'admin', actorId: string, score: number, note: string, now: Date, from: number | null): Promise<void> {
  await tx.insert(scoreLog).values({ answerId, actor, actorId, fromScore: from, toScore: score, note, createdAt: now });
  await tx.update(answer).set({ hostScore: score }).where(eq(answer.id, answerId));
}

/** 改分 (7.5): the host, during review, with a reason; logged. An answer that was not given (or failed review) has nothing to score. */
export async function setHostScore(userId: string, answerId: string, input: { score: unknown; note: unknown }, now = new Date()): Promise<ScoreOutcome> {
  if (!isUuid(answerId)) return { ok: false, error: 'not_found' };
  const checked = checkScore(input.score, input.note);
  if (typeof checked === 'string') return { ok: false, error: checked };
  const [target] = await db()
    .select({ answer, hostId: comp.hostId, status: comp.status })
    .from(answer)
    .innerJoin(comp, eq(comp.id, answer.competitionId))
    .where(eq(answer.id, answerId))
    .limit(1);
  if (!target || target.hostId !== userId) return { ok: false, error: 'not_found' };
  if (target.status !== 'review') return { ok: false, error: 'locked' };
  if (target.answer.state !== 'answered' || target.answer.review === 'rejected') return { ok: false, error: 'not_answered' };
  if (!(await hitRateBucket(`competition-score:${target.answer.competitionId}`, COMPETITION_SCORE_EDITS_PER_MINUTE, 60, now))) return { ok: false, error: 'rate_limited' };
  return db().transaction(async (tx) => {
    const [row] = await tx.select({ status: comp.status }).from(comp).where(eq(comp.id, target.answer.competitionId)).for('update');
    if (row?.status !== 'review') return { ok: false as const, error: 'locked' as const };
    const [current] = await tx.select({ host: answer.hostScore, ai: answer.aiScore }).from(answer).where(eq(answer.id, answerId)).for('update');
    await writeScore(tx, answerId, 'host', userId, checked.score, checked.note, now, current?.host ?? current?.ai ?? null);
    return { ok: true as const, score: checked.score };
  });
}

/* ------------------------------------------------------------- results */

interface TotalRow {
  entryId: string;
  reeName: string;
  answers: { final: number; weight: number; accuracy: number; answered: boolean }[];
}

/** Final scores onto every answer and totals and ranks onto every locked entry (8.3); returns the ranked entries. */
export async function writeTotals(tx: Tx, competitionId: string): Promise<{ entryId: string; rank: number; total: number }[]> {
  const rows = await tx
    .select({ answer, weight: question.weight, reeName: ree.name, entryStatus: entry.status })
    .from(answer)
    .innerJoin(question, eq(question.id, answer.questionId))
    .innerJoin(entry, eq(entry.id, answer.entryId))
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(eq(answer.competitionId, competitionId));
  const byEntry = new Map<string, TotalRow>();
  for (const { answer: a, weight, reeName, entryStatus } of rows) {
    const final = finalScore(a);
    await tx.update(answer).set({ finalScore: final }).where(eq(answer.id, a.id));
    if (entryStatus !== 'locked') continue;
    const accuracy = a.aiScores.length ? a.aiScores.reduce((sum, run) => sum + run.accuracy, 0) / a.aiScores.length : 0;
    const item = byEntry.get(a.entryId) ?? { entryId: a.entryId, reeName, answers: [] };
    item.answers.push({ final, weight, accuracy, answered: a.state === 'answered' });
    byEntry.set(a.entryId, item);
  }
  const ranked = rankEntries(
    [...byEntry.values()].map((item) => ({
      id: item.entryId,
      total: entryTotal(item.answers),
      answered: item.answers.filter((a) => a.answered).length,
      accuracy: item.answers.reduce((sum, a) => sum + a.accuracy, 0),
      name: item.reeName,
    })),
  );
  for (const item of ranked) await tx.update(entry).set({ totalScore: item.total, rank: item.rank }).where(eq(entry.id, item.id));
  return ranked.map((item) => ({ entryId: item.id, rank: item.rank, total: item.total }));
}

/**
 * 公布 (6.1, 9.3): by the host during review, or by the cron when review
 * ends. In one transaction: entries whose Ree is no longer public are
 * disqualified; final scores, totals and ranks written; every answer hold
 * settled for what was answered and the judge's for what was judged; the
 * passed answers copied onto their question posts as `post_answer` (so
 * votes, reports and the Ree page work on them); each entrant told.
 */
export async function publishCompetition(id: string, now = new Date(), by: { hostId?: string } = {}): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [row] = await tx.select().from(comp).where(and(eq(comp.id, id), eq(comp.status, 'review'), by.hostId ? eq(comp.hostId, by.hostId) : undefined)).for('update');
    if (!row) return false;
    const gone = await tx
      .select({ id: entry.id })
      .from(entry)
      .innerJoin(ree, eq(ree.id, entry.reeId))
      .where(and(eq(entry.competitionId, id), eq(entry.status, 'locked'), sql`not (${publicRee()})`));
    if (gone.length) await tx.update(entry).set({ status: 'disqualified', disqualifiedReason: 'ree_unavailable' }).where(inArray(entry.id, gone.map((item) => item.id)));
    const ranked = await writeTotals(tx, id);
    const entries = await tx.select().from(entry).where(and(eq(entry.competitionId, id), inArray(entry.status, ['locked', 'disqualified'])));
    const answerFee = row.answerFee ?? COMPETITION_ANSWER_FEE;
    for (const item of entries) {
      if (!item.holdId) continue;
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(answer).where(and(eq(answer.entryId, item.id), eq(answer.state, 'answered')));
      await settleHold(tx, item.holdId, n * answerFee, { note: NOTE, ledger: 'competition_answer', reeId: item.reeId }, now);
    }
    if (row.judgeHoldId) {
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(answer).where(and(eq(answer.competitionId, id), eq(answer.judgeState, 'done')));
      await settleHold(tx, row.judgeHoldId, n * (row.judgeFee ?? COMPETITION_JUDGE_FEE), { note: NOTE, ledger: 'competition_judge' }, now);
    }
    const passed = await tx
      .select({ id: answer.id, reeId: answer.reeId, text: answer.text, citations: answer.citations, model: answer.model, answeredAt: answer.answeredAt, postId: question.postId })
      .from(answer)
      .innerJoin(question, eq(question.id, answer.questionId))
      .innerJoin(entry, eq(entry.id, answer.entryId))
      .where(and(eq(answer.competitionId, id), eq(answer.state, 'answered'), eq(answer.review, 'passed'), eq(entry.status, 'locked'), isNotNull(question.postId)));
    for (const item of passed) {
      const [copied] = await tx
        .insert(postAnswer)
        .values({ postId: item.postId!, reeId: item.reeId, state: 'answered', text: item.text, citations: item.citations, model: item.model, createdAt: now, answeredAt: item.answeredAt ?? now })
        .onConflictDoNothing()
        .returning({ id: postAnswer.id });
      if (copied) await tx.update(answer).set({ postAnswerId: copied.id }).where(eq(answer.id, item.id));
    }
    await tx
      .update(post)
      .set({ answerCount: sql`(select count(*)::int from ${postAnswer} a where a.post_id = ${post.id} and a.followup_id is null and a.state = 'answered' and a.hidden_by is null)`, answeredAt: now })
      .where(sql`${post.id} in (select ${question.postId} from ${question} where ${question.competitionId} = ${id})`);
    await tx.update(comp).set({ status: 'published', publishedAt: now, updatedAt: now }).where(eq(comp.id, id));
    const rankOf = new Map(ranked.map((item) => [item.entryId, item]));
    const names = new Map((await tx.select({ id: ree.id, name: ree.name }).from(ree).where(inArray(ree.id, entries.length ? entries.map((item) => item.reeId) : [crypto.randomUUID()]))).map((item) => [item.id, item.name]));
    for (const item of entries) {
      const placed = rankOf.get(item.id);
      await notify(tx, { userId: item.userId, kind: 'competition_results', params: { title: row.title, slug: row.slug, ree: names.get(item.reeId) ?? '', rank: placed?.rank ?? null, total: placed?.total ?? null, entries: ranked.length }, refId: id });
    }
    return true;
  });
}

/* -------------------------------------------------------------- reports */

/** "举报" a listed competition: once per reporter. The console reviews them; nothing is taken down by count alone. */
export async function reportCompetition(id: string, reporter: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [target] = await tx.select({ id: comp.id }).from(comp).where(and(eq(comp.id, id), listed())).for('update');
    if (!target) return false;
    const added = await tx.insert(report).values({ competitionId: id, reporterKey: reporter }).onConflictDoNothing().returning({ id: report.competitionId });
    if (added.length) await tx.update(comp).set({ reportCount: sql`${comp.reportCount} + 1` }).where(eq(comp.id, id));
    return true;
  });
}

/* -------------------------------------------------------------- console */

export const ADMIN_COMPETITION_VIEWS = ['active', 'reported', 'big_changes', 'all'] as const;
export type AdminCompetitionView = (typeof ADMIN_COMPETITION_VIEWS)[number];

export interface AdminCompetition extends CompetitionCard {
  hostId: string;
  reports: number;
  bigChanges: number;
  hidden: boolean;
  createdAt: string;
}

const bigChanges = sql<number>`(select count(*)::int from ${scoreLog} l join ${answer} a on a.id = l.answer_id where a.competition_id = ${comp.id} and abs(l.to_score - coalesce(l.from_score, 0)) > ${COMPETITION_BIG_CHANGE})`;

/** `/admin/competitions`: by view, newest first; searched by title or slug. */
export async function adminCompetitions(options: { view?: AdminCompetitionView; q?: string | null; limit?: number } = {}): Promise<AdminCompetition[]> {
  const view = options.view ?? 'all';
  const q = (options.q ?? '').trim().slice(0, 80);
  const where = and(
    view === 'active' ? inArray(comp.status, [...COMPETITION_ACTIVE]) : view === 'reported' ? gte(comp.reportCount, 1) : view === 'big_changes' ? sql`${bigChanges} > 0` : undefined,
    q ? or(sql`${comp.title} ilike ${`%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}`, eq(comp.slug, q.toLowerCase())) : undefined,
  );
  const rows = await db()
    .select({ ...cardColumns, bigChanges })
    .from(comp)
    .innerJoin(user, eq(user.id, comp.hostId))
    .where(where)
    .orderBy(desc(comp.createdAt))
    .limit(options.limit ?? 100);
  return rows.map((item) => ({ ...cardOf(item.row, item.hostName, item.questions), hostId: item.row.hostId, reports: item.row.reportCount, bigChanges: item.bigChanges, hidden: Boolean(item.row.hiddenBy), createdAt: item.row.createdAt.toISOString() }));
}

/** 下架 before results (6.1): cancelled, every open hold given back, the model costs already spent the platform's. Logged. */
export async function adminCancelCompetition(administratorId: string, id: string, reason: string, now = new Date()): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [row] = await tx.select().from(comp).where(and(eq(comp.id, id), notInArray(comp.status, ['published', 'cancelled', 'rejected']))).for('update');
    if (!row) return false;
    await cancelIn(tx, row, now, reason.slice(0, COMPETITION_REASON_MAX) || 'admin');
    await audit(tx, { administratorId, action: 'competition.cancel', target: id, before: { status: row.status, title: row.title } });
    return true;
  });
}

/** 下架 / 恢复 a published competition's page (6.1): the results hidden, the ledger untouched. Logged. */
export async function adminHideCompetition(administratorId: string, id: string, hidden: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [row] = await tx.update(comp).set({ hiddenBy: hidden ? 'admin' : null }).where(and(eq(comp.id, id), eq(comp.status, 'published'), hidden ? isNull(comp.hiddenBy) : isNotNull(comp.hiddenBy))).returning({ title: comp.title });
    if (!row) return false;
    await audit(tx, { administratorId, action: hidden ? 'competition.hide' : 'competition.restore', target: id, before: { title: row.title } });
    return true;
  });
}

/**
 * 取消参赛资格: before the results, the entry's hold given back and its
 * unanswered questions dropped; after them, it leaves the ranking (the
 * ranks recomputed) and its credits stay settled. Logged.
 */
export async function adminDisqualify(administratorId: string, entryId: string, reason: string, now = new Date()): Promise<boolean> {
  if (!isUuid(entryId)) return false;
  return db().transaction(async (tx) => {
    const [item] = await tx.select().from(entry).where(and(eq(entry.id, entryId), inArray(entry.status, ['entered', 'locked']))).for('update');
    if (!item) return false;
    const [row] = await tx.select().from(comp).where(eq(comp.id, item.competitionId)).for('update');
    if (!row) return false;
    await tx.update(entry).set({ status: 'disqualified', disqualifiedReason: reason.slice(0, COMPETITION_REASON_MAX) || 'admin', rank: null, totalScore: null }).where(eq(entry.id, entryId));
    if (row.status === 'open' && item.status === 'entered') await tx.update(comp).set({ entryCount: sql`greatest(${comp.entryCount} - 1, 0)` }).where(eq(comp.id, row.id));
    if (row.status !== 'published') {
      if (item.holdId) await releaseHold(tx, item.holdId, { note: NOTE, ledger: 'competition_answer', reeId: item.reeId }, now);
      await tx.update(entry).set({ holdId: null }).where(eq(entry.id, entryId));
      await tx.update(answer).set({ state: 'failed', judgeState: null, review: null }).where(and(eq(answer.entryId, entryId), inArray(answer.state, ['queued', 'answering'])));
      await tx.update(answer).set({ judgeState: null }).where(and(eq(answer.entryId, entryId), inArray(answer.judgeState, ['pending', 'running'])));
    } else {
      await writeTotals(tx, row.id);
      await tx.update(postAnswer).set({ hiddenBy: 'admin' }).where(sql`${postAnswer.id} in (select ${answer.postAnswerId} from ${answer} where ${answer.entryId} = ${entryId})`);
    }
    await audit(tx, { administratorId, action: 'competition.disqualify', target: entryId, before: { competition: row.id, status: item.status } });
    return true;
  });
}

/**
 * Q7: an administrator's score correction, in review or after the
 * results: logged, totals and ranks recomputed; after the results the
 * entrants whose rank moved are told again.
 */
export async function adminSetScore(administratorId: string, answerId: string, input: { score: unknown; note: unknown }, now = new Date()): Promise<ScoreOutcome> {
  if (!isUuid(answerId)) return { ok: false, error: 'not_found' };
  const checked = checkScore(input.score, input.note);
  if (typeof checked === 'string') return { ok: false, error: checked };
  return db().transaction(async (tx) => {
    const [target] = await tx.select({ answer, status: comp.status, title: comp.title, slug: comp.slug }).from(answer).innerJoin(comp, eq(comp.id, answer.competitionId)).where(eq(answer.id, answerId)).for('update', { of: answer });
    if (!target) return { ok: false as const, error: 'not_found' as const };
    if (target.status !== 'review' && target.status !== 'published') return { ok: false as const, error: 'locked' as const };
    if (target.answer.state !== 'answered' || target.answer.review === 'rejected') return { ok: false as const, error: 'not_answered' as const };
    await writeScore(tx, answerId, 'admin', administratorId, checked.score, checked.note, now, target.answer.hostScore ?? target.answer.aiScore);
    await audit(tx, { administratorId, action: 'competition.score', target: answerId, before: { ai: target.answer.aiScore, host: target.answer.hostScore }, after: { score: checked.score } });
    if (target.status === 'published') {
      const before = new Map((await tx.select({ id: entry.id, rank: entry.rank }).from(entry).where(eq(entry.competitionId, target.answer.competitionId))).map((item) => [item.id, item.rank]));
      const ranked = await writeTotals(tx, target.answer.competitionId);
      const moved = ranked.filter((item) => before.get(item.entryId) !== item.rank);
      for (const item of moved) {
        const [who] = await tx.select({ userId: entry.userId, ree: ree.name }).from(entry).innerJoin(ree, eq(ree.id, entry.reeId)).where(eq(entry.id, item.entryId)).limit(1);
        if (who) await notify(tx, { userId: who.userId, kind: 'competition_results', params: { title: target.title, slug: target.slug, ree: who.ree, rank: item.rank, total: item.total, entries: ranked.length, corrected: 1 }, refId: target.answer.competitionId });
      }
    }
    return { ok: true as const, score: checked.score };
  });
}

/* ------------------------------------------------------------- 试评 */

export type TrialOutcome =
  | { ok: true; score: number; runs: { accuracy: number; completeness: number; citation: number; injection: boolean; rationale: string }[]; charged: number }
  | { ok: false; error: 'not_found' | 'locked' | 'invalid_answer' | 'judge_failed' }
  | { ok: false; error: 'insufficient'; balance: number; needed: number };

/**
 * 试评 (5.1 step 4): the host pastes a sample answer to one of their draft's
 * questions and sees how the judge scores it -- the same two runs (a third
 * when they disagree) a real answer gets, for one judge fee, given back if
 * the judge fails.
 */
export async function trialJudge(userId: string, id: string, input: { questionId: unknown; answer: unknown }, judge: CompetitionJudge = modelCompetitionJudge, now = new Date()): Promise<TrialOutcome> {
  if (!isUuid(id) || !isUuid(input.questionId)) return { ok: false, error: 'not_found' };
  const sample = typeof input.answer === 'string' ? input.answer.trim() : '';
  if (!sample || [...sample].length > 4_000) return { ok: false, error: 'invalid_answer' };
  const [row] = await db().select().from(comp).where(and(eq(comp.id, id), eq(comp.hostId, userId))).limit(1);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'draft') return { ok: false, error: 'locked' };
  const [asked] = await db().select().from(question).where(and(eq(question.id, input.questionId), eq(question.competitionId, id))).limit(1);
  if (!asked) return { ok: false, error: 'not_found' };
  const fee = COMPETITION_JUDGE_FEE;
  let holdId: string;
  try {
    holdId = await db().transaction((tx) => placeHold(tx, { userId, kind: 'competition', ledger: 'competition_judge', amount: fee, refId: id, note: NOTE }, now));
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, error: 'insufficient', balance: await balanceOf(db(), userId, now), needed: fee };
    throw error;
  }
  const material = { question: asked.question, detail: asked.detail, reference: asked.referenceAnswer, rubric: asked.rubric, answer: sample, sources: [] };
  const runs: JudgeRun[] = [];
  let combined = combineRuns(runs, row.weights);
  try {
    while (combined.needs && runs.length < 3) {
      runs.push(await judge({ material, swapped: runs.length % 2 === 1, lang: row.lang }));
      combined = combineRuns(runs, row.weights);
    }
  } catch (error) {
    console.warn(`competition ${id} trial judge failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (combined.score === null) {
    await db().transaction((tx) => releaseHold(tx, holdId, { note: NOTE, ledger: 'competition_judge' }, now));
    return { ok: false, error: 'judge_failed' };
  }
  await db().transaction((tx) => settleHold(tx, holdId, fee, { note: NOTE, ledger: 'competition_judge' }, now));
  return { ok: true, score: combined.score, runs: runs.map(({ accuracy, completeness, citation, injection, rationale }) => ({ accuracy, completeness, citation, injection, rationale })), charged: fee };
}

/** A competition's slug by id, for routes addressed by id. */
export async function slugOf(id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const [row] = await db().select({ slug: comp.slug }).from(comp).where(eq(comp.id, id)).limit(1);
  return row?.slug ?? null;
}
