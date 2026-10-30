/**
 * The A2A executor: an adapter, nothing more (agent-first-proposal.md 7.8).
 * It reads which skill the message asks for, checks the caller may use it
 * here, calls the application function that already enforces visibility,
 * policy, metering and the confirmation gate, and writes the result as a
 * task with one artifact of two parts (proposal 7.5):
 *
 * - `text`: the answer (`ask`) or a readable summary;
 * - `data`: the structured evidence -- per passage or citation the chunk id,
 *   asset id, source URL, section, version, and that version's on-chain
 *   anchor.
 *
 * Skills (proposal 7.2): `find_channels` (platform only) and
 * `search_context` call no model; `ask` runs the shared generation chain
 * (agent/ask.ts) and needs a key. The write skills -- `ingest`, `refresh`,
 * `publish` -- need `assets:write` and work on the caller's own workspace
 * only (the platform tenant, or the caller's own user tenant). They never
 * act: each writes a pending action (agent/actions.ts) and the task goes
 * `WORKING -> INPUT_REQUIRED`, its status message naming the owner's
 * Dashboard confirmation and linking it. The confirmation, a refusal, an
 * expiry and the build that follows move the task from outside this request
 * (task-events.ts).
 *
 * A message from another agent is untrusted input (proposal 10): its text is
 * a query and nothing else. It cannot pick a tenant, a workspace or a scope
 * beyond what the route already authenticated and resolved -- and nothing it
 * says confirms a pending action. A follow-up message on a task waiting for
 * the owner is answered with the same wait, whatever it contains.
 */
import { randomUUID } from 'node:crypto';
import { TaskState, type Artifact, type Message, type Part, type Task } from '@a2a-js/sdk';
import {
  AgentEvent,
  type AgentExecutionEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { AppError } from '@/contracts/errors';
import { askScope, proposeAction, type AskResult } from '@/lib/application/agent';
import { findChannels, FIND_CHANNELS_DEFAULT, FIND_CHANNELS_MAX, recordChannelVisit } from '@/lib/application/channels';
import type { PlaygroundDependencies } from '@/lib/application/playground';
import type { CallerContext } from '@/lib/application/retrieval';
import { searchScope, type ScopeSearchResult, type SearchScope } from '@/lib/application/retrieval/search-scope';
import { versionAnchor } from '@/lib/application/anchors';
import { ActionRefused } from '@/lib/domain/agent-action';
import { hasScope } from '@/lib/domain/api-key';
import { anonymousVisitorOf, callerOf, resolvedTenantOf } from './context';
import {
  cardUrl,
  extendedIsOwn,
  SKILL_ASK,
  SKILL_FIND_CHANNELS,
  SKILL_INGEST,
  SKILL_PUBLISH,
  SKILL_REFRESH,
  SKILL_SEARCH_CONTEXT,
  WRITE_SKILLS,
  type A2ASkill,
  type A2AWriteSkill,
} from './card';
import { PostgresTaskStore } from './task-store';
import { agentStatus, dataPart, textPart } from './task-events';
import type { A2ATenant } from './tenant';

export const QUERY_MAX_CHARS = 2_000;
export const DEFAULT_MAX_TOKENS = 4_000;
const MIN_MAX_TOKENS = 256;
const MAX_MAX_TOKENS = 16_000;
const SUMMARY_EXCERPT_CHARS = 280;

export interface SkillRequest {
  skill: A2ASkill;
  query: string;
  maxTokens: number;
  limit: number;
  /** The data part as sent: a write skill's arguments. */
  args: Record<string, unknown>;
}

/** A request the skill refuses; the task is REJECTED with this message. */
export class SkillRejected extends Error {}

const KNOWN_SKILLS: readonly string[] = [SKILL_FIND_CHANNELS, SKILL_SEARCH_CONTEXT, SKILL_ASK, ...WRITE_SKILLS];

function isWriteSkill(skill: A2ASkill): skill is A2AWriteSkill {
  return (WRITE_SKILLS as readonly string[]).includes(skill);
}

/**
 * What the message asks for. A data part `{skill, query, maxTokens, limit,
 * ...}` wins, then message metadata `skill`; the text parts are the query
 * when the data part names none. Defaults to `search_context`.
 */
export function readSkillRequest(message: Message, tenant: A2ATenant): SkillRequest {
  let data: Record<string, unknown> = {};
  const texts: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.content?.$case === 'text') texts.push(part.content.value);
    else if (part.content?.$case === 'data' && part.content.value && typeof part.content.value === 'object') {
      data = { ...data, ...(part.content.value as Record<string, unknown>) };
    }
  }
  const named = typeof data.skill === 'string' ? data.skill : typeof message.metadata?.skill === 'string' ? message.metadata.skill : null;
  const skill = (named ?? SKILL_SEARCH_CONTEXT) as A2ASkill;
  if (!KNOWN_SKILLS.includes(skill)) {
    throw new SkillRejected(`unknown skill "${String(named)}"`);
  }
  if (skill === SKILL_FIND_CHANNELS && tenant.level !== 'platform') {
    throw new SkillRejected('find_channels is offered on the platform card only');
  }
  const query = (typeof data.query === 'string' ? data.query : texts.join('\n')).trim();
  if (!isWriteSkill(skill)) {
    if (query.length === 0) throw new SkillRejected('the message carries no query');
    if (query.length > QUERY_MAX_CHARS) throw new SkillRejected(`the query is longer than ${QUERY_MAX_CHARS} characters`);
  }
  const maxTokens = clampInt(data.maxTokens, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS);
  const limit = clampInt(data.limit, FIND_CHANNELS_DEFAULT, 1, FIND_CHANNELS_MAX);
  return { skill, query, maxTokens, limit, args: data };
}

