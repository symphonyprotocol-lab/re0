/**
 * What a showcase page sees of its visitors: views, questions and CTA
 * clicks per UTC day, and the thumbs a visitor gives an answer.
 *
 * Counters, not audit facts: written off the request path and dropped with
 * the page. The question count rides on the widget's exchange log, which is
 * the one table the dashboard already reads for "what was asked".
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export type ShowcaseEvent = 'view' | 'question' | 'cta_click' | 'lead';

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function recordShowcaseEvent(showcaseId: string, event: ShowcaseEvent, now: Date = new Date()): Promise<void> {
  const view = event === 'view' ? 1 : 0;
  const question = event === 'question' ? 1 : 0;
  const cta = event === 'cta_click' ? 1 : 0;
  const lead = event === 'lead' ? 1 : 0;
  await db()
    .insert(schema.assetShowcaseDaily)
    .values({ showcaseId, day: utcDay(now), views: view, questions: question, ctaClicks: cta, leads: lead })
    .onConflictDoUpdate({
      target: [schema.assetShowcaseDaily.showcaseId, schema.assetShowcaseDaily.day],
      set: {
        views: sql`${schema.assetShowcaseDaily.views} + ${view}`,
        questions: sql`${schema.assetShowcaseDaily.questions} + ${question}`,
        ctaClicks: sql`${schema.assetShowcaseDaily.ctaClicks} + ${cta}`,
        leads: sql`${schema.assetShowcaseDaily.leads} + ${lead}`,
      },
    });
}

/** Fire-and-forget form for the routes: never throws, never awaited. */
export function noteShowcaseEvent(showcaseId: string, event: ShowcaseEvent): void {
  recordShowcaseEvent(showcaseId, event).catch(() => {});
}

export interface ShowcaseStats {
  days: number;
  views: number;
  questions: number;
  ctaClicks: number;
  leads: number;
}

export async function showcaseStats(input: { workspaceId: string; assetId: string; days?: number }): Promise<ShowcaseStats | null> {
  const days = input.days ?? 30;
  const [page] = await db()
    .select({ id: schema.assetShowcase.id })
    .from(schema.assetShowcase)
    .where(
      and(
        eq(schema.assetShowcase.workspaceId, input.workspaceId),
        eq(schema.assetShowcase.assetId, input.assetId),
        isNull(schema.assetShowcase.deletedAt),
      ),
    )
    .limit(1);
  if (!page) return null;
  const since = utcDay(new Date(Date.now() - days * 86_400_000));
  const rows = await db()
    .select()
    .from(schema.assetShowcaseDaily)
    .where(and(eq(schema.assetShowcaseDaily.showcaseId, page.id), gte(schema.assetShowcaseDaily.day, since)));
  return {
    days,
    views: rows.reduce((sum, row) => sum + row.views, 0),
    questions: rows.reduce((sum, row) => sum + row.questions, 0),
    ctaClicks: rows.reduce((sum, row) => sum + row.ctaClicks, 0),
    leads: rows.reduce((sum, row) => sum + row.leads, 0),
  };
}

/**
 * A visitor's verdict on one answer. The exchange must belong to the page's
 * own site key, so a guessed id from another asset changes nothing.
 */
export async function recordShowcaseFeedback(input: {
  siteKeyId: string;
  exchangeId: string;
  feedback: 'helpful' | 'unhelpful' | null;
}): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/.test(input.exchangeId)) return false;
  const updated = await db()
    .update(schema.widgetExchange)
    .set({ feedback: input.feedback })
    .where(and(eq(schema.widgetExchange.id, input.exchangeId), eq(schema.widgetExchange.siteKeyId, input.siteKeyId)))
    .returning({ id: schema.widgetExchange.id });
  return updated.length > 0;
}
