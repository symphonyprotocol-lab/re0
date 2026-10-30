/**
 * The confirmation gate (agent-first-proposal.md 5.2, 7.6): pending actions,
 * shared by the workbench and A2A.
 *
 * A tool that would change something never runs when it is called. It
 * proposes: the parameters are checked, their asset and channel references
 * resolved to the workspace's own rows, the cost estimated, and one
 * `agent_action` row written with a server-made summary of all of it. The
 * row is what the confirmation card shows.
 *
 * Confirmation is the only way out of `pending` towards execution, and it
 * has three locks:
 *
 * 1. who -- an `owner` actor, which only a Dashboard session builds, and
 *    one who may manage the workspace's assets (`mayConfirm`). The model,
 *    chunk text and an A2A caller are actors of their own kinds and are
 *    refused by name;
 * 2. what -- the digest of the parameters the card showed; a card that went
 *    stale confirms nothing, and changed parameters are a new proposal;
 * 3. once -- a conditional update `pending -> confirmed` that also checks
 *    the expiry; the loser of two clicks, and any click after 24 hours,
 *    finds nothing to update.
 *
 * Then the server runs it once, as that person, through the same use case
 * a Dashboard click runs (createWorkspaceAsset, requestAssetRebuild,
 * createChannel, moveAsset -- every rule stays there; for `delegate_task`,
 * the one SendMessage of external-agents/delegation.ts), records the outcome
 * on the row, and writes an audit entry. A use case that refuses -- a move
 * into a public channel without a rights declaration, a build the balance
 * cannot cover -- leaves the action `failed` with the reason, never
 * half-done.
 *
 * Results are written from the row and the use case's return value by the
 * server; nothing here passes through a model (proposal 5.3).
 *
 * A delegation's text is an A2A message body (proposal 10): the audit log
 * keeps its digest, not the text, and the 30-day purge clears it from the
 * row (external-agents/delegation.ts `purgeDelegationBodies`).
 *
 * An action and the A2A task waiting on it are two rows, moved by separate
 * writes. Wherever those can part -- a drain that died part-way through an
 * expiry, a confirmation whose function ended after the claim, a write that
 * failed -- `reconcileActionTasks` brings the task to where the action is,
 * from the drain and whenever the task is read.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lt, lte, ne } from 'drizzle-orm';
import { TaskState } from '@a2a-js/sdk';
import { AppError } from '@/contracts/errors';
import {
  ActionRefused,
  ACTION_TTL_MS,
  canonicalJson,
  describeAction,
  isActionTool,
  isAgentSourceType,
  mayConfirm,
  moveExposure,
  slugFromTitle,
  type ActionOrigin,
  type ActionParams,
  type ActionState,
  type ActionSummary,
  type ActionTool,
  type ConfirmActor,
  WORKBENCH_ONLY_TOOLS,
} from '@/lib/domain/agent-action';
import { channelSlugFromTitle, normalizeChannelSlug } from '@/lib/domain/channel';
import { requiresDomainVerification } from '@/lib/domain/domain-verification';
import { uuidv7 } from '@/lib/domain/id';
import { normalizeLocation } from '@/lib/domain/asset';
import { recordAudit } from '@/lib/application/administration/audit';
import { changeTask, dataPart, textPart, type TaskChange } from '@/lib/application/a2a/task-events';
import { createChannel, moveAsset } from '@/lib/application/channels';
import type { MoveFacts } from '@/lib/application/channels/manage';
import { createWorkspaceAsset } from '@/lib/application/assets/create';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { requestAssetRebuild } from '@/lib/application/assets/rebuild';
import { prepareDelegation, sendDelegation } from '@/lib/application/external-agents/delegation';
import { quoteBuild, workspaceStorage } from '@/lib/application/plans';
import { sha256 } from '@/lib/infrastructure/crypto/tokens';
import { db, schema } from '@/lib/infrastructure/postgres/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long a confirmation may take to record its outcome. Past it, a row
 * still `confirmed` with no result belongs to a function that ended between
 * the claim and the write: well over any server action's run.
 */
const CONFIRM_SETTLE_MS = 15 * 60_000;
/** What such a row is marked with, once, when the drain finds it. */
const OUTCOME_UNRECORDED = 'confirmed, but the outcome was not recorded; see the asset and its channel for what was done';