/**
 * Whether this caller may use this skill on this tenant: the scopes its key
 * holds (proposal 7.4), authentication for `ask` and the writes, and for the
 * writes the caller's own workspace only. Null when it may.
 */
export function skillRefusal(skill: A2ASkill, tenant: A2ATenant, caller: CallerContext): string | null {
  const scopes = caller.scopes;
  const reads = !scopes || hasScope(scopes, 'knowledge:search') || hasScope(scopes, 'knowledge:read');
  if (isWriteSkill(skill)) {
    if (!caller.workspaceId) return `${skill} needs an API key with the assets:write scope`;
    if (!scopes || !hasScope(scopes, 'assets:write')) return `${skill} needs the assets:write scope, which this API key lacks`;
    if (tenant.level === 'channel') return `${skill} is not offered on a channel card`;
    if (!extendedIsOwn(tenant, caller.workspaceId)) return `${skill} acts on your own workspace only; call it on the platform card`;
    return null;
  }
  if (skill === SKILL_ASK && !caller.workspaceId) return 'ask needs an API key with the knowledge:search or knowledge:read scope';
  if (!reads) return `${skill} needs the knowledge:search or knowledge:read scope, which this API key lacks`;
  return null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export interface SkillOutcome {
  text: string;
  data: Record<string, unknown>;
}

export interface ExecutorDependencies {
  /** The generation chain's seams (`ask`); the configured models by default. */
  generation?: PlaygroundDependencies;
}

/** A status as the store will hold it: the state and the moment it was set. */
export function statusKey(status: Task['status']): string {
  return `${status?.state ?? ''}@${status?.timestamp ?? ''}`;
}

export class Re0AgentExecutor implements AgentExecutor {
  /** Executions still running after the response went out (`returnImmediately`). */
  private readonly running = new Set<Promise<void>>();
  /**
   * Per task this instance ran, the last status published on its bus -- by
   * the execution, or by the SDK for one that threw. The run is over when
   * the store has saved it (server.ts `drained`).
   */
  readonly lastStatus = new Map<string, string>();

  constructor(
    private readonly origin: string,
    private readonly dependencies: ExecutorDependencies = {},
  ) {}

  /** Resolves when every execution this instance started has finished. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const watch = (event: AgentExecutionEvent) => {
      const status = event.kind === 'task' || event.kind === 'statusUpdate' ? event.data.status : undefined;
      if (status) this.lastStatus.set(requestContext.taskId, statusKey(status));
    };
    eventBus.on('event', watch);
    eventBus.once('finished', () => eventBus.off('event', watch));
    const run = this.executeInner(requestContext, eventBus);
    this.running.add(run);
    void run.finally(() => this.running.delete(run)).catch(() => {});
    return run;
  }

  private async executeInner(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    const tenant = resolvedTenantOf(requestContext.context);
    const userMessage = requestContext.userMessage;
    const now = () => new Date().toISOString();

    /*
     * A follow-up on a task that is waiting for its owner. Whatever it says
     * -- "confirmed", a data part naming the action, anything -- it is not a
     * confirmation (proposal 5.2, 7.6): the task stays where it was, and the
     * caller is told again who it is waiting for.
     */
    if (requestContext.task) {
      /* Read again: the owner may have decided since the SDK loaded it, and a stale snapshot must not undo that. */
      const existing = (await new PostgresTaskStore().load(taskId, requestContext.context)) ?? requestContext.task;
      const waiting = existing.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED;
      const text = waiting
        ? 'This task is waiting for the asset owner to confirm in the re0 Dashboard. Only the owner can confirm it; nothing sent to this task does.'
        : 'This task does not take follow-up messages; send a new message to start another task.';
      eventBus.publish(
        AgentEvent.task({
          ...existing,
          history: [...existing.history, userMessage],
          status: status(existing.status?.state ?? TaskState.TASK_STATE_REJECTED, text, taskId, contextId, existing.status?.message?.parts.slice(1)),
        }),
      );
      eventBus.finished();
      return;
    }

    const base: Task = {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now() },
      artifacts: [],
      history: [userMessage],
      metadata: {},
    };
    let request: SkillRequest | null = null;
    try {
      if (!tenant) throw new SkillRejected('unknown tenant');
      request = readSkillRequest(userMessage, tenant);
      const refused = skillRefusal(request.skill, tenant, callerOf(requestContext.context));
      if (refused) throw new SkillRejected(refused);
    } catch (error) {
      if (!(error instanceof SkillRejected)) throw error;
      eventBus.publish(AgentEvent.task({ ...base, status: status(TaskState.TASK_STATE_REJECTED, error.message, taskId, contextId) }));
      eventBus.finished();
      return;
    }

    const working: Task = {
      ...base,
      status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now() },
      metadata: { skill: request.skill },
    };
    eventBus.publish(AgentEvent.task(working));

    try {
      if (isWriteSkill(request.skill)) {
        await this.propose(request, requestContext, working, eventBus);
      } else {
        const outcome = await this.run(request, tenant!, requestContext);
        const artifact: Artifact = {
          artifactId: randomUUID(),
          name: request.skill === SKILL_FIND_CHANNELS ? 'channels' : request.skill === SKILL_ASK ? 'answer' : 'context',
          description:
            request.skill === SKILL_FIND_CHANNELS
              ? 'Matching public channels'
              : request.skill === SKILL_ASK
                ? 'An answer whose every sentence cites a retrieved passage'
                : 'Retrieved passages with citations and anchors',
          parts: [textPart(outcome.text), dataPart(outcome.data)],
          metadata: undefined,
          extensions: [],
        };
        eventBus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact, append: false, lastChunk: true, metadata: undefined }));
        eventBus.publish(
          AgentEvent.statusUpdate({ taskId, contextId, status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: now() }, metadata: undefined }),
        );
      }
    } catch (error) {
      if (error instanceof ActionRefused) {
        eventBus.publish(
          AgentEvent.statusUpdate({ taskId, contextId, status: status(TaskState.TASK_STATE_REJECTED, error.message, taskId, contextId), metadata: undefined }),
        );
      } else {
        /* Our refusals (quota, access rules) say why; anything else stays generic (architecture.md 17). */
        const message = error instanceof AppError ? `${error.code}: ${error.message}` : 'the request could not be completed';
        if (!(error instanceof AppError)) console.error('a2a skill failed', error);
        eventBus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(TaskState.TASK_STATE_FAILED, message, taskId, contextId), metadata: undefined }));
      }
    }
    eventBus.finished();
  }

  /**
   * Cancellation is the request handler's (server.ts): a build still queued
   * is cancelled there, and a task waiting for confirmation withdraws its
   * pending action. Nothing runs here long enough to interrupt.
   */
  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    void taskId;
    eventBus.finished();
  }

  /** A write skill: a pending action, and the task waits for the owner (proposal 7.6). */
  private async propose(
    request: SkillRequest,
    requestContext: RequestContext,
    working: Task,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId } = requestContext;
    const caller = callerOf(requestContext.context);
    /* The action row names this task, so the task is stored first, whatever the bus has written yet. */
    await new PostgresTaskStore().save(working, requestContext.context);
    const args = request.args;
    /* Taking an asset out of its channel is asked for by naming no channel, never by forgetting to name one. */
    if (request.skill === SKILL_PUBLISH && !('channel' in args) && !('channelId' in args)) {
      throw new ActionRefused('invalid_params', 'publish needs "channel": a channel slug, or null to take the asset out of its channel');
    }
    const tool =
      request.skill === SKILL_INGEST ? 'create_asset' : request.skill === SKILL_REFRESH ? 'refresh_asset' : 'move_asset';
    const action = await proposeAction({
      workspaceId: caller.workspaceId!,
      role: null,
      origin: 'a2a',
      apiKeyId: caller.apiKeyId,
      a2aTaskId: taskId,
      tool,
      args:
        request.skill === SKILL_PUBLISH
          ? { assetId: args.assetId ?? args.asset, channel: 'channel' in args ? args.channel : args.channelId }
          : args,
    });
    const confirmUrl = `${this.origin}/dashboard/actions/${action.id}`;
    const text =
      `${action.description} Waiting for the asset owner to confirm in the re0 Dashboard: ${confirmUrl} . ` +
      `Only the owner can confirm; nothing sent to this task does. It expires at ${action.expiresAt} if not confirmed.`;
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_INPUT_REQUIRED, text, taskId, contextId, [
          dataPart({
            pendingAction: {
              id: action.id,
              url: confirmUrl,
              skill: request.skill,
              estimatedCalls: action.estimatedCalls,
              estimatedBytes: action.estimatedBytes,
              makesPublic: action.makesPublic,
              expiresAt: action.expiresAt,
              waitingFor: 'asset_owner',
            },
          }),
        ]),
        metadata: { actionId: action.id, confirmUrl },
      }),
    );
  }

  private async run(request: SkillRequest, tenant: A2ATenant, requestContext: RequestContext): Promise<SkillOutcome> {
    const context = requestContext.context;
    const caller = callerOf(context);
    if (request.skill === SKILL_FIND_CHANNELS) {
      const channels = await findChannels(caller, { query: request.query, limit: request.limit });
      return findChannelsOutcome(this.origin, request, channels);
    }

    /* Scope: the platform routes to a channel first (proposal 3.7). */
    let scope: SearchScope;
    let channel: { id: string; slug: string; title: string; workspaceId: string | null } | null = null;
    if (tenant.level === 'channel') {
      channel = { id: tenant.channelId, slug: tenant.slug, title: tenant.title, workspaceId: tenant.workspaceId };
      scope = { kind: 'channel', channelId: tenant.channelId };
    } else if (tenant.level === 'user') {
      scope = { kind: 'workspace', workspaceId: tenant.workspaceId };
    } else {
      const [best] = await findChannels(caller, { query: request.query, limit: 1 });
      if (!best) {
        return request.skill === SKILL_ASK
          ? askOutcome(this.origin, request, tenant, null, { outcome: 'no_context', claims: [], chunks: [], callsUsed: 0, requestId: caller.requestId })
          : searchOutcome(this.origin, request, tenant, null, emptyResult(caller.requestId));
      }
      channel = { id: best.id, slug: best.slug, title: best.title, workspaceId: best.workspaceId };
      scope = { kind: 'channel', channelId: best.id };
    }

    const asking = request.skill === SKILL_ASK;
    const result = asking
      ? await askScope({ ...caller, entrypoint: 'a2a' }, { scope, question: request.query }, this.dependencies.generation)
      : await searchScope({ ...caller, entrypoint: 'a2a' }, { scope, query: request.query, maxTokens: request.maxTokens });

    /* A retrieval from a channel is a visit to it (proposal 6.4); the owner's own never counts. */
    if (channel) {
      const anonymous = anonymousVisitorOf(context);
      const visitor = caller.workspaceId
        ? ({ kind: 'workspace', workspaceId: caller.workspaceId } as const)
        : anonymous
          ? ({ kind: 'anonymous', key: anonymous } as const)
          : null;
      if (visitor) await recordChannelVisit({ id: channel.id, workspaceId: channel.workspaceId }, visitor);
    }
    return asking
      ? askOutcome(this.origin, request, tenant, channel, result as AskResult)
      : searchOutcome(this.origin, request, tenant, channel, result as ScopeSearchResult);
  }
}

