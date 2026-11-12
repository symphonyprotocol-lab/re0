/**
 * The share page `/s/[slug]`: who opened it and how many conversations it
 * started. Only a public Ree has one (`publicReeRef`, the same gate as
 * `/r/[slug]`). A visitor is the random id of the `re0_visitor` cookie --
 * no IP or user agent is stored; the owner's own visits are not counted.
 *
 * - a visit counts once per visitor, Ree and half-hour slot; the unique
 *   index makes that hold for concurrent beacons too;
 * - a browser without the cookie is answered `cookie` and counted only when
 *   it comes back with it, so a client that keeps no cookies counts nothing;
 * - an IP is limited per minute over all Rees, and per hour for each Ree;
 * - a conversion is a conversation the visitor created with the Ree, or
 *   added the Ree to, within `SHARE_CONVERSION_MINUTES`, by a browser that
 *   visited the share page within `SHARE_ATTRIBUTION_HOURS` -- once per
 *   conversation;
 * - an anonymous answer (a free Ree asked signed out on the share page)
 *   counts for the share page under the same visit rule, as a figure of its
 *   own: it is not a conversation.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Range } from '@/lib/domain/statistics';
import { isUuid } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';
import { hitRateBucket } from '@/lib/services/explore';
import { publicReeRef } from '@/lib/services/public-rees';

/** A visitor counts once per slot of this length. */
export const SHARE_VISIT_SLOT_SECONDS = 1_800;
/** Beacons per IP per minute, over all Rees; past it nothing is read or stored. */
export const SHARE_IP_PER_MINUTE = 60;
/** New visits per IP per Ree per hour (an office behind one address still counts). */
export const SHARE_IP_PER_REE_HOUR = 30;
/** The Ree must have joined the conversation this recently to count as a conversion. */
export const SHARE_CONVERSION_MINUTES = 30;
/** ...and the browser must have visited the share page this recently. */
export const SHARE_ATTRIBUTION_HOURS = 24;

export function visitSlot(at: Date): number {
  return Math.floor(at.getTime() / 1_000 / SHARE_VISIT_SLOT_SECONDS);
}

export type VisitResult = 'recorded' | 'repeat' | 'cookie' | 'owner' | 'limited' | 'not_found';

/** One open of `/s/[slug]`. `freshVisitor`: the request carried no visitor cookie; one is being set. */
export async function recordShareVisit(input: { slug: string; visitorId: string; freshVisitor: boolean; userId: string | null; ip: string | null }, now = new Date()): Promise<VisitResult> {
  if (input.ip && !(await hitRateBucket(`share:ip:${input.ip}`, SHARE_IP_PER_MINUTE, 60, now))) return 'limited';
  const ree = await publicReeRef(input.slug);
  if (!ree) return 'not_found';
  if (input.userId === ree.ownerId) return 'owner';
  if (input.freshVisitor) return 'cookie';
  const inserted = await db()
    .insert(schema.reeShareEvent)
    .values({ reeId: ree.id, kind: 'visit', visitorId: input.visitorId, userId: input.userId, visitSlot: visitSlot(now), createdAt: now })
    .onConflictDoNothing()
    .returning({ id: schema.reeShareEvent.id });
  const row = inserted[0];
  if (!row) return 'repeat';
  if (input.ip && !(await hitRateBucket(`share:ip:${input.ip}:${ree.id}`, SHARE_IP_PER_REE_HOUR, 3_600, now))) {
    await db().delete(schema.reeShareEvent).where(eq(schema.reeShareEvent.id, row.id));
    return 'limited';
  }
  return 'recorded';
}

export type ConversionResult = 'recorded' | 'repeat' | 'unattributed' | 'owner' | 'not_found';

/**
 * A conversation started (or joined) from `/s/[slug]`. It must be the
 * user's own and have taken the Ree in just now, and this browser must
 * have visited the share page -- so an old conversation cannot be claimed,
 * nor someone else's.
 */
