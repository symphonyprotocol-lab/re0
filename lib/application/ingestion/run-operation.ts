/**
 * The worker side of the refresh queue.
 *
 * `manage-platform-libraries.ts` writes a `pending` row and returns; this is
 * what turns that row into a published version. The two halves are deliberately
 * unaware of each other: architecture.md 8.4 says a caller does not wait for a
 * refresh to execute, so the console must stay correct whether this runs a
 * second later, an hour later or not at all.
 *
 * Claiming is a conditional update, not a read followed by a write. Several
 * workers may drain the same queue -- the cron entry and the background run
 * that follows an operator pressing the button, at minimum -- and a claim that
 * two of them can win is a library built twice.
 */
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  IngestionFailure,
  isIngestionError,
  type IngestionErrorCode,
} from '@/lib/domain/ingestion';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import {
  openBuildCharge,
  releaseBuildCharge,
  settleBuildCharge,
  type BuildCharge,
  type SettledBuildCharge,
} from '@/lib/application/plans/build-quota';
import { BUILD_RESERVATION_TTL_MS } from '@/lib/application/plans/quota';
import { runModelReview } from '@/lib/application/review/model';
import { MODEL_REVIEW_OPERATION } from '@/lib/application/review/stages';
import { advanceLifecycleAfterBuild } from './advance-lifecycle';
import { buildVersion } from './build-version';
import { publishVersion } from './publish-version';
import { purgeLibrary } from './purge-library';
import { purgeAbandonedUploads } from './purge-uploads';
import type { IngestionDependencies } from './dependencies';

export type OperationOutcome =
  | { status: 'succeeded'; versionId: string; documents: number; chunks: number }
  | { status: 'reviewed'; outcome: 'reviewed' | 'deferred' | 'lost' | 'skipped' }
  | { status: 'purged'; documents: number; chunks: number; objects: number }
  | { status: 'skipped'; reason: 'unchanged' }
  | { status: 'failed'; error: IngestionErrorCode }
  | { status: 'lost' };

/** The operation type `markLibraryDeleted` queues; everything else is a build. */
const DELETE_OPERATION = 'delete';

/** Attempts before an operation stops being retried. */
export const MAX_ATTEMPTS = 3;

/**
 * Runs one queued operation to completion.
 *
 * `lost` means another worker had already claimed it, which is a normal outcome
 * rather than an error: two drains that overlap should do one build between
 * them, and the one that arrives second has nothing to report.
 */