function emptyResult(requestId: string): ScopeSearchResult {
  return { chunks: [], searchedAssets: 0, callsUsed: 0, requestId };
}

const status = (state: TaskState, text: string, taskId: string, contextId: string, extra: Part[] = []) =>
  agentStatus(state, text, taskId, contextId, extra);

/* ------------------------------------------------------------ the outcomes */

function findChannelsOutcome(
  origin: string,
  request: SkillRequest,
  channels: Awaited<ReturnType<typeof findChannels>>,
): SkillOutcome {
  const entries = channels.map((channel) => ({
    slug: channel.slug,
    channelId: `/channels/${channel.slug}`,
    title: channel.title,
    description: channel.description,
    owner: channel.isPlatform ? 're0' : channel.ownerHandle,
    channelUrl: `${origin}/channels/${channel.slug}`,
    agentCardUrl: cardUrl(origin, { key: `channels/${channel.slug}` }),
    matchedAssets: channel.matchedAssets,
    matchedTerms: channel.matchedTerms,
  }));
  const text =
    entries.length === 0
      ? `No public channel matched "${request.query}".`
      : [
          `Public channels for "${request.query}":`,
          ...entries.map(
            (entry, at) =>
              `${at + 1}. ${entry.title} -- ${entry.channelUrl} (Agent Card: ${entry.agentCardUrl})` +
              (entry.description ? `\n   ${entry.description}` : ''),
          ),
        ].join('\n');
  return { text, data: { skill: SKILL_FIND_CHANNELS, query: request.query, channels: entries } };
}

