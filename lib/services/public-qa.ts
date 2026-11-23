/**
 * The Ree page's public Q&A (lib/domain/public-qa.ts).
 *
 * - Only what an asker chose to publish was ever kept: a visitor ticked
 *   "回答后公开" before asking, or a signed-in asker published an answer
 *   from their own conversation. Neither exists any more (the visitors'
 *   in 2026-11-19, the conversations with migration 0070, which kept what
 *   they had published); what is kept stays, read as posts.
 * - A snapshot was redacted on the way in (e-mail, identity numbers, long
 *   digit runs, links in the question) and starts `pending`. A moderation
 *   check publishes or rejects it; a failed check is retried by the hourly
 *   cron, and given up after `PUBLIC_QA_MODERATION_ATTEMPTS`.
 * - A published answer shows while its Ree is public with public Q&A on;
 *   deleting the asker's account deletes the snapshot (the foreign key
 *   cascades).
 * - The owner pins (one per Ree) and hides for good; an administrator hides,
 *   and restores what an administrator or reports hid -- never what the
 *   owner hid; enough distinct reporters hide it until an administrator
 *   looks. A visitor counts once per network, whatever cookie they send.
 * - A snapshot whose last check never finished (the function died) is
 *   rejected by the hourly cron after `PUBLIC_QA_STUCK_MS`: never public.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { generateText } from 'ai';
import type { CitationSnapshot } from '@/lib/domain/answer';
import {
  MODERATION_INSTRUCTIONS,
  MODERATION_OUTPUT_TOKENS,
  MODERATION_QUESTION_INSTRUCTIONS,
  MODERATION_TRIES,
  moderationPrompt,
  parseModeration,
  previewOf,
  PUBLIC_QA_ANSWER_MAX_CHARS,
  PUBLIC_QA_MODERATION_ATTEMPTS,
  PUBLIC_QA_PAGE_SIZE,
  redact,
  type PublicQa,
  type PublicQaPage,
  type PublicQaSource,
} from '@/lib/domain/public-qa';
import { isUuid } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';
import { audit } from '@/lib/services/admin';
import { generationForUser } from '@/lib/services/generation';
import { answeredPostCounts, flagQuotingAnswer, ownerActOnAnswer, reportAnswer, setAnswerHelpful, shownAnswer, visiblePost, type OwnerAction } from '@/lib/services/posts';
import { syncPublicQa } from '@/lib/services/public-qa-sync';
import { imagesNote } from '@/lib/domain/post-images';
import { visionOptions, withImages, type ImagePart } from '@/lib/services/post-images';

const { ree, reePublicQa: qa, post, postAnswer: answer, postAnswerVote: vote, postAnswerReport: report, user } = schema;

/* --------------------------------------------------------------- visibility */

/** The Ree is public and its owner lets answers be published. */
function openRee(): SQL {
  return and(publicRee(), eq(ree.publicQaEnabled, true))!;
}

/* ---------------------------------------------------------------- snapshots */

export interface Snapshot {
  reeId: string;
  source: PublicQaSource;
  question: string;
  answer: string;
  citations: CitationSnapshot[];
  lang: 'zh' | 'en';
  userId?: string | null;
}

/** Keeps a redacted, pending snapshot; null when the Ree does not take public answers now or the text is unusable. */
export async function keepSnapshot(input: Snapshot): Promise<string | null> {
  const question = redact(input.question.trim(), input.lang).slice(0, 4000);
  const answer = redact(input.answer.trim(), input.lang, { links: false }).slice(0, PUBLIC_QA_ANSWER_MAX_CHARS);
  if (!question || !answer) return null;
  const [open] = await db().select({ id: ree.id }).from(ree).where(and(eq(ree.id, input.reeId), openRee())).limit(1);
  if (!open) return null;
  const [row] = await db()
    .insert(qa)
    .values({ reeId: input.reeId, source: input.source, question, answer, citations: input.citations, lang: input.lang, userId: input.userId ?? null })
    .onConflictDoNothing()
    .returning({ id: qa.id });
  return row?.id ?? null;
}

