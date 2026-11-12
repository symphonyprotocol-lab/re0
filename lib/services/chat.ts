/**
 * The single-Ree test conversation (`conversation.kind = ree_test`) and the
 * retrieval it answers from (rebuild-proposal.md 5).
 */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { HISTORY_TURNS, RETRIEVAL_KEYWORD_ROWS, RETRIEVAL_OVERVIEWS_MAX, RETRIEVAL_RECALL, RETRIEVAL_TOP_K } from '@/lib/constants';
import type { Passage } from '@/lib/domain/answer';
import { checkPartId, SYNTHESIS_PART_ID, TEXT_META_KEY, textPartId, type ReeOutcome, type ReeUIMessage, type SuggestedRee, type SynthesisPart } from '@/lib/domain/chat-message';
import { rewriteTarget } from '@/lib/domain/cross-lingual';
import { fuse, hasEvidence, isLibraryQuestion, keywordCoverage, overviewText, searchTerms } from '@/lib/domain/retrieval';
import { embedTexts } from '@/lib/infra/ai/models';
import { db, schema } from '@/lib/infra/db';
import { chunkVector, spaceOf } from '@/lib/services/embedding-space';
import type { Rewriter } from '@/lib/services/question-rewrite';

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
  /** The rewrite searched in the question's place, when the knowledge near it is in another language (cross-lingual.ts). */
  rewrite: string | null;
}

/** Passages answers may use: ready, enabled ("参与回答") and not in the trash (8.2). Explore's second level uses the same. */
export function answerable(): SQL[] {
  return [eq(schema.knowledge.status, 'ready'), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)];
}

type Recalled = Omit<Passage, 'chunkId' | 'similarity'> & { id: string };

/**
 * The vector leg: an exact scan of the Ree's own passages (the `+ 0` keeps
 * the planner off the global HNSW index, which filters after it searches
 * and can miss a small Ree's rows entirely), nearest first.
 */
async function semanticRecall(reeId: string, embedded: QuestionVector): Promise<(Recalled & { similarity: number })[]> {
  const literal = `[${embedded.vector.join(',')}]`;
  /* Only passages with a vector in the question's space: never a comparison across models (embedding-space.ts). */
  const stored = chunkVector(embedded.space);
  const rows = await db()
    .select({
      id: schema.chunk.id,
      knowledgeId: schema.chunk.knowledgeId,
      content: schema.chunk.content,
      locator: schema.chunk.locator,
      title: schema.knowledge.title,
      kind: schema.knowledge.kind,
      similarity: sql<number>`1 - (${stored} <=> ${literal}::vector)`,
    })
    .from(schema.chunk)
    .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.chunk.knowledgeId))
    .where(and(eq(schema.chunk.reeId, reeId), ...answerable(), sql`${stored} is not null`))
    .orderBy(sql`(${stored} <=> ${literal}::vector) + 0`)
    .limit(RETRIEVAL_RECALL);
  return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
}

/**
 * The keyword leg: the passages holding the largest share of `terms`, word
 * for word. The rows read are those matching the most terms (not the first
 * that match any): a term found in nearly every passage -- the product's own
 * name in its docs -- must not fill the read with passages that have
 * nothing else. Each passage is lowered once (`offset 0` keeps the planner
 * from inlining it into every term).
 */
async function keywordRecall(reeId: string, terms: readonly string[]): Promise<(Recalled & { coverage: number })[]> {
  if (terms.length === 0) return [];
  const c = schema.chunk;
  const k = schema.knowledge;
  const hits = sql.join(terms.map((term) => sql`(strpos(lowered.text, ${term}) > 0)::int`), sql` + `);
  const result = await db().execute<Recalled & { hits: number }>(sql`
    select * from (
      select ${c.id} as id, ${c.knowledgeId} as "knowledgeId", ${c.content} as content, ${c.locator} as locator, ${k.title} as title, ${k.kind} as kind, ${hits} as hits
      from ${c}
      inner join ${k} on ${k.id} = ${c.knowledgeId}
      cross join lateral (select lower(${c.content}) as text offset 0) as lowered
      where ${and(eq(c.reeId, reeId), ...answerable())}
    ) as matched
    where hits > 0
    order by hits desc
    limit ${RETRIEVAL_KEYWORD_ROWS}`);
  return result.rows
    .map(({ hits: _hits, ...row }) => ({ ...row, coverage: keywordCoverage(terms, row.content) }))
    .filter((row) => row.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, RETRIEVAL_RECALL);
}