export async function recordShareConversion(input: { slug: string; visitorId: string; userId: string; conversationId: string }, now = new Date()): Promise<ConversionResult> {
  if (!isUuid(input.conversationId)) return 'not_found';
  const ree = await publicReeRef(input.slug);
  if (!ree) return 'not_found';
  if (input.userId === ree.ownerId) return 'owner';
  const [member] = await db()
    .select({ addedAt: schema.conversationRee.addedAt })
    .from(schema.conversation)
    .innerJoin(schema.conversationRee, and(eq(schema.conversationRee.conversationId, schema.conversation.id), eq(schema.conversationRee.reeId, ree.id)))
    .where(and(eq(schema.conversation.id, input.conversationId), eq(schema.conversation.userId, input.userId)))
    .limit(1);
  if (!member) return 'not_found';
  if (member.addedAt.getTime() < now.getTime() - SHARE_CONVERSION_MINUTES * 60_000) return 'unattributed';
  const [visited] = await db()
    .select({ id: schema.reeShareEvent.id })
    .from(schema.reeShareEvent)
    .where(
      and(
        eq(schema.reeShareEvent.visitorId, input.visitorId),
        eq(schema.reeShareEvent.reeId, ree.id),
        eq(schema.reeShareEvent.kind, 'visit'),
        gte(schema.reeShareEvent.createdAt, new Date(now.getTime() - SHARE_ATTRIBUTION_HOURS * 3_600_000)),
      ),
    )
    .limit(1);
  if (!visited) return 'unattributed';
  const inserted = await db()
    .insert(schema.reeShareEvent)
    .values({ reeId: ree.id, kind: 'conversation', visitorId: input.visitorId, userId: input.userId, conversationId: input.conversationId, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: schema.reeShareEvent.id });
  return inserted.length ? 'recorded' : 'repeat';
}

/**
 * Anonymous chat on the share page (anonymous-chat.ts): the visitor id an
 * answer is attributed to, when this browser visited this Ree's share page
 * within `SHARE_ATTRIBUTION_HOURS` -- the rule a conversion follows -- and
 * otherwise none, so a request merely claiming the share page counts
 * nothing there.
 */
export async function shareVisitorFor(reeId: string, visitorId: string | null | undefined, now = new Date()): Promise<string | null> {
  if (!isUuid(visitorId)) return null;
  const [visited] = await db()
    .select({ id: schema.reeShareEvent.id })
    .from(schema.reeShareEvent)
    .where(
      and(
        eq(schema.reeShareEvent.visitorId, visitorId),
        eq(schema.reeShareEvent.reeId, reeId),
        eq(schema.reeShareEvent.kind, 'visit'),
        gte(schema.reeShareEvent.createdAt, new Date(now.getTime() - SHARE_ATTRIBUTION_HOURS * 3_600_000)),
      ),
    )
    .limit(1);
  return visited ? visitorId : null;
}

export interface ShareStatistics {
  /** Whether the Ree has a share page now (public and not taken down). */
  shareable: boolean;
  /** Opens of the share page (once per visitor every half hour). */
  visits: number;
  /** Distinct visitors (browsers). */
  visitors: number;
  /** Conversations started or joined from it. */
  conversations: number;
  /** Visitors of the period who also started a conversation in it. */
  converted: number;
  /** `converted / visitors` as a whole percentage, or null without visitors. */
  rate: number | null;
  /** Answers a free Ree gave signed-out visitors on the share page (anonymous chat); not conversions. */
  anonymousAnswers: number;
}

export async function shareStatistics(reeId: string, range: Range | null): Promise<ShareStatistics> {
  const start = range ? new Date(range.start).toISOString() : null;
  const end = range ? new Date(range.end).toISOString() : null;
  const within = (alias: string) => (range ? sql.raw(`and ${alias}.created_at >= '${start}'::timestamptz and ${alias}.created_at < '${end}'::timestamptz`) : sql``);
  const result = await db().execute<{ shareable: boolean; visits: number; visitors: number; conversations: number; converted: number }>(sql`
    select
      exists (select 1 from ${schema.ree} r where r.id = ${reeId} and r.is_public and r.moderated_at is null and r.deleted_at is null) as shareable,
      count(*) filter (where e.kind = 'visit')::int as visits,
      count(distinct e.visitor_id) filter (where e.kind = 'visit')::int as visitors,
      count(*) filter (where e.kind = 'conversation')::int as conversations,
      count(distinct e.visitor_id) filter (
        where e.kind = 'visit'
          and exists (select 1 from ${schema.reeShareEvent} c where c.ree_id = e.ree_id and c.visitor_id = e.visitor_id and c.kind = 'conversation' ${within('c')})
      )::int as converted
    from ${schema.reeShareEvent} e
    where e.ree_id = ${reeId} ${within('e')}
  `);
  const anonymous = await db().execute<{ n: number }>(sql`
    select count(*)::int as n from ${schema.anonymousAnswer} a where a.ree_id = ${reeId} and a.share_visitor_id is not null ${within('a')}
  `);
  const row = result.rows[0] ?? { shareable: false, visits: 0, visitors: 0, conversations: 0, converted: 0 };
  const visitors = Number(row.visitors);
  const converted = Number(row.converted);
  return {
    shareable: Boolean(row.shareable),
    visits: Number(row.visits),
    visitors,
    conversations: Number(row.conversations),
    converted,
    rate: visitors ? Math.round((converted / visitors) * 100) : null,
    anonymousAnswers: Number(anonymous.rows[0]?.n ?? 0),
  };
}