/* --------------------------------------------------------------- moderation */

/** `images`: a post's images, reviewed with its text (lib/domain/post-images.ts): text inside an image is not reached by `redact`, so the model reads them. */
export type Judge = (question: string, answer: string, images?: readonly ImagePart[]) => Promise<{ publish: boolean; reason?: string }>;

/**
 * The moderation check on the platform's free generation model, logged as
 * `moderation`; an empty `answer` reviews a post's question alone.
 *
 * Written for real models, not only the test double (2026-11-19): no
 * `reasoning` setting -- on agnes-3.0-flash `minimal` turned thinking on and
 * its reasoning tokens used up the whole budget, so the JSON was cut off --
 * a budget a short thinking pass still fits in, and the verdict read from
 * the text leniently (providers without structured output). A reply cut off
 * or without a verdict is asked once more before it counts as a failed check.
 */
export const modelJudge: Judge = async (question, answer, images = []) => {
  const generation = await generationForUser(null, 'moderation');
  let last = '';
  for (let attempt = 0; attempt < MODERATION_TRIES; attempt += 1) {
    const { text, finishReason } = await generateText({
      model: generation.model,
      instructions: answer ? MODERATION_INSTRUCTIONS : MODERATION_QUESTION_INSTRUCTIONS,
      messages: [withImages(images.length ? `${moderationPrompt(question, answer)}\n\n${imagesNote(images.length)} Review the images as part of the post, including any text in them.` : moderationPrompt(question, answer), images)],
      ...visionOptions(images),
      maxOutputTokens: MODERATION_OUTPUT_TOKENS,
      temperature: 0,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(Math.min(generation.endpoint.timeoutMs, 30_000)),
    });
    const verdict = parseModeration(text);
    if (verdict) return verdict;
    last = `finish=${finishReason} chars=${text.length}`;
  }
  throw new Error(`moderation reply had no verdict (${last})`);
};

/**
 * Checks one pending snapshot: published or rejected. A failed check counts
 * an attempt and leaves it pending for the cron; the last attempt rejects it.
 */
