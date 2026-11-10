/**
 * The single-Ree test conversation (`conversation.kind = ree_test`) and the
 * retrieval it answers from (rebuild-proposal.md 5).
 */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { HISTORY_TURNS, RETRIEVAL_OVERVIEWS_MAX, RETRIEVAL_RECALL, RETRIEVAL_TOP_K } from '@/lib/constants';
import type { Passage } from '@/lib/domain/answer';
import { checkPartId, SYNTHESIS_PART_ID, TEXT_META_KEY, textPartId, type ReeOutcome, type ReeUIMessage, type SuggestedRee, type SynthesisPart } from '@/lib/domain/chat-message';
import { fuse, hasEvidence, isLibraryQuestion, keywordCoverage, overviewText, searchTerms } from '@/lib/domain/retrieval';
import { likePattern } from '@/lib/domain/list';
import { embedTexts } from '@/lib/infra/ai/models';
import { db, schema } from '@/lib/infra/db';

export type Conversation = typeof schema.conversation.$inferSelect;
export type MessageRow = typeof schema.message.$inferSelect;

/** The owner's test conversation with one Ree, created on first visit. */
export async function testConversation(userId: string, reeId: string): Promise<Conversation> {
  const database = db();
  await database
    .insert(schema.conversation)
    .values({ userId, kind: 'ree_test', reeId })
    .onConflictDoNothing();
  const [conversation] = await database
    .select()
    .from(schema.conversation)
    .where(and(eq(schema.conversation.userId, userId), eq(schema.conversation.kind, 'ree_test'), eq(schema.conversation.reeId, reeId)))
    .limit(1);
  await database.insert(schema.conversationRee).values({ conversationId: conversation!.id, reeId }).onConflictDoNothing();
  return conversation!;
}

