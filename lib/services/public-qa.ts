/**
 * The Ree page's public Q&A (lib/domain/public-qa.ts).
 *
 * - Only what an asker chose to publish is ever kept: a visitor ticks
 *   "回答后公开" before asking and the anonymous route snapshots the answer
 *   it gave; a signed-in asker publishes an answer from their own
 *   conversation. Single-turn only: a visitor's question with earlier turns,
 *   or a signed-in follow-up, is never kept.
 * - A snapshot is redacted on the way in (e-mail, identity numbers, long
 *   digit runs, links in the question) and starts `pending`. A moderation
 *   check publishes or rejects it; a failed check is retried by the hourly
 *   cron, and given up after `PUBLIC_QA_MODERATION_ATTEMPTS`.
 * - A published answer shows while its Ree is public with public Q&A on,
 *   and -- for a signed-in asker -- while its message is in a conversation
 *   outside the trash: deleting the conversation takes it down, restoring
 *   brings it back, purging ends it.
 * - The owner pins (one per Ree) and hides; an administrator hides and
 *   restores; enough distinct reports hide it until an administrator looks.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { generateText, Output } from 'ai';
import type { CitationSnapshot } from '@/lib/domain/answer';
import {
  MODERATION_INSTRUCTIONS,
  MODERATION_SCHEMA,
  moderationPrompt,
  previewOf,
  PUBLIC_QA_ANSWER_MAX_CHARS,
  PUBLIC_QA_MODERATION_ATTEMPTS,
  PUBLIC_QA_PAGE_SIZE,
  PUBLIC_QA_REPORT_THRESHOLD,
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

const { ree, reePublicQa: qa, reePublicQaVote: vote, reePublicQaReport: report, message, conversation } = schema;

/* --------------------------------------------------------------- visibility */

/** The Ree is public and its owner lets answers be published. */
function openRee(): SQL {
  return and(publicRee(), eq(ree.publicQaEnabled, true))!;
}

/** A signed-in asker's answer shows only while its message is in a conversation outside the trash. */
function askerKeepsIt(): SQL {
  return sql`(${qa.source} <> 'user' or exists (
    select 1 from ${message} m join ${conversation} c on c.id = m.conversation_id
    where m.id = ${qa.messageId} and c.deleted_at is null))`;
}

/** What anyone sees: published, on an open Ree, not taken down with its conversation. */
function shown(): SQL {
  return and(eq(qa.status, 'published'), openRee(), askerKeepsIt())!;
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
  messageId?: string | null;
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
    .values({ reeId: input.reeId, source: input.source, question, answer, citations: input.citations, lang: input.lang, userId: input.userId ?? null, messageId: input.messageId ?? null })
    .onConflictDoNothing()
    .returning({ id: qa.id });
  return row?.id ?? null;
}

export type PublishResult = { id: string } | 'not_found' | 'not_single_turn' | 'no_answer' | 'closed' | 'already';

/**
 * A signed-in asker publishes one of their answers: the Ree's reply to the
 * first question of a conversation they own, not in the trash, that answered
 * (not a "no answer"), on a Ree that takes public answers.
 */
export async function publishOwnAnswer(userId: string, reeId: string, messageId: string, lang: 'zh' | 'en'): Promise<PublishResult> {
  if (!isUuid(messageId) || !isUuid(reeId)) return 'not_found';
  const [reply] = await db()
    .select({ id: message.id, conversationId: message.conversationId, content: message.content, citations: message.citations, noAnswer: message.noAnswer, reeId: message.reeId, createdAt: message.createdAt })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(and(eq(message.id, messageId), eq(message.role, 'ree'), eq(message.reeId, reeId), eq(conversation.userId, userId), isNull(conversation.deletedAt), eq(conversation.kind, 'normal')))
    .limit(1);
  if (!reply) return 'not_found';
  if (reply.noAnswer || !reply.content.trim()) return 'no_answer';
  const questions = await db()
    .select({ id: message.id, content: message.content, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.conversationId, reply.conversationId), eq(message.role, 'user')))
    .orderBy(asc(message.createdAt))
    .limit(2);
  /* Single turn: the conversation's first question, and the reply came before any second one. */
  const first = questions[0];
  if (!first || first.createdAt > reply.createdAt || (questions[1] && questions[1].createdAt <= reply.createdAt)) return 'not_single_turn';
  const [existing] = await db().select({ id: qa.id }).from(qa).where(eq(qa.messageId, messageId)).limit(1);
  if (existing) return 'already';
  const id = await keepSnapshot({ reeId, source: 'user', question: first.content, answer: reply.content, citations: reply.citations, lang, userId, messageId });
  return id ? { id } : 'closed';
}