export async function moderateSnapshot(id: string, judge: Judge = modelJudge, now = new Date()): Promise<'published' | 'rejected' | 'pending' | 'gone'> {
  const [row] = await db()
    .update(qa)
    .set({ moderationAttempts: sql`${qa.moderationAttempts} + 1` })
    .where(and(eq(qa.id, id), eq(qa.status, 'pending'), lt(qa.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS)))
    .returning({ question: qa.question, answer: qa.answer, attempts: qa.moderationAttempts });
  if (!row) return 'gone';
  let verdict: boolean | null = null;
  try {
    verdict = (await judge(row.question, row.answer)).publish;
  } catch (error) {
    console.warn(`public answer ${id} moderation failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (verdict === null && row.attempts < PUBLIC_QA_MODERATION_ATTEMPTS) return 'pending';
  const status = verdict ? 'published' : 'rejected';
  await db()
    .update(qa)
    .set(status === 'published' ? { status, publishedAt: now } : { status })
    .where(and(eq(qa.id, id), eq(qa.status, 'pending')));
  /* v5: shown as a post with one answer from now on. A failure here is caught up by the hourly cron. */
  if (status === 'published') await syncPublicQa().catch((error: unknown) => console.warn(`public answer ${id} not copied yet: ${error instanceof Error ? error.message : 'unknown'}`));
  return status;
}

/** A pending snapshot out of attempts this long ago died mid-check; the cron rejects it. */
export const PUBLIC_QA_STUCK_MS = 10 * 60_000;

/** The hourly cron: pending snapshots a request did not finish checking, oldest first; ones out of attempts are rejected. */
export async function moderatePending(judge: Judge = modelJudge, limit = 25, now = new Date()): Promise<number> {
  await db()
    .update(qa)
    .set({ status: 'rejected' })
    .where(and(eq(qa.status, 'pending'), sql`${qa.moderationAttempts} >= ${PUBLIC_QA_MODERATION_ATTEMPTS}`, lt(qa.createdAt, new Date(now.getTime() - PUBLIC_QA_STUCK_MS))));
  const rows = await db()
    .select({ id: qa.id })
    .from(qa)
    .where(and(eq(qa.status, 'pending'), lt(qa.moderationAttempts, PUBLIC_QA_MODERATION_ATTEMPTS), lt(qa.createdAt, new Date(Date.now() - 60_000))))
    .orderBy(asc(qa.createdAt))
    .limit(limit);
  let done = 0;
  for (const row of rows) if ((await moderateSnapshot(row.id, judge)) !== 'pending') done += 1;
  return done;
}

/* ------------------------------------------------------------------ reading */

/*
 * v5: what was published is copied into posts (public-qa-sync.ts), and
 * everything below reads and acts on the copies -- together with the
 * answers the Ree gave to public posts. An item's `id` is the answer's id
 * (`post_answer`), its `postId` the post's.
 */

const answerColumns = {
  id: answer.id,
  postId: post.id,
  source: post.source,
  anonymous: post.anonymous,
  authorName: user.name,
  question: post.question,
  answer: answer.text,
  citations: answer.citations,
  helpful: answer.helpfulCount,
  pinnedAt: answer.pinnedAt,
  publishedAt: answer.answeredAt,
};
type Row = {
  id: string;
  postId: string;
  source: string;
  anonymous: boolean;
  authorName: string | null;
  question: string;
  answer: string;
  citations: CitationSnapshot[];
  helpful: number;
  pinnedAt: Date | null;
  publishedAt: Date | null;
};

/** Answers, their post and asker, and the answering Ree. */
function answers() {
  return db()
    .select(answerColumns)
    .from(answer)
    .innerJoin(post, eq(post.id, answer.postId))
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .leftJoin(user, eq(user.id, post.userId));
}

function shown(): SQL {
  /* A Ree page's Q&A is the posts' first rounds: a follow-up's answer is read under its post (追问). */
  return and(shownAnswer(), visiblePost(), isNull(answer.followupId))!;
}

function toPublic(row: Row, voted: Set<string>, whole = false): PublicQa {
  const { answer: text, truncated } = whole ? { answer: row.answer, truncated: false } : previewOf(row.answer);
  return {
    id: row.id,
    postId: row.postId,
    asker: row.source === 'anonymous' || row.source === 'share' ? 'visitor' : 'user',
    author: row.source === 'post' && !row.anonymous && row.authorName ? row.authorName : null,
    question: row.question,
    answer: text,
    truncated,
    citations: row.citations,
    helpful: row.helpful,
    voted: voted.has(row.id),
    pinned: row.pinnedAt !== null,
    publishedAt: (row.publishedAt ?? new Date(0)).toISOString(),
  };
}

async function votedBy(viewerId: string | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewerId || ids.length === 0) return new Set();
  const rows = await db().select({ id: vote.answerId }).from(vote).where(and(eq(vote.userId, viewerId), inArray(vote.answerId, ids)));
  return new Set(rows.map((row) => row.id));
}

async function countShown(reeId: string): Promise<number> {
  const [row] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(answer)
    .innerJoin(post, eq(post.id, answer.postId))
    .innerJoin(ree, eq(ree.id, answer.reeId))
    .where(and(eq(answer.reeId, reeId), shown()));
  return row?.total ?? 0;
}

/**
 * One page of a Ree's answered posts: the pinned answer first on the first
 * page, then the newest; `before` is the last id of the previous page. Null
 * when the Ree is not public.
 */
export async function listPublicQa(reeId: string, options: { before?: string | null; viewerId?: string; size?: number } = {}): Promise<PublicQaPage | null> {
  if (!isUuid(reeId)) return null;
  const size = options.size ?? PUBLIC_QA_PAGE_SIZE;
  const [target] = await db().select({ id: ree.id }).from(ree).where(and(eq(ree.id, reeId), publicRee())).limit(1);
  if (!target) return null;
  const base = and(eq(answer.reeId, reeId), shown())!;
  const total = await countShown(reeId);
  let boundary: SQL | undefined;
  if (options.before) {
    if (!isUuid(options.before)) return null;
    const [cursor] = await db().select({ at: answer.answeredAt, id: answer.id }).from(answer).where(and(eq(answer.id, options.before), eq(answer.reeId, reeId))).limit(1);
    if (!cursor?.at) return { items: [], total, next: null };
    boundary = sql`(${answer.answeredAt}, ${answer.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
  }
  const pinned = options.before ? [] : await answers().where(and(base, isNotNull(answer.pinnedAt))).limit(1);
  const rows = await answers().where(and(base, isNull(answer.pinnedAt), boundary)).orderBy(desc(answer.answeredAt), desc(answer.id)).limit(size + 1);
  const page = [...pinned, ...rows.slice(0, size)] as Row[];
  const voted = await votedBy(options.viewerId, page.map((row) => row.id));
  return { items: page.map((row) => toPublic(row, voted)), total, next: rows.length > size ? rows[size - 1]!.id : null };
}

/** One shown answer in full ("展开全文"). */
export async function publicQaById(reeId: string, id: string, viewerId?: string): Promise<PublicQa | null> {
  if (!isUuid(reeId) || !isUuid(id)) return null;
  const [row] = await answers().where(and(eq(answer.id, id), eq(answer.reeId, reeId), shown())).limit(1);
  if (!row) return null;
  return toPublic(row as Row, await votedBy(viewerId, [row.id]), true);
}

/** The share page's picks ("大家问过的"): the pinned one, then the most helpful, then the newest. */
export async function publicQaPicks(reeId: string, count: number): Promise<{ items: PublicQa[]; total: number }> {
  const rows = await answers()
    .where(and(eq(answer.reeId, reeId), shown()))
    .orderBy(sql`${answer.pinnedAt} is null`, desc(answer.helpfulCount), desc(answer.answeredAt))
    .limit(count);
  return { items: (rows as Row[]).map((row) => toPublic(row, new Set())), total: await countShown(reeId) };
}

/** Shown answers per Ree, for explore's activity line. */
export async function publicQaCounts(reeIds: readonly string[]): Promise<Map<string, number>> {
  return answeredPostCounts(reeIds);
}

/* ------------------------------------------------------------------ actions */

/** "有帮助", once per signed-in user; answers the new count, or null when the answer is not shown. */
export async function setHelpful(userId: string, reeId: string, id: string, on: boolean): Promise<{ helpful: number; voted: boolean; taskReward: number } | null> {
  if (!isUuid(reeId)) return null;
  return setAnswerHelpful(userId, id, on, reeId);
}

/**
 * "举报", once per reporter (`reporterKey`, already hashed for visitors).
 * The `PUBLIC_QA_REPORT_THRESHOLD`th distinct report hides the answer until
 * an administrator restores it. False when the answer is not shown.
 */
export async function reportPublicQa(reeId: string, id: string, reporter: string): Promise<boolean> {
  if (!isUuid(reeId)) return false;
  return reportAnswer(id, reporter, reeId);
}

export type { OwnerAction };

/** The Ree's owner hides an answer for good, or pins one (replacing the pinned one) or unpins it. */
export async function ownerAct(userId: string, reeId: string, id: string, action: OwnerAction): Promise<boolean> {
  return ownerActOnAnswer(userId, reeId, id, action);
}

/* ------------------------------------------------------------- administrator */

export interface AdminPublicQa {
  id: string;
  postId: string;
  source: string;
  /** The follow-up's question for a follow-up's answer, else the post's. */
  question: string;
  followup: boolean;
  /** The post was taken down (by an administrator or reports): its answers are out of sight whatever their own status. */
  postHidden: boolean;
  answer: string;
  status: 'published' | 'hidden';
  hiddenBy: 'owner' | 'admin' | 'reports' | null;
  reports: number;
  helpful: number;
  createdAt: string;
}

/**
 * The answers the console may see and act on: on a public post past review
 * (shown or taken down) out of its author's trash, and for a follow-up's
 * answer, a follow-up past review and not deleted. A private post's -- a
 * private question, a 试问, an MCP ask -- is its author's alone,
 * administrators included (as `adminPosts`).
 */
const consoleAnswer = (): SQL =>
  sql`(${post.visibility} = 'public' and ${post.status} in ('published', 'hidden') and ${post.deletedAt} is null
    and (${answer.followupId} is null or exists (select 1 from ${schema.postFollowup} cf where cf.id = ${answer.followupId} and cf.status in ('published', 'hidden') and cf.deleted_at is null)))`;

/** A Ree's public answers for the console (shown and hidden), reported first. */
export async function adminPublicQa(reeId: string, limit = 50): Promise<AdminPublicQa[]> {
  if (!isUuid(reeId)) return [];
  const rows = await db()
    .select({
      id: answer.id,
      postId: post.id,
      source: post.source,
      question: sql<string>`coalesce((select qf.question from ${schema.postFollowup} qf where qf.id = ${answer.followupId}), ${post.question})`,
      followupId: answer.followupId,
      postStatus: post.status,
      answer: answer.text,
      hiddenBy: answer.hiddenBy,
      reports: answer.reportCount,
      helpful: answer.helpfulCount,
      createdAt: answer.createdAt,
    })
    .from(answer)
    .innerJoin(post, eq(post.id, answer.postId))
    .where(and(eq(answer.reeId, reeId), eq(answer.state, 'answered'), consoleAnswer()))
    .orderBy(desc(answer.reportCount), desc(answer.createdAt))
    .limit(limit);
  return rows.map(({ followupId, postStatus, ...row }) => ({
    ...row,
    followup: followupId !== null,
    postHidden: postStatus === 'hidden',
    status: row.hiddenBy ? 'hidden' : 'published',
    answer: previewOf(row.answer).answer,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** An administrator hides an answer, or restores one an owner or reports hid; either is in the management log. */
export async function adminSetPublicQa(administratorId: string, reeId: string, id: string, show: boolean): Promise<boolean> {
  if (!isUuid(reeId) || !isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [before] = await tx
      .select({ hiddenBy: answer.hiddenBy, postId: answer.postId, question: post.question })
      .from(answer)
      .innerJoin(post, eq(post.id, answer.postId))
      .where(and(eq(answer.id, id), eq(answer.reeId, reeId), eq(answer.state, 'answered'), consoleAnswer()))
      .for('update', { of: answer });
    if (!before || (before.hiddenBy !== null) !== show) return false;
    /* The owner's hiding is theirs: an administrator restores only what an administrator or reports hid. */
    if (show && before.hiddenBy === 'owner') return false;
    if (show) {
      await tx.update(answer).set({ hiddenBy: null, reportCount: 0 }).where(eq(answer.id, id));
      await tx.delete(report).where(eq(report.answerId, id));
    } else {
      await tx.update(answer).set({ hiddenBy: 'admin', pinnedAt: null }).where(eq(answer.id, id));
      await flagQuotingAnswer(tx, id);
    }
    await tx
      .update(post)
      /* The post's first round only, as posts.ts `recount`: a follow-up's answers are not the post's. */
      .set({ answerCount: sql`(select count(*)::int from ${answer} a where a.post_id = ${before.postId} and a.followup_id is null and a.state = 'answered' and a.hidden_by is null)` })
      .where(and(eq(post.id, before.postId), eq(post.answerState, 'done')));
    await audit(tx, { administratorId, action: show ? 'ree.qa.restore' : 'ree.qa.hide', target: reeId, before: { qa: id, status: before.hiddenBy ? 'hidden' : 'published', hiddenBy: before.hiddenBy, question: before.question.slice(0, 200) } });
    return true;
  });
}
