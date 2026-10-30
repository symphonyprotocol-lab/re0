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
import { and, desc, eq, isNull, lt, lte, sql } from 'drizzle-orm';
import { Task, TaskState, type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { callerOf, tenantOf } from './context';

/** Proposal 10: message bodies are kept 30 days, ids and metering for good. */
export const TASK_BODY_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const LIST_PAGE_MAX = 100;

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
        /* A task id is the creator's: a save under another owner or tenant is not an update of it. */
        setWhere: and(ownedBy(caller.workspaceId), eq(schema.a2aTask.tenant, tenantOf(context))),
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
    const cursor = decodeCursor(params.pageToken);
    if (cursor) filters.push(lt(schema.a2aTask.updatedAt, cursor));
    const rows = await db()
      .select()
      .from(schema.a2aTask)
      .where(and(...filters))
      .orderBy(desc(schema.a2aTask.updatedAt), desc(schema.a2aTask.id))
      .limit(pageSize + 1);
    const page = rows.slice(0, pageSize);
    const [counted] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.a2aTask)
      .where(and(eq(schema.a2aTask.workspaceId, caller.workspaceId), eq(schema.a2aTask.tenant, tenantOf(context))));
    return {
      tasks: page.map((row) => {
        const task = toTask(row);
        if (params.historyLength !== undefined && params.historyLength >= 0) {
          task.history = params.historyLength === 0 ? [] : task.history.slice(-params.historyLength);
        }
        if (!params.includeArtifacts) task.artifacts = [];
        return task;
      }),
      nextPageToken: rows.length > pageSize ? encodeCursor(page[page.length - 1]!.updatedAt) : '',
      pageSize,
      totalSize: Number(counted?.n ?? 0),
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

function encodeCursor(at: Date): string {
  return Buffer.from(at.toISOString()).toString('base64url');
}

function decodeCursor(token: string | undefined): Date | null {
  if (!token) return null;
  const parsed = new Date(Buffer.from(token, 'base64url').toString('utf8'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
