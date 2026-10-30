/**
 * Delegations (agent-first-proposal.md 7.9, prerequisite 3): re0 as an A2A
 * client, sending one sub-task to an external Agent the workspace
 * registered.
 *
 * Three halves, at three moments:
 *
 * 1. `prepareDelegation` runs when the planner calls `delegate_task`. It
 *    resolves the agent, the skill and the credential to rows and freezes
 *    them -- with the exact text to send -- into the pending action's
 *    params, so the card the owner confirms names every one of them and
 *    the digest binds them. Nothing is sent.
 * 2. `sendDelegation` runs once, after the owner confirmed
 *    (agent/actions.ts). It re-checks that what the card showed still
 *    holds -- the agent active, the endpoint still on its card, the
 *    credential the same row and version -- and sends exactly one
 *    SendMessage with the SDK, through transport.ts. The remote task is
 *    recorded in `agent_delegation`.
 * 3. `pollDelegation` and `cancelDelegation` are the owner's GetTask and
 *    CancelTask, from the delegation card. re0 never polls on its own.
 *
 * What the external Agent sends back is the external Agent's words:
 * stored clipped, rendered as plain data, read by the planner only through
 * `check_delegation` with an `untrusted` mark, never handed to the
 * answering model and never a cited claim (requirement.md 5.1). Errors from
 * the SDK are reduced to our own codes, so neither a credential nor a body
 * reaches a log line through an exception message.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { Role, TaskState, type Message, type Part, type Task } from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';
import { ActionRefused, type ActionParams, type DelegationSummary } from '@/lib/domain/agent-action';
import { A2A_BODY_RETENTION_DAYS } from '@/lib/domain/a2a-retention';
import {
  clip,
  credentialHeader,
  credentialValue,
  ExternalAgentRefused,
  isTerminalRemoteState,
  MESSAGE_MAX_CHARS,
  OUTPUT_MAX_CHARS,
  RESPONSE_MAX_BYTES,
  SEND_TIMEOUT_MS,
  type AgentEndpoint,
  type SchemeSnapshot,
} from '@/lib/domain/external-agent';
import { uuidv7 } from '@/lib/domain/id';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { AppError } from '@/contracts/errors';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { findExternalAgent, openCredentialFor, storedCard } from './registry';
import { guardedFetch } from './transport';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** One part of what the external Agent returned, as stored and shown. */
export type OutputPart =
  | { kind: 'text'; text: string }
  | { kind: 'data'; json: string }
  | { kind: 'file'; name: string; mediaType: string; url: string | null };

export interface DelegationView {
  id: string;
  actionId: string | null;
  agentId: string | null;
  agentName: string;
  skill: string | null;
  endpointUrl: string;
  remoteTaskId: string | null;
  state: string;
  terminal: boolean;
  statusMessage: string | null;
  output: OutputPart[];
  error: string | null;
  /** The bodies were cleared after 30 days (proposal 10). */
  purged: boolean;
  createdAt: string;
  updatedAt: string;
  lastPolledAt: string | null;
}

type DelegationRow = typeof schema.agentDelegation.$inferSelect;

function view(row: DelegationRow, now: Date = new Date()): DelegationView {
  return {
    id: row.id,
    actionId: row.actionId ?? null,
    agentId: row.agentId ?? null,
    agentName: row.agentName,
    skill: row.skill ?? null,
    endpointUrl: row.endpointUrl,
    remoteTaskId: row.remoteTaskId ?? null,
    state: row.state,
    terminal: isTerminalRemoteState(row.state),
    statusMessage: row.statusMessage ?? null,
    output: row.output as unknown as OutputPart[],
    error: row.error ?? null,
    purged: row.bodyPurgeAt <= now,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
  };
}

/* ------------------------------------------------------------------ propose */

type DelegateParams = Extract<ActionParams, { tool: 'delegate_task' }>;

/**
 * The pending action's params and the card's summary for one delegation.
 * Refuses (`ActionRefused`) an unknown or disabled agent, a skill the card
 * does not list, an empty message, and an agent whose card asks for a
 * credential none was saved for.
 */
