/**
 * What the MCP server's four tools do, apart from the protocol: Ree lookup
 * and Q&A for the account behind an API key. Each answers plain data or a
 * `McpToolError`; `lib/http/mcp.ts` turns either into a tool result.
 *
 * Asking is billed exactly as on the web (`holdQuestion` / `runQuestion`):
 * the base fee and the owner's query fee held, settled when the Ree answers,
 * the fee credited to the owner. A question that would cost more than the
 * caller's `max_cost`, or more than their balance, is refused before
 * anything is saved or held.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { MCP_RATE_LIMIT, MCP_SEARCH_MAX, MCP_SOURCE_TITLES, QUERY_BASE_FEE, QUESTION_MAX_CHARS } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { isUuid } from '@/lib/domain/list';
import { appBaseUrl } from '@/lib/http/cookies';
import { db, schema } from '@/lib/infra/db';
import { collectAnswer, holdQuestion, maxCostFor, type Emit } from '@/lib/services/answer';
import type { ApiKeyCaller } from '@/lib/services/api-keys';
import { balanceOf } from '@/lib/services/credits';
import { usableBy } from '@/lib/services/conversations';
import { allowSearch, answersByOthers, explore, hitRateBucket, readySources } from '@/lib/services/explore';
import type { Ree } from '@/lib/services/rees';

export type McpErrorCode =
  | 'rate_limited'
  | 'not_found'
  | 'invalid_question'
  | 'invalid_conversation'
  | 'max_cost_exceeded'
  | 'insufficient_credits'
  | 'answer_failed'
  | 'internal_error';

export class McpToolError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** Where a caller tops up: the balance tab of their settings. */
export function topUpUrl(): string {
  return `${appBaseUrl()}/settings?tab=balance`;
}

/** One tool call against the key's and the account's per-minute limits. */
export async function allowToolCall(caller: ApiKeyCaller, now = new Date()): Promise<void> {
  const byKey = await hitRateBucket(`mcp:key:${caller.keyId}`, MCP_RATE_LIMIT.perKey, MCP_RATE_LIMIT.windowSeconds, now);
  const byUser = await hitRateBucket(`mcp:user:${caller.user.id}`, MCP_RATE_LIMIT.perUser, MCP_RATE_LIMIT.windowSeconds, now);
  if (!byKey || !byUser) {
    throw new McpToolError('rate_limited', `Too many calls: at most ${MCP_RATE_LIMIT.perKey} per minute per key and ${MCP_RATE_LIMIT.perUser} per account. Wait a minute and try again.`, {
      retry_after_seconds: MCP_RATE_LIMIT.windowSeconds,
    });
  }
}

/* ----------------------------------------------------------------- search */

export async function searchReesTool(caller: ApiKeyCaller, input: { query: string; limit?: number }, ip: string | null) {
  const query = input.query.trim().slice(0, QUESTION_MAX_CHARS);
  if (!(await allowSearch({ ip, userId: caller.user.id }))) {
    throw new McpToolError('rate_limited', 'Too many searches this minute. Wait a minute and try again.', { retry_after_seconds: 60 });
  }
  const limit = Math.min(Math.max(input.limit ?? MCP_SEARCH_MAX, 1), MCP_SEARCH_MAX);
  const found = await explore({ q: query, category: null, sort: 'active' }, { cursor: null, size: MCP_SEARCH_MAX }, { includeIntros: false });
  return {
    query,
    rees: found.items.slice(0, limit).map((card) => ({
      id: card.id,
      slug: card.slug,
      name: card.name,
      intro: card.description,
      category: card.category,
      tags: card.tags,
      owner: { name: card.ownerName, role: card.role },
      price_per_question: card.ownerId === caller.user.id ? QUERY_BASE_FEE : card.price,
      ready_sources: card.sources,
      answers: card.answers,
      positive_rate: card.positiveRate,
      matched_excerpt: card.excerpt,
      url: `${appBaseUrl()}/r/${card.slug}`,
    })),
  };
}

/* ---------------------------------------------------------------- one Ree */

const PUBLIC = sql<boolean>`(${schema.ree.isPublic} and ${schema.ree.isPublished} and ${schema.ree.moderatedAt} is null)`;

/** A Ree this caller may see and ask, by id or slug: their own live one, or a public one. */
export async function usableRee(userId: string, ref: string): Promise<(Ree & { ownerName: string; ownerRole: 'normal' | 'verified' | 'official' }) | null> {
  const key: string = ref.trim();
  if (!key) return null;
  const slug = /^[a-z0-9-]{1,80}$/i.test(key) ? key.toLowerCase() : null;
  const match = isUuid(key) ? eq(schema.ree.id, key) : slug ? eq(schema.ree.slug, slug) : null;
  if (!match) return null;
  const [row] = await db()
    .select({ ree: schema.ree, ownerName: schema.user.name, ownerRole: schema.user.role })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(and(match, usableBy(userId)))
    .limit(1);
  return row ? { ...row.ree, ownerName: row.ownerName, ownerRole: row.ownerRole } : null;
}