/** Per passage: where it came from, which version, and that version's anchor (proposal 7.5). */
async function evidenceOf(origin: string, chunks: ScopeSearchResult['chunks']) {
  /* One anchor lookup per version, not per passage. */
  const versions = [...new Map(chunks.map((chunk) => [chunk.asset.versionId, chunk.asset])).values()];
  const anchors = new Map(
    await Promise.all(
      versions.map(async (asset) => {
        const anchor = await versionAnchor({ versionId: asset.versionId, pinnedId: `${asset.publicId}/${asset.version}` });
        return [
          asset.versionId,
          {
            status: anchor.status,
            network: anchor.network,
            txHash: anchor.txHash,
            batchId: anchor.batchId,
            merkleRoot: anchor.merkleRoot,
            leafHash: anchor.leafHash,
            verifyUrl: `${origin}/api/v1/anchors?version=${encodeURIComponent(`${asset.publicId}/${asset.version}`)}`,
          },
        ] as const;
      }),
    ),
  );
  return chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    assetId: chunk.asset.publicId,
    assetTitle: chunk.asset.title,
    sourceUrl: chunk.citation.sourceUrl,
    documentTitle: chunk.citation.documentTitle,
    section: chunk.citation.section,
    version: chunk.asset.version,
    pinnedId: `${chunk.asset.publicId}/${chunk.asset.version}`,
    text: chunk.text,
    score: chunk.score,
    tokens: chunk.tokens,
    anchor: anchors.get(chunk.asset.versionId) ?? null,
  }));
}

