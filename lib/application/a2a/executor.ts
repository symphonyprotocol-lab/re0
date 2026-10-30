/**
 * The A2A executor: an adapter, nothing more (agent-first-proposal.md 7.8).
 * It reads which skill the message asks for, calls the application function
 * that already enforces visibility, policy and metering, and writes the
 * result as a task with one artifact of two parts (proposal 7.5):
 *
 * - `text`: a readable summary of what was found;
 * - `data`: the structured evidence -- per passage the chunk id, asset id,
 *   source URL, section, version, and that version's on-chain anchor.
 *
 * P1 has two skills, neither of which calls a model (proposal 7.7):
 * `find_channels` (platform card only) and `search_context` (every card).
 * Tasks go `WORKING -> COMPLETED`, or `REJECTED` for a request the skill
 * cannot take, or `FAILED` for one it could not finish (proposal 7.6).
 *
 * A message from another agent is untrusted input (proposal 10): its text is
 * a query and nothing else. It cannot pick a tenant, a workspace or a scope
 * beyond what the route already authenticated and resolved.
 */
import { randomUUID } from 'node:crypto';
import { Role, TaskState, type Artifact, type Message, type Part, type Task } from '@a2a-js/sdk';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import { AppError } from '@/contracts/errors';
import { findChannels, FIND_CHANNELS_DEFAULT, FIND_CHANNELS_MAX, recordChannelVisit } from '@/lib/application/channels';
import { searchScope, type ScopeSearchResult, type SearchScope } from '@/lib/application/retrieval/search-scope';
import { versionAnchor } from '@/lib/application/anchors';
import { anonymousVisitorOf, callerOf, resolvedTenantOf } from './context';
import { cardUrl, SKILL_FIND_CHANNELS, SKILL_SEARCH_CONTEXT, type A2ASkill } from './card';
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
}

/** A request the skill refuses; the task is REJECTED with this message. */
export class SkillRejected extends Error {}

/**
 * What the message asks for. A data part `{skill, query, maxTokens, limit}`
 * wins, then message metadata `skill`; the text parts are the query when the
 * data part names none. Defaults to `search_context`.
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
  if (skill !== SKILL_SEARCH_CONTEXT && skill !== SKILL_FIND_CHANNELS) {
    throw new SkillRejected(`unknown skill "${String(named)}"; this card offers ${tenant.level === 'platform' ? 'find_channels and search_context' : 'search_context'}`);
  }
  if (skill === SKILL_FIND_CHANNELS && tenant.level !== 'platform') {
    throw new SkillRejected('find_channels is offered on the platform card only');
  }
  const query = (typeof data.query === 'string' ? data.query : texts.join('\n')).trim();
  if (query.length === 0) throw new SkillRejected('the message carries no query');
  if (query.length > QUERY_MAX_CHARS) throw new SkillRejected(`the query is longer than ${QUERY_MAX_CHARS} characters`);
  const maxTokens = clampInt(data.maxTokens, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS);
  const limit = clampInt(data.limit, FIND_CHANNELS_DEFAULT, 1, FIND_CHANNELS_MAX);
  return { skill, query, maxTokens, limit };
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

export class Re0AgentExecutor implements AgentExecutor {
  constructor(private readonly origin: string) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    const tenant = resolvedTenantOf(requestContext.context);
    const userMessage = requestContext.userMessage;
    const now = () => new Date().toISOString();

    const base: Task = requestContext.task ?? {
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
    } catch (error) {
      if (!(error instanceof SkillRejected)) throw error;
      eventBus.publish(AgentEvent.task({ ...base, status: status(TaskState.TASK_STATE_REJECTED, error.message, taskId, contextId) }));
      eventBus.finished();
      return;
    }

    eventBus.publish(
      AgentEvent.task({
        ...base,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now() },
        metadata: { ...(base.metadata ?? {}), skill: request.skill },
      }),
    );

    try {
      const outcome = await this.run(request, tenant!, requestContext);
      const artifact: Artifact = {
        artifactId: randomUUID(),
        name: request.skill === SKILL_FIND_CHANNELS ? 'channels' : 'context',
        description: request.skill === SKILL_FIND_CHANNELS ? 'Matching public channels' : 'Retrieved passages with citations and anchors',
        parts: [textPart(outcome.text), dataPart(outcome.data)],
        metadata: undefined,
        extensions: [],
      };
      eventBus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact, append: false, lastChunk: true, metadata: undefined }));
      eventBus.publish(
        AgentEvent.statusUpdate({ taskId, contextId, status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: now() }, metadata: undefined }),
      );
    } catch (error) {
      /* Our refusals (quota, access rules) say why; anything else stays generic (architecture.md 17). */
      const message = error instanceof AppError ? `${error.code}: ${error.message}` : 'the request could not be completed';
      if (!(error instanceof AppError)) console.error('a2a skill failed', error);
      eventBus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(TaskState.TASK_STATE_FAILED, message, taskId, contextId), metadata: undefined }));
    }
    eventBus.finished();
  }

  /** Nothing in P1 runs long enough to cancel; a finished task is not cancelable. */
  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    void taskId;
    eventBus.finished();
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
      if (!best) return searchOutcome(this.origin, request, tenant, null, emptyResult(caller.requestId));
      channel = { id: best.id, slug: best.slug, title: best.title, workspaceId: null };
      scope = { kind: 'channel', channelId: best.id };
    }

    const result = await searchScope({ ...caller, entrypoint: 'a2a' }, { scope, query: request.query, maxTokens: request.maxTokens });

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
    return searchOutcome(this.origin, request, tenant, channel, result);
  }
}

function emptyResult(requestId: string): ScopeSearchResult {
  return { chunks: [], searchedAssets: 0, callsUsed: 0, requestId };
}

function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function dataPart(value: Record<string, unknown>): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' };
}

function status(state: TaskState, text: string, taskId: string, contextId: string) {
  return {
    state,
    timestamp: new Date().toISOString(),
    message: {
      messageId: randomUUID(),
      contextId,
      taskId,
      role: Role.ROLE_AGENT,
      parts: [textPart(text)],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    } satisfies Message,
  };
}

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

async function searchOutcome(
  origin: string,
  request: SkillRequest,
  tenant: A2ATenant,
  channel: { slug: string; title: string } | null,
  result: ScopeSearchResult,
): Promise<SkillOutcome> {
  /* One anchor lookup per version, not per passage. */
  const versions = [...new Map(result.chunks.map((chunk) => [chunk.asset.versionId, chunk.asset])).values()];
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

  const results = result.chunks.map((chunk) => ({
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

  const where = channel ? `the channel "${channel.title}"` : tenant.level === 'user' ? `${tenant.handle}'s assets` : 're0';
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
      scope: {
        tenant: tenant.key,
        ...(channel ? { channel: { channelId: `/channels/${channel.slug}`, title: channel.title, url: `${origin}/channels/${channel.slug}` } } : {}),
      },
      results,
      usage: { callsUsed: result.callsUsed },
      requestId: result.requestId,
    },
  };
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_EXCERPT_CHARS ? `${flat.slice(0, SUMMARY_EXCERPT_CHARS)}...` : flat;
}