function notFound(ref: string): McpToolError {
  return new McpToolError('not_found', `No Ree "${ref}" that you can ask: it does not exist, is private to someone else, or was taken down. Use search_rees or list_my_rees to find one.`);
}

export async function getReeTool(caller: ApiKeyCaller, input: { ree: string }) {
  const ree = await usableRee(caller.user.id, input.ree);
  if (!ree) throw notFound(input.ree);
  const own = ree.ownerId === caller.user.id;
  const database = db();
  const kinds = await database
    .select({ kind: schema.knowledge.kind, status: schema.knowledge.status, count: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, ree.id), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)))
    .groupBy(schema.knowledge.kind, schema.knowledge.status);
  const ready = kinds.filter((row) => row.status === 'ready');
  const readyCount = ready.reduce((sum, row) => sum + Number(row.count), 0);
  const inProgress = kinds.filter((row) => row.status === 'pending' || row.status === 'processing').reduce((sum, row) => sum + Number(row.count), 0);
  /* Titles are the owner's to see; anyone else gets only what the public page shows, the counts. */
  const titles = own
    ? await database
        .select({ title: schema.knowledge.title, kind: schema.knowledge.kind })
        .from(schema.knowledge)
        .where(and(eq(schema.knowledge.reeId, ree.id), eq(schema.knowledge.status, 'ready'), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)))
        .orderBy(schema.knowledge.createdAt)
        .limit(MCP_SOURCE_TITLES)
    : [];
  const [stats] = await database.select({ answers: answersByOthers }).from(schema.ree).where(eq(schema.ree.id, ree.id));
  const isPublic = Boolean(ree.isPublic && ree.isPublished && !ree.moderatedAt);
  return {
    id: ree.id,
    slug: ree.slug,
    name: ree.name,
    intro: ree.description,
    category: ree.category,
    tags: ree.tags,
    owner: { name: ree.ownerName, role: ree.ownerRole, is_you: own },
    visibility: isPublic ? 'public' : 'private',
    url: isPublic ? `${appBaseUrl()}/r/${ree.slug}` : null,
    readiness: { ready: readyCount > 0, ready_sources: readyCount, sources_in_progress: inProgress },
    price: {
      per_question: maxCostFor(ree, caller.user.id),
      base_fee: QUERY_BASE_FEE,
      query_fee: own ? 0 : ree.queryFee,
      charged_only_when_answered: true,
    },
    knowledge: {
      sources_by_kind: Object.fromEntries(ready.map((row) => [row.kind, Number(row.count)])),
      sample_questions: ree.sampleQuestions,
      ...(own ? { source_titles: titles.map((row) => ({ title: row.title, kind: row.kind })) } : {}),
    },
    answers_to_others: Number(stats?.answers ?? 0),
  };
}

export async function listMyReesTool(caller: ApiKeyCaller) {
  const rows = await db()
    .select({
      id: schema.ree.id,
      slug: schema.ree.slug,
      name: schema.ree.name,
      description: schema.ree.description,
      isPublic: PUBLIC,
      isPublished: schema.ree.isPublished,
      moderatedAt: schema.ree.moderatedAt,
      queryFee: schema.ree.queryFee,
      sources: readySources,
      answers: answersByOthers,
      createdAt: schema.ree.createdAt,
    })
    .from(schema.ree)
    .where(and(eq(schema.ree.ownerId, caller.user.id), isNull(schema.ree.deletedAt)))
    .orderBy(sql`${schema.ree.createdAt} desc`);
  return {
    rees: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      intro: row.description,
      visibility: row.isPublic ? 'public' : 'private',
      taken_down: Boolean(row.moderatedAt),
      ready: Number(row.sources) > 0,
      ready_sources: Number(row.sources),
      query_fee_for_others: row.queryFee,
      price_per_question_for_you: QUERY_BASE_FEE,
      answers_to_others: Number(row.answers),
      created_at: row.createdAt.toISOString(),
    })),
  };
}

/* -------------------------------------------------------------------- ask */

export interface AskInput {
  ree: string;
  question: string;
  conversation_id?: string;
  max_cost?: number;
}

export interface AskProgress {
  /** Called as the answer is generated; best effort. */
  onEvent?: Emit;
}

