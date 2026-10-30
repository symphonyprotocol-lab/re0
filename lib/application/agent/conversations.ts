/**
 * Workbench conversations (agent-first-proposal.md 4.4, 12): what the owner
 * asked and what the server showed back, kept so the workbench reopens
 * where it was. The assistant side is the server's own record -- bound
 * claims, their sources, the actions proposed, a listing -- never the
 * planner's text, which nobody is shown.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface StoredTurn {
  id: string;
  role: 'user' | 'assistant';
  content: Record<string, unknown>;
  createdAt: string;
}

const TITLE_CHARS = 80;
const TURNS_SHOWN = 40;

export async function startConversation(input: { workspaceId: string; userId: string; title: string }): Promise<string> {
  const id = uuidv7();
  await db()
    .insert(schema.agentConversation)
    .values({
      id,
      workspaceId: input.workspaceId,
      createdBy: input.userId,
      title: input.title.trim().slice(0, TITLE_CHARS) || 'Conversation',
    });
  return id;
}

/** The conversation, if it is this workspace's; null otherwise, as if it did not exist. */
async function owned(workspaceId: string, conversationId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: schema.agentConversation.id })
    .from(schema.agentConversation)
    .where(and(eq(schema.agentConversation.id, conversationId), eq(schema.agentConversation.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(row);
}

export async function appendTurn(input: {
  workspaceId: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: Record<string, unknown>;
}): Promise<void> {
  if (!(await owned(input.workspaceId, input.conversationId))) return;
  const now = new Date();
  await db().insert(schema.agentMessage).values({
    id: uuidv7(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    createdAt: now,
  });
  await db()
    .update(schema.agentConversation)
    .set({ updatedAt: now })
    .where(eq(schema.agentConversation.id, input.conversationId));
}

export async function listConversations(workspaceId: string, limit = 20): Promise<ConversationSummary[]> {
  const rows = await db()
    .select({ id: schema.agentConversation.id, title: schema.agentConversation.title, updatedAt: schema.agentConversation.updatedAt })
    .from(schema.agentConversation)
    .where(eq(schema.agentConversation.workspaceId, workspaceId))
    .orderBy(desc(schema.agentConversation.updatedAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

export async function latestConversation(workspaceId: string): Promise<ConversationSummary | null> {
  return (await listConversations(workspaceId, 1))[0] ?? null;
}

export async function conversationTurns(workspaceId: string, conversationId: string): Promise<StoredTurn[]> {
  if (!(await owned(workspaceId, conversationId))) return [];
  const rows = await db()
    .select()
    .from(schema.agentMessage)
    .where(eq(schema.agentMessage.conversationId, conversationId))
    .orderBy(asc(schema.agentMessage.createdAt))
    .limit(TURNS_SHOWN * 2);
  return rows.map((row) => ({ id: row.id, role: row.role, content: row.content, createdAt: row.createdAt.toISOString() }));
}
