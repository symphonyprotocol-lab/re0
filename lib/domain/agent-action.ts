/**
 * The re0 Agent's side effects, as rules (agent-first-proposal.md 5.1, 5.2,
 * 7.6). Pure: no I/O.
 *
 * The Agent's tool set is closed. Six tools on top of retrieval and
 * `answer`: two read (`list_assets`, `subscription_summary`), four would
 * change something and so are never run when called -- each writes a pending
 * action that only the signed-in owner can confirm in the Dashboard. The
 * operations the proposal keeps out of the tool set (deleting an asset or a
 * channel, revoking or rotating a key, changing access rules, buying Calls,
 * pricing a channel, publishing posts or audio, moderating comments) have no
 * tool and no action kind here, so there is nothing an Agent or an A2A
 * caller could name to reach them.
 *
 * Who may confirm is part of the rule, not of a screen: the owner, signed
 * in. The model, text inside an asset's chunks and an A2A caller are each a
 * named kind of actor that is refused (`mayConfirm`), so the refusal is
 * explicit and testable rather than the absence of a code path.
 */

export const READ_TOOLS = ['list_assets', 'subscription_summary'] as const;
export const ACTION_TOOLS = ['create_asset', 'refresh_asset', 'create_channel', 'move_asset'] as const;

export type ReadTool = (typeof READ_TOOLS)[number];
export type ActionTool = (typeof ACTION_TOOLS)[number];

/** Operations that stay Dashboard clicks (proposal 5.1); listed so a test can prove none is a tool. */
export const NOT_AGENT_OPERATIONS = [
  'delete_asset',
  'delete_channel',
  'revoke_api_key',
  'rotate_api_key',
  'change_access_rules',
  'buy_calls',
  'set_channel_price',
  'publish_post',
  'publish_audio',
  'moderate_comment',
] as const;

export function isActionTool(value: unknown): value is ActionTool {
  return typeof value === 'string' && (ACTION_TOOLS as readonly string[]).includes(value);
}

/** Proposal 5.2: a pending action not decided within a day is void. */
export const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export type ActionState = 'pending' | 'confirmed' | 'failed' | 'rejected' | 'expired';

export type ActionOrigin = 'workbench' | 'a2a';

/** Sources the Agent may turn into an asset; uploads need the Dashboard's file picker. */
export const AGENT_SOURCE_TYPES = ['website', 'github', 'notion'] as const;
export type AgentSourceType = (typeof AGENT_SOURCE_TYPES)[number];

export function isAgentSourceType(value: unknown): value is AgentSourceType {
  return typeof value === 'string' && (AGENT_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * Whoever is trying to confirm. Only `owner` -- a member who may manage the
 * workspace's assets, acting through a Dashboard session -- can; the other
 * kinds exist to be refused by name.
 */
export type ConfirmActor =
  | { kind: 'owner'; userId: string; workspaceId: string; canManage: boolean }
  | { kind: 'model' }
  | { kind: 'content' }
  | { kind: 'a2a'; workspaceId: string | null; apiKeyId: string | null };

export type ConfirmRefusal = 'not_owner' | 'not_manager' | 'wrong_workspace';

export function mayConfirm(actor: ConfirmActor, workspaceId: string): ConfirmRefusal | null {
  if (actor.kind !== 'owner') return 'not_owner';
  if (actor.workspaceId !== workspaceId) return 'wrong_workspace';
  if (!actor.canManage) return 'not_manager';
  return null;
}

/**
 * Parameters as the row freezes them. Asset and channel references are
 * resolved to ids before the row is written, so what is confirmed is the
 * object the card named, not whatever a name resolves to later.
 */
export type ActionParams =
  | {
      tool: 'create_asset';
      sourceType: AgentSourceType;
      location: string;
      title: string;
      slug: string;
    }
  | { tool: 'refresh_asset'; assetId: string }
  | { tool: 'create_channel'; slug: string; title: string; description: string | null; visibility: 'public' | 'private' }
  | { tool: 'move_asset'; assetId: string; channelId: string | null };

/**
 * What the confirmation card states (proposal 5.2): what will be done, to
 * which asset or channel, the estimated Calls and capacity, and whether
 * content becomes public. Written by the server from the parameters and the
 * rows they name -- never model text.
 */
export interface ActionSummary {
  tool: ActionTool;
  asset: { id: string; publicId: string; title: string } | null;
  /** For a move: where it is now and where it would go; null is "no channel". */
  from: { id: string; slug: string; title: string; visibility: 'public' | 'private' } | null;
  to: { id: string; slug: string; title: string; visibility: 'public' | 'private' } | null;
  source: { type: AgentSourceType; location: string } | null;
  channel: { slug: string; title: string; visibility: 'public' | 'private' } | null;
  calls: { min: number; max: number };
  /** Bytes the asset holds now (refresh), or null when unknown until built. */
  assetBytes: number | null;
  /** What the workspace has left, for the card's capacity line. */
  capacityRemainingBytes: number | null;
  makesPublic: boolean;
}

/**
 * The summary as one English sentence: what an A2A caller's status message
 * and the planner's tool result carry. Server-templated, like the card.
 */
export function describeAction(summary: ActionSummary): string {
  const calls =
    summary.calls.max === 0
      ? 'no Calls'
      : summary.calls.min === summary.calls.max
        ? `${summary.calls.max} Calls`
        : `${summary.calls.min}-${summary.calls.max} Calls`;
  const where = (channel: ActionSummary['to']) =>
    channel ? `the ${channel.visibility} channel /channels/${channel.slug}` : 'no channel';
  let what: string;
  switch (summary.tool) {
    case 'create_asset':
      what = `create a ${summary.source?.type ?? ''} asset from ${summary.source?.location ?? ''} and build it`;
      break;
    case 'refresh_asset':
      what = `rebuild the asset ${summary.asset?.publicId ?? ''}`;
      break;
    case 'create_channel':
      what = `create the ${summary.channel?.visibility ?? 'public'} channel /channels/${summary.channel?.slug ?? ''}`;
      break;
    case 'move_asset':
      what = `move the asset ${summary.asset?.publicId ?? ''} from ${where(summary.from)} to ${where(summary.to)}`;
      break;
  }
  return `Pending owner confirmation: ${what}; estimated cost ${calls}${summary.makesPublic ? '; this makes the content public' : ''}.`;
}

/** Canonical JSON: keys sorted at every level, so one set of parameters has one digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/** An asset id the Agent derived from a title: lower-case words joined by hyphens. */
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Why a proposal, confirmation or rejection was refused; the Dashboard and the tools word the code. */
export class ActionRefused extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'not_owner'
      | 'not_pending'
      | 'expired'
      | 'stale'
      | 'unknown_tool'
      | 'invalid_params'
      | 'asset_not_found'
      | 'channel_not_found'
      | 'domain_unverified'
      | 'upload_needs_dashboard',
    message: string,
  ) {
    super(message);
    this.name = 'ActionRefused';
  }
}
