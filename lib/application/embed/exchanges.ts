/**
 * What the widget was asked, and what it answered: the owner's view of
 * their visitors' questions. requirement.md 9.4.
 *
 * Recorded by the ask route once an exchange has ended, off the request
 * path: a lost row costs the owner one line of history, failing the
 * visitor over it would cost them an answer. Read on the library's page,
 * newest first, with a figure for how many questions the library could not
 * answer -- those are the ones worth writing a page for.
 */
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import { normaliseOrigin } from '@/lib/domain/site-key';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export type WidgetOutcome = 'answer' | 'no_context' | 'degraded' | 'not_ready' | 'unavailable';

/** How much of a question and an answer is kept: a line of history, not a transcript. */
export const EXCHANGE_LIMITS = { questionChars: 2_000, answerChars: 4_000, sources: 8 } as const;

export interface RecordExchangeInput {
  libraryId: string;
  workspaceId: string;
  siteKeyId: string;
  origin: string | null | undefined;
  preview: boolean;
  question: string;
  rewrittenQuery: string | null;
  outcome: WidgetOutcome;
  answer: string | null;
  sources: { url: string; title: string }[];
  latencyMs: number;
}

export async function recordWidgetExchange(input: RecordExchangeInput): Promise<void> {
  await db()
    .insert(schema.widgetExchange)
    .values({
      id: uuidv7(),
      libraryId: input.libraryId,
      workspaceId: input.workspaceId,
      siteKeyId: input.siteKeyId,
      origin: (input.origin ? normaliseOrigin(input.origin) : null) ?? '',
      preview: input.preview,
      question: input.question.slice(0, EXCHANGE_LIMITS.questionChars),
      rewrittenQuery: input.rewrittenQuery,
      outcome: input.outcome,
      answer: input.answer ? input.answer.slice(0, EXCHANGE_LIMITS.answerChars) : null,
      sources: input.sources.slice(0, EXCHANGE_LIMITS.sources),
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
    });
}

/** Fire-and-forget form for the route: never throws, never awaited. */
export function noteWidgetExchange(input: RecordExchangeInput): void {
  recordWidgetExchange(input).catch((error: unknown) => {
    console.error(`widget exchange not recorded: ${error instanceof Error ? error.message : 'unknown'}`);
  });
}

export interface WidgetExchangeView {
  id: string;
  origin: string;
  preview: boolean;
  question: string;
  rewrittenQuery: string | null;
  outcome: WidgetOutcome;
  answer: string | null;
  sources: { url: string; title: string }[];
  latencyMs: number | null;
  createdAt: string;
}

export const EXCHANGE_PAGE_SIZE = 20;

/** The library's exchanges, newest first. The library must be the workspace's own. */
export async function listWidgetExchanges(input: {
  workspaceId: string;
  libraryId: string;
  limit?: number;
  offset?: number;
}): Promise<{ exchanges: WidgetExchangeView[]; total: number }> {
  const scope = and(
    eq(schema.widgetExchange.workspaceId, input.workspaceId),
    eq(schema.widgetExchange.libraryId, input.libraryId),
  );
  const [rows, [counted]] = await Promise.all([
    db()
      .select()
      .from(schema.widgetExchange)
      .where(scope)
      .orderBy(desc(schema.widgetExchange.createdAt), desc(schema.widgetExchange.id))
      .limit(Math.max(1, Math.min(100, input.limit ?? EXCHANGE_PAGE_SIZE)))
      .offset(Math.max(0, input.offset ?? 0)),
    db().select({ n: count() }).from(schema.widgetExchange).where(scope),
  ]);
  return {
    total: counted?.n ?? 0,
    exchanges: rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      preview: row.preview,
      question: row.question,
      rewrittenQuery: row.rewrittenQuery,
      outcome: row.outcome as WidgetOutcome,
      answer: row.answer,
      sources: row.sources,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export interface WidgetExchangeStats {
  days: number;
  /** Visitors' questions in the window; previews excluded. */
  questions: number;
  answered: number;
  /** Nothing relevant found, or the library was not ready: the gaps. */
  missed: number;
}

export async function widgetExchangeStats(input: {
  workspaceId: string;
  libraryId: string;
  days?: number;
}): Promise<WidgetExchangeStats> {
  const days = input.days ?? 30;
  const since = new Date(Date.now() - days * 86_400_000);
  const [row] = await db()
    .select({
      questions: sql<number>`count(*)::int`,
      answered: sql<number>`(count(*) filter (where ${schema.widgetExchange.outcome} in ('answer', 'degraded')))::int`,
      missed: sql<number>`(count(*) filter (where ${schema.widgetExchange.outcome} in ('no_context', 'not_ready')))::int`,
    })
    .from(schema.widgetExchange)
    .where(
      and(
        eq(schema.widgetExchange.workspaceId, input.workspaceId),
        eq(schema.widgetExchange.libraryId, input.libraryId),
        eq(schema.widgetExchange.preview, false),
        gte(schema.widgetExchange.createdAt, since),
      ),
    );
  return { days, questions: row?.questions ?? 0, answered: row?.answered ?? 0, missed: row?.missed ?? 0 };
}