export async function prepareDelegation(
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<{ params: DelegateParams; delegation: DelegationSummary }> {
  const ref = typeof args.agent === 'string' ? args.agent : typeof args.agentId === 'string' ? args.agentId : '';
  const agent = await findExternalAgent(workspaceId, ref);
  if (!agent) throw new ActionRefused('agent_not_found', `no external agent "${ref.slice(0, 80)}" is registered in this workspace`);
  if (agent.status !== 'active') throw new ActionRefused('agent_disabled', `the external agent "${agent.name}" is disabled`);
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) throw new ActionRefused('invalid_params', 'a delegation needs the message to send');
  if (message.length > MESSAGE_MAX_CHARS) {
    throw new ActionRefused('invalid_params', `the message is longer than ${MESSAGE_MAX_CHARS} characters`);
  }
  const skillRef = typeof args.skill === 'string' ? args.skill.trim().toLowerCase() : '';
  const skill = skillRef
    ? agent.skills.find((candidate) => candidate.id.toLowerCase() === skillRef || candidate.name.toLowerCase() === skillRef)
    : null;
  if (skillRef && !skill) throw new ActionRefused('skill_not_found', `"${agent.name}" lists no skill "${skillRef.slice(0, 80)}"`);
  if (agent.requiresCredential && !agent.credential) {
    throw new ActionRefused(
      'credential_missing',
      `"${agent.name}" asks for a credential; save one for it in the Dashboard (/dashboard/external-agents) first`,
    );
  }
  const endpoint = agent.endpoints[0]!;
  const credential = agent.credential
    ? { id: agent.credential.id, version: agent.credential.version, kind: agent.credential.kind, header: agent.credential.header }
    : null;
  return {
    params: {
      tool: 'delegate_task',
      agentId: agent.id,
      endpoint: { url: endpoint.url, binding: endpoint.binding, protocolVersion: endpoint.protocolVersion, tenant: endpoint.tenant },
      skill: skill?.id ?? null,
      message,
      credential,
    },
    delegation: {
      agentId: agent.id,
      agentName: agent.name,
      cardUrl: agent.cardUrl,
      endpoint: { url: endpoint.url, binding: endpoint.binding },
      skill: skill ? { id: skill.id, name: skill.name } : null,
      message,
      credential: agent.credential ? { kind: agent.credential.kind, suffix: agent.credential.suffix } : null,
    },
  };
}

/* --------------------------------------------------------------------- send */

/**
 * Sends the confirmed delegation: one SendMessage, `returnImmediately`. A
 * delegation whose card, credential or text no longer matches what was
 * confirmed is refused as `stale` before anything leaves. A send that fails
 * on the wire is recorded (`SEND_FAILED`) and rethrown, so the action reads
 * failed with the reason.
 */
