/**
 * The share page `/s/[slug]`: who opened it and how many conversations it
 * started. Only a public Ree has one (the same `publicRee()` gate as
 * `/r/[slug]`). A visitor is the random id of the `re0_visitor` cookie --
 * no IP or user agent is stored; the owner's own visits are not counted.
 *
 * - a visit is recorded at most once per visitor and Ree in
 *   `SHARE_VISIT_DEDUPE_MINUTES`, so reloads do not inflate it;
 * - a conversion is a conversation the visitor created with the Ree, or
 *   added the Ree to, from the share page -- once per conversation.
 */
import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { Range } from '@/lib/domain/statistics';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';

/** Reloads inside this window are the same visit. */
export const SHARE_VISIT_DEDUPE_MINUTES = 30;
/** Recorded visits per IP per minute; past it the beacon is answered but not stored. */
export const SHARE_RATE_LIMIT = { windowSeconds: 60, perIp: 60 } as const;

const VISITOR_ID = /^[a-f0-9-]{36}$/;

export function validVisitorId(value: string | undefined | null): value is string {
  return Boolean(value && VISITOR_ID.test(value));
}

/** The public Ree behind a share link, or null when it is private, taken down, deleted or unknown. */
async function sharedRee(slug: string): Promise<{ id: string; ownerId: string } | null> {
  if (!/^[a-z0-9-]{1,64}$/i.test(slug)) return null;
  const [row] = await db()
    .select({ id: schema.ree.id, ownerId: schema.ree.ownerId })
    .from(schema.ree)
    .where(and(eq(schema.ree.slug, slug.toLowerCase()), publicRee()))
    .limit(1);
  return row ?? null;
}

async function allowIp(ip: string | null, now: Date): Promise<boolean> {
  if (!ip) return true;
  const windowMs = SHARE_RATE_LIMIT.windowSeconds * 1_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db()
    .insert(schema.rateBucket)
    .values({ key: `share:ip:${ip}`, windowStart, hits: 1 })
    .onConflictDoUpdate({ target: [schema.rateBucket.key, schema.rateBucket.windowStart], set: { hits: sql`${schema.rateBucket.hits} + 1` } })
    .returning({ hits: schema.rateBucket.hits });
  return (row?.hits ?? 0) <= SHARE_RATE_LIMIT.perIp;
}

export type VisitResult = 'recorded' | 'repeat' | 'owner' | 'limited' | 'not_found';

/** One open of `/s/[slug]`. */
export async function recordShareVisit(input: { slug: string; visitorId: string; userId: string | null; ip: string | null }, now = new Date()): Promise<VisitResult> {
  const ree = await sharedRee(input.slug);
  if (!ree) return 'not_found';
  if (input.userId === ree.ownerId) return 'owner';
  const since = new Date(now.getTime() - SHARE_VISIT_DEDUPE_MINUTES * 60_000);
  const [recent] = await db()
    .select({ id: schema.reeShareEvent.id })
    .from(schema.reeShareEvent)
    .where(and(eq(schema.reeShareEvent.visitorId, input.visitorId), eq(schema.reeShareEvent.reeId, ree.id), eq(schema.reeShareEvent.kind, 'visit'), gte(schema.reeShareEvent.createdAt, since)))
    .limit(1);
  if (recent) return 'repeat';
  if (!(await allowIp(input.ip, now))) return 'limited';
  await db().insert(schema.reeShareEvent).values({ reeId: ree.id, kind: 'visit', visitorId: input.visitorId, userId: input.userId, createdAt: now });
  return 'recorded';
}

export type ConversionResult = 'recorded' | 'repeat' | 'owner' | 'not_found';

/**
 * A conversation started (or joined) from `/s/[slug]`. It must be the
 * user's own and already hold the Ree, so a conversion cannot be claimed
 * for someone else's conversation or one without the Ree.
 */
export async function recordShareConversion(input: { slug: string; visitorId: string; userId: string; conversationId: string }): Promise<ConversionResult> {
  const ree = await sharedRee(input.slug);
  if (!ree || !/^[a-f0-9-]{36}$/i.test(input.conversationId)) return 'not_found';
  if (input.userId === ree.ownerId) return 'owner';
  const [member] = await db()
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .innerJoin(schema.conversationRee, and(eq(schema.conversationRee.conversationId, schema.conversation.id), eq(schema.conversationRee.reeId, ree.id)))
    .where(and(eq(schema.conversation.id, input.conversationId), eq(schema.conversation.userId, input.userId)))
    .limit(1);
  if (!member) return 'not_found';
  const inserted = await db()
    .insert(schema.reeShareEvent)
    .values({ reeId: ree.id, kind: 'conversation', visitorId: input.visitorId, userId: input.userId, conversationId: input.conversationId })
    .onConflictDoNothing()
    .returning({ id: schema.reeShareEvent.id });
  return inserted.length ? 'recorded' : 'repeat';
}

export interface ShareStatistics {
  /** Opens of the share page (deduplicated per visitor every 30 minutes). */
  visits: number;
  /** Distinct visitors (browsers). */
  visitors: number;
  /** Conversations started or joined from it. */
  conversations: number;
  /** `conversations / visitors` as a whole percentage, or null without visitors. */
  rate: number | null;
}

export async function shareStatistics(reeId: string, range: Range | null): Promise<ShareStatistics> {
  const within: SQL[] = range ? [gte(schema.reeShareEvent.createdAt, new Date(range.start)), lt(schema.reeShareEvent.createdAt, new Date(range.end))] : [];
  const [row] = await db()
    .select({
      visits: sql<number>`count(*) filter (where ${schema.reeShareEvent.kind} = 'visit')::int`,
      visitors: sql<number>`count(distinct ${schema.reeShareEvent.visitorId}) filter (where ${schema.reeShareEvent.kind} = 'visit')::int`,
      conversations: sql<number>`count(*) filter (where ${schema.reeShareEvent.kind} = 'conversation')::int`,
    })
    .from(schema.reeShareEvent)
    .where(and(eq(schema.reeShareEvent.reeId, reeId), ...within));
  const visits = row?.visits ?? 0;
  const visitors = row?.visitors ?? 0;
  const conversations = row?.conversations ?? 0;
  return { visits, visitors, conversations, rate: visitors ? Math.round((Math.min(conversations, visitors) / visitors) * 100) : null };
}
