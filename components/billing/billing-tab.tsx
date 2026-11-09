import { LIST_PAGE_SIZES } from '@/lib/constants';
import { parseActivity } from '@/lib/http/billing';
import { billingSummary, listEntries } from '@/lib/services/billing';
import { Entries } from '@/components/billing/entries';

/** Historical spending, earnings, and credit purchases, filtered by reporting period. */
export async function BillingTab({ userId, query }: { userId: string; query: Record<string, string | undefined> }) {
  const listQuery = parseActivity(query, LIST_PAGE_SIZES);
  const [summary, entries] = await Promise.all([billingSummary(userId), listEntries(userId, listQuery)]);
  return (
    <div className={`settings-billing billing-report${summary.official ? ' official-billing' : ''}`}>
      <Entries
        items={entries.items}
        total={entries.total}
        page={entries.page}
        size={entries.size}
        activity={entries.activity}
        official={summary.official}
        filter={listQuery}
        summary={entries.summary}
      />
    </div>
  );
}
