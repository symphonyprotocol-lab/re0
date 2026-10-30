/**
 * Workflow: refresh-asset
 *
 * Every step must be idempotent and resumable, deduped by digest and operation id.
 * architecture.md 8.2.
 *
 * The cron entry point. It drains whatever is pending in `workflow_operation`,
 * which is the same queue an operator fills by pressing Refresh in the console
 * -- one queue, one worker, whichever side put the row there. Idempotence and
 * resumability live in `runOperation`: claiming is a conditional update, an
 * unchanged source digest ends the run without creating a version, and a
 * retriable failure puts the row back to `pending` for the next drain rather
 * than losing it.
 */
import { drainOperations } from '@/lib/application/ingestion';

/** One drain's ceiling, so a scheduled run has a bounded duration. */
const BATCH = 10;

export async function run(): Promise<void> {
  const outcomes = await drainOperations({ limit: BATCH });
  if (outcomes.length === 0) return;

  const counts = outcomes.reduce<Record<string, number>>((tally, outcome) => {
    tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
    return tally;
  }, {});

  /*
   * Counts only. architecture.md 17.1 keeps source URLs, titles and fetched
   * content out of logs, and a per-asset line here would put all three in.
   */
  console.info(`refresh-asset drained ${outcomes.length}: ${JSON.stringify(counts)}`);
}
