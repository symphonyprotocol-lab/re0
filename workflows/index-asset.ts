/**
 * Workflow: index-asset
 *
 * Every step must be idempotent and resumable, deduped by digest and operation id.
 * architecture.md 8.2.
 *
 * One named operation, run to completion. `refresh-asset` is the scheduled
 * drain; this is the single-target entry the console uses after queueing a
 * refresh, so an operator who presses the button sees the result on the page
 * they are already looking at rather than at the next cron tick.
 *
 * Both go through `runOperation`, so "run it now" and "run it later" cannot
 * disagree about what a build is.
 */
import { runOperation, type OperationOutcome } from '@/lib/application/ingestion';

export async function run(operationId: string): Promise<OperationOutcome> {
  return runOperation({ operationId });
}
