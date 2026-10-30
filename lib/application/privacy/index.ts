/**
 * What is kept of a workspace's Agent conversations and A2A tasks, and for
 * how long (agent-first-proposal.md 7.9 part 4, 10).
 *
 * - Bodies of A2A tasks, inbound (P1, P2) and outbound (P4 delegations),
 *   are kept 30 days, then cleared to ids, states and metering:
 *   `runRetention`, from the hourly cron route.
 * - Private assets -- in no public channel -- are deleted once older than
 *   the workspace's retention setting, through the ordinary deletion
 *   (`markAssetDeleted`, whose queued cleanup the drain runs).
 * - The owner exports conversations and A2A tasks as JSON and deletes them
 *   in one click. Deleting never touches metering: usage events reference
 *   request ids, not tasks or conversations.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, notExists, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { purgeA2aTaskBodies } from '@/lib/application/a2a/task-store';
import {
  clearDelegationText,
  listDelegations,
  purgeDelegationBodies,
  type DelegationView,
} from '@/lib/application/external-agents/delegation';
import { canManageAssets, markAssetDeleted, type WorkspaceRole } from '@/lib/application/assets/delete';
import { db, schema } from '@/lib/infrastructure/postgres/client';

/** Proposal 7.9: the retention choices for private assets, in days; null keeps them. */
export const PRIVATE_ASSET_RETENTION_DAYS = [30, 90, 180, 365] as const;
export type PrivateAssetRetention = (typeof PRIVATE_ASSET_RETENTION_DAYS)[number] | null;

const DAY_MS = 86_400_000;
/** Assets deleted per workspace per run: a lapse is caught up over a few days, never in one burst. */
const RETENTION_BATCH = 50;

export function isRetentionChoice(value: unknown): value is PrivateAssetRetention {
  return value === null || (typeof value === 'number' && (PRIVATE_ASSET_RETENTION_DAYS as readonly number[]).includes(value));
}

/* ---------------------------------------------------------------- settings */

export async function privateAssetRetention(workspaceId: string): Promise<PrivateAssetRetention> {
  const [row] = await db()
    .select({ days: schema.workspace.privateAssetRetentionDays })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, workspaceId))
    .limit(1);
  const days = row?.days ?? null;
  return isRetentionChoice(days) ? days : null;
}

export async function setPrivateAssetRetention(input: {
  workspaceId: string;
  role: WorkspaceRole;
  days: PrivateAssetRetention;
}): Promise<void> {
  assertManager(input.role);
  if (!isRetentionChoice(input.days)) throw new AppError('invalid_request', 'retention is 30, 90, 180 or 365 days, or none');
  await db()
    .update(schema.workspace)
    .set({ privateAssetRetentionDays: input.days })
    .where(eq(schema.workspace.id, input.workspaceId));
}

function assertManager(role: WorkspaceRole): void {
  if (!canManageAssets(role)) throw new AppError('access_denied', 'only a workspace owner or admin can do this');
}

/* ---------------------------------------------------------------- the cron */

export interface RetentionOutcome {
  inboundTasks: number;
  delegations: number;
  privateAssets: number;
}

