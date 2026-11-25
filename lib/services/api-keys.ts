/**
 * API keys for the MCP server (`/api/mcp`): what a user creates in
 * `/settings?tab=api` and what `Authorization: Bearer` is checked against.
 *
 * A key is `re0_sk_` and 64 hex characters, shown once when it is made;
 * the row keeps its SHA-256 digest and last four characters only. A
 * revoked or expired key, or any key of a disabled account, is nobody.
 * Keys are revoked, never deleted, so the questions they asked keep their
 * tag and the settings page can still show what each one spent.
 *
 * A key reads and asks (`search_rees`, `get_*`, `list_*`, `ask_ree`); only
 * one made with `canWrite` may also change things -- post, follow up,
 * manage Rees and their knowledge (lib/services/mcp.ts `requireWrite`). It
 * is chosen when the key is made and never widened afterwards: a key that
 * needs more is a new key.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { API_KEY_LAST_USED_RESOLUTION_MS, API_KEY_MAX_ACTIVE, API_KEY_MAX_DAYS, API_KEY_NAME_MAX, API_KEY_PREFIX } from '@/lib/constants';
import { db, schema } from '@/lib/infra/db';
import { randomHex, sha256 } from '@/lib/infra/crypto/tokens';
import { AdminInputError, audit } from '@/lib/services/admin';
import type { SessionUser } from '@/lib/services/auth';
import { cleanClientName, clientLabel, normalizePath, WORKSPACE_ACCESS, type WorkspaceAccess } from '@/lib/domain/workspace';
import { defaultWorkspace } from '@/lib/services/workspace';

export type ApiKeyRow = typeof schema.apiKey.$inferSelect;

export class ApiKeyError extends Error {
  constructor(readonly code: 'invalid_name' | 'invalid_expiry' | 'too_many_keys' | 'invalid_workspace_access' | 'invalid_workspace_root') {
    super(code);
  }
}

export interface ApiKeyItem {
  id: string;
  name: string;
  /** The key's last four characters, shown as `re0_sk_…abcd`. */
  tail: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** May change things through MCP, not only read and ask. */
  canWrite: boolean;
  /** `workspace`: confined to one workspace's `ws_*` tools under `workspaceRoot`; `account`: the Ree and post tools, and the workspace if `workspaceAccess` allows. */
  kind: 'account' | 'workspace';
  workspaceAccess: WorkspaceAccess;
  workspaceRoot: string;
  /** What the client last called itself when it connected (`clientInfo.name`), for display. */
  client: string | null;
  /** Questions asked with this key, and the credits they cost. */
  questions: number;
  spent: number;
  /**
   * Set for an OAuth grant (lib/services/oauth.ts) rather than a key: the
   * app the user approved, as it named itself, and where it sends them
   * back. Settings shows these under 已连接的应用, the console with the keys.
   */
  oauthClient: { id: string; name: string; uri: string | null; redirectHosts: string[]; documentHost: string | null } | null;
}