function citationOut(citation: CitationSnapshot) {
  return { index: citation.index, source: citation.title, kind: citation.kind, locator: citation.locator, excerpt: citation.excerpt };
}

/** An MCP conversation of this caller with this Ree, or a new one when none is named. */
async function mcpConversation(userId: string, reeId: string, id: string | undefined) {
  if (id === undefined) return null;
  if (!isUuid(id)) throw new McpToolError('invalid_conversation', 'conversation_id is not one of your MCP conversations.');
  const [row] = await db()
    .select({ conversation: schema.conversation, reeId: schema.conversationRee.reeId })
    .from(schema.conversation)
    .leftJoin(schema.conversationRee, and(eq(schema.conversationRee.conversationId, schema.conversation.id), eq(schema.conversationRee.reeId, reeId)))
    .where(and(eq(schema.conversation.id, id), eq(schema.conversation.userId, userId), eq(schema.conversation.kind, 'mcp'), isNull(schema.conversation.deletedAt)))
    .limit(1);
  if (!row) throw new McpToolError('invalid_conversation', 'conversation_id is not one of your MCP conversations.');
  if (!row.reeId) throw new McpToolError('invalid_conversation', 'This conversation is with a different Ree. Leave conversation_id out to start a new one with this Ree.');
  return row.conversation;
}

export async function askReeTool(caller: ApiKeyCaller, input: AskInput, progress: AskProgress = {}) {
  const userId = caller.user.id;
  const question = input.question.trim();
  if (!question || question.length > QUESTION_MAX_CHARS) throw new McpToolError('invalid_question', `The question must be 1–${QUESTION_MAX_CHARS} characters.`);
  const ree = await usableRee(userId, input.ree);
  if (!ree) throw notFound(input.ree);
  const existing = await mcpConversation(userId, ree.id, input.conversation_id);

  const possible = maxCostFor(ree, userId);
  if (input.max_cost !== undefined && input.max_cost < possible) {
    throw new McpToolError('max_cost_exceeded', `Asking ${ree.name} can cost up to ${possible} credits, above your max_cost of ${input.max_cost}. Nothing was charged.`, {
      possible_cost: possible,
      max_cost: input.max_cost,
    });
  }
  const insufficient = (balance: number, needed: number) =>
    new McpToolError('insufficient_credits', `Not enough credits: this question needs ${needed} and your balance is ${balance}. Nothing was charged. Top up at ${topUpUrl()}`, {
      balance,
      needed,
      top_up_url: topUpUrl(),
    });
  /* Checked before a conversation is made, so a refused question leaves nothing behind. */
  const balance = await balanceOf(db(), userId);
  if (balance < possible) throw insufficient(balance, possible);

  const conversation =
    existing ??
    (await db().transaction(async (tx) => {
      const [row] = await tx.insert(schema.conversation).values({ userId, kind: 'mcp' }).returning();
      await tx.insert(schema.conversationRee).values({ conversationId: row!.id, reeId: ree.id });
      return row!;
    }));
  const holding = await holdQuestion({ userId, lang: caller.user.lang, conversation, targets: [ree], question, verify: false, apiKeyId: caller.keyId });
  if (!holding.ok) {
    /* Spent elsewhere in the meantime: the question was not saved; drop the conversation made for it. */
    if (!existing) await db().delete(schema.conversation).where(eq(schema.conversation.id, conversation.id));
    /* MCP sends no seen fees, so the price check never refuses here. */
    if (holding.reason !== 'insufficient') throw new Error('unexpected price check on an MCP question');
    throw insufficient(holding.balance, holding.needed);
  }
  const replies = await collectAnswer(holding.question, progress.onEvent);
  const reply = replies.get(ree.id)!;
  const outcome = reply.outcome;
  const base = { ree: { id: ree.id, slug: ree.slug, name: ree.name }, conversation_id: conversation.id };
  if (!outcome || outcome.failed) {
    throw new McpToolError('answer_failed', `${ree.name} could not answer just now. Nothing was charged; try again.`, { ...base, cost: 0 });
  }
  if (outcome.noAnswer) {
    return {
      ...base,
      status: 'no_answer' as const,
      reason: outcome.reason,
      explanation:
        outcome.reason === 'no_sources'
          ? `${ree.name} has no ready knowledge yet, so it cannot answer. Nothing was charged.`
          : `${ree.name}'s knowledge does not cover this question. Nothing was charged.`,
      answer: null,
      citations: [],
      cost: 0,
      message_id: outcome.messageId,
    };
  }
  return {
    ...base,
    status: 'answered' as const,
    answer: reply.text,
    citations: outcome.citations.map(citationOut),
    cost: outcome.cost,
    message_id: outcome.messageId,
  };
}