/** The hourly retention run. Each part is independent; one failing does not stop the others. */
export async function runRetention(now: Date = new Date()): Promise<RetentionOutcome> {
  const settle = async (label: string, work: () => Promise<number>) => {
    try {
      return await work();
    } catch (error) {
      console.error(`retention ${label} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return 0;
    }
  };
  return {
    inboundTasks: await settle('a2a tasks', () => purgeA2aTaskBodies(now)),
    delegations: await settle('delegations', () => purgeDelegationBodies(now)),
    privateAssets: await settle('private assets', () => expirePrivateAssets(now)),
  };
}

/**
 * Deletes the private assets past their workspace's retention. "Private"
 * is in no public channel; age is from the last successful build, or from
 * creation for one never built. An asset with a build queued or running is
 * skipped this time: the owner is working on it, and a success resets its
 * age.
 */
export async function expirePrivateAssets(now: Date = new Date()): Promise<number> {
  const workspaces = await db()
    .select({ id: schema.workspace.id, days: schema.workspace.privateAssetRetentionDays })
    .from(schema.workspace)
    .where(isNotNull(schema.workspace.privateAssetRetentionDays));
  let deleted = 0;
  for (const workspace of workspaces) {
    if (!isRetentionChoice(workspace.days) || workspace.days === null) continue;
    const cutoff = new Date(now.getTime() - workspace.days * DAY_MS);
    const due = await db()
      .select({ id: schema.asset.id })
      .from(schema.asset)
      .where(
        and(
          eq(schema.asset.ownerWorkspaceId, workspace.id),
          eq(schema.asset.isPlatformAsset, false),
          isNull(schema.asset.deletedAt),
          lte(sql`coalesce(${schema.asset.lastSuccessfulRefreshAt}, ${schema.asset.createdAt})`, cutoff),
          notExists(
            db()
              .select({ one: sql`1` })
              .from(schema.workflowOperation)
              .where(
                and(
                  eq(schema.workflowOperation.assetId, schema.asset.id),
                  inArray(schema.workflowOperation.status, ['pending', 'running']),
                ),
              ),
          ),
          notExists(
            db()
              .select({ one: sql`1` })
              .from(schema.channelAsset)
              .innerJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
              .where(and(eq(schema.channelAsset.assetId, schema.asset.id), eq(schema.channel.visibility, 'public'))),
          ),
        ),
      )
      .orderBy(asc(schema.asset.createdAt))
      .limit(RETENTION_BATCH);
    for (const asset of due) {
      const result = await markAssetDeleted(asset.id, now);
      if (!result.alreadyDeleted) deleted += 1;
    }
  }
  return deleted;
}

/* ----------------------------------------------------------------- export */

export interface ConversationExport {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: { role: string; content: Record<string, unknown>; createdAt: string }[];
}

export async function exportConversations(workspaceId: string): Promise<ConversationExport[]> {
  const conversations = await db()
    .select()
    .from(schema.agentConversation)
    .where(eq(schema.agentConversation.workspaceId, workspaceId))
    .orderBy(desc(schema.agentConversation.updatedAt));
  if (conversations.length === 0) return [];
  const turns = await db()
    .select()
    .from(schema.agentMessage)
    .where(inArray(schema.agentMessage.conversationId, conversations.map((conversation) => conversation.id)))
    .orderBy(asc(schema.agentMessage.createdAt));
  const byConversation = new Map<string, ConversationExport['turns']>();
  for (const turn of turns) {
    const list = byConversation.get(turn.conversationId) ?? [];
    list.push({ role: turn.role, content: turn.content, createdAt: turn.createdAt.toISOString() });
    byConversation.set(turn.conversationId, list);
  }
  return conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    turns: byConversation.get(conversation.id) ?? [],
  }));
}

export interface TaskExport {
  inbound: {
    id: string;
    contextId: string;
    tenant: string;
    skill: string | null;
    state: string;
    status: Record<string, unknown>;
    history: unknown[];
    artifacts: unknown[];
    createdAt: string;
    updatedAt: string;
    bodyPurgeAt: string;
  }[];
  outbound: (DelegationView & { message: string | null })[];
}

/** Inbound A2A tasks and outbound delegations, with whatever bodies are still within their 30 days. */
export async function exportA2aTasks(workspaceId: string): Promise<TaskExport> {
  const inbound = await db()
    .select()
    .from(schema.a2aTask)
    .where(eq(schema.a2aTask.workspaceId, workspaceId))
    .orderBy(desc(schema.a2aTask.createdAt));
  const delegations = await listDelegations(workspaceId, null);
  const actionIds = delegations.flatMap((delegation) => (delegation.actionId ? [delegation.actionId] : []));
  const sent =
    actionIds.length === 0
      ? []
      : await db()
          .select({ id: schema.agentAction.id, params: schema.agentAction.params })
          .from(schema.agentAction)
          .where(and(eq(schema.agentAction.workspaceId, workspaceId), inArray(schema.agentAction.id, actionIds)));
  const messages = new Map(sent.map((row) => [row.id, typeof row.params.message === 'string' ? row.params.message : null]));
  return {
    inbound: inbound.map((task) => ({
      id: task.id,
      contextId: task.contextId,
      tenant: task.tenant,
      skill: task.skill ?? null,
      state: task.state,
      status: task.status,
      history: task.history,
      artifacts: task.artifacts,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      bodyPurgeAt: task.bodyPurgeAt.toISOString(),
    })),
    outbound: delegations.map((delegation) => ({
      ...delegation,
      message: delegation.actionId ? (messages.get(delegation.actionId) ?? null) : null,
    })),
  };
}

/* ----------------------------------------------------------------- delete */

/** Deletes every conversation of the workspace, with its turns. Pending actions keep their row, unlinked. */
export async function deleteConversations(input: { workspaceId: string; role: WorkspaceRole }): Promise<number> {
  assertManager(input.role);
  const deleted = await db()
    .delete(schema.agentConversation)
    .where(eq(schema.agentConversation.workspaceId, input.workspaceId))
    .returning({ id: schema.agentConversation.id });
  return deleted.length;
}

/**
 * Deletes the workspace's A2A task records: inbound tasks with their push
 * configs, outbound delegations, and the text of every confirmed or
 * expired delegation action. A pending delegation is left for the owner to
 * decide; its card still states what it would send.
 */
export async function deleteA2aTasks(input: { workspaceId: string; role: WorkspaceRole }): Promise<number> {
  assertManager(input.role);
  const database = db();
  await database.delete(schema.a2aPushConfig).where(eq(schema.a2aPushConfig.workspaceId, input.workspaceId));
  const inbound = await database
    .delete(schema.a2aTask)
    .where(eq(schema.a2aTask.workspaceId, input.workspaceId))
    .returning({ id: schema.a2aTask.id });
  const outbound = await database
    .delete(schema.agentDelegation)
    .where(eq(schema.agentDelegation.workspaceId, input.workspaceId))
    .returning({ id: schema.agentDelegation.id });
  await clearDelegationText(and(eq(schema.agentAction.workspaceId, input.workspaceId), ne(schema.agentAction.state, 'pending')));
  return inbound.length + outbound.length;
}
