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
 * a Dashboard click runs (createWorkspaceLibrary, requestLibraryRebuild,
 * createChannel, moveAsset -- every rule stays there), records the outcome
 * on the row, and writes an audit entry. A use case that refuses -- a move
 * into a public channel without a rights declaration, a build the balance
 * cannot cover -- leaves the action `failed` with the reason, never
 * half-done.
 *
 * Results are written from the row and the use case's return value by the
 * server; nothing here passes through a model (proposal 5.3).
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, ne } from 'drizzle-orm';
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
  slugFromTitle,
  type ActionOrigin,
  type ActionParams,
  type ActionState,
  type ActionSummary,
  type ActionTool,
  type ConfirmActor,
} from '@/lib/domain/agent-action';
import { channelSlugFromTitle, normalizeChannelSlug } from '@/lib/domain/channel';
import { requiresDomainVerification } from '@/lib/domain/domain-verification';
import { uuidv7 } from '@/lib/domain/id';
import { normalizeLocation } from '@/lib/domain/library';
import { recordAudit } from '@/lib/application/administration/audit';
import { changeTask, dataPart, textPart } from '@/lib/application/a2a/task-events';
import { createChannel, moveAsset } from '@/lib/application/channels';
import { createWorkspaceLibrary } from '@/lib/application/libraries/create';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { requestLibraryRebuild } from '@/lib/application/libraries/rebuild';
import { quoteBuild, workspaceStorage } from '@/lib/application/plans';
import { sha256 } from '@/lib/infrastructure/crypto/tokens';
import { db, schema } from '@/lib/infrastructure/postgres/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (input.role !== null && !canManageLibraries(input.role)) {
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
    calls: { min: 0, max: 0 },
    assetBytes: null,
    capacityRemainingBytes: null,
    makesPublic: false,
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
      .where(eq(schema.source.libraryId, asset.id))
      .limit(1);
    const quote = await quoteBuild({
      workspaceId,
      fetchesPages: source ? requiresDomainVerification(source.type) : false,
      libraryId: asset.id,
    });
    const storage = await workspaceStorage(workspaceId, { excludeLibraryId: asset.id });
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
  const makesPublic = target?.visibility === 'public' && from?.visibility !== 'public';
  return {
    params: { tool, assetId: asset.id, channelId: target?.id ?? null },
    summary: {
      ...blank,
      tool,
      asset: { id: asset.id, publicId: asset.publicId, title: asset.title },
      from,
      to: target,
      makesPublic,
    },
    estimatedCalls: 0,
    estimatedBytes: 0,
  };
}

/** An asset of this workspace, by id or public id; anything else is "not found". */
export async function ownedAsset(
  workspaceId: string,
  ref: unknown,
): Promise<{ id: string; publicId: string; title: string; storageBytes: number }> {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) throw new ActionRefused('asset_not_found', 'name the asset by its id');
  const [row] = await db()
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      title: schema.library.title,
      storageBytes: schema.library.storageBytes,
    })
    .from(schema.library)
    .where(
      and(
        UUID.test(value) ? eq(schema.library.id, value) : eq(schema.library.publicId, value.toLowerCase()),
        eq(schema.library.ownerWorkspaceId, workspaceId),
        eq(schema.library.isPlatformLibrary, false),
        ne(schema.library.lifecycleStatus, 'archived'),
        isNull(schema.library.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ActionRefused('asset_not_found', `no asset ${value} in this workspace`);
  return { ...row, storageBytes: Number(row.storageBytes ?? 0) };
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
        isNull(schema.domainVerification.consumedLibraryId),
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
    result = await execute(action.workspaceId, role, owner.userId, params);
    operationId = typeof result.operationId === 'string' ? result.operationId : null;
  } catch (error) {
    const message = refusalMessage(error);
    const [failed] = await db()
      .update(schema.agentAction)
      .set({ state: 'failed', error: message })
      .where(eq(schema.agentAction.id, action.id))
      .returning();
    await audit(failed!, owner.userId, 'failure');
    if (failed!.a2aTaskId) {
      await changeTask(failed!.a2aTaskId, {
        state: TaskState.TASK_STATE_FAILED,
        message: `The owner confirmed, but it could not be done: ${message}`,
      });
    }
    return { action: view(failed!), operationId: null };
  }

  const [done] = await db()
    .update(schema.agentAction)
    .set({ result })
    .where(eq(schema.agentAction.id, action.id))
    .returning();
  await audit(done!, owner.userId, 'success');
  if (done!.a2aTaskId) await followConfirmation(done!, result);
  return { action: view(done!), operationId };
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
): Promise<Record<string, unknown>> {
  switch (params.tool) {
    case 'create_asset': {
      const challenge = requiresDomainVerification(params.sourceType)
        ? await spendableChallenge(workspaceId, params.location)
        : null;
      const created = await createWorkspaceLibrary({
        workspaceId,
        role,
        userId,
        title: params.title,
        sourceType: params.sourceType,
        location: params.location,
        slug: params.slug,
        ...(challenge ? { domainVerificationId: challenge } : {}),
      });
      return { assetId: created.libraryId, publicId: created.publicId, operationId: created.operationId };
    }
    case 'refresh_asset': {
      const rebuilt = await requestLibraryRebuild({ workspaceId, role, libraryId: params.assetId });
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
      const moved = await moveAsset({ workspaceId, role, assetId: params.assetId, channelId: params.channelId });
      return { assetId: params.assetId, from: moved.from, to: moved.to, madePublic: moved.madePublic };
    }
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
 * close the action, never run it.
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
    beforeValue: { params: closed.params, origin: closed.origin },
    afterValue: { workspaceId: closed.workspaceId, decidedBy: userId },
    result: 'success',
  });
  if (closed.a2aTaskId) {
    await changeTask(closed.a2aTaskId, { state: TaskState.TASK_STATE_FAILED, message: `Not done: ${reason}.` });
  }
  return view(closed);
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
    .returning({ id: schema.agentAction.id, a2aTaskId: schema.agentAction.a2aTaskId });
  for (const row of expired) {
    if (row.a2aTaskId) {
      await changeTask(row.a2aTaskId, {
        state: TaskState.TASK_STATE_FAILED,
        message: 'Not done: the owner did not confirm within 24 hours, so the pending action expired.',
      });
    }
  }
  return expired.length;
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

async function audit(row: ActionRow, userId: string, result: 'success' | 'failure'): Promise<void> {
  await recordAudit({
    administratorId: null,
    action: `agent_action.${row.tool}`,
    targetType: 'agent_action',
    targetId: row.id,
    reason: row.origin === 'a2a' ? 'confirmed an A2A request' : 'confirmed a workbench request',
    beforeValue: { params: row.params, summary: row.summary, origin: row.origin },
    afterValue: { workspaceId: row.workspaceId, confirmedBy: userId, result: row.result, error: row.error },
    result,
  });
}
