/**
 * The A2A server, framework-free (agent-first-proposal.md 7.3, 7.8).
 *
 * Bindings: JSON-RPC and HTTP+JSON at protocol 1.0, and the SDK's v0.3
 * compatibility mode on JSON-RPC, so clients that have not moved to 1.0
 * still connect. (v0.3 over HTTP+JSON needs the v0.3 proto codecs, which
 * the SDK keeps inside its Express router.) JSON-RPC goes through the SDK's `JsonRpcTransportHandler` (or its
 * legacy twin, chosen by the method name the client used); HTTP+JSON maps the
 * path onto the same request handler with the SDK's own codecs and error
 * bodies, which is what its Express router does -- only without Express.
 * Streams come back as async generators for the Route Handler to write as
 * `text/event-stream` on the Node.js runtime.
 *
 * `SubscribeToTask` does not use the SDK's in-memory event bus, which only
 * exists in the instance that ran the task: it reads the task from Postgres
 * at short intervals for as long as the function may run, pushes what
 * changed, and ends the stream at a terminal state or at the deadline, after
 * which the client reconnects.
 *
 * P2 (proposal 7.6, 7.8): `returnImmediately` is honoured -- the response
 * goes out after the first event and the executor runs on, kept alive by the
 * route (`keepAlive`, Next's `after`). Push-notification configs live in
 * Postgres (push.ts). A task that follows something outside the request --
 * a pending action, a build -- catches up whenever it is read. `CancelTask`
 * on a build task cancels the build only while it is queued; on a task
 * waiting for confirmation it withdraws the pending action. The extended
 * card is built per caller, with its quota.
 */
import { AgentCard, Message, StreamResponse, Task, TaskState, type ListTasksRequest as ListTasksRequestType } from '@a2a-js/sdk';
import {
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  SendMessageRequest,
  TaskPushNotificationConfig,
} from '@a2a-js/sdk';
import { and, eq, inArray } from 'drizzle-orm';
import { expireActions, withdrawAction } from '@/lib/application/agent';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  validateVersion,
  type A2ARequestHandler,
  type ServerCallContext,
} from '@a2a-js/sdk/server';
import { isLegacyJsonRpcMethod } from '@a2a-js/sdk/compat/v0_3';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';
import {
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  restStatusFor,
  toRestErrorBody,
} from '@a2a-js/sdk/errors';
import { buildAgentCard } from './card';
import { buildCallContext, callerOf, type A2ACallFacts } from './context';
import { Re0AgentExecutor, type ExecutorDependencies } from './executor';
import { callerQuota } from './extended';
import { PostgresPushNotificationStore, Re0PushNotificationSender } from './push';
import { syncBuildTasks } from './task-events';
import { PostgresTaskStore } from './task-store';

export type A2AResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'empty'; status: number }
  | { kind: 'sse'; events: AsyncGenerator<unknown, void, undefined>; errorEvent: (error: unknown) => unknown };

export interface A2ARequest {
  method: string;
  /** Path segments after `/a2a/{tenant}`. */
  rest: string[];
  search: URLSearchParams;
  /** The parsed JSON body, or undefined for none. */
  body: unknown;
  /** The `A2A-Version` header as sent; absent means 0.3 to the SDK. */
  version: string | null;
  card: AgentCard;
  origin: string;
  facts: Omit<A2ACallFacts, 'requestedVersion' | 'pathTenant'>;
  /** Whether the tenant came from the path (true) or will be named by the body. */
  pathTenant: boolean;
  /** How long a `SubscribeToTask` stream may stay open. */
  streamWindowMs?: number;
  /** For a user card: whether the user has a public channel (the public card's skills). */
  hasPublicChannel?: boolean;
  /**
   * Keeps the function alive for work that outlives the response: an
   * execution under `returnImmediately`. The route passes Next's `after`;
   * without one (a test, a script) the process simply runs it on.
   */
  keepAlive?: (work: Promise<unknown>) => void;
  /** Seams for the executor; the configured models by default. */
  dependencies?: ExecutorDependencies;
}

export const TERMINAL: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_STREAM_WINDOW_MS = 50_000;

/**
 * The SDK's request handler with the parts a serverless deployment needs
 * replaced: `resubscribe` reads the shared store instead of a process-local
 * bus, reads catch a task up with what happened outside the request, and
 * cancellation knows about builds and pending actions. Everything else is
 * delegated untouched.
 */
class StoreBackedRequestHandler implements A2ARequestHandler {
  constructor(
    private readonly inner: DefaultRequestHandler,
    private readonly store: PostgresTaskStore,
    private readonly executor: Re0AgentExecutor,
    private readonly windowMs: number,
    private readonly keepAlive?: (work: Promise<unknown>) => void,
  ) {}

