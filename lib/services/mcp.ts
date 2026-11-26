/**
 * What the MCP server's Ree lookup and Q&A tools do, apart from the
 * protocol, and what every tool shares: its errors, the per-key limits, the
 * write permission and the web's own per-route limits. Posts are
 * mcp-posts.ts, a Ree's owner's work mcp-rees.ts. Each tool answers plain
 * data or a `McpToolError`; `lib/http/mcp.ts` turns either into a tool result.
 *
 * Every tool does what the web route for the same action does, through the
 * same service function, for the account behind the key: the same checks,
 * limits, prices and holds, nothing of its own beyond refusing a cost above
 * the caller's `max_cost`.
 *
 * Asking is a private post on the web (private-posts.ts, `source = 'api'`),
 * billed like any private question: the base fee and the owner's query fee
 * held, settled when the Ree answers, the fee credited to the owner. A question that would cost more than the
 * caller's `max_cost`, or more than their balance, is refused before
 * anything is saved or held.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { MCP_RATE_LIMIT, MCP_SEARCH_MAX, MCP_SOURCE_TITLES, QUERY_BASE_FEE, QUESTION_MAX_CHARS, REE_CATEGORIES } from '@/lib/constants';
import { EXPLORE_SORTS, type ExploreSort } from '@/lib/domain/explore';
import { rateLimited, type RateLimitName } from '@/lib/http/rate-limit';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { POST_DETAIL_MAX, POST_QUESTION_MAX } from '@/lib/domain/post';
import { isUuid } from '@/lib/domain/list';
import { appBaseUrl } from '@/lib/http/cookies';
import { db, schema } from '@/lib/infra/db';
import { maxCostFor, readyRees, type Emit } from '@/lib/services/grounded-answer';
import type { ApiKeyCaller } from '@/lib/services/api-keys';
import { balanceOf } from '@/lib/services/credits';
import { allowSearch, answersByOthers, explore, ExploreCursorError, hitRateBucket, readySources } from '@/lib/services/explore';
import { groundedAnswer, ownPrivatePost, type AnswerOne } from '@/lib/services/posts';
import { askPrivateFollowup, processPrivateFollowup, processPrivatePost, publishPrivatePost } from '@/lib/services/private-posts';
import { ownedRee, usableBy, type Ree } from '@/lib/services/rees';
import { favoriteReeIds } from '@/lib/services/ree-favorites';

export type McpErrorCode =
  | 'rate_limited'
  | 'not_found'
  | 'invalid_question'
  | 'invalid_conversation'
  | 'max_cost_exceeded'
  | 'insufficient_credits'
  | 'answer_failed'
  | 'write_not_allowed'
  | 'invalid_input'
  | 'limit_reached'
  | 'price_changed'
  | 'conflict'
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

/**
 * A tool that changes something: only a key made with "allow changes"
 * (`api_key.can_write`). Reading and `ask_ree` never need it.
 */
export function requireWrite(caller: ApiKeyCaller): void {
  if (caller.canWrite) return;
  throw new McpToolError(
    'write_not_allowed',
    `This API key may only read and ask. To post, follow up or manage Rees through MCP, create a key with "Allow changes" turned on at ${appBaseUrl()}/settings?tab=api and use it instead.`,
  );
}

/** The web route's own limit for the same action (lib/http/rate-limit.ts), counted for the account as the web counts it. */
export async function routeLimit(name: RateLimitName, caller: ApiKeyCaller): Promise<void> {
  const limited = await rateLimited(name, { userId: caller.user.id, headers: new Headers() });
  if (!limited) return;
  const retry = Number(limited.headers.get('retry-after')) || 60;
  throw new McpToolError('rate_limited', `Too many of these actions for now; the same limit applies on the web. Try again in ${retry} seconds.`, { retry_after_seconds: retry });
}

/** Work the web runs after its response (Next's `after`): reviews, matching, answers, knowledge processing. A cron sweep picks up anything it misses. */
export type Defer = (task: () => Promise<unknown>) => void;