export async function sendDelegation(
  workspaceId: string,
  params: DelegateParams,
  context: { actionId: string; conversationId: string | null },
): Promise<{ delegationId: string; state: string; remoteTaskId: string | null }> {
  const stored = await storedCard(workspaceId, params.agentId);
  if (!stored) throw new ActionRefused('agent_not_found', 'the external agent was removed after this was proposed');
  if (stored.row.status !== 'active') throw new ActionRefused('agent_disabled', 'the external agent was disabled after this was proposed');
  if (params.message === null) throw new ActionRefused('stale', 'the message of this delegation was purged');
  const endpoint = listedEndpoint(stored.row.endpoints as unknown as AgentEndpoint[], params.endpoint);
  if (!endpoint) throw new ActionRefused('stale', 'the agent’s card changed since this was proposed; ask again');
  const headers = await credentialHeaders(params.agentId, params.credential, stored.row.securitySchemes as Record<string, SchemeSnapshot>);

  const now = new Date();
  const delegationId = uuidv7();
  const base = {
    id: delegationId,
    workspaceId,
    actionId: context.actionId,
    agentId: stored.row.id,
    agentName: stored.row.name,
    conversationId: context.conversationId,
    skill: params.skill,
    endpointUrl: endpoint.url,
    bodyPurgeAt: new Date(now.getTime() + A2A_BODY_RETENTION_DAYS * DAY_MS),
    createdAt: now,
    updatedAt: now,
  };

  let result: Message | Task;
  try {
    const client = await clientFor(stored.card, endpoint, headers);
    result = await client.sendMessage({
      tenant: endpoint.tenant,
      message: {
        messageId: randomUUID(),
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [{ content: { $case: 'text', value: params.message }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: params.skill ? { skill: params.skill } : undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: ['text/plain', 'application/json'],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    });
  } catch (error) {
    const failure = wireFailure(error);
    const note = mayHaveArrived(failure)
      ? `${failure.message}. Check with the agent before asking again.`
      : failure.message;
    await db()
      .insert(schema.agentDelegation)
      .values({ ...base, state: 'SEND_FAILED', error: note });
    throw mayHaveArrived(failure) ? new ExternalAgentRefused('unreachable', note) : failure;
  }

  const recorded = 'messageId' in result ? fromMessage(result) : fromTask(result);
  await db()
    .insert(schema.agentDelegation)
    .values({ ...base, ...recorded, lastPolledAt: now });
  return { delegationId, state: recorded.state, remoteTaskId: recorded.remoteTaskId };
}

function listedEndpoint(endpoints: readonly AgentEndpoint[], wanted: DelegateParams['endpoint']): AgentEndpoint | null {
  return (
    endpoints.find(
      (endpoint) =>
        endpoint.url === wanted.url &&
        endpoint.binding === wanted.binding &&
        endpoint.protocolVersion === wanted.protocolVersion &&
        endpoint.tenant === wanted.tenant,
    ) ?? null
  );
}

async function credentialHeaders(
  agentId: string,
  credential: DelegateParams['credential'],
  schemes: Record<string, SchemeSnapshot>,
): Promise<Record<string, string>> {
  if (!credential) return {};
  /* The header the card names now must be the one the confirmation card showed. */
  if (credentialHeader(credential.kind, schemes) !== credential.header) {
    throw new ActionRefused('stale', 'the agent’s card changed how it takes credentials; ask again');
  }
  const secret = await openCredentialFor(agentId, credential);
  if (!secret) throw new ActionRefused('stale', 'the credential was rotated or deleted since this was proposed; ask again');
  return { [credential.header]: credentialValue(credential.kind, secret) };
}

/** A client bound to the one endpoint the owner confirmed, on the checked fetch. */
async function clientFor(card: Parameters<ClientFactory['createFromAgentCard']>[0], endpoint: AgentEndpoint, headers: Record<string, string>): Promise<Client> {
  const fetchImpl = guardedFetch({ timeoutMs: SEND_TIMEOUT_MS, maxBytes: RESPONSE_MAX_BYTES, headers }) as typeof fetch;
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
        new RestTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
      ],
      preferredTransports: [endpoint.binding],
      clientConfig: { polling: true },
    }),
  );
  return factory.createFromAgentCard({
    ...card,
    supportedInterfaces: [
      { url: endpoint.url, protocolBinding: endpoint.binding, protocolVersion: endpoint.protocolVersion, tenant: endpoint.tenant },
    ],
  });
}

/** Any failure on the wire, as our own error: no remote text, no header, no URL query. */
function wireFailure(error: unknown): ExternalAgentRefused | ActionRefused {
  if (error instanceof ExternalAgentRefused || error instanceof ActionRefused) return error;
  return new ExternalAgentRefused('unreachable', 'the external agent answered with an error');
}

/**
 * Whether a failed send may still have reached the agent: a timeout or a
 * dropped connection after the request left. The owner is told to check
 * with the agent before asking again, so a booking is not made twice.
 */
function mayHaveArrived(error: ExternalAgentRefused | ActionRefused): boolean {
  return error instanceof ExternalAgentRefused && error.code === 'unreachable' && /may still have received/.test(error.message);
}

/* ------------------------------------------------------------ the response */

type Recorded = Pick<DelegationRow, 'remoteTaskId' | 'remoteContextId' | 'state' | 'statusMessage' | 'output'>;

function fromMessage(message: Message): Recorded {
  return {
    remoteTaskId: message.taskId || null,
    remoteContextId: message.contextId || null,
    state: 'MESSAGE',
    statusMessage: null,
    output: outputOf([message.parts]) as unknown as Record<string, unknown>[],
  };
}

function fromTask(task: Task): Recorded {
  const status = task.status;
  const statusText = status?.message ? textOf(status.message.parts) : null;
  return {
    remoteTaskId: task.id || null,
    remoteContextId: task.contextId || null,
    state: TaskState[status?.state ?? TaskState.TASK_STATE_UNSPECIFIED] ?? 'TASK_STATE_UNSPECIFIED',
    statusMessage: statusText ? clip(statusText, 4_000) : null,
    output: outputOf((task.artifacts ?? []).map((artifact) => artifact.parts)) as unknown as Record<string, unknown>[],
  };
}

function textOf(parts: readonly Part[]): string {
  return parts
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .filter(Boolean)
    .join('\n');
}

