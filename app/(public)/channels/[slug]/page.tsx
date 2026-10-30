import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { CopyButton } from '@/components/dashboard/copy-button';
import { ArrowUpRightIcon, BotIcon, LockIcon, SparklesIcon } from '@/components/ui/icons';
import { channelBySlug, channelStream, recordChannelVisit, type ChannelView } from '@/lib/application/channels';
import { optionalSession } from '@/lib/http/session';
import { anonymousVisitorKey } from '@/lib/http/visitor';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { publicUrl } from '@/lib/site/origin';

type Props = { params: Promise<{ slug: string }> };

/* One read per request for the metadata and the page. */
const channelFor = cache(async (slug: string): Promise<ChannelView | null> => {
  const session = await optionalSession();
  return channelBySlug(slug, session?.workspace.id ?? null);
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const [channel, { channels: c }] = await Promise.all([channelFor(slug), getMessages()]);
  if (!channel) return { title: c.page.breadcrumb };
  const canonical = `/channels/${channel.slug}`;
  return {
    title: channel.title,
    description: channel.description ?? c.metaDescription,
    alternates: { canonical },
    openGraph: { url: canonical },
    /* A private or suspended channel is its owner's view only; nothing to index. */
    ...(channel.isPublic ? {} : { robots: { index: false, follow: false } }),
  };
}

/**
 * A channel's page (agent-first-proposal.md 6.3): its introduction, the
 * asset stream (pinned first, newest first), and the channel Agent Card's
 * address. A free asset shows its source, version and last update; a paid
 * one its title, summary and date only. The AI twin's question box is P2.
 *
 * Private and suspended channels answer like missing ones to everyone but
 * their owner, who sees them with a notice -- and they have no card.
 * A reader's visit counts toward the directory's activity term, once a day;
 * the owner's never does.
 */
export default async function ChannelPage({ params }: Props) {
  const { slug } = await params;
  const [channel, { locale, t }, session] = await Promise.all([channelFor(slug), translations(), optionalSession()]);
  if (!channel) notFound();
  const c = t.channels;
  const p = c.page;
  const stream = await channelStream(channel);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const cardUrl = publicUrl(`/a2a/channels/${channel.slug}/agent-card.json`);

  if (channel.isPublic && !channel.viewerIsOwner) {
    const visitor = session
      ? ({ kind: 'user', userId: session.user.id, workspaceId: session.workspace.id } as const)
      : await anonymousVisitorKey(await headers()).then((key) => (key ? ({ kind: 'anonymous', key } as const) : null));
    if (visitor) await recordChannelVisit({ id: channel.id, workspaceId: channel.workspaceId }, visitor);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-5 pt-12 pb-20">
      {/* Discoverable by agents reading the page (proposal 7.1); React hoists it into <head>. */}
      {channel.isPublic ? <link rel="agent-card" href={cardUrl} type="application/json" /> : null}

      <nav className="text-caption text-muted">
        <Link href="/channels" className="hover:text-ink">
          {p.breadcrumb}
        </Link>
        <span className="px-1.5">/</span>
        <span className="text-ink">{channel.title}</span>
      </nav>

      {channel.viewerIsOwner && !channel.isPublic ? (
        <p className="flex items-center gap-2 rounded-md border border-line bg-subtle px-4 py-3 text-caption text-steel">
          <LockIcon size={15} />
          {channel.status === 'suspended' ? p.suspendedNotice : p.privateNotice}
        </p>
      ) : null}

      <header className="flex flex-col gap-3">
        <h1 className="text-[36px] leading-[1.25] font-semibold tracking-[0.018em] text-ink">{channel.title}</h1>
        <p className="text-caption text-muted">
          {p.by}{' '}
          {channel.owner.isPlatform ? (
            c.byPlatform
          ) : channel.owner.handle ? (
            <Link href={`/u/${channel.owner.handle}`} className="text-brandink hover:underline">
              @{channel.owner.handle}
            </Link>
          ) : (
            channel.owner.name
          )}
          {channel.viewerIsOwner && channel.workspaceId ? (
            <>
              {' · '}
              <Link href={`/dashboard/channels/${channel.id}`} className="text-brandink hover:underline">
                {p.manage}
              </Link>
            </>
          ) : null}
        </p>
        {channel.description ? <p className="max-w-[72ch] text-body text-steel">{channel.description}</p> : null}
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="flex flex-col gap-3">
          <h2 className="text-[17px] font-medium text-ink">{p.stream}</h2>
          {stream.length === 0 ? (
            <p className="rounded-md border border-dashed border-line px-5 py-10 text-center text-caption text-muted">{p.empty}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-card">
              {stream.map((item) => (
                <li key={item.assetId} className="flex flex-col gap-1.5 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {item.sight === 'full' && item.live ? (
                      <Link href={`/assets${item.publicId}`} className="text-[15px] font-medium text-ink hover:text-brandink">
                        {item.title}
                      </Link>
                    ) : (
                      <span className="text-[15px] font-medium text-ink">{item.title}</span>
                    )}
                    <span className="rounded-full bg-mutedbg px-2 py-0.5 text-[11px] text-steel">
                      {(c.kinds as Record<string, string>)[item.kind] ?? item.kind}
                    </span>
                    {item.pinned ? (
                      <span className="rounded-full bg-brandsoft px-2 py-0.5 text-[11px] text-brandink">{p.pinned}</span>
                    ) : null}
                    {item.access === 'paid' ? (
                      <span className="flex items-center gap-1 rounded-full bg-privsoft px-2 py-0.5 text-[11px] text-privink">
                        <LockIcon size={11} />
                        {p.paid}
                      </span>
                    ) : null}
                    {channel.viewerIsOwner && !item.live ? (
                      <span className="text-[11px] text-muted">{p.notLive}</span>
                    ) : null}
                  </div>
                  {item.description ? <p className="text-[13px] leading-[1.6] text-steel">{item.description}</p> : null}
                  {item.sight === 'summary' ? <p className="text-[12px] text-muted">{p.paidNote}</p> : null}
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
                    <span className="font-mono">{item.publicId}</span>
                    {item.sourceLocation ? (
                      <span className="max-w-full truncate">
                        {p.source}: {item.sourceLocation}
                      </span>
                    ) : null}
                    {item.versionLabel ? (
                      <span>
                        {p.version}: {item.versionLabel}
                      </span>
                    ) : null}
                    {item.lastRefreshedAt && item.sight === 'full' ? (
                      <span>
                        {p.updated}: {date.format(new Date(item.lastRefreshedAt))}
                      </span>
                    ) : (
                      <span>
                        {p.published}: {date.format(new Date(item.publishedAt))}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          {channel.isPublic ? (
            <section className="flex flex-col gap-3 rounded-lg border border-line bg-card p-5">
              <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
                <BotIcon size={16} className="text-brandink" />
                {p.agentTitle}
              </h2>
              <p className="text-[12.5px] leading-[1.6] text-muted">{p.agentBody}</p>
              <span className="flex items-center gap-2 rounded-md border border-line bg-subtle py-1 pr-1 pl-3">
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{cardUrl}</code>
                <CopyButton value={cardUrl} label={p.agentCard} className="text-steel hover:bg-card" />
              </span>
              <Link
                href={`/a2a/channels/${channel.slug}/agent-card.json`}
                className="inline-flex items-center gap-1.5 text-[12px] text-brandink hover:underline"
              >
                {p.agentCard}
                <ArrowUpRightIcon size={13} />
              </Link>
            </section>
          ) : null}
          <p className="flex items-start gap-2 rounded-lg border border-dashed border-line px-4 py-3 text-[12px] leading-[1.6] text-muted">
            <SparklesIcon size={14} className="mt-[3px] shrink-0 text-brandink" />
            {p.askSoon}
          </p>
          <p className="text-[11px] text-muted">{fill(c.assetCount, { count: String(stream.filter((item) => item.live).length) })}</p>
        </aside>
      </div>
    </div>
  );
}
