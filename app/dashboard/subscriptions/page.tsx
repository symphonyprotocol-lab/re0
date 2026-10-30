import type { Metadata } from 'next';
import Link from 'next/link';
import { formatUsd } from '@/components/creator/format';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { mySubscriptions } from '@/lib/application/channels/subscriptions';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { cancelSubscriptionAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).creator.dashboard.subscriptions.metaTitle };
}

/**
 * The subscriber's view (agent-first-proposal.md 4.4 订阅, 6.9): every
 * channel this person subscribes or subscribed to, with its plan, status
 * and period end, and the cancel that keeps access to that end.
 */
export default async function SubscriptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, { locale, t }, query] = await Promise.all([requireSession('/dashboard/subscriptions'), translations(), searchParams]);
  const c = t.creator.dashboard.subscriptions;
  const errors = t.creator.errors as Record<string, string>;
  const rows = await mySubscriptions(session.user.id);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const notice = typeof query.notice === 'string' ? query.notice : null;
  const message = notice === null ? null : ((c.notices as Record<string, string>)[notice] ?? errors[notice] ?? errors.unavailable);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={c.title} description={c.description} />
      {message ? <p role="status" className="text-[12.5px] text-steel">{message}</p> : null}
      <section className={PANEL}>
        {rows.length === 0 ? (
          <p className="px-6 py-10 text-center text-[12.5px] text-muted">{c.empty}</p>
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead className="border-b border-line text-[11px] text-muted">
              <tr>
                {c.columns.map((column) => (
                  <th key={column} className="px-5 py-3 font-medium">
                    {column}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-5 py-3">
                    <Link href={`/channels/${row.channel.slug}`} className="font-medium text-ink hover:text-brandink">
                      {row.channel.title}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-steel">
                    {fill(row.interval === 'month' ? c.month : c.year, { price: formatUsd(row.priceMinor, locale) })}
                  </td>
                  <td className="px-5 py-3 text-steel">
                    {row.cancelAtPeriodEnd && row.status === 'active' ? c.renewsOff : c.status[row.status]}
                  </td>
                  <td className="px-5 py-3 text-steel">{date.format(row.currentPeriodEnd)}</td>
                  <td className="px-5 py-3 text-right">
                    {row.grantsAccess && !row.cancelAtPeriodEnd ? (
                      <form action={cancelSubscriptionAction}>
                        <input type="hidden" name="subscriptionId" value={row.id} />
                        <button type="submit" className="inline-flex h-8 items-center rounded-md border border-line bg-card px-2.5 text-[11.5px] font-medium text-steel hover:bg-subtle">
                          {c.cancel}
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
