/**
 * A2A tasks in Postgres (agent-first-proposal.md 7.8).
 *
 * The SDK's `InMemoryTaskStore` lives in one function instance; on Vercel the
 * next request -- a `GetTask`, a `SubscribeToTask` -- may land on another, find
 * nothing, and report a task that exists as missing. This store is the one
 * every instance shares.
 *
 * Scoping follows the SDK's contract: by tenant (`context.tenant`) and by the
 * caller (`context.user`). An authenticated caller sees the tasks its
 * workspace created and no others. An anonymous caller's tasks belong to no
 * workspace; one is readable by its id, which is a random v4/v7 identifier
 * handed only to the caller that made it, and anonymous callers can list
 * nothing. Bodies (`history`, `artifacts`) are kept until `body_purge_at`
 * (proposal 10), then cleared by `purgeA2aTaskBodies`.
 */
import { and, desc, eq, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { Task, TaskState, type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { callerOf, tenantOf } from './context';

/** Proposal 10: message bodies are kept 30 days, ids and metering for good. */
export const TASK_BODY_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const LIST_PAGE_MAX = 100;
const TERMINAL_STATE_NAMES = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'];

export class PostgresTaskStore implements TaskStore {
  async save(task: Task, context: ServerCallContext): Promise<void> {
    const caller = callerOf(context);
    const wire = Task.toJSON(task) as {
      status?: Record<string, unknown>;
      history?: unknown[];
      artifacts?: unknown[];
      metadata?: Record<string, unknown>;
    };
    const now = new Date();
    const state = TaskState[task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED] ?? 'TASK_STATE_UNSPECIFIED';
    const skill = typeof task.metadata?.skill === 'string' ? task.metadata.skill : null;
    await db()
      .insert(schema.a2aTask)
      .values({
        id: task.id,
        contextId: task.contextId,
        workspaceId: caller.workspaceId,
        apiKeyId: caller.apiKeyId,
        tenant: tenantOf(context),
        skill,
        state,
        status: wire.status ?? {},
        history: wire.history ?? [],
        artifacts: wire.artifacts ?? [],
        metadata: wire.metadata ?? null,
        bodyPurgeAt: new Date(now.getTime() + TASK_BODY_RETENTION_DAYS * DAY_MS),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.a2aTask.id,
        set: {
          state,
          skill: sql`coalesce(${skill}, ${schema.a2aTask.skill})`,
          status: wire.status ?? {},
          history: wire.history ?? [],
          artifacts: wire.artifacts ?? [],
          metadata: wire.metadata ?? null,
          updatedAt: now,
        },
        /*
         * A task id is the creator's: a save under another owner or tenant is
         * not an update of it. And a terminal state is final: a snapshot the
         * SDK loaded before an out-of-band change (task-events.ts) -- a
         * confirmation, a cancel -- does not overwrite what that change wrote.
         */
        setWhere: and(
          ownedBy(caller.workspaceId),
          eq(schema.a2aTask.tenant, tenantOf(context)),
          notInArray(schema.a2aTask.state, TERMINAL_STATE_NAMES),
        ),
      });
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const caller = callerOf(context);
    const [row] = await db()
      .select()
      .from(schema.a2aTask)
      .where(
        and(
          eq(schema.a2aTask.id, taskId),
          eq(schema.a2aTask.tenant, tenantOf(context)),
          ownedBy(caller.workspaceId),
        ),
      )
      .limit(1);
    return row ? toTask(row) : undefined;
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const caller = callerOf(context);
    const pageSize = Math.min(Math.max(1, params.pageSize || 50), LIST_PAGE_MAX);
    /* An anonymous caller has no identity to list by. */
    if (!caller.workspaceId) return { tasks: [], nextPageToken: '', pageSize, totalSize: 0 };
    const filters = [
      eq(schema.a2aTask.workspaceId, caller.workspaceId),
      eq(schema.a2aTask.tenant, tenantOf(context)),
    ];
    if (params.contextId) filters.push(eq(schema.a2aTask.contextId, params.contextId));
    if (params.status) {
      filters.push(eq(schema.a2aTask.state, TaskState[params.status] ?? ''));
    }
    const counted = db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.a2aTask)
      .where(and(...filters));
    /* (updated_at, id) so tasks saved in the same instant never fall between pages. */
    const cursor = decodeCursor(params.pageToken);
    const paged = cursor
      ? [
          ...filters,
          or(
            lt(schema.a2aTask.updatedAt, cursor.at),
            and(eq(schema.a2aTask.updatedAt, cursor.at), lt(schema.a2aTask.id, cursor.id)),
          )!,
        ]
      : filters;
    const rows = await db()
      .select()
      .from(schema.a2aTask)
      .where(and(...paged))
      .orderBy(desc(schema.a2aTask.updatedAt), desc(schema.a2aTask.id))
      .limit(pageSize + 1);
    const page = rows.slice(0, pageSize);
    const [total] = await counted;
    return {
      tasks: page.map((row) => {
        const task = toTask(row);
        if (params.historyLength !== undefined && params.historyLength >= 0) {
          task.history = params.historyLength === 0 ? [] : task.history.slice(-params.historyLength);
        }
        if (!params.includeArtifacts) task.artifacts = [];
        return task;
      }),
      nextPageToken: rows.length > pageSize ? encodeCursor(page[page.length - 1]!) : '',
      pageSize,
      totalSize: Number(total?.n ?? 0),
    };
  }
}

function ownedBy(workspaceId: string | null) {
  return workspaceId ? eq(schema.a2aTask.workspaceId, workspaceId) : isNull(schema.a2aTask.workspaceId);
}

function toTask(row: typeof schema.a2aTask.$inferSelect): Task {
  return Task.fromJSON({
    id: row.id,
    contextId: row.contextId,
    status: row.status,
    history: row.history,
    artifacts: row.artifacts,
    metadata: row.metadata ?? undefined,
  });
}

function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.updatedAt.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(token: string | undefined): { at: Date; id: string } | null {
  if (!token) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as [string, string];
    const parsed = new Date(at);
    return Number.isNaN(parsed.getTime()) || typeof id !== 'string' ? null : { at: parsed, id };
  } catch {
    return null;
  }
}