  getAgentCard = () => this.inner.getAgentCard();
  getAuthenticatedExtendedAgentCard: A2ARequestHandler['getAuthenticatedExtendedAgentCard'] = (p, c) =>
    this.inner.getAuthenticatedExtendedAgentCard(p, c);
  /*
   * `returnImmediately` answers after the first event while the executor
   * runs on; the route's `keepAlive` holds the function open until it has
   * finished, so an instance never freezes with a task left WORKING.
   */
  sendMessage: A2ARequestHandler['sendMessage'] = async (p, c) => {
    const result = await this.inner.sendMessage(p, c);
    if (p.configuration?.returnImmediately) this.keepAlive?.(this.executor.settled());
    return result;
  };
  sendMessageStream: A2ARequestHandler['sendMessageStream'] = (p, c) => this.inner.sendMessageStream(p, c);
  getTask: A2ARequestHandler['getTask'] = async (p, c) => {
    await catchUp([p.id]);
    return this.inner.getTask(p, c);
  };
  listTasks: A2ARequestHandler['listTasks'] = (p, c) => this.inner.listTasks(p, c);
  createTaskPushNotificationConfig: A2ARequestHandler['createTaskPushNotificationConfig'] = (p, c) =>
    this.inner.createTaskPushNotificationConfig(p, c);
  getTaskPushNotificationConfig: A2ARequestHandler['getTaskPushNotificationConfig'] = (p, c) =>
    this.inner.getTaskPushNotificationConfig(p, c);
  listTaskPushNotificationConfigs: A2ARequestHandler['listTaskPushNotificationConfigs'] = (p, c) =>
    this.inner.listTaskPushNotificationConfigs(p, c);
  deleteTaskPushNotificationConfig: A2ARequestHandler['deleteTaskPushNotificationConfig'] = (p, c) =>
    this.inner.deleteTaskPushNotificationConfig(p, c);