/**
 * Vector and keyword recall over this Ree's ready passages, fused by rank.
 * With `rewrite`, a question whose recall is nearly all in another language
 * (a Chinese question over English docs) is searched again as its rewrite
 * into that language, and the rewrite's two legs rank the passages: the
 * question's own legs only matched the product's name in every passage,
 * and even at a fraction of the weight they tip rank fusion's near-ties
 * towards those (cross-lingual.ts). The own vector leg still counts for
 * whether anything is close enough, and stands in should both of the
 * rewrite's legs come back empty.
 */
export async function retrieve(reeId: string, question: string, embedded?: QuestionVector, options: { rewrite?: Rewriter } = {}): Promise<Retrieval> {
  const asked = embedded ?? (await embedQuestion(question));
  const terms = searchTerms(question);
  const [semantic, keyword] = await Promise.all([semanticRecall(reeId, asked), keywordRecall(reeId, terms)]);

  const target = options.rewrite ? rewriteTarget(question, semantic.map((row) => row.content)) : null;
  const rewrite = target ? await options.rewrite!(target) : null;
  /* A model switch between the two embeddings leaves the rewrite's vector in another space: its keyword leg still counts. */
  const [again, rewriteKeyword] = rewrite
    ? await Promise.all([rewrite.vector && rewrite.vector.space === asked.space ? semanticRecall(reeId, rewrite.vector) : [], keywordRecall(reeId, rewrite.terms)])
    : [[], []];
  const searched = rewrite && (again.length > 0 || rewriteKeyword.length > 0) ? rewrite : null;
  const legs = searched ? { lists: [again, rewriteKeyword], keyword: rewriteKeyword, terms: searched.terms } : { lists: [semantic, keyword], keyword, terms };

  const byId = new Map<string, Recalled & { similarity: number }>();
  for (const row of [...semantic, ...again]) {
    const seen = byId.get(row.id);
    if (!seen || row.similarity > seen.similarity) byId.set(row.id, row);
  }
  for (const row of legs.keyword) if (!byId.has(row.id)) byId.set(row.id, { ...row, similarity: 0 });
  const order = fuse(legs.lists.map((list) => list.map((row) => row.id))).slice(0, RETRIEVAL_TOP_K);
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
  const nearest = [semantic[0]?.similarity, again[0]?.similarity].filter((value): value is number => value !== undefined);
  const bestSimilarity = nearest.length ? Math.max(...nearest) : null;
  const evidence = passages.length > 0 && hasEvidence({ bestSimilarity, bestCoverage: legs.keyword[0]?.coverage ?? 0, terms: legs.terms.length });
  const model = asked.model;
  const rewritten = searched ? searched.query || searched.terms.join(' ') : null;
  /* A question about the sources themselves also sees each source whole, the closest sources first. */
  if (isLibraryQuestion(question)) {
    const overviews = await sourceOverviews(reeId, [...new Set([...semantic, ...again].map((row) => row.knowledgeId))]);
    if (overviews.length) return { passages: [...overviews, ...passages], bestSimilarity, evidence: true, model, rewrite: rewritten };
  }
  return { passages, bestSimilarity, evidence, model, rewrite: rewritten };
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
  /** The embedding space `vector` is in; retrieval compares it with that space's vectors only. */
  space: string;
}

/** One embedding per question, shared by every asked Ree and by the suggestions. */
export async function embedQuestion(question: string): Promise<QuestionVector> {
  const { vectors, endpoint } = await embedTexts([question]);
  return { vector: vectors[0]!, model: endpoint.model, space: spaceOf(endpoint) };
}