export async function runOperation(input: {
  operationId: string;
  dependencies?: IngestionDependencies;
}): Promise<OperationOutcome> {
  const database = db();

  const claimed = await database
    .update(schema.workflowOperation)
    .set({
      status: 'running',
      attempts: sql`${schema.workflowOperation.attempts} + 1`,
      error: null,
      /* A retry starts over; a stale readout from the last attempt would lie. */
      stage: null,
      progress: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.workflowOperation.id, input.operationId),
        eq(schema.workflowOperation.status, 'pending'),
      ),
    )
    .returning({
      id: schema.workflowOperation.id,
      libraryId: schema.workflowOperation.libraryId,
      operationType: schema.workflowOperation.operationType,
      attempts: schema.workflowOperation.attempts,
      trigger: schema.workflowOperation.trigger,
    });

  const operation = claimed[0];
  if (!operation) return { status: 'lost' };

  if (!operation.libraryId) {
    await finish(operation.id, 'failed', 'internal_error');
    return { status: 'failed', error: 'internal_error' };
  }

  if (operation.operationType === DELETE_OPERATION) {
    return purge(operation.id, operation.libraryId, input.dependencies);
  }

  /*
   * A model review is not a build: nothing is fetched, parsed or indexed,
   * and the library's status is not touched by its running. The claim
   * above is handed back so the review runner can take it as its own.
   */
  if (operation.operationType === MODEL_REVIEW_OPERATION) {
    await database
      .update(schema.workflowOperation)
      .set({ status: 'pending', attempts: sql`${schema.workflowOperation.attempts} - 1` })
      .where(eq(schema.workflowOperation.id, operation.id));
    const reviewed = await runModelReview({ operationId: operation.id });
    return { status: 'reviewed', outcome: reviewed.status };
  }

  /*
   * The library says it is building while it is. A first build used to leave
   * `index_status` at `pending` until the version published, so the detail
   * page's banner (which reads the running operation) said "in progress"
   * while the status readout beside it said "waiting to build". Only a
   * library with nothing published moves: one already serving a version
   * keeps `ready` or `stale` throughout, as requirement.md 8.2 asks -- a
   * refresh in flight is not a reason to look unavailable.
   */
  await database
    .update(schema.library)
    .set({ indexStatus: 'processing' })
    .where(
      and(
        eq(schema.library.id, operation.libraryId),
        sql`${schema.library.currentVersionId} is null`,
        isNull(schema.library.deletedAt),
      ),
    );

  /*
   * The build's seat in the call ledger. library-build-billing.md 4: held at
   * the quoted cap before the fetch, resized to the measured price before
   * embedding, committed inside the publication transaction, released on
   * every other exit. `charge` is null for a build that is nobody's bill.
   */
  let charge: BuildCharge | null = null;
  const billing: { settled: SettledBuildCharge | null } = { settled: null };
  try {
    charge = await openBuildCharge({
      operationId: operation.id,
      libraryId: operation.libraryId,
      trigger: operation.trigger,
    });
    const openCharge = charge;

    const built = await buildVersion({
      libraryId: operation.libraryId,
      operationId: operation.id,
      dependencies: input.dependencies,
      beforeIndex: openCharge
        ? async (facts) => {
            billing.settled = await settleBuildCharge(openCharge, facts);
          }
        : undefined,
    });

    if (!built.changed) {
      await releaseBuildCharge(charge);
      await finish(operation.id, 'skipped', null);
      return { status: 'skipped', reason: 'unchanged' };
    }

    /*
     * architecture.md 8.1 sends a platform library from `Evaluating` straight
     * to `Publishing` -- there is no human review of our own libraries. What is
     * published here is the *version*: the pointer moves and the index goes
     * live. Whether the library appears in the catalogue is a separate decision
     * on `lifecycle_status`, which only an operator makes (requirement.md 5.3),
     * and requirement.md 6.2 forbids collapsing the two into one field.
     */
    await database
      .update(schema.workflowOperation)
      .set({ stage: 'publish' })
      .where(eq(schema.workflowOperation.id, operation.id))
      .catch(() => {});
    await publishVersion({
      libraryId: operation.libraryId,
      versionId: built.versionId,
      charge:
        charge && billing.settled
          ? {
              charge,
              settled: billing.settled,
              operation: operation.operationType === 'ingest' ? 'index' : 'refresh',
            }
          : null,
    });

    /* A user library, by contrast, does move: private goes live, public
       joins the review queue (`lifecycleAfterBuild`). Platform rows are
       left alone, as the comment above says. */
    await advanceLifecycleAfterBuild(operation.libraryId);

    await finish(operation.id, 'succeeded', null);
    return {
      status: 'succeeded',
      versionId: built.versionId,
      documents: built.documents,
      chunks: built.chunks,
    };
  } catch (error) {
    const code = errorCode(error);
    await releaseBuildCharge(charge);

    /*
     * A failed refresh keeps the current version. requirement.md 8.2 is
     * explicit about it: the library goes on answering from what it already
     * has, and only `index_status` records that the newest attempt did not
     * land. Marking the library failed would take a working library offline
     * because a network fetch timed out.
     */
    await database
      .update(schema.library)
      .set({ lastCheckedAt: new Date() })
      .where(eq(schema.library.id, operation.libraryId));

    const retriable = operation.attempts < MAX_ATTEMPTS && isRetriable(code);
    await finish(operation.id, retriable ? 'pending' : 'failed', code);

    /* A queued retry leaves `processing` in place: the operation is still
       open, the banner still says so, and the queue row carries the retry
       count. Only a final failure changes the library's status, below. */
    if (!retriable) {
      await database
        .update(schema.library)
        .set({ indexStatus: 'failed' })
        .where(
          and(
            eq(schema.library.id, operation.libraryId),
            // A library that is already serving a version is not "failed".
            sql`${schema.library.currentVersionId} is null`,
            // A tombstone's pointer is null too, and it stays `deleting`.
            isNull(schema.library.deletedAt),
          ),
        );
    }

    /*
     * The stage and the code for an expected refusal; the exception message as
     * well for anything else. architecture.md 17.1 keeps fetched content out of
     * logs, and an `IngestionFailure`'s message can quote a host -- but an
     * unexpected error is a bug or a misconfiguration, its message describes our
     * own code or a provider's response, and swallowing it leaves whoever is on
     * call with `internal_error` and nothing to go on.
     */
    console.error(
      error instanceof IngestionFailure
        ? `ingestion ${operation.id} failed at ${error.stage}: ${code}`
        : `ingestion ${operation.id} failed: ${code}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
    );
    return { status: 'failed', error: code };
  }
}

/**
 * The Delete Workflow's run. architecture.md 8.4.
 *
 * Retried without limit, unlike a build: the doc is explicit that cleanup
 * failures keep retrying and alert, and never restore access. A build that
 * fails three times has told the operator something about the source; a purge
 * that fails is an outage on our side, and giving up on it would leave a
 * deleted library's content in the store indefinitely. The row goes back to
 * `pending` with the code on it, the next drain picks it up, and the error
 * line below is the alert.
 */
async function purge(
  operationId: string,
  libraryId: string,
  dependencies: IngestionDependencies | undefined,
): Promise<OperationOutcome> {
  try {
    const purged = await purgeLibrary({ libraryId, dependencies });
    await finish(operationId, 'succeeded', null);
    return { status: 'purged', ...purged };
  } catch (error) {
    const code = errorCode(error);
    await finish(operationId, 'pending', code);
    console.error(
      `purge ${operationId} failed: ${code}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return { status: 'failed', error: code };
  }
}

