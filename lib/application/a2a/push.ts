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

const SEND_TIMEOUT_MS = 5_000;
/** Configs one task may carry; a caller needs one, a few at most. */
const CONFIGS_PER_TASK = 5;

interface Secret {
  token: string;
  authentication: { scheme: string; credentials: string } | null;
}

/** How a send leaves the building; a test swaps it for a recorder. */
export type PushTransport = (url: URL, init: { headers: Record<string, string>; body: string }) => Promise<void>;

const fetchTransport: PushTransport = async (url, init) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  /* The body is the receiver's business; drain it so the socket is released. */
  await response.arrayBuffer().catch(() => undefined);
};

let transport: PushTransport = fetchTransport;
let resolveHost: ResolveHost | undefined;

/** Test seam: where sends go and how hosts resolve. Pass nothing to restore the real ones. */
export function setPushTransport(next?: { transport?: PushTransport; resolve?: ResolveHost }): void {
  transport = next?.transport ?? fetchTransport;
  resolveHost = next?.resolve;
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
    if (taskId) await deliverTaskPush(taskId, streamResponse);
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
 * Sends one event to every config of the task. Best-effort and awaited: a
 * notification is a courtesy on top of `GetTask`, never the reason a state
 * change fails, but a send left floating on a frozen instance is lost.
 */
export async function deliverTaskPush(taskId: string, event: StreamResponse): Promise<number> {
  const rows = await db().select().from(schema.a2aPushConfig).where(eq(schema.a2aPushConfig.taskId, taskId));
  if (rows.length === 0) return 0;
  const body = JSON.stringify(StreamResponse.toJSON(event));
  /* In parallel: one slow receiver must not hold up the others, or the request. */
  const outcomes = await Promise.all(
    rows.map(async (row) => {
      let url: URL;
      try {
        url = await assertCallbackReachable(row.url, resolveHost);
      } catch (error) {
        console.warn(`a2a push dropped for task ${taskId}: ${error instanceof Error ? error.message : 'refused'}`);
        return false;
      }
      const headers: Record<string, string> = { 'content-type': 'application/a2a+json' };
      const secret = row.secret ? await openSecret(row.secret) : null;
      if (secret?.authentication) headers.authorization = `${secret.authentication.scheme} ${secret.authentication.credentials}`;
      else if (secret?.token) headers['x-a2a-notification-token'] = secret.token;
      try {
        await transport(url, { headers, body });
        return true;
      } catch (error) {
        console.warn(`a2a push to ${url.host} failed: ${error instanceof Error ? error.message : 'unknown'}`);
        return false;
      }
    }),
  );
  return outcomes.filter(Boolean).length;
}

async function openSecret(sealed: string): Promise<Secret | null> {
  try {
    const opened = await openCredential(sealed);
    return opened ? (JSON.parse(opened) as Secret) : null;
  } catch {
    return null;
  }
}
