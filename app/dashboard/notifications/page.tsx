import type { Metadata } from 'next';
import Link from 'next/link';
import { PANEL, PageHeader } from '@/components/dashboard/ui';
import { listNotifications } from '@/lib/application/notifications';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { markNotificationsReadAction } from '../subscriptions/actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).creator.dashboard.notifications.metaTitle };
}

/** In-app notifications (agent-first-proposal.md 6.5, 6.7, 6.8): newest first; the payload names, never quotes. */
export default async function NotificationsPage() {
  const [session, { locale, t }] = await Promise.all([requireSession('/dashboard/notifications'), translations()]);
  const c = t.creator.dashboard.notifications;
  const rows = await listNotifications(session.user.id);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const text = (value: unknown) => (typeof value === 'string' ? value : '');

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow={session.workspace.name}
        title={c.title}
        description={c.description}
        action={
          rows.some((row) => !row.read) ? (
            <form action={markNotificationsReadAction}>
              <button type="submit" className="inline-flex h-9 items-center rounded-md border border-line bg-card px-3 text-[12px] font-medium text-steel hover:bg-subtle">
                {c.markRead}
              </button>
            </form>
          ) : undefined
        }
      />
      <section className={PANEL}>
        {rows.length === 0 ? (
          <p className="px-6 py-10 text-center text-[12.5px] text-muted">{c.empty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((row) => {
              const publicId = text(row.payload.publicId);
              const line = fill((c.kinds as Record<string, string>)[row.kind] ?? row.kind, {
                title: text(row.payload.title),
                channel: text(row.payload.channelTitle),
              });
              /* A refused scheduled publication opens its editor, which words the refusal. */
              const failed = row.kind === 'publish_failed' ? text(row.payload.assetId) : '';
              const href = failed
                ? `/dashboard/assets/${failed}/edit?notice=${encodeURIComponent(text(row.payload.reason))}`
                : publicId
                  ? `/assets${publicId}`
                  : row.kind === 'new_question'
                    ? '/dashboard/questions'
                    : null;
              return (
                <li key={row.id} className={`flex items-center justify-between gap-3 px-5 py-3 text-[12.5px] ${row.read ? 'text-steel' : 'text-ink'}`}>
                  {href ? (
                    <Link href={href} className="min-w-0 truncate hover:text-brandink">
                      {!row.read ? <span className="mr-2 inline-block size-1.5 rounded-full bg-brand align-middle" /> : null}
                      {line}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate">{line}</span>
                  )}
                  <span className="shrink-0 text-[11px] text-muted">{date.format(row.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
