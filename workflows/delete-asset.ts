/**
 * Workflow: delete-asset
 *
 * Every step must be idempotent and resumable, deduped by digest and operation id.
 * architecture.md 8.2.
 *
 * The second half of a delete (architecture.md 8.4). The request has already
 * made the asset unreachable and queued one Delete Operation; this runs it
 * to completion -- chunk rows, objects, cache -- through the same
 * `runOperation` the builds use, so a purge that fails goes back to the queue
 * and the scheduled drain (`refresh-asset`) retries it. The console and the
 * dashboard call this after their response, the way a refresh is run, so the
 * content is usually gone by the time the page reloads.
 */
import { runOperation, type OperationOutcome } from '@/lib/application/ingestion';

export async function run(operationId: string): Promise<OperationOutcome> {
  return runOperation({ operationId });
}