/**
 * Failures worth trying again.
 *
 * A network that was down may be up; a source that is empty, forbidden or
 * unparseable will be all three again next time, and retrying it three times
 * only delays the operator finding out.
 */
function isRetriable(code: IngestionErrorCode): boolean {
  return (
    code === 'source_unreachable' ||
    code === 'embedding_unavailable' ||
    code === 'index_incomplete' ||
    code === 'storage_unavailable' ||
    code === 'internal_error'
  );
}

function errorCode(error: unknown): IngestionErrorCode {
  if (error instanceof IngestionFailure) return error.code;
  if (error instanceof Error && isIngestionError((error as { code?: unknown }).code)) {
    return (error as unknown as { code: IngestionErrorCode }).code;
  }
  return 'internal_error';
}

async function finish(
  operationId: string,
  status: 'succeeded' | 'failed' | 'skipped' | 'pending',
  error: IngestionErrorCode | null,
): Promise<void> {
  await db()
    .update(schema.workflowOperation)
    .set({ status, error, updatedAt: new Date() })
    .where(eq(schema.workflowOperation.id, operationId));
}

/**
 * An operation that has been `running` longer than any build can take belongs
 * to a worker that died before `finish` -- a function timeout, an eviction.
 * Nothing else would ever close it: the drain claims `pending` rows only, and
 * a rebuild request sees the open row and queues behind it for ever. It is
 * failed here, and the seat it held in the call ledger (library-build-billing.md
 * 4.2) goes back, on the same clock `sweepAbandonedSeats` uses for build seats.
 */
async function reapStaleRunning(): Promise<void> {
  const database = db();
  const stale = await database
    .update(schema.workflowOperation)
    .set({ status: 'failed', error: 'internal_error', updatedAt: new Date() })
    .where(
      and(
        eq(schema.workflowOperation.status, 'running'),
        lt(schema.workflowOperation.updatedAt, new Date(Date.now() - BUILD_RESERVATION_TTL_MS)),
      ),
    )
    .returning({ id: schema.workflowOperation.id, reservationId: schema.workflowOperation.reservationId });
  const seats = stale.map((row) => row.reservationId).filter((id): id is string => id !== null);
  if (seats.length > 0) {
    await database
      .update(schema.usageReservation)
      .set({ status: 'released' })
      .where(
        and(
          inArray(schema.usageReservation.id, seats),
          eq(schema.usageReservation.status, 'pending'),
        ),
      );
  }
  for (const row of stale) console.error(`ingestion ${row.id} reaped: worker never finished`);
}

/**
 * Drains the queue, oldest first.
 *
 * Serial rather than concurrent. A build holds an embedding provider's rate
 * limit and a Postgres transaction for as long as it runs, and the queue is
 * platform libraries -- tens of them, refreshed daily. Parallelism here would
 * buy nothing and would make provider throttling everyone's problem at once.
 */
export async function drainOperations(input: {
  limit?: number;
  dependencies?: IngestionDependencies;
} = {}): Promise<OperationOutcome[]> {
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));

  await reapStaleRunning();

  const pending = await db()
    .select({ id: schema.workflowOperation.id })
    .from(schema.workflowOperation)
    .where(eq(schema.workflowOperation.status, 'pending'))
    .orderBy(asc(schema.workflowOperation.createdAt))
    .limit(limit);

  const outcomes: OperationOutcome[] = [];
  for (const row of pending) {
    outcomes.push(await runOperation({ operationId: row.id, dependencies: input.dependencies }));
  }

  /*
   * Housekeeping rides the same schedule: the drain is the one thing that
   * runs periodically, and a store without lifecycle rules (Vercel Blob)
   * needs someone to expire abandoned uploads. A failure here is logged, not
   * thrown -- the builds above already happened, and a listing hiccup is not
   * a reason to report them as failed.
   */
  try {
    await purgeAbandonedUploads({ dependencies: input.dependencies });
  } catch (error) {
    console.error(`upload purge failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  return outcomes;
}