/**
 * Clears the bodies of tasks past their retention (proposal 10): the message
 * history and the artifacts go, the row with its ids, tenant, skill, state
 * and workspace stays, as the metering record does.
 */
export async function purgeA2aTaskBodies(now: Date = new Date()): Promise<number> {
  const purged = await db()
    .update(schema.a2aTask)
    .set({ history: [], artifacts: [], status: sql`${schema.a2aTask.status} - 'message'`, updatedAt: now })
    .where(
      and(
        lte(schema.a2aTask.bodyPurgeAt, now),
        sql`(${schema.a2aTask.history} <> '[]'::jsonb or ${schema.a2aTask.artifacts} <> '[]'::jsonb)`,
      ),
    )
    .returning({ id: schema.a2aTask.id });
  return purged.length;
}

export interface WorkspaceTaskRow {
  id: string;
  skill: string | null;
  state: string;
  tenant: string;
  updatedAt: string;
  /** The pending action the task waits on, when it waits for the owner. */
  pendingActionId: string | null;
}

/** The workspace's A2A tasks, newest first, for the Dashboard's A2A 任务 page (proposal 4.4). */
export async function listWorkspaceTasks(workspaceId: string, limit = 50): Promise<WorkspaceTaskRow[]> {
  const rows = await db()
    .select({
      id: schema.a2aTask.id,
      skill: schema.a2aTask.skill,
      state: schema.a2aTask.state,
      tenant: schema.a2aTask.tenant,
      updatedAt: schema.a2aTask.updatedAt,
      pendingActionId: schema.agentAction.id,
    })
    .from(schema.a2aTask)
    .leftJoin(
      schema.agentAction,
      and(eq(schema.agentAction.a2aTaskId, schema.a2aTask.id), eq(schema.agentAction.state, 'pending')),
    )
    .where(eq(schema.a2aTask.workspaceId, workspaceId))
    .orderBy(desc(schema.a2aTask.updatedAt))
    .limit(Math.min(Math.max(limit, 1), LIST_PAGE_MAX));
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString(), pendingActionId: row.pendingActionId ?? null }));
}
