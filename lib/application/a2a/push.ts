/**
 * A2A push notifications (agent-first-proposal.md 7.6, 7.8): where a caller
 * wants to hear about a task, kept in Postgres, and the sends.
 *
 * Long tasks are the reason they exist -- an `ingest` waits on its owner's
 * confirmation and then on a build -- and on Vercel the instance that
 * accepted the task is long gone when either finishes, so configs live in
 * `a2a_push_config` and every change of a task's state, wherever it happens
 * (the executor, the owner's confirmation, the build), sends through
 * `deliverTaskPush`.
 *
 * Only an authenticated caller registers, and only on its own task: the
 * store is scoped like the task store, by tenant and calling workspace. A
 * config sent inline with SendMessage arrives before the task row exists,
 * which is why the table has no foreign key to it. The
 * URL passes the source-fetch SSRF checks when it is registered and again,
 * resolved, before every send; a refused send is dropped and logged by host,
 * never retried against a private address. The token and credentials are
 * sealed at rest. Registering and reading configs is free (proposal 8.2).
 *
 * The receivers are the caller's, so how long they take is too. A send is
 * bounded end to end -- resolving the name, connecting, the answer -- and
 * the answer's body is never read. And nothing that moves a task waits for
 * its sends: `queueTaskPush` starts them and returns, and whoever owns the
 * request holds the function open for them with `settlePushes` (the route's
 * or the Dashboard's `after`, the drain at its end), under one budget. So a
 * slow receiver cannot stretch the owner's click, or hold the drain's walk
 * over every tenant's tasks.
 */
import { and, eq } from 'drizzle-orm';
import { StreamResponse, type Task, type TaskPushNotificationConfig } from '@a2a-js/sdk';
import type { PushNotificationSender, PushNotificationStore, ServerCallContext } from '@a2a-js/sdk/server';
import { RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { uuidv7 } from '@/lib/domain/id';
import { openCredential, sealCredential } from '@/lib/infrastructure/crypto/credentials';
import {
  assertCallbackReachable,
  CallbackRefused,
  type ResolveHost,
} from '@/lib/infrastructure/connectors/callback-url';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { callerOf, tenantOf } from './context';

/** One send, from resolving the callback's name to the receiver's status line. */
const SEND_TIMEOUT_MS = 5_000;
/** How long `settlePushes` waits, at most, for the sends in flight. */
const SETTLE_BUDGET_MS = SEND_TIMEOUT_MS + 2_000;
/** Configs one task may carry; a caller needs one, a few at most. */
const CONFIGS_PER_TASK = 5;

interface Secret {
  token: string;
  authentication: { scheme: string; credentials: string } | null;
}

/** How a send leaves the building; a test swaps it for a recorder. */
export type PushTransport = (url: URL, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<void>;

const fetchTransport: PushTransport = async (url, init) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
    signal: init.signal,
  });
  /* The body is the receiver's business, and may never end: release the socket without reading it. */
  await response.body?.cancel().catch(() => undefined);
};

let transport: PushTransport = fetchTransport;
let resolveHost: ResolveHost | undefined;
let sendTimeoutMs = SEND_TIMEOUT_MS;

/** Test seam: where sends go, how hosts resolve, how long a send may take. Pass nothing to restore the real ones. */
export function setPushTransport(next?: { transport?: PushTransport; resolve?: ResolveHost; timeoutMs?: number }): void {
  transport = next?.transport ?? fetchTransport;
  resolveHost = next?.resolve;
  sendTimeoutMs = next?.timeoutMs ?? SEND_TIMEOUT_MS;
}

/* ------------------------------------------------------------- in flight */

const inFlight = new Set<Promise<unknown>>();

/**
 * Sends one event to the task's receivers without waiting for them. The
 * request that moved the task keeps the function alive for the sends with
 * `settlePushes`; a send never decides whether the move happened.
 */
