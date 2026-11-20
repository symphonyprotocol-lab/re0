/**
 * The share page `/s/[slug]`: who opened it and how many posts (before,
 * conversations) it started. Only a public Ree has one (`publicReeRef`,
 * the same gate as `/r/[slug]`). A visitor is the random id of the `re0_visitor` cookie --
 * no IP or user agent is stored; the owner's own visits are not counted.
 *
 * - a visit counts once per visitor, Ree and half-hour slot; the unique
 *   index makes that hold for concurrent beacons too;
 * - a browser without the cookie is answered `cookie` and counted only when
 *   it comes back with it, so a client that keeps no cookies counts nothing;
 * - an IP is limited per minute over all Rees, and per hour for each Ree;
 * - a conversion is a post the visitor published from the share page
 *   that asks the Ree -- a public post naming it, or a private one asking it
 *   -- within `SHARE_CONVERSION_MINUTES`, by a browser that visited the
 *   share page within `SHARE_ATTRIBUTION_HOURS`, once per post (2026-11-20;
 *   before, a conversation that took the Ree in, once per conversation --
 *   those rows are still counted);
 * - an anonymous answer (a free Ree asked signed out on the share page,
 *   until 2026-11-19) counted for the share page under the same visit rule,
 *   as a figure of its own: it is not a conversion.
 */
import { and, eq, gte, isNull, or, sql } from 'drizzle-orm';
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
/** The post must have asked the Ree this recently to count as a conversion. */
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

/** Whether this browser visited the Ree's share page recently enough to be credited with what it does next. */
async function visitedRecently(reeId: string, visitorId: string, now: Date): Promise<boolean> {
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
  return Boolean(visited);
}

/**
 * A post published from `/s/[slug]` (its 向 … 提问 box). The post must be
 * the user's own, made just now, and ask the Ree: a public post naming it,
 * or a private post it was asked in. And this browser must have visited the
 * share page -- so an old post cannot be claimed, nor someone else's.
 */
export async function recordShareConversion(input: { slug: string; visitorId: string; userId: string; postId: string }, now = new Date()): Promise<ConversionResult> {
  const target = input.postId;
  if (!isUuid(target)) return 'not_found';
  const ree = await publicReeRef(input.slug);
  if (!ree) return 'not_found';
  if (input.userId === ree.ownerId) return 'owner';
  const { post, postAnswer } = schema;
  const [asked] = await db()
    .select({ createdAt: post.createdAt })
    .from(post)
    .where(
      and(
        eq(post.id, target),
        eq(post.userId, input.userId),
        eq(post.source, 'post'),
        isNull(post.deletedAt),
        or(
          and(eq(post.visibility, 'public'), eq(post.mentionReeId, ree.id)),
          and(eq(post.visibility, 'private'), sql`exists (select 1 from ${postAnswer} sa where sa.post_id = ${post.id} and sa.ree_id = ${ree.id} and sa.followup_id is null)`),
        ),
      ),
    )
    .limit(1);
  if (!asked) return 'not_found';
  if (asked.createdAt.getTime() < now.getTime() - SHARE_CONVERSION_MINUTES * 60_000) return 'unattributed';
  if (!(await visitedRecently(ree.id, input.visitorId, now))) return 'unattributed';
  const inserted = await db()
    .insert(schema.reeShareEvent)
    .values({ reeId: ree.id, kind: 'post', visitorId: input.visitorId, userId: input.userId, postId: target, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: schema.reeShareEvent.id });
  return inserted.length ? 'recorded' : 'repeat';
}

export interface ShareStatistics {
  /** Whether the Ree has a share page now (public and not taken down). */
  shareable: boolean;
  /** Opens of the share page (once per visitor every half hour). */
  visits: number;
  /** Distinct visitors (browsers). */
  visitors: number;
  /** Conversions: posts published from it, and the conversations started or joined there before the chat pages went. */
  conversations: number;
  /** Visitors of the period who also converted in it. */
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
      count(*) filter (where e.kind in ('conversation', 'post'))::int as conversations,
      count(distinct e.visitor_id) filter (
        where e.kind = 'visit'
          and exists (select 1 from ${schema.reeShareEvent} c where c.ree_id = e.ree_id and c.visitor_id = e.visitor_id and c.kind in ('conversation', 'post') ${within('c')})
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