/** Logs instead of throwing: a deferred task's failure is the sweep's to retry, never the caller's. */
export function quietly(label: string, task: () => Promise<unknown>): () => Promise<void> {
  return () => task().then(
    () => undefined,
    (error: unknown) => console.error(`mcp ${label} failed: ${error instanceof Error ? error.message : 'unknown'}`),
  );
}

export function insufficientCredits(balance: number, needed: number): McpToolError {
  return new McpToolError('insufficient_credits', `Not enough credits: this needs up to ${needed} and your balance is ${balance}. Nothing was charged. Top up at ${topUpUrl()}`, {
    balance,
    needed,
    top_up_url: topUpUrl(),
  });
}

/** `max_cost` below what the action can cost: refused before anything is saved or held. */
export function checkMaxCost(maxCost: number | undefined, possible: number, what: string): void {
  if (maxCost === undefined || maxCost >= possible) return;
  throw new McpToolError('max_cost_exceeded', `${what} can cost up to ${possible} credits, above your max_cost of ${maxCost}. Nothing was charged.`, { possible_cost: possible, max_cost: maxCost });
}

/** A web refusal code that is the caller's input, kept as `reason` so nothing of the web's precision is lost. */
export function invalidInput(reason: string, message: string, details: Record<string, unknown> = {}): McpToolError {
  return new McpToolError('invalid_input', message, { reason, ...details });
}

/** One of the caller's own live Rees, by id or slug; `not_found` for anyone else's, a deleted one or an unknown ref. */
export async function ownReeOf(userId: string, ref: string): Promise<Ree> {
  const key = ref.trim();
  let id: string | null = isUuid(key) ? key : null;
  if (!id && /^[a-z0-9-]{1,80}$/i.test(key)) {
    const [row] = await db()
      .select({ id: schema.ree.id })
      .from(schema.ree)
      .where(and(eq(schema.ree.slug, key.toLowerCase()), eq(schema.ree.ownerId, userId), isNull(schema.ree.deletedAt)))
      .limit(1);
    id = row?.id ?? null;
  }
  const ree = id ? await ownedRee(db(), userId, id) : null;
  if (!ree) throw new McpToolError('not_found', `No Ree "${ref}" of yours: it does not exist, belongs to someone else, or was deleted. list_my_rees lists yours.`);
  return ree;
}

/** The public page of a Ree that has one, else null. */
export function publicUrl(ree: Pick<Ree, 'slug' | 'isPublic' | 'isPublished' | 'moderatedAt' | 'deletedAt'>): string | null {
  return ree.isPublic && ree.isPublished && !ree.moderatedAt && !ree.deletedAt ? `${appBaseUrl()}/r/${ree.slug}` : null;
}

/* ----------------------------------------------------------------- search */

export interface SearchInput {
  query?: string;
  limit?: number;
  category?: string;
  sort?: string;
  cursor?: string;
}

/**
 * `/explore` for MCP: with a query, the question search (counted like the
 * web's, per account and address); without one, browsing the public Rees
 * by category and order a batch at a time (the web's `browse` limit), the
 * next batch from `next_cursor`.
 */
