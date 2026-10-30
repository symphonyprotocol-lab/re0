/**
 * A2A task changes that happen outside the request that created the task
 * (agent-first-proposal.md 7.6): the owner confirms or rejects the pending
 * action an `ingest`, `refresh` or `publish` is waiting on, a pending action
 * expires, a build finishes. None of these has the SDK's event bus at hand
 * -- on Vercel it lived in an instance that is gone -- so they write the
 * stored task directly, in the same wire form the task store writes, and
 * send the push notifications the SDK would have.
 *
 * A task already in a terminal state is never moved again.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { Role, Task, TaskState, type Artifact, type Message, type Part } from '@a2a-js/sdk';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { deliverTaskPush } from './push';

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

export function dataPart(value: Record<string, unknown>): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' };
}

export function agentStatus(
  state: TaskState,
  text: string | null,
  taskId: string,
  contextId: string,
  extra: Part[] = [],
): Task['status'] {
  return {
    state,
    timestamp: new Date().toISOString(),
    message: text
      ? ({
          messageId: randomUUID(),
          contextId,
          taskId,
          role: Role.ROLE_AGENT,
          parts: [textPart(text), ...extra],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        } satisfies Message)
      : undefined,
  };
}

export interface TaskChange {
  state: TaskState;
  message: string | null;
  artifact?: Artifact;
  /** The build operation the task now follows; undefined leaves it as it is. */
  workflowRunId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Moves a stored task, unless it is already terminal. Returns the task as
 * written, or null when there was nothing to move.
 */
export async function changeTask(taskId: string, change: TaskChange): Promise<Task | null> {
  const [row] = await db().select().from(schema.a2aTask).where(eq(schema.a2aTask.id, taskId)).limit(1);
  if (!row) return null;
  const task = Task.fromJSON({
    id: row.id,
    contextId: row.contextId,
    status: row.status,
    history: row.history,
    artifacts: row.artifacts,
    metadata: row.metadata ?? undefined,
  });
  if (task.status && TERMINAL_STATES.has(task.status.state)) return null;

  task.status = agentStatus(change.state, change.message, task.id, task.contextId);
  if (change.artifact) task.artifacts = [...task.artifacts, change.artifact];
  if (change.metadata) task.metadata = { ...(task.metadata ?? {}), ...change.metadata };
  const wire = Task.toJSON(task) as { status?: Record<string, unknown>; artifacts?: unknown[]; metadata?: Record<string, unknown> };
  const state = TaskState[change.state] ?? 'TASK_STATE_UNSPECIFIED';
  const moved = await db()
    .update(schema.a2aTask)
    .set({
      state,
      status: wire.status ?? {},
      artifacts: wire.artifacts ?? [],
      metadata: wire.metadata ?? null,
      ...(change.workflowRunId !== undefined ? { workflowRunId: change.workflowRunId } : {}),
      updatedAt: new Date(),
    })
    /* Compare-and-set on the state read above: two writers never both move it. */
    .where(and(eq(schema.a2aTask.id, taskId), eq(schema.a2aTask.state, row.state)))
    .returning({ id: schema.a2aTask.id });
  if (moved.length === 0) return null;

  if (change.artifact) {
    await deliverTaskPush(task.id, {
      payload: {
        $case: 'artifactUpdate',
        value: { taskId: task.id, contextId: task.contextId, artifact: change.artifact, append: false, lastChunk: true, metadata: undefined },
      },
    }).catch(() => 0);
  }
  await deliverTaskPush(task.id, {
    payload: { $case: 'statusUpdate', value: { taskId: task.id, contextId: task.contextId, status: task.status, metadata: undefined } },
  }).catch(() => 0);
  return task;
}

/**
 * Tasks following a build (`ingest`, `refresh` after confirmation) catch up
 * with it: a build that published, or found nothing changed, completes the
 * task; one that failed or was cancelled fails it. Run by the drain after
 * every batch, and on read, so `GetTask` and `SubscribeToTask` see the build
 * finish even between drains. Only `WORKING` tasks are read.
 */
export async function syncBuildTasks(taskIds?: readonly string[]): Promise<number> {
  const rows = await db()
    .select({
      taskId: schema.a2aTask.id,
      operationId: schema.a2aTask.workflowRunId,
      status: schema.workflowOperation.status,
      error: schema.workflowOperation.error,
      libraryId: schema.workflowOperation.libraryId,
    })
    .from(schema.a2aTask)
    /* `workflow_run_id` is text (a run id need not be ours); the operation id is a uuid. */
    .innerJoin(schema.workflowOperation, sql`${schema.workflowOperation.id}::text = ${schema.a2aTask.workflowRunId}`)
    .where(
      and(
        eq(schema.a2aTask.state, 'TASK_STATE_WORKING'),
        isNotNull(schema.a2aTask.workflowRunId),
        inArray(schema.workflowOperation.status, ['succeeded', 'skipped', 'failed', 'cancelled']),
        ...(taskIds ? [inArray(schema.a2aTask.id, taskIds.length > 0 ? [...taskIds] : [''])] : []),
      ),
    );
  let moved = 0;
  for (const row of rows) {
    const done = row.status === 'succeeded' || row.status === 'skipped';
    const [asset] = row.libraryId
      ? await db()
          .select({ publicId: schema.library.publicId, title: schema.library.title })
          .from(schema.library)
          .where(eq(schema.library.id, row.libraryId))
          .limit(1)
      : [];
    const outcome = done
      ? {
          state: TaskState.TASK_STATE_COMPLETED,
          message:
            row.status === 'skipped'
              ? `The build of ${asset?.publicId ?? 'the asset'} found nothing changed; the current version stands.`
              : `The build of ${asset?.publicId ?? 'the asset'} finished and its new version is published.`,
        }
      : {
          state: row.status === 'cancelled' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
          message: `The build of ${asset?.publicId ?? 'the asset'} ${row.status === 'cancelled' ? 'was cancelled' : `failed (${row.error ?? 'internal_error'})`}.`,
        };
    const artifact: Artifact | undefined = done
      ? {
          artifactId: randomUUID(),
          name: 'build',
          description: 'The build this task waited on',
          parts: [
            textPart(outcome.message),
            dataPart({ operationId: row.operationId, status: row.status, assetId: asset?.publicId ?? null, title: asset?.title ?? null }),
          ],
          metadata: undefined,
          extensions: [],
        }
      : undefined;
    if (await changeTask(row.taskId, { ...outcome, artifact })) moved += 1;
  }
  return moved;
}
