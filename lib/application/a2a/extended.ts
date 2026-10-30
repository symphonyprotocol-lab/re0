/**
 * The facts an extended card states about its caller (agent-first-proposal.md
 * 7.2): what is left of the workspace's Calls and capacity, and of today's
 * `ask` answers. Read when the card is asked for; a card is a snapshot.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { activeRetrievalSettings } from '@/lib/application/administration';
import { ASK_OPERATION } from '@/lib/application/agent';
import { quoteBuild, utcDayStart, workspaceStorage } from '@/lib/application/plans';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import type { CallerQuota } from './card';

export async function callerQuota(workspaceId: string): Promise<CallerQuota> {
  const [quote, storage, settings, [answers]] = await Promise.all([
    quoteBuild({ workspaceId, fetchesPages: false }),
    workspaceStorage(workspaceId),
    activeRetrievalSettings(),
    db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.usageEvent)
      .where(
        and(
          eq(schema.usageEvent.workspaceId, workspaceId),
          eq(schema.usageEvent.operation, ASK_OPERATION),
          gte(schema.usageEvent.createdAt, utcDayStart()),
        ),
      ),
  ]);
  return {
    planAllowanceRemaining: quote.planAllowanceRemaining,
    addonBalanceRemaining: quote.addonBalanceRemaining,
    capacityBytes: storage.capacityBytes,
    usedBytes: storage.usedBytes,
    askCallsPerAnswer: settings.askCallsPerAnswer,
    askDailyAnswers: settings.askDailyAnswers,
    answersToday: Number(answers?.n ?? 0),
  };
}