export function queueTaskPush(taskId: string, event: StreamResponse): void {
  const send = deliverTaskPush(taskId, event).catch((error: unknown) => {
    console.warn(`a2a push for task ${taskId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return 0;
  });
  inFlight.add(send);
  void send.finally(() => inFlight.delete(send));
}

/**
 * Waits for the sends in flight -- each already bounded -- for at most
 * `budgetMs`. What is still out after that is given up, as a frozen
 * instance would.
 */
export async function settlePushes(budgetMs: number = SETTLE_BUDGET_MS): Promise<void> {
  if (inFlight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    }),
  ]);
  clearTimeout(timer);
}

export class PostgresPushNotificationStore implements PushNotificationStore {
  async save(taskId: string, context: ServerCallContext, config: TaskPushNotificationConfig): Promise<void> {
    const caller = callerOf(context);
    if (!caller.workspaceId) {
      throw new UnsupportedOperationError('push notifications need an authenticated caller (a re0 API key)');
    }
    try {
      await assertCallbackReachable(config.url, resolveHost);
    } catch (error) {
      if (error instanceof CallbackRefused) throw new RequestMalformedError(`push notification URL refused: ${error.message}`);
      throw error;
    }
    if (!config.id) config.id = uuidv7();
    const tenant = tenantOf(context);
    const existing = await db()
      .select({ id: schema.a2aPushConfig.id })
      .from(schema.a2aPushConfig)
      .where(eq(schema.a2aPushConfig.taskId, taskId));
    if (existing.length >= CONFIGS_PER_TASK && !existing.some((row) => row.id === config.id)) {
      throw new RequestMalformedError(`a task carries at most ${CONFIGS_PER_TASK} push notification configs`);
    }
    const secret: Secret | null =
      config.token || config.authentication
        ? {
            token: config.token ?? '',
            authentication: config.authentication
              ? { scheme: config.authentication.scheme, credentials: config.authentication.credentials }
              : null,
          }
        : null;
    const sealed = secret ? await sealCredential(JSON.stringify(secret)) : null;
    const wireVersion = context.requestedVersion?.startsWith('0.') ? '0.3' : '1.0';
    await db()
      .insert(schema.a2aPushConfig)
      .values({ id: config.id, taskId, workspaceId: caller.workspaceId, tenant, url: config.url, secret: sealed, wireVersion })
      .onConflictDoUpdate({
        target: [schema.a2aPushConfig.taskId, schema.a2aPushConfig.id],
        set: { url: config.url, secret: sealed, wireVersion },
        setWhere: and(eq(schema.a2aPushConfig.workspaceId, caller.workspaceId), eq(schema.a2aPushConfig.tenant, tenant)),
      });
  }

  async load(taskId: string, context: ServerCallContext): Promise<TaskPushNotificationConfig[]> {
    const caller = callerOf(context);
    if (!caller.workspaceId) return [];
    const rows = await db()
      .select()
      .from(schema.a2aPushConfig)
      .where(
        and(
          eq(schema.a2aPushConfig.taskId, taskId),
          eq(schema.a2aPushConfig.workspaceId, caller.workspaceId),
          eq(schema.a2aPushConfig.tenant, tenantOf(context)),
        ),
      );
    /* What a caller reads back is its URL and id; the secret it sent stays sealed. */
    return rows.map((row) => ({
      tenant: row.tenant,
      id: row.id,
      taskId: row.taskId,
      url: row.url,
      token: '',
      authentication: undefined,
    }));
  }

  async delete(taskId: string, context: ServerCallContext, configId?: string): Promise<void> {
    const caller = callerOf(context);
    if (!caller.workspaceId) return;
    await db()
      .delete(schema.a2aPushConfig)
      .where(
        and(
          eq(schema.a2aPushConfig.taskId, taskId),
          eq(schema.a2aPushConfig.workspaceId, caller.workspaceId),
          eq(schema.a2aPushConfig.tenant, tenantOf(context)),
          ...(configId ? [eq(schema.a2aPushConfig.id, configId)] : []),
        ),
      );
  }
}

/** The SDK's sender seam: every event the executor publishes, sent from the shared configs. */
export class Re0PushNotificationSender implements PushNotificationSender {
  async send(streamResponse: StreamResponse, _context: ServerCallContext, task?: Task): Promise<void> {
    const taskId = task?.id ?? taskIdOf(streamResponse);
    /* The SDK does not await this either; queued, the request's `settlePushes` covers it. */
    if (taskId) queueTaskPush(taskId, streamResponse);
  }
}

function taskIdOf(event: StreamResponse): string | null {
  const payload = event.payload;
  if (!payload) return null;
  if (payload.$case === 'task') return payload.value.id;
  if (payload.$case === 'statusUpdate' || payload.$case === 'artifactUpdate') return payload.value.taskId;
  return null;
}

/**
 * Sends one event to every config of the task, in parallel, each send
 * within its own deadline. Best-effort: a notification is a courtesy on top
 * of `GetTask`, never the reason a state change fails.
 */
export async function deliverTaskPush(taskId: string, event: StreamResponse): Promise<number> {
  const rows = await db().select().from(schema.a2aPushConfig).where(eq(schema.a2aPushConfig.taskId, taskId));
  if (rows.length === 0) return 0;
  const body = JSON.stringify(StreamResponse.toJSON(event));
  /* In parallel: one slow receiver must not hold up the others, or the request. */
  const outcomes = await Promise.all(
    rows.map(async (row) => {
      /* One deadline from the name lookup to the answer: a stranger's name server is as slow as it likes. */
      const signal = AbortSignal.timeout(sendTimeoutMs);
      let url: URL;
      try {
        url = await assertCallbackReachable(row.url, resolveHost, { timeoutMs: sendTimeoutMs, signal });
      } catch (error) {
        console.warn(`a2a push dropped for task ${taskId}: ${error instanceof Error ? error.message : 'refused'}`);
        return false;
      }
      const headers: Record<string, string> = { 'content-type': 'application/a2a+json' };
      const secret = row.secret ? await openSecret(row.secret) : null;
      if (secret?.authentication) headers.authorization = `${secret.authentication.scheme} ${secret.authentication.credentials}`;
      else if (secret?.token) headers['x-a2a-notification-token'] = secret.token;
      try {
        await untilAborted(transport(url, { headers, body, signal }), signal);
        return true;
      } catch (error) {
        console.warn(`a2a push to ${url.host} failed: ${error instanceof Error ? error.message : 'unknown'}`);
        return false;
      }
    }),
  );
  return outcomes.filter(Boolean).length;
}

/** The send, or a rejection once its deadline passed -- whether or not the transport honours the signal. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function openSecret(sealed: string): Promise<Secret | null> {
  try {
    const opened = await openCredential(sealed);
    return opened ? (JSON.parse(opened) as Secret) : null;
  } catch {
    return null;
  }
}