  /**
   * Proposal 7.6: on a build task, cancelling means cancelling the queue. A
   * build already running finishes (architecture.md 8.3 publishes whole
   * versions or nothing), so its task is not cancelable. A task waiting for
   * the owner withdraws its pending action -- which can only close it.
   */
  cancelTask: A2ARequestHandler['cancelTask'] = async (p, c) => {
    const task = await this.store.load(p.id, c);
    if (!task) throw new TaskNotFoundError(`task ${p.id} not found`);
    if (!TERMINAL.has(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) {
      const [row] = await db()
        .select({ workflowRunId: schema.a2aTask.workflowRunId })
        .from(schema.a2aTask)
        .where(eq(schema.a2aTask.id, task.id))
        .limit(1);
      if (row?.workflowRunId) {
        const cancelled = await db()
          .update(schema.workflowOperation)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(and(eq(schema.workflowOperation.id, row.workflowRunId), eq(schema.workflowOperation.status, 'pending')))
          .returning({ id: schema.workflowOperation.id });
        if (cancelled.length === 0) throw new TaskNotCancelableError(`the build of task ${p.id} has already started`);
      }
      const pending = await db()
        .select({ id: schema.agentAction.id })
        .from(schema.agentAction)
        .where(and(eq(schema.agentAction.a2aTaskId, task.id), eq(schema.agentAction.state, 'pending')));
      for (const action of pending) await withdrawAction(action.id);
    }
    return this.inner.cancelTask(p, c);
  };

  async *resubscribe(
    params: { id: string; tenant?: string },
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    if (!params.id?.trim()) throw new RequestMalformedError('task id is required');
    const deadline = Date.now() + this.windowMs;
    await catchUp([params.id]);
    let task = await this.store.load(params.id, context);
    if (!task) throw new TaskNotFoundError(`task ${params.id} not found`);
    yield { payload: { $case: 'task', value: task } };
    let seenState = task.status?.state;
    let seenTimestamp = task.status?.timestamp;
    const seenArtifacts = new Set(task.artifacts.map((artifact) => artifact.artifactId));
    while (!TERMINAL.has(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      await catchUp([params.id]);
      const next = await this.store.load(params.id, context);
      if (!next) return;
      task = next;
      for (const artifact of task.artifacts) {
        if (seenArtifacts.has(artifact.artifactId)) continue;
        seenArtifacts.add(artifact.artifactId);
        yield {
          payload: {
            $case: 'artifactUpdate',
            value: { taskId: task.id, contextId: task.contextId, artifact, append: false, lastChunk: true, metadata: undefined },
          },
        };
      }
      if (task.status?.state !== seenState || task.status?.timestamp !== seenTimestamp) {
        seenState = task.status?.state;
        seenTimestamp = task.status?.timestamp;
        yield {
          payload: {
            $case: 'statusUpdate',
            value: { taskId: task.id, contextId: task.contextId, status: task.status, metadata: undefined },
          },
        };
      }
    }
  }
}

/**
 * What happened to these tasks outside any request: a pending action that
 * expired, a build that finished. Cheap when nothing did.
 */
async function catchUp(taskIds: string[]): Promise<void> {
  const ids = taskIds.filter((id) => id && id.length <= 200);
  if (ids.length === 0) return;
  const overdue = await db()
    .select({ id: schema.agentAction.id })
    .from(schema.agentAction)
    .where(and(inArray(schema.agentAction.a2aTaskId, ids), eq(schema.agentAction.state, 'pending')));
  if (overdue.length > 0) await expireActions(new Date(), overdue.map((row) => row.id));
  await syncBuildTasks(ids);
}

function requestHandlerFor(input: A2ARequest): StoreBackedRequestHandler {
  const store = new PostgresTaskStore();
  const executor = new Re0AgentExecutor(input.origin, input.dependencies);
  /* Built per caller: the extended card speaks for whoever is authenticated (proposal 7.2). */
  const extendedCard = async (context: ServerCallContext) => {
    const caller = callerOf(context);
    if (!caller.workspaceId) return input.card;
    return buildAgentCard({
      origin: input.origin,
      tenant: input.facts.tenant,
      hasPublicChannel: input.hasPublicChannel,
      extended: { workspaceId: caller.workspaceId, quota: await callerQuota(caller.workspaceId) },
    });
  };
  const inner = new DefaultRequestHandler(
    input.card,
    store,
    executor,
    undefined,
    new PostgresPushNotificationStore(),
    new Re0PushNotificationSender(),
    extendedCard,
    undefined,
    /* No bus outlives the request on a serverless instance; a waiting task is resumed from the store. */
    { keepBusAliveStates: [] },
  );
  return new StoreBackedRequestHandler(inner, store, executor, input.streamWindowMs ?? DEFAULT_STREAM_WINDOW_MS, input.keepAlive);
}

/* ---------------------------------------------------------------- dispatch */

export async function handleA2A(input: A2ARequest): Promise<A2AResponse> {
  if (input.method === 'POST' && input.rest.length === 0) return handleJsonRpc(input);
  return handleRest(input);
}

async function handleJsonRpc(input: A2ARequest): Promise<A2AResponse> {
  const body = input.body as { method?: unknown; id?: unknown } | undefined;
  const legacy = isLegacyJsonRpcMethod(body?.method);
  const context = buildCallContext({ ...input.facts, requestedVersion: input.version ?? undefined, pathTenant: input.pathTenant });
  const handler = requestHandlerFor(input);
  const mapError = legacy
    ? LegacyJsonRpcTransportHandler.mapToLegacyJSONRPCError
    : JsonRpcTransportHandler.mapToJSONRPCError;
  const id = (typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null) as string | number | null;
  try {
    validateVersion(context.requestedVersion, input.card, 'JSONRPC');
    const transport = legacy ? new LegacyJsonRpcTransportHandler(handler) : new JsonRpcTransportHandler(handler);
    const result = await transport.handle((input.body ?? '') as Record<string, unknown>, context);
    if (isAsyncIterable(result)) {
      return {
        kind: 'sse',
        events: result as AsyncGenerator<unknown, void, undefined>,
        errorEvent: (error) => ({ jsonrpc: '2.0', id, error: mapError(error) }),
      };
    }
    return { kind: 'json', status: 200, body: result };
  } catch (error) {
    return { kind: 'json', status: 200, body: { jsonrpc: '2.0', id, error: mapError(error) } };
  }
}

/**
 * HTTP+JSON. v1.0 paths sit directly under the tenant (`/message:send`,
 * `/tasks/{id}`...); v0.3 paths under `/v1/` (`/v1/message:send`, `/v1/card`).
 */
async function handleRest(input: A2ARequest): Promise<A2AResponse> {
  const legacy = input.rest[0] === 'v1';
  const path = legacy ? input.rest.slice(1) : input.rest;
  const context = buildCallContext({ ...input.facts, requestedVersion: input.version ?? (legacy ? '0.3' : '1.0'), pathTenant: true });
  const handler = requestHandlerFor(input);
  const tenant = context.tenant ?? '';
  const restError = (error: unknown): A2AResponse => {
    const status = restStatusFor(error);
    return { kind: 'json', status, body: toRestErrorBody(error, status) };
  };
  const stream = (events: AsyncGenerator<unknown, void, undefined>): A2AResponse => ({
    kind: 'sse',
    events,
    errorEvent: (error) => toRestErrorBody(error, restStatusFor(error)),
  });

  try {
    validateVersion(context.requestedVersion, input.card, 'HTTP+JSON');
    const [head, second] = path;
    const taskOp = second ? /^(.+?)(?::(cancel|subscribe))?$/.exec(second) : null;

    /* v0.3 over HTTP+JSON is not offered (card.ts); its paths answer as missing. */
    if (legacy) return { kind: 'json', status: 404, body: { code: -32601, message: 'v0.3 is offered over JSON-RPC only' } };

    if (input.method === 'GET' && head === 'extendedAgentCard' && path.length === 1) {
      return { kind: 'json', status: 200, body: AgentCard.toJSON(await handler.getAuthenticatedExtendedAgentCard({ tenant }, context)) };
    }
    if (input.method === 'POST' && (head === 'message:send' || head === 'message:stream') && path.length === 1) {
      const params = SendMessageRequest.fromJSON({ ...((input.body as object | undefined) ?? {}), tenant });
      if (!params.message) throw new RequestMalformedError('message is required');
      if (!params.message.messageId) throw new RequestMalformedError('message.messageId is required');
      if (head === 'message:stream') {
        return stream(mapEvents(handler.sendMessageStream(params, context), (event) => StreamResponse.toJSON(event)));
      }
      const result = await handler.sendMessage(params, context);
      return {
        kind: 'json',
        status: 200,
        body: 'messageId' in result ? { message: Message.toJSON(result) } : { task: Task.toJSON(result) },
      };
    }
    if (input.method === 'GET' && head === 'tasks' && path.length === 1) {
      const query = Object.fromEntries(input.search.entries());
      const params: ListTasksRequestType = ListTasksRequest.fromJSON({ ...query, tenant });
      return { kind: 'json', status: 200, body: ListTasksResponse.toJSON(await handler.listTasks(params, context)) };
    }
    if (head === 'tasks' && taskOp && path.length === 2) {
      const [, taskId, op] = taskOp;
      if (op === 'cancel' && input.method === 'POST') {
        const params = CancelTaskRequest.fromJSON({ id: taskId, tenant });
        return { kind: 'json', status: 200, body: Task.toJSON(await handler.cancelTask(params, context)) };
      }
      if (op === 'subscribe' && (input.method === 'GET' || input.method === 'POST')) {
        return stream(mapEvents(handler.resubscribe({ id: taskId!, tenant }, context), (event) => StreamResponse.toJSON(event)));
      }
      if (!op && input.method === 'GET') {
        const historyLength = input.search.get('historyLength');
        const params = GetTaskRequest.fromJSON({ id: taskId, tenant, ...(historyLength !== null ? { historyLength: Number(historyLength) } : {}) });
        return { kind: 'json', status: 200, body: Task.toJSON(await handler.getTask(params, context)) };
      }
    }
    if (head === 'tasks' && path[2] === 'pushNotificationConfigs' && second && path.length <= 4) {
      const taskId = second;
      const configId = path[3];
      if (input.method === 'POST' && !configId) {
        const params = TaskPushNotificationConfig.fromJSON({ ...((input.body as object | undefined) ?? {}), taskId, tenant });
        return { kind: 'json', status: 200, body: TaskPushNotificationConfig.toJSON(await handler.createTaskPushNotificationConfig(params, context)) };
      }
      if (input.method === 'GET' && !configId) {
        const params = ListTaskPushNotificationConfigsRequest.fromJSON({ ...Object.fromEntries(input.search.entries()), taskId, tenant });
        return {
          kind: 'json',
          status: 200,
          body: ListTaskPushNotificationConfigsResponse.toJSON(await handler.listTaskPushNotificationConfigs(params, context)),
        };
      }
      if (input.method === 'GET' && configId) {
        const params = GetTaskPushNotificationConfigRequest.fromJSON({ taskId, id: configId, tenant });
        return { kind: 'json', status: 200, body: TaskPushNotificationConfig.toJSON(await handler.getTaskPushNotificationConfig(params, context)) };
      }
      if (input.method === 'DELETE' && configId) {
        const params = DeleteTaskPushNotificationConfigRequest.fromJSON({ taskId, id: configId, tenant });
        await handler.deleteTaskPushNotificationConfig(params, context);
        return { kind: 'empty', status: 204 };
      }
    }
    return { kind: 'json', status: 404, body: toRestErrorBody(new RequestMalformedError('no such A2A operation'), 404) };
  } catch (error) {
    return restError(error);
  }
}

async function* mapEvents<T>(
  events: AsyncGenerator<T, void, undefined>,
  map: (event: T) => unknown,
): AsyncGenerator<unknown, void, undefined> {
  for await (const event of events) yield map(event);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