function whereOf(tenant: A2ATenant, channel: { title: string } | null): string {
  return channel ? `the channel "${channel.title}"` : tenant.level === 'user' ? `${tenant.handle}'s assets` : 're0';
}

function scopeData(origin: string, tenant: A2ATenant, channel: { slug: string; title: string } | null) {
  return {
    tenant: tenant.key,
    ...(channel ? { channel: { channelId: `/channels/${channel.slug}`, title: channel.title, url: `${origin}/channels/${channel.slug}` } } : {}),
  };
}

async function searchOutcome(
  origin: string,
  request: SkillRequest,
  tenant: A2ATenant,
  channel: { slug: string; title: string } | null,
  result: ScopeSearchResult,
): Promise<SkillOutcome> {
  const results = await evidenceOf(origin, result.chunks);
  const where = whereOf(tenant, channel);
  const text =
    results.length === 0
      ? `Nothing in ${where} matched "${request.query}".`
      : [
          `${results.length} passage${results.length === 1 ? '' : 's'} from ${where} for "${request.query}":`,
          ...results.map(
            (entry, at) =>
              `${at + 1}. ${entry.documentTitle}${entry.section ? ` -- ${entry.section}` : ''} (${entry.sourceUrl}; asset ${entry.assetId}, version ${entry.version})\n   ${excerpt(entry.text)}`,
          ),
        ].join('\n');

  return {
    text,
    data: {
      skill: SKILL_SEARCH_CONTEXT,
      query: request.query,
      scope: scopeData(origin, tenant, channel),
      results,
      usage: { callsUsed: result.callsUsed },
      requestId: result.requestId,
    },
  };
}