const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[0-9a-f]{64}$`);

export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/** A key that still opens the server: not revoked and not past its expiry. */
export function keyIsLive(key: Pick<ApiKeyRow, 'revokedAt' | 'expiresAt'>, now = new Date()): boolean {
  return !key.revokedAt && (!key.expiresAt || key.expiresAt.getTime() > now.getTime());
}

/**
 * `{name, expiresInDays?, canWrite?, kind?, workspaceAccess?, workspaceRoot?}`
 * → the new key, whose `secret` is never readable again. Only
 * `canWrite: true` makes a key that may write Rees and posts, and only an
 * explicit `workspaceAccess` one that reaches files: every default is the
 * narrowest. A `workspace` key needs `read` or `write`, never writes Rees or
 * posts, and is bound to the account's default workspace at `workspaceRoot`.
 */
export async function createApiKey(
  userId: string,
  raw: { name?: unknown; expiresInDays?: unknown; canWrite?: unknown; kind?: unknown; workspaceAccess?: unknown; workspaceRoot?: unknown },
  now = new Date(),
): Promise<{ key: ApiKeyItem; secret: string }> {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || Array.from(name).length > API_KEY_NAME_MAX) throw new ApiKeyError('invalid_name');
  const kind = raw.kind === 'workspace' ? 'workspace' : 'account';
  const access = raw.workspaceAccess === undefined || raw.workspaceAccess === null ? 'none' : raw.workspaceAccess;
  if (!(WORKSPACE_ACCESS as readonly unknown[]).includes(access) || (kind === 'workspace' && access === 'none')) throw new ApiKeyError('invalid_workspace_access');
  const root = kind === 'workspace' ? normalizePath(raw.workspaceRoot ?? '/') : '/';
  if (!root) throw new ApiKeyError('invalid_workspace_root');
  let expiresAt: Date | null = null;
  if (raw.expiresInDays !== undefined && raw.expiresInDays !== null && raw.expiresInDays !== '') {
    const days = Number(raw.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > API_KEY_MAX_DAYS) throw new ApiKeyError('invalid_expiry');
    expiresAt = new Date(now.getTime() + days * 86_400_000);
  }
  const secret = `${API_KEY_PREFIX}${randomHex(32)}`;
  const keyDigest = await sha256(secret);
  const row = await db().transaction(async (tx) => {
    /* Serialises one user's creations, so the cap holds under concurrent requests. */
    await tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId)).for('update');
    const [{ live } = { live: 0 }] = await tx
      .select({ live: sql<number>`count(*)::int` })
      .from(schema.apiKey)
      .where(and(eq(schema.apiKey.userId, userId), isNull(schema.apiKey.oauthClientId), isNull(schema.apiKey.revokedAt), sql`(${schema.apiKey.expiresAt} is null or ${schema.apiKey.expiresAt} > ${now})`));
    if (live >= API_KEY_MAX_ACTIVE) throw new ApiKeyError('too_many_keys');
    const workspaceId = kind === 'workspace' ? await defaultWorkspace(userId, tx) : null;
    const [created] = await tx
      .insert(schema.apiKey)
      .values({
        userId,
        name,
        keyDigest,
        keyTail: secret.slice(-4),
        expiresAt,
        canWrite: kind === 'account' && raw.canWrite === true,
        workspaceAccess: access as WorkspaceAccess,
        workspaceId,
        workspaceRoot: root,
        createdAt: now,
      })
      .returning();
    return created!;
  });
  return { key: { ...item(row, null), questions: 0, spent: 0 }, secret };
}

function hostOf(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : `${url.protocol}//`;
  } catch {
    return uri;
  }
}

function item(row: ApiKeyRow, client: typeof schema.oauthClient.$inferSelect | null): Omit<ApiKeyItem, 'questions' | 'spent'> {
  return {
    id: row.id,
    name: row.name,
    tail: row.keyTail,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    canWrite: row.canWrite,
    kind: row.workspaceId ? 'workspace' : 'account',
    workspaceAccess: row.workspaceAccess,
    workspaceRoot: row.workspaceRoot,
    client: clientLabel(row.clientName),
    oauthClient: client
      ? {
          id: client.id,
          name: client.clientName,
          uri: client.clientUri,
          redirectHosts: Array.from(new Set(client.redirectUris.map(hostOf))),
          documentHost: client.kind === 'metadata_document' ? hostOf(client.id) : null,
        }
      : null,
  };
}

/**
 * Every key of the user, newest first, with what each one asked and spent;
 * OAuth grants (connected apps) are among them, marked by `oauthClient`.
 */
export async function listApiKeys(userId: string): Promise<ApiKeyItem[]> {
  const rows = await db()
    .select({ key: schema.apiKey, client: schema.oauthClient })
    .from(schema.apiKey)
    .leftJoin(schema.oauthClient, eq(schema.oauthClient.id, schema.apiKey.oauthClientId))
    .where(eq(schema.apiKey.userId, userId))
    .orderBy(desc(schema.apiKey.createdAt));
  const usage = await usageOf(rows.map((row) => row.key.id));
  return rows.map(({ key, client }) => ({ ...item(key, client), questions: usage.get(key.id)?.questions ?? 0, spent: usage.get(key.id)?.spent ?? 0 }));
}

/**
 * Per key: the questions it asked -- every post MCP made through it
 * (`ask_ree`'s `source = 'api'` and `create_post`'s, tagged `api_key_id`)
 * and every follow-up -- and what their answers were charged: each Ree
 * answer's price once it answered (posts.ts `closeAnswer` settles exactly
 * that; a hold given back cost nothing) and each AI answer's fee once
 * written. Each adds what the key asked through MCP conversations before
 * (`legacy_*`, frozen by migration 0067).
 */