export interface PendingActionView {
  id: string;
  tool: ActionTool;
  state: ActionState;
  origin: ActionOrigin;
  summary: ActionSummary;
  /** The one-line English form of the summary (`describeAction`). */
  description: string;
  digest: string;
  estimatedCalls: number;
  estimatedBytes: number | null;
  makesPublic: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  a2aTaskId: string | null;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
}

type ActionRow = typeof schema.agentAction.$inferSelect;

function view(row: ActionRow, now: Date = new Date()): PendingActionView {
  const summary = row.summary as unknown as ActionSummary;
  /* A row past its expiry reads as expired before the sweep has written it. */
  const state = row.state === 'pending' && row.expiresAt <= now ? 'expired' : row.state;
  return {
    id: row.id,
    tool: row.tool as ActionTool,
    state,
    origin: row.origin,
    summary,
    description: describeAction(summary),
    digest: row.paramsDigest,
    estimatedCalls: row.estimatedCalls,
    estimatedBytes: row.estimatedBytes ?? null,
    makesPublic: row.makesPublic,
    result: row.result ?? null,
    error: row.error ?? null,
    a2aTaskId: row.a2aTaskId ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

export async function paramsDigest(params: ActionParams): Promise<string> {
  return sha256(canonicalJson(params));
}

/* ------------------------------------------------------------------ propose */

export interface ProposeInput {
  workspaceId: string;
  /** The workbench user's role; an A2A key acts for its workspace and only proposes. */
  role: WorkspaceRole | null;
  origin: ActionOrigin;
  requestedBy?: string | null;
  apiKeyId?: string | null;
  conversationId?: string | null;
  a2aTaskId?: string | null;
  tool: string;
  /** The tool's raw arguments, as the model or the A2A data part sent them. */
  args: Record<string, unknown>;
}

/**
 * Writes a pending action, or refuses with `ActionRefused`. Nothing is
 * executed and nothing is charged.
 */
export async function proposeAction(input: ProposeInput): Promise<PendingActionView> {
  if (!isActionTool(input.tool)) throw new ActionRefused('unknown_tool', `"${input.tool}" is not an action`);
  if (WORKBENCH_ONLY_TOOLS.has(input.tool) && input.origin !== 'workbench') {
    throw new ActionRefused('workbench_only', `"${input.tool}" is proposed only from the owner's workbench`);
  }
  if (input.role !== null && !canManageAssets(input.role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can ask for this');
  }
  const { params, summary, estimatedCalls, estimatedBytes } = await prepare(input.workspaceId, input.tool, input.args);
  const id = uuidv7();
  const now = new Date();
  const [row] = await db()
    .insert(schema.agentAction)
    .values({
      id,
      workspaceId: input.workspaceId,
      tool: input.tool,
      params: params as unknown as Record<string, unknown>,
      paramsDigest: await paramsDigest(params),
      summary: summary as unknown as Record<string, unknown>,
      estimatedCalls,
      estimatedBytes,
      makesPublic: summary.makesPublic,
      state: 'pending',
      origin: input.origin,
      requestedBy: input.requestedBy ?? null,
      apiKeyId: input.apiKeyId ?? null,
      conversationId: input.conversationId ?? null,
      a2aTaskId: input.a2aTaskId ?? null,
      expiresAt: new Date(now.getTime() + ACTION_TTL_MS),
      createdAt: now,
    })
    .returning();
  return view(row!, now);
}

async function prepare(
  workspaceId: string,
  tool: ActionTool,
  args: Record<string, unknown>,
): Promise<{ params: ActionParams; summary: ActionSummary; estimatedCalls: number; estimatedBytes: number | null }> {
  const blank: Omit<ActionSummary, 'tool'> = {
    asset: null,
    from: null,
    to: null,
    source: null,
    channel: null,
    delegation: null,
    calls: { min: 0, max: 0 },
    assetBytes: null,
    capacityRemainingBytes: null,
    makesPublic: false,
    makesFree: false,
  };
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

  if (tool === 'create_asset') {
    const sourceType = args.sourceType;
    if (sourceType === 'pdf' || sourceType === 'markdown' || sourceType === 'upload') {
      throw new ActionRefused('upload_needs_dashboard', 'files are uploaded in the Dashboard (/dashboard/assets/new), not through the Agent');
    }
    if (!isAgentSourceType(sourceType)) {
      throw new ActionRefused('invalid_params', 'sourceType must be website, github or notion');
    }
    const location = normalizeLocation(sourceType, text(args.location, 2_000));
    if (!location) throw new ActionRefused('invalid_params', `that is not a valid ${sourceType} location`);
    const title = text(args.title, 120) || location.replace(/^https?:\/\//, '').slice(0, 120);
    const slug = slugFromTitle(text(args.slug, 60) || title) || 'asset';
    if (requiresDomainVerification(sourceType) && !(await spendableChallenge(workspaceId, location))) {
      throw new ActionRefused(
        'domain_unverified',
        'verify control of this website first, in the Dashboard (/dashboard/assets/new); then ask again',
      );
    }
    const quote = await quoteBuild({ workspaceId, fetchesPages: requiresDomainVerification(sourceType) });
    const storage = await workspaceStorage(workspaceId);
    return {
      params: { tool, sourceType, location, title, slug },
      summary: {
        ...blank,
        tool,
        source: { type: sourceType, location },
        calls: { min: quote.rates.baseCalls, max: quote.maxCalls },
        capacityRemainingBytes: storage.remainingBytes,
      },
      estimatedCalls: quote.maxCalls,
      estimatedBytes: null,
    };
  }

  if (tool === 'refresh_asset') {
    const asset = await ownedAsset(workspaceId, args.assetId ?? args.asset);
    const [source] = await db()
      .select({ type: schema.source.type })
      .from(schema.source)
      .where(eq(schema.source.assetId, asset.id))
      .limit(1);
    const quote = await quoteBuild({
      workspaceId,
      fetchesPages: source ? requiresDomainVerification(source.type) : false,
      assetId: asset.id,
    });
    const storage = await workspaceStorage(workspaceId, { excludeAssetId: asset.id });
    return {
      params: { tool, assetId: asset.id },
      summary: {
        ...blank,
        tool,
        asset: { id: asset.id, publicId: asset.publicId, title: asset.title },
        calls: { min: quote.rates.baseCalls, max: quote.maxCalls },
        assetBytes: asset.storageBytes,
        capacityRemainingBytes: storage.remainingBytes,
      },
      estimatedCalls: quote.maxCalls,
      estimatedBytes: asset.storageBytes,
    };
  }

  if (tool === 'create_channel') {
    const slug = normalizeChannelSlug(text(args.slug, 60).toLowerCase() || channelSlugFromTitle(text(args.title, 80)));
    const title = text(args.title, 80);
    if (!slug || !title) throw new ActionRefused('invalid_params', 'a channel needs a title and an address (slug)');
    const visibility = args.visibility === 'private' ? 'private' : 'public';
    const description = text(args.description, 500) || null;
    return {
      params: { tool, slug, title, description, visibility },
      /* An empty channel shows nothing yet; what goes into it is a move of its own. */
      summary: { ...blank, tool, channel: { slug, title, visibility } },
      estimatedCalls: 0,
      estimatedBytes: 0,
    };
  }

  if (tool === 'delegate_task') {
    /* Sends nothing: the agent, endpoint, skill, text and credential are frozen for the card. */
    const { params, delegation } = await prepareDelegation(workspaceId, args);
    return {
      params,
      summary: { ...blank, tool, delegation },
      /* Delegation bills no Calls (proposal 7.9, 8.2). */
      estimatedCalls: 0,
      estimatedBytes: 0,
    };
  }

  /* move_asset */
  const asset = await ownedAsset(workspaceId, args.assetId ?? args.asset);
  const toRef = args.channelId ?? args.channel ?? null;
  const target = toRef === null || toRef === '' ? null : await ownedChannel(workspaceId, toRef);
  const [current] = await db()
    .select({
      id: schema.channel.id,
      slug: schema.channel.slug,
      title: schema.channel.title,
      visibility: schema.channel.visibility,
    })
    .from(schema.channelAsset)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
    .where(eq(schema.channelAsset.assetId, asset.id))
    .limit(1);
  const from = current ?? null;
  /* A paid asset leaving for a public channel arrives free (channels/manage.ts `moveAsset`): the card says so. */
  const { makesPublic, makesFree } = moveExposure(from, target, asset.access);
  return {
    params: { tool, assetId: asset.id, channelId: target?.id ?? null },
    summary: {
      ...blank,
      tool,
      asset: { id: asset.id, publicId: asset.publicId, title: asset.title },
      from,
      to: target,
      makesPublic,
      makesFree,
    },
    estimatedCalls: 0,
    estimatedBytes: 0,
  };
}

/** An asset of this workspace, by id or public id; anything else is "not found". */
export async function ownedAsset(
  workspaceId: string,
  ref: unknown,
): Promise<{ id: string; publicId: string; title: string; storageBytes: number; access: 'free' | 'paid' }> {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) throw new ActionRefused('asset_not_found', 'name the asset by its id');
  const [row] = await db()
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      storageBytes: schema.asset.storageBytes,
      access: schema.asset.access,
    })
    .from(schema.asset)
    .where(
      and(
        UUID.test(value) ? eq(schema.asset.id, value) : eq(schema.asset.publicId, value.toLowerCase()),
        eq(schema.asset.ownerWorkspaceId, workspaceId),
        eq(schema.asset.isPlatformAsset, false),
        ne(schema.asset.lifecycleStatus, 'archived'),
        isNull(schema.asset.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ActionRefused('asset_not_found', `no asset ${value} in this workspace`);
  return { ...row, storageBytes: Number(row.storageBytes ?? 0), access: row.access === 'paid' ? 'paid' : 'free' };
}

/** A channel of this workspace, by id, slug or `/channels/{slug}`. */
export async function ownedChannel(
  workspaceId: string,
  ref: unknown,
): Promise<{ id: string; slug: string; title: string; visibility: 'public' | 'private' }> {
  const value = typeof ref === 'string' ? ref.trim().replace(/^\/?channels\//, '') : '';
  if (!value) throw new ActionRefused('channel_not_found', 'name the channel by its address');
  const [row] = await db()
    .select({
      id: schema.channel.id,
      slug: schema.channel.slug,
      title: schema.channel.title,
      visibility: schema.channel.visibility,
    })
    .from(schema.channel)
    .where(
      and(
        UUID.test(value) ? eq(schema.channel.id, value) : eq(schema.channel.slug, value.toLowerCase()),
        eq(schema.channel.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new ActionRefused('channel_not_found', `no channel ${value} in this workspace`);
  return row;
}

/** The newest verified, unspent domain challenge for a website's host, if any. */
async function spendableChallenge(workspaceId: string, location: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(location).hostname.toLowerCase();
  } catch {
    return null;
  }
  const [row] = await db()
    .select({ id: schema.domainVerification.id })
    .from(schema.domainVerification)
    .where(
      and(
        eq(schema.domainVerification.workspaceId, workspaceId),
        eq(schema.domainVerification.host, host),
        eq(schema.domainVerification.status, 'verified'),
        isNull(schema.domainVerification.consumedAssetId),
      ),
    )
    .orderBy(desc(schema.domainVerification.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/* ------------------------------------------------------------------ confirm */

export interface ConfirmOutcome {
  action: PendingActionView;
  /** A build the confirmation queued: the caller runs it after responding (`after`). */
  operationId: string | null;
}

/**
 * Confirms and runs a pending action once. Refuses with `ActionRefused`:
 * `not_owner` for anyone but the signed-in owner, `stale` for a digest that
 * is not the row's, `expired` past 24 hours, `not_pending` for one already
 * decided. A refusal leaves the row as it was (an expired one is marked so).
 */
export async function confirmAction(
  actor: ConfirmActor,
  input: { actionId: string; digest: string },
): Promise<ConfirmOutcome> {
  const row = await loadRow(input.actionId);
  /* Not the actor's workspace looks like no row at all, as everywhere else. */
  if (!row || (actor.kind === 'owner' && actor.workspaceId !== row.workspaceId)) {
    throw new ActionRefused('not_found', 'no such pending action');
  }
  if (mayConfirm(actor, row.workspaceId)) {
    throw new ActionRefused('not_owner', 'only the signed-in owner can confirm this, from the Dashboard');
  }
  const owner = actor as Extract<ConfirmActor, { kind: 'owner' }>;
  const now = new Date();
  const claimed = await db()
    .update(schema.agentAction)
    .set({ state: 'confirmed', confirmedBy: owner.userId, decidedAt: now })
    .where(
      and(
        eq(schema.agentAction.id, row.id),
        eq(schema.agentAction.state, 'pending'),
        eq(schema.agentAction.paramsDigest, input.digest),
        gt(schema.agentAction.expiresAt, now),
      ),
    )
    .returning();
  if (claimed.length === 0) throw await whyNotClaimed(row.id, input.digest, now);
  const action = claimed[0]!;

  const params = action.params as unknown as ActionParams;
  let result: Record<string, unknown>;
  let operationId: string | null = null;
  try {
    const role = await memberRole(owner.userId, action.workspaceId);
    result = await execute(action.workspaceId, role, owner.userId, params, action);
    operationId = typeof result.operationId === 'string' ? result.operationId : null;
  } catch (error) {
    const message = refusalMessage(error);
    const [failed] = await db()
      .update(schema.agentAction)
      .set({ state: 'failed', error: message })
      .where(eq(schema.agentAction.id, action.id))
      .returning();
    await audit(failed!, owner.userId, 'failure');
    await moveTaskAfter(failed!);
    return { action: view(failed!), operationId: null };
  }

  /*
   * It ran. The row's result, the audit entry and the task are three
   * writes, and none may undo another: a failed result write still leaves
   * the audit entry of what was done, and a task left behind is caught up
   * by `reconcileActionTasks`. The task's push notifications go out after
   * the click (push.ts), not inside it.
   */
  const done =
    (await db()
      .update(schema.agentAction)
      .set({ result })
      .where(eq(schema.agentAction.id, action.id))
      .returning()
      .then(
        ([row]) => row,
        (error: unknown) => {
          console.error(`agent action ${action.id} ran but its result was not stored: ${error instanceof Error ? error.message : 'unknown'}`);
          return undefined;
        },
      )) ?? { ...action, result };
  await audit(done, owner.userId, 'success');
  if (done.a2aTaskId) {
    await followConfirmation(done, result).catch((error: unknown) => {
      console.error(`a2a task ${done.a2aTaskId} not moved after confirmation: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }
  return { action: view(done), operationId };
}

/** Why the conditional update matched nothing, worded for the one who clicked. */
async function whyNotClaimed(actionId: string, digest: string, now: Date): Promise<ActionRefused> {
  const row = await loadRow(actionId);
  if (!row) return new ActionRefused('not_found', 'no such pending action');
  if (row.state === 'pending' && row.expiresAt <= now) {
    await expireActions(now, [row.id]);
    return new ActionRefused('expired', 'this pending action expired after 24 hours; ask again');
  }
  if (row.state === 'expired') return new ActionRefused('expired', 'this pending action expired after 24 hours; ask again');
  if (row.state !== 'pending') return new ActionRefused('not_pending', 'this action was already decided');
  if (row.paramsDigest !== digest) {
    return new ActionRefused('stale', 'what you confirmed is not what is pending; reload and confirm again');
  }
  return new ActionRefused('not_pending', 'this action was already decided');
}

async function execute(
  workspaceId: string,
  role: WorkspaceRole,
  userId: string,
  params: ActionParams,
  action: ActionRow,
): Promise<Record<string, unknown>> {
  switch (params.tool) {
    case 'create_asset': {
      const challenge = requiresDomainVerification(params.sourceType)
        ? await spendableChallenge(workspaceId, params.location)
        : null;
      const created = await createWorkspaceAsset({
        workspaceId,
        role,
        userId,
        title: params.title,
        sourceType: params.sourceType,
        location: params.location,
        slug: params.slug,
        ...(challenge ? { domainVerificationId: challenge } : {}),
      });
      return { assetId: created.assetId, publicId: created.publicId, operationId: created.operationId };
    }
    case 'refresh_asset': {
      const rebuilt = await requestAssetRebuild({ workspaceId, role, assetId: params.assetId });
      return { assetId: params.assetId, operationId: rebuilt.operationId, queued: rebuilt.created };
    }
    case 'create_channel': {
      const created = await createChannel({
        workspaceId,
        role,
        slug: params.slug,
        title: params.title,
        description: params.description,
        visibility: params.visibility,
      });
      return { channelId: created.id, slug: created.slug };
    }
    case 'move_asset': {
      /* What the card said must still hold, checked under the move's own locks (proposal 5.2). */
      const card = action.summary as unknown as ActionSummary;
      const moved = await moveAsset({
        workspaceId,
        role,
        assetId: params.assetId,
        channelId: params.channelId,
        expect: (facts) => assertMoveAsShown(card, facts),
      });
      return { assetId: params.assetId, from: moved.from, to: moved.to, madePublic: moved.madePublic };
    }
    case 'delegate_task': {
      const sent = await sendDelegation(workspaceId, params, { actionId: action.id, conversationId: action.conversationId ?? null });
      return { delegationId: sent.delegationId, remoteState: sent.state, remoteTaskId: sent.remoteTaskId };
    }
  }
}

/**
 * A move card states where the asset is, where it goes, who can see each,
 * and whether that makes content public or a paid asset free. Any of those
 * that changed since -- the target turned public, the asset left its
 * channel, its access changed -- makes the card stale: refused, like a
 * delegation whose agent changed (external-agents/delegation.ts).
 */
function assertMoveAsShown(card: ActionSummary, facts: MoveFacts): void {
  const now = moveExposure(facts.from, facts.to, facts.access);
  const unchanged =
    (card.from?.id ?? null) === (facts.from?.id ?? null) &&
    (card.from?.visibility ?? null) === (facts.from?.visibility ?? null) &&
    (card.to?.visibility ?? null) === (facts.to?.visibility ?? null) &&
    card.makesPublic === now.makesPublic &&
    (card.makesFree ?? false) === now.makesFree;
  if (!unchanged) {
    throw new ActionRefused(
      'stale',
      'the asset or a channel changed since this card was made (where the asset is, who can see a channel, or its access); ask again',
    );
  }
}

/** The A2A task an action was waiting for moves on (proposal 7.6). */
async function followConfirmation(action: ActionRow, result: Record<string, unknown>): Promise<void> {
  const taskId = action.a2aTaskId!;
  const summary = action.summary as unknown as ActionSummary;
  const operationId = typeof result.operationId === 'string' ? result.operationId : null;
  if (operationId) {
    await changeTask(taskId, {
      state: TaskState.TASK_STATE_WORKING,
      message: `The owner confirmed. The build is queued (operation ${operationId}).`,
      workflowRunId: operationId,
      metadata: { actionId: action.id, operationId },
    });
    return;
  }
  const text =
    summary.tool === 'move_asset'
      ? `Done: ${summary.asset?.publicId ?? 'the asset'} is now in ${summary.to ? `/channels/${summary.to.slug}` : 'no channel'}${result.madePublic ? ' and public' : ''}.`
      : 'Done.';
  await changeTask(taskId, {
    state: TaskState.TASK_STATE_COMPLETED,
    message: text,
    artifact: {
      artifactId: randomUUID(),
      name: 'result',
      description: 'What the confirmed action did',
      parts: [textPart(text), dataPart({ actionId: action.id, tool: action.tool, ...result })],
      metadata: undefined,
      extensions: [],
    },
  });
}

/* ------------------------------------------------------------------- reject */

/** The owner declines. Same lock on who as confirming; a linked A2A task fails with the reason. */
export async function rejectAction(actor: ConfirmActor, input: { actionId: string }): Promise<PendingActionView> {
  const row = await loadRow(input.actionId);
  if (!row || (actor.kind === 'owner' && actor.workspaceId !== row.workspaceId)) {
    throw new ActionRefused('not_found', 'no such pending action');
  }
  if (mayConfirm(actor, row.workspaceId)) {
    throw new ActionRefused('not_owner', 'only the signed-in owner can decline this, from the Dashboard');
  }
  const owner = actor as Extract<ConfirmActor, { kind: 'owner' }>;
  return closeAction(row.id, 'rejected', 'the owner declined', owner.userId);
}

/**
 * The A2A caller withdraws its own request (`CancelTask` on a task that is
 * waiting for confirmation). Withdrawing is not confirming: it can only
 * close the action, never run it. The task ends CANCELED -- the caller's
 * cancel is what happened -- where an owner's refusal fails it.
 */
export async function withdrawAction(actionId: string): Promise<PendingActionView | null> {
  try {
    return await closeAction(actionId, 'rejected', 'the caller cancelled the task', null);
  } catch (error) {
    if (error instanceof ActionRefused) return null;
    throw error;
  }
}

async function closeAction(
  actionId: string,
  state: 'rejected',
  reason: string,
  userId: string | null,
): Promise<PendingActionView> {
  const now = new Date();
  const [closed] = await db()
    .update(schema.agentAction)
    .set({ state, decidedAt: now, error: reason, ...(userId ? { confirmedBy: userId } : {}) })
    .where(and(eq(schema.agentAction.id, actionId), eq(schema.agentAction.state, 'pending'), gt(schema.agentAction.expiresAt, now)))
    .returning();
  if (!closed) throw await whyNotClaimed(actionId, '', now);
  await recordAudit({
    administratorId: null,
    action: `agent_action.${closed.tool}.rejected`,
    targetType: 'agent_action',
    targetId: closed.id,
    reason,
    beforeValue: { params: await auditedParams(closed.params), origin: closed.origin },
    afterValue: { workspaceId: closed.workspaceId, decidedBy: userId },
    result: 'success',
  });
  await moveTaskAfter(closed);
  return view(closed);
}

/**
 * Where an A2A task goes once its action is decided (proposal 7.6): an
 * expiry or an owner's refusal fails it with the reason, the caller's own
 * withdrawal cancels it, a confirmed action that could not be done fails it.
 * Null for a confirmed action, which `followConfirmation` follows, and for
 * one still pending.
 */
function taskChangeFor(row: ActionRow): TaskChange | null {
  switch (row.state) {
    case 'expired':
      return { state: TaskState.TASK_STATE_FAILED, message: 'Not done: the owner did not confirm within 24 hours, so the pending action expired.' };
    case 'rejected':
      return row.confirmedBy
        ? { state: TaskState.TASK_STATE_FAILED, message: `Not done: ${row.error ?? 'the owner declined'}.` }
        : { state: TaskState.TASK_STATE_CANCELED, message: 'Canceled: the request was withdrawn before the owner decided; nothing was done.' };
    case 'failed':
      return { state: TaskState.TASK_STATE_FAILED, message: `The owner confirmed, but it could not be done: ${row.error ?? 'the action could not be completed'}` };
    default:
      return null;
  }
}

/** Moves the action's task, if it has one; a move that fails is left to `reconcileActionTasks`. */
async function moveTaskAfter(row: ActionRow): Promise<void> {
  const change = taskChangeFor(row);
  if (!row.a2aTaskId || !change) return;
  await changeTask(row.a2aTaskId, change).catch((error: unknown) => {
    console.error(`a2a task ${row.a2aTaskId} not moved after its action: ${error instanceof Error ? error.message : 'unknown'}`);
  });
}

/* ------------------------------------------------------------------- expiry */

/**
 * Proposal 5.2: undecided for 24 hours, void. Marks them expired and fails
 * the A2A tasks waiting on them. Run by the drain; a confirmation that
 * arrives late expires its own row on the spot.
 */
export async function expireActions(now: Date = new Date(), ids?: readonly string[]): Promise<number> {
  const expired = await db()
    .update(schema.agentAction)
    .set({ state: 'expired', decidedAt: now })
    .where(
      and(
        eq(schema.agentAction.state, 'pending'),
        lte(schema.agentAction.expiresAt, now),
        ...(ids ? [inArray(schema.agentAction.id, ids.length > 0 ? [...ids] : [''])] : []),
      ),
    )
    .returning();
  /* One task that cannot be moved does not keep the rest waiting; what is left behind is reconciled. */
  for (const row of expired) await moveTaskAfter(row);
  return expired.length;
}

/* ---------------------------------------------------------- reconciliation */

/**
 * Brings A2A tasks to where their actions are, for every way the two can
 * part: an action expired, declined, withdrawn or failed whose task still
 * waits; a confirmed action whose task never heard (the function ended
 * after the claim, or the move failed). And a confirmation that never
 * recorded its outcome -- `confirmed`, no result, long past -- is marked so,
 * once, with the audit entry it never wrote, and its task fails.
 * Run by the drain over everything, and on read for the tasks read
 * (a2a/server.ts `catchUp`).
 */
export async function reconcileActionTasks(taskIds?: readonly string[], now: Date = new Date()): Promise<number> {
  const scope = taskIds ? [inArray(schema.agentAction.a2aTaskId, taskIds.length > 0 ? [...taskIds] : [''])] : [];
  let repaired = 0;

  const lost = await db()
    .update(schema.agentAction)
    .set({ error: OUTCOME_UNRECORDED })
    .where(
      and(
        eq(schema.agentAction.state, 'confirmed'),
        isNull(schema.agentAction.result),
        isNull(schema.agentAction.error),
        lt(schema.agentAction.decidedAt, new Date(now.getTime() - CONFIRM_SETTLE_MS)),
        ...scope,
      ),
    )
    .returning();
  for (const row of lost) {
    await audit(row, row.confirmedBy ?? null, 'failure');
    repaired += 1;
  }

  const behind = await db()
    .select({ action: schema.agentAction })
    .from(schema.agentAction)
    .innerJoin(schema.a2aTask, eq(schema.a2aTask.id, schema.agentAction.a2aTaskId))
    .where(and(eq(schema.a2aTask.state, 'TASK_STATE_INPUT_REQUIRED'), ne(schema.agentAction.state, 'pending'), ...scope))
    .limit(500);
  for (const { action } of behind) {
    try {
      if (action.state === 'confirmed') {
        if (action.result) await followConfirmation(action, action.result);
        else if (action.error === OUTCOME_UNRECORDED) {
          await changeTask(action.a2aTaskId!, { state: TaskState.TASK_STATE_FAILED, message: `The owner ${OUTCOME_UNRECORDED}.` });
        } else continue;
      } else {
        const change = taskChangeFor(action);
        if (!change) continue;
        await changeTask(action.a2aTaskId!, change);
      }
      repaired += 1;
    } catch (error) {
      console.error(`a2a task ${action.a2aTaskId} not reconciled: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  return repaired;
}

/* -------------------------------------------------------------------- reads */

export async function listActions(
  workspaceId: string,
  options: { pendingOnly?: boolean; limit?: number } = {},
): Promise<PendingActionView[]> {
  const now = new Date();
  const rows = await db()
    .select()
    .from(schema.agentAction)
    .where(
      and(
        eq(schema.agentAction.workspaceId, workspaceId),
        ...(options.pendingOnly ? [eq(schema.agentAction.state, 'pending'), gt(schema.agentAction.expiresAt, now)] : []),
      ),
    )
    .orderBy(desc(schema.agentAction.createdAt))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
  return rows.map((row) => view(row, now));
}

export async function actionById(workspaceId: string, actionId: string): Promise<PendingActionView | null> {
  if (!UUID.test(actionId)) return null;
  const [row] = await db()
    .select()
    .from(schema.agentAction)
    .where(and(eq(schema.agentAction.id, actionId), eq(schema.agentAction.workspaceId, workspaceId)))
    .limit(1);
  return row ? view(row) : null;
}

/** Several actions of this workspace by id, in one read; unknown and foreign ids are left out. */
export async function actionsByIds(workspaceId: string, actionIds: readonly string[]): Promise<Map<string, PendingActionView>> {
  const ids = actionIds.filter((id) => UUID.test(id));
  if (ids.length === 0) return new Map();
  const rows = await db()
    .select()
    .from(schema.agentAction)
    .where(and(eq(schema.agentAction.workspaceId, workspaceId), inArray(schema.agentAction.id, ids)));
  return new Map(rows.map((row) => [row.id, view(row)]));
}

/** Pending actions per asset or channel id, for the workbench's cards. */
export function pendingTargets(pending: readonly PendingActionView[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const action of pending) {
    for (const id of [action.summary.asset?.id, action.summary.to?.id, action.summary.from?.id]) {
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ helpers */

async function loadRow(actionId: string): Promise<ActionRow | null> {
  if (!UUID.test(actionId)) return null;
  const [row] = await db().select().from(schema.agentAction).where(eq(schema.agentAction.id, actionId)).limit(1);
  return row ?? null;
}

async function memberRole(userId: string, workspaceId: string): Promise<WorkspaceRole> {
  const [member] = await db()
    .select({ role: schema.workspaceMember.role })
    .from(schema.workspaceMember)
    .where(and(eq(schema.workspaceMember.userId, userId), eq(schema.workspaceMember.workspaceId, workspaceId)))
    .limit(1);
  if (!member) throw new AppError('access_denied', 'not a member of this workspace');
  return member.role as WorkspaceRole;
}

function refusalMessage(error: unknown): string {
  if (error instanceof AppError || error instanceof ActionRefused) return error.message;
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return `${(error as { code: string }).code}: ${error.message}`;
  }
  console.error(`agent action failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return 'the action could not be completed';
}

/** A delegation's text is a message body: the audit log keeps its digest (proposal 10). */
async function auditedParams(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (params.tool !== 'delegate_task' || typeof params.message !== 'string') return params;
  return { ...params, message: null, messageDigest: await sha256(params.message) };
}

function auditedSummary(summary: Record<string, unknown>): Record<string, unknown> {
  const delegation = summary.delegation as Record<string, unknown> | null | undefined;
  return delegation ? { ...summary, delegation: { ...delegation, message: null } } : summary;
}

async function audit(row: ActionRow, userId: string | null, result: 'success' | 'failure'): Promise<void> {
  await recordAudit({
    administratorId: null,
    action: `agent_action.${row.tool}`,
    targetType: 'agent_action',
    targetId: row.id,
    reason: row.origin === 'a2a' ? 'confirmed an A2A request' : 'confirmed a workbench request',
    beforeValue: { params: await auditedParams(row.params), summary: auditedSummary(row.summary), origin: row.origin },
    afterValue: { workspaceId: row.workspaceId, confirmedBy: userId, result: row.result, error: row.error },
    result,
  });
}