/**
 * The answer as text with numbered markers, and as data: each sentence with
 * the chunk ids it cites, and per citation the evidence (proposal 7.5). A
 * degraded answer is the passages and no prose (requirement.md 5.1 rule 5).
 */
async function askOutcome(
  origin: string,
  request: SkillRequest,
  tenant: A2ATenant,
  channel: { slug: string; title: string } | null,
  result: AskResult,
): Promise<SkillOutcome> {
  const where = whereOf(tenant, channel);
  const cited = result.outcome === 'answer' ? new Set(result.claims.flatMap((claim) => claim.chunkIds)) : null;
  const evidence = await evidenceOf(origin, cited ? result.chunks.filter((chunk) => cited.has(chunk.chunkId)) : result.chunks);
  const numbers = new Map(evidence.map((entry, at) => [entry.chunkId, at + 1]));
  let text: string;
  if (result.outcome === 'no_context') {
    text = `Nothing in ${where} matched "${request.query}", so there is no answer (nothing was charged).`;
  } else if (result.outcome === 'degraded') {
    text = [
      `No answer could be generated; the passages from ${where} for "${request.query}" follow:`,
      ...evidence.map(
        (entry, at) =>
          `${at + 1}. ${entry.documentTitle}${entry.section ? ` -- ${entry.section}` : ''} (${entry.sourceUrl}; asset ${entry.assetId}, version ${entry.version})\n   ${excerpt(entry.text)}`,
      ),
    ].join('\n');
  } else {
    const body = result.claims
      .map((claim) => `${claim.claim} ${claim.chunkIds.map((id) => `[${numbers.get(id) ?? '?'}]`).join('')}`)
      .join(' ');
    const sources = evidence.map(
      (entry) => `[${numbers.get(entry.chunkId)}] ${entry.documentTitle}${entry.section ? ` -- ${entry.section}` : ''} (${entry.sourceUrl}; asset ${entry.assetId}, version ${entry.version})`,
    );
    text = [body, '', 'Sources:', ...sources].join('\n');
  }
  return {
    text,
    data: {
      skill: SKILL_ASK,
      query: request.query,
      outcome: result.outcome,
      scope: scopeData(origin, tenant, channel),
      answer: result.claims.map((claim) => ({ text: claim.claim, citations: claim.chunkIds })),
      citations: evidence.map((entry) => ({
        chunk_id: entry.chunkId,
        asset_id: entry.assetId,
        asset_title: entry.assetTitle,
        source_url: entry.sourceUrl,
        document_title: entry.documentTitle,
        section: entry.section,
        version: entry.version,
        pinned_id: entry.pinnedId,
        anchor: entry.anchor,
        ...(result.outcome === 'degraded' ? { text: entry.text } : {}),
      })),
      usage: { callsUsed: result.callsUsed },
      requestId: result.requestId,
    },
  };
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_EXCERPT_CHARS ? `${flat.slice(0, SUMMARY_EXCERPT_CHARS)}...` : flat;
}