export async function usageOf(keyIds: readonly string[]): Promise<Map<string, { questions: number; spent: number }>> {
  if (keyIds.length === 0) return new Map();
  const keys = sql.join(
    keyIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await db().execute<{ key_id: string; questions: number; spent: number }>(sql`
    with asked as (
      select p.api_key_id as key_id, p.id as post_id, null::uuid as followup_id
      from ${schema.post} p where p.api_key_id in (${keys})
      union all
      select f.api_key_id, f.post_id, f.id
      from ${schema.postFollowup} f where f.api_key_id in (${keys})
    )
    select k.id as key_id, (k.legacy_questions + count(q.post_id))::int as questions,
      (k.legacy_spent + coalesce(sum((select coalesce(sum(a.price), 0) from ${schema.postAnswer} a
        where a.post_id = q.post_id and a.followup_id is not distinct from q.followup_id and a.state = 'answered' and a.base_hold_id is not null)
        + (select coalesce(sum(ai.price), 0) from ${schema.postAiAnswer} ai
        where ai.post_id = q.post_id and ai.followup_id is not distinct from q.followup_id and ai.state = 'answered')), 0))::int as spent
    from ${schema.apiKey} k left join asked q on q.key_id = k.id
    where k.id in (${keys})
    group by k.id`);
  return new Map(result.rows.map((row) => [row.key_id, { questions: Number(row.questions), spent: Number(row.spent) }]));
}

/** The owner revokes one of their keys or connected apps; false for someone else's, an unknown id, or one already revoked. An app's tokens stop working with it. */
export async function revokeApiKey(userId: string, id: string, now = new Date()): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const rows = await db()
    .update(schema.apiKey)
    .set({ revokedAt: now })
    .where(and(eq(schema.apiKey.id, id), eq(schema.apiKey.userId, userId), isNull(schema.apiKey.revokedAt)))
    .returning({ id: schema.apiKey.id });
  return rows.length > 0;
}

/** The console's forced revoke, written to the audit log. */
export async function adminRevokeApiKey(administratorId: string, userId: string, id: string, now = new Date()): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AdminInputError('not_found');
  await db().transaction(async (tx) => {
    const [row] = await tx.select().from(schema.apiKey).where(and(eq(schema.apiKey.id, id), eq(schema.apiKey.userId, userId))).for('update');
    if (!row) throw new AdminInputError('not_found');
    if (row.revokedAt) throw new AdminInputError('stale');
    await tx.update(schema.apiKey).set({ revokedAt: now }).where(eq(schema.apiKey.id, id));
    await audit(tx, {
      administratorId,
      action: 'user.api_key.revoke',
      target: userId,
      before: { key: row.id, name: row.name, tail: row.keyTail, status: 'active' },
      after: { key: row.id, name: row.name, tail: row.keyTail, status: 'revoked' },
    });
  });
}

export interface ApiKeyCaller {
  user: SessionUser;
  keyId: string;
  /** The key may write (`api_key.can_write`); without it, only reading and `ask_ree`. */
  canWrite: boolean;
  /** What the key may do with files, and where (lib/http/mcp-workspace.ts). A workspace key has `workspaceId` and sees nothing else. */
  workspaceAccess: WorkspaceAccess;
  workspaceId: string | null;
  workspaceRoot: string;
  /** The MCP client's own name from its last `initialize` with this key. */
  clientName: string | null;
}

/**
 * The account a presented key belongs to, or null: unknown, revoked or
 * expired keys, and every key of a disabled account. `last_used_at` moves
 * at most once a minute, so a busy client does not write on every call.
 */
export async function resolveApiKey(secret: string, now = new Date()): Promise<ApiKeyCaller | null> {
  if (!looksLikeApiKey(secret)) return null;
  const digest = await sha256(secret);
  const [row] = await db()
    .select({ key: schema.apiKey, user: schema.user })
    .from(schema.apiKey)
    .innerJoin(schema.user, eq(schema.user.id, schema.apiKey.userId))
    .where(eq(schema.apiKey.keyDigest, digest))
    .limit(1);
  if (!row || row.key.oauthClientId || !keyIsLive(row.key, now) || row.user.disabledAt) return null;
  if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() >= API_KEY_LAST_USED_RESOLUTION_MS) {
    await db().update(schema.apiKey).set({ lastUsedAt: now }).where(eq(schema.apiKey.id, row.key.id));
  }
  return keyCaller(row.key, row.user);
}

/** The caller a key row stands for -- an API key's, or an OAuth grant's (lib/services/oauth.ts `resolveAccessToken`). */
export function keyCaller(key: ApiKeyRow, user: SessionUser): ApiKeyCaller {
  return {
    user,
    keyId: key.id,
    canWrite: key.canWrite,
    workspaceAccess: key.workspaceAccess,
    workspaceId: key.workspaceId,
    workspaceRoot: key.workspaceRoot,
    clientName: key.clientName,
  };
}

/** Remembers what an MCP client called itself when it connected with this key (`initialize`), when that changed. */
export async function noteKeyClient(keyId: string, raw: unknown): Promise<void> {
  const name = cleanClientName(raw);
  if (!name) return;
  await db().update(schema.apiKey).set({ clientName: name }).where(and(eq(schema.apiKey.id, keyId), sql`${schema.apiKey.clientName} is distinct from ${name}`));
}
