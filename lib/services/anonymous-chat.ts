/**
 * What is left of anonymous chat with free Rees (beyond 4), which ended
 * with the conversation code (2026-11): its HMAC of a visitor's values,
 * which report keys still use (lib/http/reporter.ts) so a visitor who
 * reported before still counts once, and the hourly clearing of its quota
 * table's past days. The console's limits form went too (2026-11-21); its
 * table, anonymous_chat_settings, is left as it was.
 */
import { sql } from 'drizzle-orm';
import { anonymousDay } from '@/lib/domain/anonymous-chat';
import { authSecret } from '@/lib/infra/crypto/secrets';
import { hmacSha256 } from '@/lib/infra/crypto/tokens';
import { db, schema } from '@/lib/infra/db';

let derivedKey: Promise<string> | null = null;

/** A key for these HMACs only, so the stored values say nothing under any other use of AUTH_SECRET. */
function quotaKey(): Promise<string> {
  derivedKey ??= hmacSha256(authSecret(), 're0:anonymous-chat-quota:v1');
  return derivedKey;
}

export async function quotaKeyHash(kind: 'fp' | 'id' | 'ip', value: string): Promise<string> {
  return `${kind}:${await hmacSha256(await quotaKey(), `${kind}:${value}`)}`;
}

/** Past days, cleared hourly by `/api/cron/rank` (on its own, before the ranking); yesterday stays a little longer for a request still in flight at midnight. */
export async function clearAnonymousQuota(now = new Date()): Promise<void> {
  await db().delete(schema.anonymousChatQuota).where(sql`${schema.anonymousChatQuota.day} < ${anonymousDay(new Date(now.getTime() - 86_400_000))}`);
}
