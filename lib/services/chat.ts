/**
 * The single-Ree test conversation (`conversation.kind = ree_test`) and the
 * retrieval it answers from (rebuild-proposal.md 5).
 */
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { HISTORY_TURNS, RETRIEVAL_RECALL, RETRIEVAL_TOP_K } from '@/lib/constants';
import type { Passage } from '@/lib/domain/answer';
import type { ReeOutcome, ReeUIMessage } from '@/lib/domain/chat-message';
import { fuse, hasEvidence, keywordCoverage, searchTerms } from '@/lib/domain/retrieval';
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

export async function messagesOf(conversationId: string): Promise<MessageRow[]> {
  return db()
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, conversationId))
    .orderBy(asc(schema.message.createdAt));
}

export function outcomeOf(row: MessageRow): ReeOutcome {
  return {
    messageId: row.id,
    noAnswer: row.noAnswer,
    reason: row.noAnswerReason ?? null,
    cost: row.costCredits,
    citations: row.citations,
    model: null,
    failed: false,
  };
}

/** Stored rows as `useChat` messages. */
export function toUIMessages(rows: readonly MessageRow[]): ReeUIMessage[] {
  return rows.map((row) =>
    row.role === 'user'
      ? { id: row.id, role: 'user', parts: [{ type: 'text', text: row.content }] }
      : {
          id: row.id,
          role: 'assistant',
          parts: [
            ...(row.content ? [{ type: 'text' as const, text: row.content }] : []),
            { type: 'data-outcome' as const, data: outcomeOf(row) },
          ],
        },
  );
}

/** Clearing deletes messages only; the ledger and usage stay (prototype "清空对话"). */
export async function clearConversation(conversationId: string): Promise<void> {
  await db().delete(schema.message).where(eq(schema.message.conversationId, conversationId));
}

/** This Ree's own earlier turns, answered ones only, newest last. */
export async function historyTurns(conversationId: string, reeId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const rows = await db()
    .select({ role: schema.message.role, content: schema.message.content, noAnswer: schema.message.noAnswer, reeId: schema.message.reeId, id: schema.message.id, requestId: schema.message.requestId })
    .from(schema.message)
    .where(eq(schema.message.conversationId, conversationId))
    .orderBy(asc(schema.message.createdAt));
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

/** Passages answers may use: ready, enabled ("参与回答") and not in the trash (8.2). */
function answerable(): SQL[] {
  return [eq(schema.knowledge.status, 'ready'), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)];
}

/**
 * Vector and keyword recall over this Ree's ready passages, fused by rank.
 * The vector leg is an exact scan of the Ree's own passages (the `+ 0`
 * keeps the planner off the global HNSW index, which filters after it
 * searches and can miss a small Ree's rows entirely).
 */
export async function retrieve(reeId: string, question: string): Promise<Retrieval> {
  const database = db();
  const { vectors, endpoint } = await embedTexts([question]);
  const literal = `[${vectors[0]!.join(',')}]`;
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
  return {
    passages,
    bestSimilarity,
    evidence: passages.length > 0 && hasEvidence({ bestSimilarity, bestCoverage: keyword[0]?.coverage ?? 0, terms: terms.length }),
    model: endpoint.model,
  };
}

