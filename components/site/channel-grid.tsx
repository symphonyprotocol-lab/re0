import Link from 'next/link';
import { BadgeCheckIcon, DatabaseIcon } from '@/components/ui/icons';
import type { DirectoryEntry } from '@/lib/application/channels';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';

/**
 * Public channels as cards: the directory, the home page's block and a
 * user's page all draw them the same way (agent-first-proposal.md 6.4). What
 * a card says is what the directory knows -- title, owner, summary, what
 * kinds of assets it holds, how many, when it last moved -- and never a
 * subscriber count or revenue, which are not ranking inputs either.
 */
export async function ChannelGrid({ entries, locale }: { entries: DirectoryEntry[]; locale: string }) {
  const c = (await getMessages()).channels;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((entry) => (
        <li key={entry.id}>
          <Link
            href={`/channels/${entry.slug}`}
            className="flex h-full flex-col gap-3 rounded-lg border border-line bg-card p-5 transition-colors hover:border-brandline hover:bg-subtle/60"
          >
            <span className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-brandline bg-brandsoft text-brandink">
                {entry.owner.isPlatform ? <BadgeCheckIcon size={17} /> : <DatabaseIcon size={17} />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[15px] font-medium text-ink">{entry.title}</span>
                <span className="truncate text-[12px] text-muted">
                  {entry.owner.isPlatform ? c.byPlatform : entry.owner.handle ? `@${entry.owner.handle}` : entry.owner.name}
                </span>
              </span>
            </span>
            {entry.description ? (
              <span className="line-clamp-3 text-[13px] leading-[1.6] text-steel">{entry.description}</span>
            ) : null}
            <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              {entry.kinds.map((kind) => (
                <span key={kind} className="rounded-full bg-mutedbg px-2 py-0.5 text-[11px] text-steel">
                  {(c.kinds as Record<string, string>)[kind] ?? kind}
                </span>
              ))}
            </span>
            <span className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[11px] text-muted">
              <span>{fill(c.assetCount, { count: String(entry.assetCount) })}</span>
              {entry.lastUpdatedAt ? (
                <span>{fill(c.updatedOn, { date: date.format(new Date(entry.lastUpdatedAt)) })}</span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
