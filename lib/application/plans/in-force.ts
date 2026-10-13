/**
 * Which subscription row sets a workspace's plan right now. One definition,
 * read by every place that asks: the quota transaction, billing, the session,
 * and the library and key ceilings.
 *
 * Two rules on top of "active, and its period contains now":
 *
 * **A provider-billed row outranks the Free row.** Signup writes a Free row
 * with a period of its own, and a paid subscription bought during it is a
 * second active row. Picking "the one ending last" made the paid row win only
 * by month-length arithmetic on two clocks; a Free row that happened to end
 * later would have put a paying customer back on Free's allowance. The rows
 * are ranked by what they are, not by when they end.
 *
 * **A provider-billed row survives its own period end by a day.** The provider
 * renews at exactly `period_end`, and the webhook that moves the period lands
 * after it -- seconds normally, longer when delivery is retried. Without the
 * grace, every renewal dropped a Pro workspace to Free for that gap. A renewal
 * whose payment fails does not ride the grace: the provider reports it
 * `past_due`, which is not `active`. The Free row never gets one; nothing
 * renews it.
 *
 * During the grace the billing window is the period that has just begun --
 * starting at the old `period_end` -- so a workspace that used its whole
 * allowance last month is not refused on the first request of this one. When
 * the webhook lands, the real period starts at that same instant, and the calls
 * made in between are already inside it.
 */
import { asc, desc, eq, and, lte, sql, type SQL } from 'drizzle-orm';
import { schema } from '@/lib/infrastructure/postgres/client';

/** How long a provider-billed subscription is honoured past its period end. */
export const RENEWAL_GRACE_MS = 86_400_000;

const s = schema.subscription;

/** The row is in force now. Combine with a workspace condition. */
export function subscriptionInForce(): SQL {
  return and(
    eq(s.status, 'active'),
    lte(s.periodStart, sql`now()`),
    sql`${s.periodEnd} + case when ${s.providerSubscriptionId} is null then interval '0' else interval '1 day' end >= now()`,
  )!;
}

/** Among rows in force, the one that decides: provider-billed first, then the latest end. */
export const IN_FORCE_FIRST = [asc(sql`${s.providerSubscriptionId} is null`), desc(s.periodEnd)] as const;

/** The billing window a row in force covers at `now`. See the module comment. */
export function windowInForce(
  row: { periodStart: Date; periodEnd: Date },
  now: Date = new Date(),
): { periodStart: Date; periodEnd: Date } {
  if (now < row.periodEnd) return { periodStart: row.periodStart, periodEnd: row.periodEnd };
  return {
    periodStart: row.periodEnd,
    periodEnd: new Date(row.periodEnd.getTime() + RENEWAL_GRACE_MS),
  };
}
