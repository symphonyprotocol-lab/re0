/**
 * API keys for the MCP server (`/api/mcp`): what a user creates in
 * `/settings?tab=api` and what `Authorization: Bearer` is checked against.
 *
 * A key is `re0_sk_` and 64 hex characters, shown once when it is made;
 * the row keeps its SHA-256 digest and last four characters only. A
 * revoked or expired key, or any key of a disabled account, is nobody.
 * Keys are revoked, never deleted, so the questions they asked keep their
 * tag and the settings page can still show what each one spent.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { API_KEY_LAST_USED_RESOLUTION_MS, API_KEY_MAX_ACTIVE, API_KEY_MAX_DAYS, API_KEY_NAME_MAX, API_KEY_PREFIX } from '@/lib/constants';
import { db, schema } from '@/lib/infra/db';
import { randomHex, sha256 } from '@/lib/infra/crypto/tokens';
import { AdminInputError, audit } from '@/lib/services/admin';
import type { SessionUser } from '@/lib/services/auth';

export type ApiKeyRow = typeof schema.apiKey.$inferSelect;

export class ApiKeyError extends Error {
  constructor(readonly code: 'invalid_name' | 'invalid_expiry' | 'too_many_keys') {
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
  /** Questions asked with this key, and the credits they cost. */
  questions: number;
  spent: number;
}

const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[0-9a-f]{64}$`);

export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/** A key that still opens the server: not revoked and not past its expiry. */
export function keyIsLive(key: Pick<ApiKeyRow, 'revokedAt' | 'expiresAt'>, now = new Date()): boolean {
  return !key.revokedAt && (!key.expiresAt || key.expiresAt.getTime() > now.getTime());
}

/** `{name, expiresInDays?}` → the new key, whose `secret` is never readable again. */
export async function createApiKey(userId: string, raw: { name?: unknown; expiresInDays?: unknown }, now = new Date()): Promise<{ key: ApiKeyItem; secret: string }> {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || Array.from(name).length > API_KEY_NAME_MAX) throw new ApiKeyError('invalid_name');
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
      .where(and(eq(schema.apiKey.userId, userId), isNull(schema.apiKey.revokedAt), sql`(${schema.apiKey.expiresAt} is null or ${schema.apiKey.expiresAt} > ${now})`));
    if (live >= API_KEY_MAX_ACTIVE) throw new ApiKeyError('too_many_keys');
    const [created] = await tx.insert(schema.apiKey).values({ userId, name, keyDigest, keyTail: secret.slice(-4), expiresAt, createdAt: now }).returning();
    return created!;
  });
  return { key: { ...item(row), questions: 0, spent: 0 }, secret };
}

function item(row: ApiKeyRow): Omit<ApiKeyItem, 'questions' | 'spent'> {
  return { id: row.id, name: row.name, tail: row.keyTail, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
}

/** Every key of the user, newest first, with what each one asked and spent. */
export async function listApiKeys(userId: string): Promise<ApiKeyItem[]> {
  const rows = await db().select().from(schema.apiKey).where(eq(schema.apiKey.userId, userId)).orderBy(desc(schema.apiKey.createdAt));
  const usage = await usageOf(rows.map((row) => row.id));
  return rows.map((row) => ({ ...item(row), questions: usage.get(row.id)?.questions ?? 0, spent: usage.get(row.id)?.spent ?? 0 }));
}

/** Per key: the questions it asked, and the credits their answers were charged. */
export async function usageOf(keyIds: readonly string[]): Promise<Map<string, { questions: number; spent: number }>> {
  if (keyIds.length === 0) return new Map();
  const reply = alias(schema.message, 'reply');
  const rows = await db()
    .select({
      keyId: schema.message.apiKeyId,
      questions: sql<number>`count(distinct ${schema.message.id})::int`,
      spent: sql<number>`coalesce(sum(${reply.costCredits}), 0)::int`,
    })
    .from(schema.message)
    .leftJoin(reply, and(eq(reply.requestId, schema.message.id), eq(reply.role, 'ree')))
    .where(and(inArray(schema.message.apiKeyId, [...keyIds]), eq(schema.message.role, 'user')))
    .groupBy(schema.message.apiKeyId);
  return new Map(rows.map((row) => [row.keyId!, { questions: Number(row.questions), spent: Number(row.spent) }]));
}

/** The owner revokes one of their keys; false for someone else's, an unknown id, or one already revoked. */
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
  if (!row || !keyIsLive(row.key, now) || row.user.disabledAt) return null;
  if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() >= API_KEY_LAST_USED_RESOLUTION_MS) {
    await db().update(schema.apiKey).set({ lastUsedAt: now }).where(eq(schema.apiKey.id, row.key.id));
  }
  return { user: row.user, keyId: row.key.id };
}