export async function ownedConversation(userId: string, id: string): Promise<Conversation | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db()
    .select()
    .from(schema.conversation)
    .where(and(eq(schema.conversation.id, id), eq(schema.conversation.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * How long a question can still be answering: the answer stream and the
 * citation check together stay under the 300 s function limit, so a hold
 * older than this belongs to a function that was killed (the hold reaper
 * gives it back) and nothing more will arrive.
 */
export const ANSWER_PENDING_MS = 6 * 60_000;

/**
 * Whether the conversation's latest question is still being answered: one
 * of its chat holds is open. A page loaded (or refreshed after a dropped
 * stream) while that is so shows the question as waiting and polls, rather
 * than inviting the asker to pay for it again (review C3).
 */
export async function answeringQuestion(userId: string, rows: readonly Pick<MessageRow, 'id' | 'role'>[], now = new Date()): Promise<boolean> {
  const asked = [...rows].reverse().find((row) => row.role === 'user');
  if (!asked) return false;
  const [hold] = await db()
    .select({ id: schema.creditHold.id })
    .from(schema.creditHold)
    .where(
      and(
        eq(schema.creditHold.userId, userId),
        eq(schema.creditHold.kind, 'chat'),
        eq(schema.creditHold.refId, asked.id),
        eq(schema.creditHold.status, 'held'),
        sql`${schema.creditHold.createdAt} > ${new Date(now.getTime() - ANSWER_PENDING_MS).toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  return Boolean(hold);
}

export async function messagesOf(conversationId: string): Promise<MessageRow[]> {
  return db()
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, conversationId))
    .orderBy(asc(schema.message.createdAt));
}

export function outcomeOf(row: MessageRow, vote: 'up' | 'down' | null = null): ReeOutcome {
  return {
    reeId: row.reeId!,
    messageId: row.id,
    noAnswer: row.noAnswer,
    reason: row.noAnswerReason ?? null,
    cost: row.costCredits,
    citations: row.citations,
    model: null,
    failed: false,
    vote,
  };
}

/**
 * Stored rows as `useChat` messages: each question, then one assistant
 * message holding the reply of every Ree it went to, in the order they were
 * written, the suggestions shown under it when nobody could answer, and the
 * question's synthesis (Ree 圆桌) when there is one.
 */
export function toUIMessages(
  rows: readonly MessageRow[],
  extras: { votes?: ReadonlyMap<string, 'up' | 'down'>; suggestions?: ReadonlyMap<string, SuggestedRee[]>; syntheses?: ReadonlyMap<string, SynthesisPart> } = {},
): ReeUIMessage[] {
  const replies = new Map<string, MessageRow[]>();
  for (const row of rows) {
    if (row.role !== 'ree' || !row.reeId) continue;
    const key = row.requestId ?? row.id;
    replies.set(key, [...(replies.get(key) ?? []), row]);
  }
  const out: ReeUIMessage[] = [];
  const asked = new Set<string>();
  for (const row of rows) {
    if (row.role === 'user') {
      asked.add(row.id);
      out.push({ id: row.id, role: 'user', parts: [{ type: 'text', text: row.content }] });
      const answers = replies.get(row.id) ?? [];
      const suggested = extras.suggestions?.get(row.id) ?? [];
      const synthesis = extras.syntheses?.get(row.id);
      if (answers.length === 0 && suggested.length === 0) continue;
      out.push({
        id: `${row.id}-replies`,
        role: 'assistant',
        parts: [
          ...answers.flatMap((reply) => replyParts(reply, extras.votes?.get(reply.id) ?? null)),
          ...(suggested.length ? [{ type: 'data-suggestions' as const, id: 'suggestions', data: { rees: suggested } }] : []),
          ...(synthesis ? [{ type: 'data-synthesis' as const, id: SYNTHESIS_PART_ID, data: synthesis }] : []),
        ],
      });
    }
  }
  /* Replies whose question row is missing still show, rather than vanish. */
  for (const [key, answers] of replies) if (!asked.has(key)) out.push({ id: `${key}-replies`, role: 'assistant', parts: answers.flatMap((reply) => replyParts(reply, extras.votes?.get(reply.id) ?? null)) });
  return out;
}

function replyParts(row: MessageRow, vote: 'up' | 'down' | null): ReeUIMessage['parts'] {
  const reeId = row.reeId!;
  return [
    { type: 'data-ree', id: reeId, data: { reeId } },
    ...(row.content ? [{ type: 'text' as const, text: row.content, state: 'done' as const, providerMetadata: { [TEXT_META_KEY]: { reeId, part: textPartId(reeId) } } }] : []),
    { type: 'data-outcome', id: `outcome-${reeId}`, data: outcomeOf(row, vote) },
    ...(row.checkState
      ? [{ type: 'data-check' as const, id: checkPartId(reeId), data: { reeId, messageId: row.id, state: row.checkState, checks: row.checks, cost: row.checkCredits } }]
      : []),
  ];
}

/** The asker's own votes on these answers. */
export async function votesFor(userId: string, messageIds: readonly string[]): Promise<Map<string, 'up' | 'down'>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db()
    .select({ messageId: schema.reeFeedback.messageId, vote: schema.reeFeedback.vote })
    .from(schema.reeFeedback)
    .where(and(eq(schema.reeFeedback.userId, userId), inArray(schema.reeFeedback.messageId, [...messageIds])));
  return new Map(rows.map((row) => [row.messageId, row.vote]));
}

/** Clearing deletes messages only; the ledger and usage stay (prototype "清空对话"). */
export async function clearConversation(conversationId: string): Promise<void> {
  await db().delete(schema.message).where(eq(schema.message.conversationId, conversationId));
}

/** A Ree's own earlier turns, answered ones only, newest last, from the conversation's rows (read once per question for every Ree asked). */
export function turnsOf(
  rows: readonly Pick<MessageRow, 'role' | 'content' | 'noAnswer' | 'reeId' | 'id' | 'requestId'>[],
  reeId: string,
): { role: 'user' | 'assistant'; content: string }[] {
  const answered = new Set(rows.filter((row) => row.role === 'ree' && !row.noAnswer && row.reeId === reeId).map((row) => row.requestId));
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const row of rows) {
    if (row.role === 'user' && answered.has(row.id)) turns.push({ role: 'user', content: row.content });
    if (row.role === 'ree' && !row.noAnswer && row.reeId === reeId) turns.push({ role: 'assistant', content: row.content });
  }
  return turns.slice(-HISTORY_TURNS * 2);
}

/* ---------------------------------------------------------------- retrieval */

export interface Retrieval {
  passages: Passage[];
  evidence: boolean;
  bestSimilarity: number | null;
  model: string;
}

/** Passages answers may use: ready, enabled ("参与回答") and not in the trash (8.2). Explore's second level uses the same. */
export function answerable(): SQL[] {
  return [eq(schema.knowledge.status, 'ready'), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)];
}

/**
 * Vector and keyword recall over this Ree's ready passages, fused by rank.
 * The vector leg is an exact scan of the Ree's own passages (the `+ 0`
 * keeps the planner off the global HNSW index, which filters after it
 * searches and can miss a small Ree's rows entirely).
 */
export async function retrieve(reeId: string, question: string, embedded?: QuestionVector): Promise<Retrieval> {
  const database = db();
  const { vector, model } = embedded ?? (await embedQuestion(question));
  const literal = `[${vector.join(',')}]`;
  const semantic = await database
    .select({
      id: schema.chunk.id,
      knowledgeId: schema.chunk.knowledgeId,
      content: schema.chunk.content,
      locator: schema.chunk.locator,
      title: schema.knowledge.title,
      kind: schema.knowledge.kind,
      similarity: sql<number>`1 - (${schema.chunk.embedding} <=> ${literal}::vector)`,
    })
    .from(schema.chunk)
    .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.chunk.knowledgeId))
    .where(and(eq(schema.chunk.reeId, reeId), ...answerable()))
    .orderBy(sql`(${schema.chunk.embedding} <=> ${literal}::vector) + 0`)
    .limit(RETRIEVAL_RECALL);

  const terms = searchTerms(question);
  const keywordRows = terms.length
    ? await database
        .select({
          id: schema.chunk.id,
          knowledgeId: schema.chunk.knowledgeId,
          content: schema.chunk.content,
          locator: schema.chunk.locator,
          title: schema.knowledge.title,
          kind: schema.knowledge.kind,
        })
        .from(schema.chunk)
        .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.chunk.knowledgeId))
        .where(
          and(
            eq(schema.chunk.reeId, reeId),
            ...answerable(),
            sql`(${sql.join(terms.map((term) => sql`${schema.chunk.content} ilike ${likePattern(term)}`), sql` or `)})`,
          ),
        )
        .limit(200)
    : [];
  const keyword = keywordRows
    .map((row) => ({ ...row, coverage: keywordCoverage(terms, row.content) }))
    .filter((row) => row.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, RETRIEVAL_RECALL);

  const byId = new Map<string, Omit<Passage, 'chunkId' | 'similarity'> & { similarity: number }>();
  for (const row of semantic) byId.set(row.id, { ...row, similarity: Number(row.similarity) });
  for (const row of keyword) if (!byId.has(row.id)) byId.set(row.id, { ...row, similarity: 0 });
  const order = fuse([semantic.map((row) => row.id), keyword.map((row) => row.id)]).slice(0, RETRIEVAL_TOP_K);
  const passages: Passage[] = order.map((id) => {
    const row = byId.get(id)!;
    return {
      chunkId: id,
      knowledgeId: row.knowledgeId,
      title: row.title,
      kind: row.kind,
      content: row.content,
      locator: row.locator,
      similarity: row.similarity,
    };
  });
  const bestSimilarity = semantic.length ? Number(semantic[0]!.similarity) : null;
  const evidence = passages.length > 0 && hasEvidence({ bestSimilarity, bestCoverage: keyword[0]?.coverage ?? 0, terms: terms.length });
  /* A question about the sources themselves also sees each source whole, the closest sources first. */
  if (isLibraryQuestion(question)) {
    const overviews = await sourceOverviews(reeId, [...new Set(semantic.map((row) => row.knowledgeId))]);
    if (overviews.length) return { passages: [...overviews, ...passages], bestSimilarity, evidence: true, model };
  }
  return { passages, bestSimilarity, evidence, model };
}

/** Characters read from each end of a source to build its overview (more than the overview keeps). */
const OVERVIEW_READ_CHARS = 2000;

/**
 * Overviews of a Ree's answerable sources, built from the stored text at
 * question time (nothing to keep in sync, nothing to backfill): the sources
 * recall ranked first, then the most recently updated.
 */
export async function sourceOverviews(reeId: string, ranked: readonly string[]): Promise<Passage[]> {
  const k = schema.knowledge;
  const rows = await db()
    .select({
      id: k.id,
      title: k.title,
      kind: k.kind,
      chars: sql<number>`char_length(coalesce(${k.content}, ''))`,
      head: sql<string>`left(coalesce(${k.content}, ''), ${OVERVIEW_READ_CHARS})`,
      tail: sql<string>`right(coalesce(${k.content}, ''), ${OVERVIEW_READ_CHARS})`,
      parts: sql<number>`jsonb_array_length(coalesce(${k.children}, '[]'::jsonb))`,
      seconds: sql<number | null>`case when ${k.kind} = 'audio' then (${k.children} -> -1 ->> 'end')::float end`,
      labels: sql<string[] | null>`case when ${k.kind} in ('github', 'site') then (select jsonb_agg(c ->> 'label') from (select jsonb_array_elements(${k.children}) as c limit 20) as first) end`,
    })
    .from(k)
    .where(and(eq(k.reeId, reeId), ...answerable()))
    .orderBy(ranked.length ? sql`case when ${inArray(k.id, [...ranked])} then 0 else 1 end` : sql`1`, desc(k.updatedAt))
    .limit(RETRIEVAL_OVERVIEWS_MAX);
  const rank = (id: string) => (ranked.includes(id) ? ranked.indexOf(id) : ranked.length);
  return rows
    .filter((row) => row.chars > 0)
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((row) => ({
      chunkId: `overview:${row.id}`,
      knowledgeId: row.id,
      title: row.title,
      kind: row.kind,
      content: overviewText({
        kind: row.kind,
        chars: Number(row.chars),
        parts: Number(row.parts),
        seconds: row.seconds === null ? null : Number(row.seconds),
        labels: row.labels,
        head: row.head,
        tail: row.tail,
      }),
      locator: { overview: true },
      similarity: 0,
    }));
}

export interface QuestionVector {
  vector: number[];
  model: string;
}

/** One embedding per question, shared by every asked Ree and by the suggestions. */
export async function embedQuestion(question: string): Promise<QuestionVector> {
  const { vectors, endpoint } = await embedTexts([question]);
  return { vector: vectors[0]!, model: endpoint.model };
}

