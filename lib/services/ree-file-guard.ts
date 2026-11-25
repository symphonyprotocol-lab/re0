/**
 * The publication edge of the agent workspace (docs/design/agent-workspace.md
 * §7.3): when a Ree becomes reachable by others (published), every workspace
 * file of it that the secret scan flagged stops answering and waits for the
 * owner, in the publishing transaction, so no public answer or citation can
 * quote it even once. Kept apart from workspace-rees.ts so rees.ts and
 * admin-rees.ts can call it without importing the workspace.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Tx } from '@/lib/infra/db';

export async function quarantineFlaggedFiles(tx: Tx, reeId: string, now = new Date()): Promise<number> {
  const rows = await tx
    .update(schema.knowledge)
    .set({ enabled: false, awaitingConfirmation: true, updatedAt: now })
    .where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.kind, 'file'), isNotNull(schema.knowledge.secretFound), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)))
    .returning({ id: schema.knowledge.id });
  return rows.length;
}