/** Every part, as data: text clipped, JSON serialised, files by name and URL only. */
export function outputOf(groups: readonly (readonly Part[])[]): OutputPart[] {
  const out: OutputPart[] = [];
  let left = OUTPUT_MAX_CHARS;
  for (const parts of groups) {
    for (const part of parts) {
      if (left <= 0) return out;
      const content = part.content;
      if (!content) continue;
      if (content.$case === 'text') {
        const text = clip(content.value, left);
        left -= text.length;
        out.push({ kind: 'text', text });
      } else if (content.$case === 'data') {
        let json: string;
        try {
          json = JSON.stringify(content.value ?? null);
        } catch {
          json = 'null';
        }
        json = clip(json, left);
        left -= json.length;
        out.push({ kind: 'data', json });
      } else {
        const name = clip(part.filename || 'file', 200);
        left -= name.length;
        out.push({
          kind: 'file',
          name,
          mediaType: clip(part.mediaType || 'application/octet-stream', 100),
          url: content.$case === 'url' ? clip(content.value, 2_000) : null,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ poll, cancel */

/** The owner's GetTask: asks the external Agent for the task's state now. */
export async function pollDelegation(input: { workspaceId: string; role: WorkspaceRole; delegationId: string }): Promise<DelegationView> {
  return remoteCall(input, (client, tenant, id) => client.getTask({ tenant, id }));
}

/** The owner's CancelTask. The external Agent decides whether it can. */
export async function cancelDelegation(input: { workspaceId: string; role: WorkspaceRole; delegationId: string }): Promise<DelegationView> {
  return remoteCall(input, (client, tenant, id) => client.cancelTask({ tenant, id, metadata: undefined }));
}

async function remoteCall(
  input: { workspaceId: string; role: WorkspaceRole; delegationId: string },
  call: (client: Client, tenant: string, taskId: string) => Promise<Task>,
): Promise<DelegationView> {
  if (!canManageAssets(input.role)) throw new AppError('access_denied', 'only a workspace owner or admin can follow a delegation');
  const row = await ownedDelegation(input.workspaceId, input.delegationId);
  if (!row) throw new ExternalAgentRefused('not_found', 'no such delegation');
  if (isTerminalRemoteState(row.state) || !row.remoteTaskId) return view(row);
  const stored = row.agentId ? await storedCard(input.workspaceId, row.agentId) : null;
  if (!stored) throw new ExternalAgentRefused('not_found', 'the external agent was removed');
  if (stored.row.status !== 'active') throw new ExternalAgentRefused('disabled', 'the external agent is disabled');
  const endpoint = (stored.row.endpoints as unknown as AgentEndpoint[]).find((candidate) => candidate.url === row.endpointUrl);
  if (!endpoint) throw new ExternalAgentRefused('no_usable_interface', 'the agent’s card no longer lists the endpoint this task was sent to');
  const headers = await currentHeaders(stored.row.id, stored.row.securitySchemes as Record<string, SchemeSnapshot>);

  let task: Task;
  try {
    task = await call(await clientFor(stored.card, endpoint, headers), endpoint.tenant, row.remoteTaskId);
  } catch (error) {
    throw wireFailure(error);
  }
  const recorded = fromTask(task);
  const now = new Date();
  const [updated] = await db()
    .update(schema.agentDelegation)
    .set({
      state: recorded.state,
      /* After the purge date the bodies stay cleared, whatever the agent still sends. */
      ...(row.bodyPurgeAt > now ? { statusMessage: recorded.statusMessage, output: recorded.output } : {}),
      lastPolledAt: now,
      updatedAt: now,
    })
    .where(eq(schema.agentDelegation.id, row.id))
    .returning();
  return view(updated!, now);
}

/** GetTask and CancelTask go with the credential as it is now: the owner is the one asking. */
async function currentHeaders(agentId: string, schemes: Record<string, SchemeSnapshot>): Promise<Record<string, string>> {
  const [row] = await db()
    .select({ id: schema.externalAgentCredential.id, version: schema.externalAgentCredential.version, kind: schema.externalAgentCredential.kind })
    .from(schema.externalAgentCredential)
    .where(eq(schema.externalAgentCredential.agentId, agentId))
    .limit(1);
  if (!row) return {};
  const secret = await openCredentialFor(agentId, row);
  if (!secret) return {};
  return { [credentialHeader(row.kind, schemes)]: credentialValue(row.kind, secret) };
}

/* -------------------------------------------------------------------- reads */

/** The workspace's delegations, newest first; `limit: null` reads them all (the export). */
export async function listDelegations(workspaceId: string, limit: number | null = 50): Promise<DelegationView[]> {
  const now = new Date();
  const query = db()
    .select()
    .from(schema.agentDelegation)
    .where(eq(schema.agentDelegation.workspaceId, workspaceId))
    .orderBy(desc(schema.agentDelegation.createdAt));
  const rows = limit === null ? await query : await query.limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((row) => view(row, now));
}

/** The delegations confirmed actions started, by action id, for the workbench's cards. */
export async function delegationsByActionIds(workspaceId: string, actionIds: readonly string[]): Promise<Map<string, DelegationView>> {
  const ids = actionIds.filter((id) => UUID.test(id));
  if (ids.length === 0) return new Map();
  const rows = await db()
    .select()
    .from(schema.agentDelegation)
    .where(and(eq(schema.agentDelegation.workspaceId, workspaceId), inArray(schema.agentDelegation.actionId, ids)));
  return new Map(rows.map((row) => [row.actionId!, view(row)]));
}

/** Several delegations of this workspace by id, in one read; unknown and foreign ids are left out. */
export async function delegationsByIds(workspaceId: string, delegationIds: readonly string[]): Promise<DelegationView[]> {
  const ids = delegationIds.filter((id) => UUID.test(id));
  if (ids.length === 0) return [];
  const rows = await db()
    .select()
    .from(schema.agentDelegation)
    .where(and(eq(schema.agentDelegation.workspaceId, workspaceId), inArray(schema.agentDelegation.id, ids)));
  const byId = new Map(rows.map((row) => [row.id, view(row)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * What `check_delegation` hands the planner: the stored state and output of
 * one delegation (by its id or its action's), or the latest few, each
 * wrapped as the external Agent's untrusted words. No network call.
 */
export async function delegationsForPlanner(workspaceId: string, ref: string | null): Promise<DelegationView[]> {
  const value = (ref ?? '').trim();
  if (value && UUID.test(value)) {
    const [row] = await db()
      .select()
      .from(schema.agentDelegation)
      .where(
        and(
          eq(schema.agentDelegation.workspaceId, workspaceId),
          or(eq(schema.agentDelegation.id, value), eq(schema.agentDelegation.actionId, value)),
        ),
      )
      .limit(1);
    return row ? [view(row)] : [];
  }
  return listDelegations(workspaceId, 3);
}

async function ownedDelegation(workspaceId: string, delegationId: string): Promise<DelegationRow | null> {
  if (!UUID.test(delegationId)) return null;
  const [row] = await db()
    .select()
    .from(schema.agentDelegation)
    .where(and(eq(schema.agentDelegation.id, delegationId), eq(schema.agentDelegation.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/* -------------------------------------------------------------------- purge */

/**
 * Proposal 10: after 30 days a delegation keeps its ids, agent, skill,
 * state and times; the external Agent's words and the text re0 sent go.
 * The sent text lives in the confirmed action's params and summary.
 */
export async function purgeDelegationBodies(now: Date = new Date()): Promise<number> {
  const purged = await db()
    .update(schema.agentDelegation)
    .set({ statusMessage: null, output: [], updatedAt: now })
    .where(
      and(
        lte(schema.agentDelegation.bodyPurgeAt, now),
        sql`(${schema.agentDelegation.statusMessage} is not null or ${schema.agentDelegation.output} <> '[]'::jsonb)`,
      ),
    )
    .returning({ id: schema.agentDelegation.id });
  const cutoff = new Date(now.getTime() - A2A_BODY_RETENTION_DAYS * DAY_MS);
  return purged.length + (await clearDelegationText(lte(schema.agentAction.createdAt, cutoff)));
}

/**
 * Clears the text a delegation action sent -- from its params and its
 * card's summary -- on the delegation actions `where` selects. The digest
 * stays. Shared by the 30-day purge and the owner's deletion.
 */
export async function clearDelegationText(where: SQL | undefined): Promise<number> {
  const cleared = await db()
    .update(schema.agentAction)
    .set({
      params: sql`jsonb_set(${schema.agentAction.params}, '{message}', 'null'::jsonb)`,
      summary: sql`jsonb_set(${schema.agentAction.summary}, '{delegation,message}', 'null'::jsonb)`,
    })
    .where(and(eq(schema.agentAction.tool, 'delegate_task'), sql`${schema.agentAction.params}->>'message' is not null`, where))
    .returning({ id: schema.agentAction.id });
  return cleared.length;
}
