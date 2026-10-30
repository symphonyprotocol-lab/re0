/**
 * The scheduled queue drain. architecture.md 8.4.
 *
 * Every build is kicked off right after the response that queued it
 * (`after(runOperation)` in the dashboard and console actions), so for those
 * this is the safety net: operations whose follow-up run died with the function,
 * retries of failed ones, and the upload sweep that runs at the end of each
 * drain. It is also the schedule: each call first queues a refresh for every
 * platform source whose policy says it is due (`scheduleDueRefreshes`), and
 * it publishes the posts and episodes scheduled for now (6.5). Clearing A2A
 * task bodies past their 30 days moved to the daily /api/cron/retention
 * (agent-first-proposal.md 7.9, 10).
 * Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`;
 * anything else is a 401, so the route cannot be used to make the platform
 * do work on demand.
 */
import { NextResponse } from 'next/server';
import { drainOperations, isIngestionConfigured, scheduleDueRefreshes } from '@/lib/application/ingestion';
import { syncBuildTasks } from '@/lib/application/a2a/task-events';
import { expireActions } from '@/lib/application/agent';
import { publishDueDrafts } from '@/lib/application/editorial';

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }
  /*
   * Policies first, then the queue: a source that fell due since the last
   * drain is queued here and built in the same call. Not when the deployment
   * cannot build -- queuing work that fails on the spot would only mark
   * libraries failed for a missing provider key.
   */
  const scheduled = (await isIngestionConfigured()) ? await scheduleDueRefreshes() : [];
  /* Scheduled posts and episodes whose time has come queue their builds here too (proposal 6.5). */
  const due = await publishDueDrafts().catch((error: unknown) => {
    console.error(`scheduled publication failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { published: [], operations: [] };
  });
  const outcomes = await drainOperations({ limit: 10 });
  /*
   * Pending actions undecided for 24 hours expire, failing the A2A tasks
   * that waited on them; tasks following a build catch up with it and send
   * their push notifications (agent-first-proposal.md 5.2, 7.6).
   */
  const expiredActions = await expireActions().catch((error: unknown) => {
    console.error(`agent action expiry failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return 0;
  });
  const syncedTasks = await syncBuildTasks().catch((error: unknown) => {
    console.error(`a2a build sync failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return 0;
  });

  return NextResponse.json(
    {
      scheduled: scheduled.length,
      publishedDrafts: due.published.length,
      drained: outcomes.length,
      outcomes: outcomes.map((outcome) => outcome.status),
      expiredActions,
      syncedTasks,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
