/**
 * Workflow: settle-revenue
 *
 * Cron-triggered (architecture.md 11.4: settlement is a batch outside the
 * request path). Closes the previous UTC month's revenue period -- the close
 * itself is a single idempotent transaction (close-period.ts), so a retried
 * or doubly-scheduled run returns the frozen numbers instead of recomputing.
 * agent-first-proposal.md 6.9: accounting only, no payouts.
 */
import { revenuePeriodId } from '@/lib/domain';
import { closePeriod } from '@/lib/application/revenue';

export async function run(): Promise<void> {
  const now = new Date();
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const closed = await closePeriod(revenuePeriodId(previousMonth));
  console.log(
    `settle-revenue: period ${closed.periodId} ${closed.alreadyLocked ? 'was already locked' : 'locked'}, ${closed.totalAmountMinor} minor across ${closed.allocations.length} creators`,
  );
}
