/**
 * Recording who read, asked or retrieved from a channel, for the directory's
 * activity term (agent-first-proposal.md 6.4).
 *
 * People, not calls: one row per distinct visitor per day, keyed by user for
 * a signed-in reader, by workspace for an API or A2A caller, and by the
 * hashed address-and-device key the anonymous rate limiter uses for everyone
 * else -- so one caller hammering a channel is still one visitor, and free
 * posts read by search-engine traffic still count. The owner's own visits
 * never count. Nothing here holds an address or a query.
 */
import { db, schema } from '@/lib/infrastructure/postgres/client';

export type ChannelVisitor =
  | { kind: 'user'; userId: string; workspaceId: string | null }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'anonymous'; key: string };

/** Best-effort: a visit that fails to record costs the ranking one sample, never the page. */
export async function recordChannelVisit(
  channel: { id: string; workspaceId: string | null },
  visitor: ChannelVisitor,
  now: Date = new Date(),
): Promise<void> {
  const ownWorkspace = visitor.kind === 'anonymous' ? null : visitor.workspaceId;
  if (ownWorkspace && channel.workspaceId && ownWorkspace === channel.workspaceId) return;
  const key =
    visitor.kind === 'user' ? visitor.userId : visitor.kind === 'workspace' ? visitor.workspaceId : visitor.key;
  try {
    await db()
      .insert(schema.channelVisit)
      .values({
        channelId: channel.id,
        visitorKind: visitor.kind,
        visitorKey: key.slice(0, 128),
        /* The UTC day: one row per visitor per day, whatever the reader's zone. */
        visitedOn: now.toISOString().slice(0, 10),
      })
      .onConflictDoNothing();
  } catch (error) {
    console.warn(`channel visit not recorded: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