export async function searchReesTool(caller: ApiKeyCaller, input: SearchInput, ip: string | null) {
  const query = (input.query ?? '').trim().slice(0, QUESTION_MAX_CHARS);
  const category = input.category && (REE_CATEGORIES as readonly string[]).includes(input.category) ? (input.category as (typeof REE_CATEGORIES)[number]) : null;
  const sort: ExploreSort = (EXPLORE_SORTS as readonly string[]).includes(input.sort ?? '') ? (input.sort as ExploreSort) : 'active';
  if (query) {
    if (!(await allowSearch({ ip, userId: caller.user.id }))) {
      throw new McpToolError('rate_limited', 'Too many searches this minute. Wait a minute and try again.', { retry_after_seconds: 60 });
    }
  } else {
    await routeLimit('browse', caller);
  }
  const limit = Math.min(Math.max(input.limit ?? MCP_SEARCH_MAX, 1), MCP_SEARCH_MAX);
  let found;
  try {
    found = await explore({ q: query, category, sort }, { cursor: query ? null : (input.cursor ?? null), size: query ? MCP_SEARCH_MAX : limit }, { includeIntros: false });
  } catch (error) {
    if (error instanceof ExploreCursorError) throw invalidInput('invalid_cursor', 'cursor is not one search_rees handed out for this category and sort.');
    throw error;
  }
  const items = found.items.slice(0, limit);
  const favorites = new Set(await favoriteReeIds(caller.user.id, items.map((card) => card.id)));
  return {
    query: query || null,
    category,
    sort,
    total: found.total,
    next_cursor: found.nextCursor,
    rees: items.map((card) => ({
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
      favorite: favorites.has(card.id),
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
  const [favorite] = await favoriteReeIds(caller.user.id, [ree.id]);
  const failed = kinds.filter((row) => row.status === 'failed').reduce((sum, row) => sum + Number(row.count), 0);
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
    favorite: Boolean(favorite),
    /* What the owner's settings page shows, for their own Ree only (update_ree changes it). */
    ...(own
      ? {
          settings: {
            is_public: ree.isPublic,
            is_published: ree.isPublished,
            taken_down: Boolean(ree.moderatedAt),
            query_fee: ree.queryFee,
            system_prompt: ree.systemPrompt,
            color: ree.color,
            public_qa_enabled: ree.publicQaEnabled,
            answers_posts: ree.answersPosts,
            share_style: ree.shareStyle,
            sources_failed: failed,
            share_url: isPublic ? `${appBaseUrl()}/s/${ree.slug}` : null,
            manage_url: `${appBaseUrl()}/rees/${ree.id}`,
          },
        }
      : {}),
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
      setPublic: schema.ree.isPublic,
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
      is_public: row.setPublic,
      is_published: row.isPublished,
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

/** The longest question `ask_ree` takes: a post's question and its detail; a continuation (a follow-up) only a question's. */
export const MCP_QUESTION_MAX = POST_QUESTION_MAX + POST_DETAIL_MAX;

/** A long question becomes a post's question (cut at a space when there is one) and its detail, read together as one. */
export function splitQuestion(text: string): { question: string; detail: string } {
  if (text.length <= POST_QUESTION_MAX) return { question: text, detail: '' };
  const space = text.lastIndexOf(' ', POST_QUESTION_MAX);
  const cut = space > POST_QUESTION_MAX / 2 ? space : POST_QUESTION_MAX;
  return { question: text.slice(0, cut).trim(), detail: text.slice(cut).trim() };
}

/**
 * The caller's MCP thread (a private post they asked through MCP) this Ree is
 * in, or null when none is named: `conversation_id` is the post's id.
 */
async function mcpThread(userId: string, reeId: string, id: string | undefined): Promise<{ id: string } | null> {
  if (id === undefined) return null;
  const invalid = () => new McpToolError('invalid_conversation', 'conversation_id is not one of your MCP conversations.');
  if (!isUuid(id)) throw invalid();
  const [row] = await db()
    .select({ id: schema.post.id, inThread: sql<boolean>`exists (select 1 from ${schema.postAnswer} a where a.post_id = "post"."id" and a.ree_id = ${reeId})` })
    .from(schema.post)
    .where(and(eq(schema.post.id, id), eq(schema.post.source, 'api'), ownPrivatePost(userId)))
    .limit(1);
  if (!row) throw invalid();
  if (!row.inThread) throw new McpToolError('invalid_conversation', 'This conversation is with a different Ree. Leave conversation_id out to start a new one with this Ree.');
  return { id: row.id };
}

/**
 * Asks one Ree through MCP: a private post (`source = 'api'`, tagged with the
 * key) for a new question, or a private follow-up on the caller's MCP post
 * named by `conversation_id` -- billed as any private question
 * (private-posts.ts), answered before the call returns, with the text's
 * progress sent to the client. It appears under the caller's 我的帖子 → 私密.
 */
export async function askReeTool(caller: ApiKeyCaller, input: AskInput, progress: AskProgress = {}) {
  const userId = caller.user.id;
  const question = input.question.trim();
  const tooLong = (max: number) => new McpToolError('invalid_question', `The question must be 1–${max} characters${max === POST_QUESTION_MAX ? ' when it continues a conversation' : ''}.`);
  if (!question || question.length > MCP_QUESTION_MAX) throw tooLong(MCP_QUESTION_MAX);
  const ree = await usableRee(userId, input.ree);
  if (!ree) throw notFound(input.ree);
  const existing = await mcpThread(userId, ree.id, input.conversation_id);
  if (existing && question.length > POST_QUESTION_MAX) throw tooLong(POST_QUESTION_MAX);

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
  /* Checked before anything is saved, so a refused question leaves nothing behind. */
  const balance = await balanceOf(db(), userId);
  const ready = (await readyRees([ree.id])).has(ree.id);
  if (ready && balance < possible) throw insufficient(balance, possible);

  /* The price just checked is the one "shown": it can only have moved in the last instant. */
  const fees = { [ree.id]: possible };
  const asked = existing
    ? await askPrivateFollowup(userId, existing.id, { question, mentionReeIds: [ree.id], fees, lang: caller.user.lang }, { apiKeyId: caller.keyId })
    : await publishPrivatePost(userId, { ...splitQuestion(question), reeIds: [ree.id], fees, lang: caller.user.lang }, { source: 'api', apiKeyId: caller.keyId });
  if (!asked.ok) {
    switch (asked.error) {
      case 'insufficient_credits':
        throw insufficient(asked.balance, asked.needed);
      case 'empty':
      case 'too_long':
        throw tooLong(existing ? POST_QUESTION_MAX : MCP_QUESTION_MAX);
      case 'price_changed':
        throw new McpToolError('max_cost_exceeded', `${ree.name}'s price changed while you asked. Nothing was charged; ask again.`, { possible_cost: asked.prices[0]?.price ?? possible, max_cost: input.max_cost ?? null });
      case 'full':
        throw new McpToolError('invalid_conversation', 'This conversation is full. Leave conversation_id out to start a new one with this Ree.');
      case 'ree_unavailable':
        throw notFound(input.ree);
      default:
        throw new McpToolError('invalid_conversation', 'conversation_id is not one of your MCP conversations.');
    }
  }
  const postId = existing ? existing.id : asked.id;
  const followupId = existing ? asked.id : null;
  const emit = progress.onEvent;
  const answerOne: AnswerOne = (one) => groundedAnswer({ ...one, emit: emit ? (event) => emit(event) : undefined });
  if (followupId) await processPrivateFollowup(followupId, { answerOne });
  else await processPrivatePost(postId, { answerOne });

  const [reply] = await db()
    .select({ id: schema.postAnswer.id, state: schema.postAnswer.state, text: schema.postAnswer.text, citations: schema.postAnswer.citations, price: schema.postAnswer.price, baseHoldId: schema.postAnswer.baseHoldId })
    .from(schema.postAnswer)
    .where(and(eq(schema.postAnswer.postId, postId), followupId ? eq(schema.postAnswer.followupId, followupId) : isNull(schema.postAnswer.followupId), eq(schema.postAnswer.reeId, ree.id)))
    .limit(1);
  const base = { ree: { id: ree.id, slug: ree.slug, name: ree.name }, conversation_id: postId };
  if (!reply || (reply.state !== 'answered' && reply.state !== 'no_answer')) {
    throw new McpToolError('answer_failed', `${ree.name} could not answer just now. Nothing was charged; try again.`, { ...base, cost: 0 });
  }
  if (reply.state === 'no_answer') {
    const reason = ready ? ('out_of_scope' as const) : ('no_sources' as const);
    return {
      ...base,
      status: 'no_answer' as const,
      reason,
      explanation: reason === 'no_sources' ? `${ree.name} has no ready knowledge yet, so it cannot answer. Nothing was charged.` : `${ree.name}'s knowledge does not cover this question. Nothing was charged.`,
      answer: null,
      citations: [],
      cost: 0,
      message_id: reply.id,
    };
  }
  return {
    ...base,
    status: 'answered' as const,
    answer: reply.text,
    citations: reply.citations.map(citationOut),
    cost: reply.baseHoldId ? (reply.price ?? 0) : 0,
    message_id: reply.id,
  };
}