/* --------------------------------------------------------------- moderation */

export type Judge = (question: string, answer: string) => Promise<{ publish: boolean }>;

/** The moderation check: one structured call on the platform's free generation model, logged as `moderation`. */
export const modelJudge: Judge = async (question, answer) => {
  const generation = await generationForUser(null, 'moderation');
  const { output } = await generateText({
    model: generation.model,
    output: Output.object({ schema: MODERATION_SCHEMA }),
    instructions: MODERATION_INSTRUCTIONS,
    prompt: moderationPrompt(question, answer),
    maxOutputTokens: 200,
    temperature: 0,
    reasoning: 'minimal',
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(Math.min(generation.endpoint.timeoutMs, 30_000)),
  });
  return { publish: output.publish === true };
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
  return status;
}

/** The hourly cron: pending snapshots a request did not finish checking, oldest first. */
export async function moderatePending(judge: Judge = modelJudge, limit = 25): Promise<number> {
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

const columns = {
  id: qa.id,
  source: qa.source,
  question: qa.question,
  answer: qa.answer,
  citations: qa.citations,
  helpful: qa.helpfulCount,
  pinnedAt: qa.pinnedAt,
  publishedAt: qa.publishedAt,
};
type Row = { id: string; source: PublicQaSource; question: string; answer: string; citations: CitationSnapshot[]; helpful: number; pinnedAt: Date | null; publishedAt: Date | null };

function toPublic(row: Row, voted: Set<string>, whole = false): PublicQa {
  const { answer, truncated } = whole ? { answer: row.answer, truncated: false } : previewOf(row.answer);
  return {
    id: row.id,
    asker: row.source === 'user' ? 'user' : 'visitor',
    question: row.question,
    answer,
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
  const rows = await db().select({ id: vote.qaId }).from(vote).where(and(eq(vote.userId, viewerId), inArray(vote.qaId, ids)));
  return new Set(rows.map((row) => row.id));
}

/**
 * One page of a Ree's stream: the pinned answer first on the first page,
 * then the newest; `before` is the last id of the previous page. Null when
 * the Ree is not public.
 */
export async function listPublicQa(reeId: string, options: { before?: string | null; viewerId?: string; size?: number } = {}): Promise<PublicQaPage | null> {
  if (!isUuid(reeId)) return null;
  const size = options.size ?? PUBLIC_QA_PAGE_SIZE;
  const [target] = await db().select({ id: ree.id, enabled: ree.publicQaEnabled }).from(ree).where(and(eq(ree.id, reeId), publicRee())).limit(1);
  if (!target) return null;
  if (!target.enabled) return { items: [], total: 0, next: null };
  const base = and(eq(qa.reeId, reeId), shown())!;
  const total = (await db().select({ total: sql<number>`count(*)::int` }).from(qa).innerJoin(ree, eq(ree.id, qa.reeId)).where(base))[0]?.total ?? 0;
  let boundary: SQL | undefined;
  if (options.before) {
    if (!isUuid(options.before)) return null;
    const [cursor] = await db().select({ publishedAt: qa.publishedAt, id: qa.id }).from(qa).where(and(eq(qa.id, options.before), eq(qa.reeId, reeId))).limit(1);
    if (!cursor?.publishedAt) return { items: [], total, next: null };
    boundary = sql`(${qa.publishedAt}, ${qa.id}) < (${cursor.publishedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
  }
  const pinned = options.before
    ? []
    : await db().select(columns).from(qa).innerJoin(ree, eq(ree.id, qa.reeId)).where(and(base, isNotNull(qa.pinnedAt))).limit(1);
  const rows = await db()
    .select(columns)
    .from(qa)
    .innerJoin(ree, eq(ree.id, qa.reeId))
    .where(and(base, isNull(qa.pinnedAt), boundary))
    .orderBy(desc(qa.publishedAt), desc(qa.id))
    .limit(size + 1);
  const page = [...pinned, ...rows.slice(0, size)] as Row[];
  const voted = await votedBy(options.viewerId, page.map((row) => row.id));
  return { items: page.map((row) => toPublic(row, voted)), total, next: rows.length > size ? rows[size - 1]!.id : null };
}

/** One shown answer in full ("展开全文"). */
export async function publicQaById(reeId: string, id: string, viewerId?: string): Promise<PublicQa | null> {
  if (!isUuid(reeId) || !isUuid(id)) return null;
  const [row] = await db().select(columns).from(qa).innerJoin(ree, eq(ree.id, qa.reeId)).where(and(eq(qa.id, id), eq(qa.reeId, reeId), shown())).limit(1);
  if (!row) return null;
  return toPublic(row as Row, await votedBy(viewerId, [row.id]), true);
}

/** The share page's picks ("大家问过的"): the pinned one, then the most helpful, then the newest. */
export async function publicQaPicks(reeId: string, count: number): Promise<{ items: PublicQa[]; total: number }> {
  const base = and(eq(qa.reeId, reeId), shown())!;
  const rows = await db()
    .select(columns)
    .from(qa)
    .innerJoin(ree, eq(ree.id, qa.reeId))
    .where(base)
    .orderBy(sql`${qa.pinnedAt} is null`, desc(qa.helpfulCount), desc(qa.publishedAt))
    .limit(count);
  const total = (await db().select({ total: sql<number>`count(*)::int` }).from(qa).innerJoin(ree, eq(ree.id, qa.reeId)).where(base))[0]?.total ?? 0;
  return { items: (rows as Row[]).map((row) => toPublic(row, new Set())), total };
}

/** Shown answers per Ree, for explore's activity line. */
export async function publicQaCounts(reeIds: readonly string[]): Promise<Map<string, number>> {
  if (reeIds.length === 0) return new Map();
  const rows = await db()
    .select({ reeId: qa.reeId, total: sql<number>`count(*)::int` })
    .from(qa)
    .innerJoin(ree, eq(ree.id, qa.reeId))
    .where(and(inArray(qa.reeId, [...reeIds]), shown()))
    .groupBy(qa.reeId);
  return new Map(rows.map((row) => [row.reeId, row.total]));
}

/* ------------------------------------------------------------------ actions */

/** "有帮助", once per signed-in user; answers the new count, or null when the answer is not shown. */
export async function setHelpful(userId: string, reeId: string, id: string, on: boolean): Promise<{ helpful: number; voted: boolean } | null> {
  if (!isUuid(reeId) || !isUuid(id)) return null;
  return db().transaction(async (tx) => {
    const [target] = await tx.select({ id: qa.id }).from(qa).innerJoin(ree, eq(ree.id, qa.reeId)).where(and(eq(qa.id, id), eq(qa.reeId, reeId), shown())).for('update', { of: qa });
    if (!target) return null;
    const changed = on
      ? await tx.insert(vote).values({ qaId: id, userId }).onConflictDoNothing().returning({ id: vote.qaId })
      : await tx.delete(vote).where(and(eq(vote.qaId, id), eq(vote.userId, userId))).returning({ id: vote.qaId });
    const [row] = changed.length
      ? await tx.update(qa).set({ helpfulCount: sql`greatest(${qa.helpfulCount} + ${on ? 1 : -1}, 0)` }).where(eq(qa.id, id)).returning({ helpful: qa.helpfulCount })
      : await tx.select({ helpful: qa.helpfulCount }).from(qa).where(eq(qa.id, id));
    return { helpful: row!.helpful, voted: on };
  });
}

/**
 * "举报", once per reporter (`reporterKey`, already hashed for visitors).
 * The `PUBLIC_QA_REPORT_THRESHOLD`th distinct report hides the answer until
 * an administrator restores it. False when the answer is not shown.
 */
export async function reportPublicQa(reeId: string, id: string, reporter: string): Promise<boolean> {
  if (!isUuid(reeId) || !isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [target] = await tx.select({ id: qa.id }).from(qa).innerJoin(ree, eq(ree.id, qa.reeId)).where(and(eq(qa.id, id), eq(qa.reeId, reeId), shown())).for('update', { of: qa });
    if (!target) return false;
    const added = await tx.insert(report).values({ qaId: id, reporterKey: reporter }).onConflictDoNothing().returning({ id: report.qaId });
    if (added.length === 0) return true;
    const [row] = await tx.update(qa).set({ reportCount: sql`${qa.reportCount} + 1` }).where(eq(qa.id, id)).returning({ reports: qa.reportCount });
    if (row!.reports >= PUBLIC_QA_REPORT_THRESHOLD) {
      await tx.update(qa).set({ status: 'hidden', hiddenBy: 'reports', pinnedAt: null }).where(and(eq(qa.id, id), eq(qa.status, 'published')));
    }
    return true;
  });
}

export type OwnerAction = 'hide' | 'pin' | 'unpin';

/** The Ree's owner hides an answer for good, or pins one (replacing the pinned one) or unpins it. */
export async function ownerAct(userId: string, reeId: string, id: string, action: OwnerAction): Promise<boolean> {
  if (!isUuid(reeId) || !isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ id: qa.id })
      .from(qa)
      .innerJoin(ree, eq(ree.id, qa.reeId))
      .where(and(eq(qa.id, id), eq(qa.reeId, reeId), eq(ree.ownerId, userId), isNull(ree.deletedAt), eq(qa.status, 'published')))
      .for('update', { of: qa });
    if (!target) return false;
    if (action === 'hide') {
      await tx.update(qa).set({ status: 'hidden', hiddenBy: 'owner', pinnedAt: null }).where(eq(qa.id, id));
    } else if (action === 'pin') {
      await tx.update(qa).set({ pinnedAt: null }).where(and(eq(qa.reeId, reeId), isNotNull(qa.pinnedAt)));
      await tx.update(qa).set({ pinnedAt: new Date() }).where(eq(qa.id, id));
    } else {
      await tx.update(qa).set({ pinnedAt: null }).where(eq(qa.id, id));
    }
    return true;
  });
}

/* ------------------------------------------------------------- administrator */

export interface AdminPublicQa {
  id: string;
  source: PublicQaSource;
  question: string;
  answer: string;
  status: 'pending' | 'published' | 'hidden' | 'rejected';
  hiddenBy: 'owner' | 'admin' | 'reports' | null;
  reports: number;
  helpful: number;
  createdAt: string;
}

/** A Ree's public answers for the console, everything but rejected ones, reported first. */
export async function adminPublicQa(reeId: string, limit = 50): Promise<AdminPublicQa[]> {
  if (!isUuid(reeId)) return [];
  const rows = await db()
    .select({ id: qa.id, source: qa.source, question: qa.question, answer: qa.answer, status: qa.status, hiddenBy: qa.hiddenBy, reports: qa.reportCount, helpful: qa.helpfulCount, createdAt: qa.createdAt })
    .from(qa)
    .where(and(eq(qa.reeId, reeId), or(eq(qa.status, 'published'), eq(qa.status, 'hidden'), eq(qa.status, 'pending'))))
    .orderBy(desc(qa.reportCount), desc(qa.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, answer: previewOf(row.answer).answer, createdAt: row.createdAt.toISOString() }));
}

/** An administrator hides an answer, or restores one an owner or reports hid; either is in the management log. */
export async function adminSetPublicQa(administratorId: string, reeId: string, id: string, show: boolean): Promise<boolean> {
  if (!isUuid(reeId) || !isUuid(id)) return false;
  return db().transaction(async (tx) => {
    const [before] = await tx.select({ status: qa.status, hiddenBy: qa.hiddenBy, question: qa.question }).from(qa).where(and(eq(qa.id, id), eq(qa.reeId, reeId))).for('update');
    if (!before || before.status !== (show ? 'hidden' : 'published')) return false;
    if (show) {
      await tx.update(qa).set({ status: 'published', hiddenBy: null, reportCount: 0, publishedAt: sql`coalesce(${qa.publishedAt}, now())` }).where(eq(qa.id, id));
      await tx.delete(report).where(eq(report.qaId, id));
    } else {
      await tx.update(qa).set({ status: 'hidden', hiddenBy: 'admin', pinnedAt: null }).where(eq(qa.id, id));
    }
    await audit(tx, { administratorId, action: show ? 'ree.qa.restore' : 'ree.qa.hide', target: reeId, before: { qa: id, status: before.status, hiddenBy: before.hiddenBy, question: before.question.slice(0, 200) } });
    return true;
  });
}
