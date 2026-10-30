import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { CopyButton } from '@/components/dashboard/copy-button';
import { ArrowUpRightIcon, BotIcon, LockIcon, SparklesIcon } from '@/components/ui/icons';
import { formatUsd } from '@/components/creator/format';
import { channelBySlug, channelStream, recordChannelVisit, type ChannelView } from '@/lib/application/channels';
import { channelCommerce, mySubscriptions } from '@/lib/application/channels/subscriptions';
import { readerTwinAnswers } from '@/lib/application/questions';
import { askAuthorAction, askTwinAction, subscribeAction } from './actions';
import { optionalSession } from '@/lib/http/session';
import { anonymousVisitorKey } from '@/lib/http/visitor';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { publicUrl } from '@/lib/site/origin';

type Props = { params: Promise<{ slug: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

/* One read per request for the metadata and the page. */
/** Articles, episodes and Q&As have their own reading page, which shows a paid one's summary to anyone. */
const EDITORIAL = new Set<string>(['post', 'audio', 'qa']);

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
 * one its title, summary and date only -- unless the viewer subscribes.
 * Beside the stream: the subscription plans, the AI twin (signed-in readers,
 * 1 Call each, always labelled as the twin), and "ask the author"
 * (agent-first-proposal.md 6.3, 6.7, 6.9).
 *
 * Private and suspended channels answer like missing ones to everyone but
 * their owner, who sees them with a notice -- and they have no card.
 * A reader's visit counts toward the directory's activity term, once a day;
 * the owner's never does.
 */
export default async function ChannelPage({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>)]);
  const [channel, { locale, t }, session] = await Promise.all([channelFor(slug), translations(), optionalSession()]);
  if (!channel) notFound();
  const c = t.channels;
  const p = c.page;
  const k = t.creator;
  const errors = k.errors as Record<string, string>;
  const viewerWorkspaceId = session?.workspace.id ?? null;
  const [stream, commerce, mine, twinAnswers] = await Promise.all([
    channelStream(channel, 100, { workspaceId: viewerWorkspaceId }),
    channelCommerce(channel.id),
    session ? mySubscriptions(session.user.id).then((rows) => rows.find((row) => row.channel.id === channel.id && row.grantsAccess) ?? null) : null,
    readerTwinAnswers(session?.user.id ?? null, channel.id),
  ]);
  const flag = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : null);
  const subscribeError = flag('subscribe');
  const twinError = flag('twinError');
  const asked = flag('asked');
  const shownTwin = flag('twin');
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
                    {(item.sight === 'full' || EDITORIAL.has(item.kind)) && item.live ? (
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
          {channel.isPublic && channel.workspaceId && (commerce.subscriptionsEnabled || channel.viewerIsOwner) ? (
            <section id="subscribe" className="flex flex-col gap-3 rounded-lg border border-line bg-card p-5">
              <h2 className="text-[15px] font-medium text-ink">{k.subscribe.title}</h2>
              <p className="text-[12.5px] leading-[1.6] text-muted">{k.subscribe.body}</p>
              {subscribeError ? <p role="alert" className="text-[12px] text-rose">{errors[subscribeError] ?? errors.unavailable}</p> : null}
              {channel.viewerIsOwner ? (
                <p className="text-[12px] text-steel">{k.subscribe.own}</p>
              ) : mine ? (
                <p className="text-[12.5px] text-brandink">
                  {fill(mine.cancelAtPeriodEnd ? k.subscribe.canceling : k.subscribe.subscribed, { date: date.format(mine.currentPeriodEnd) })}{' '}
                  <Link href="/dashboard/subscriptions" className="underline">
                    {k.subscribe.manage}
                  </Link>
                </p>
              ) : commerce.plans.length === 0 ? (
                <p className="text-[12px] text-muted">{k.subscribe.none}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {commerce.plans.map((plan) => (
                    <li key={plan.id}>
                      {session ? (
                        <form action={subscribeAction} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
                          <input type="hidden" name="slug" value={channel.slug} />
                          <input type="hidden" name="channelId" value={channel.id} />
                          <input type="hidden" name="interval" value={plan.interval} />
                          <span className="text-[13px] text-ink">
                            {fill(plan.interval === 'month' ? k.subscribe.month : k.subscribe.year, { price: formatUsd(plan.priceMinor, locale) })}
                          </span>
                          <button type="submit" className="inline-flex h-8 items-center rounded-md bg-brand px-3 text-[12px] font-medium text-onbrand hover:bg-brand/90">
                            {k.subscribe.button}
                          </button>
                        </form>
                      ) : (
                        <Link href={`/login?returnTo=${encodeURIComponent(`/channels/${channel.slug}`)}`} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-[13px] text-ink hover:bg-subtle">
                          {fill(plan.interval === 'month' ? k.subscribe.month : k.subscribe.year, { price: formatUsd(plan.priceMinor, locale) })}
                          <span className="text-[12px] text-brandink">{k.subscribe.signIn}</span>
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] leading-[1.5] text-muted">{k.subscribe.seller}</p>
            </section>
          ) : null}

          {channel.isPublic ? (
            <section id="twin" className="flex flex-col gap-3 rounded-lg border border-line bg-card p-5">
              <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
                <SparklesIcon size={15} className="text-brandink" />
                {k.twin.title}
              </h2>
              <p className="text-[12px] leading-[1.6] text-muted">{k.twin.label}</p>
              {session ? (
                <form action={askTwinAction} className="flex flex-col gap-2">
                  <input type="hidden" name="slug" value={channel.slug} />
                  <input type="hidden" name="channelId" value={channel.id} />
                  <textarea name="question" required maxLength={2000} rows={3} placeholder={k.twin.placeholder} className="w-full rounded-md border border-line bg-field px-3 py-2 text-[13px] text-ink" />
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted">{k.twin.cost}</span>
                    <button type="submit" className="inline-flex h-8 items-center rounded-md bg-brand px-3 text-[12px] font-medium text-onbrand hover:bg-brand/90">
                      {k.twin.button}
                    </button>
                  </span>
                </form>
              ) : (
                <Link href={`/login?returnTo=${encodeURIComponent(`/channels/${channel.slug}`)}`} className="text-[12.5px] text-brandink hover:underline">
                  {k.twin.signIn}
                </Link>
              )}
              {twinError ? <p role="alert" className="text-[12px] text-rose">{errors[twinError] ?? errors.unavailable}</p> : null}
              {twinAnswers.length > 0 ? (
                <ul className="flex flex-col gap-3 border-t border-line pt-3">
                  {twinAnswers.map((answer) => (
                    <li key={answer.id} className={`flex flex-col gap-1.5 ${answer.id === shownTwin ? '' : 'opacity-80'}`}>
                      <p className="text-[12.5px] font-medium text-ink">{answer.question}</p>
                      {answer.outcome === 'no_context' ? (
                        <p className="text-[12px] text-muted">{k.twin.noContext}</p>
                      ) : answer.outcome === 'degraded' ? (
                        <p className="text-[12px] text-muted">{k.twin.degraded}</p>
                      ) : (
                        <ul className="flex flex-col gap-1 text-[12.5px] leading-[1.6] text-steel">
                          {answer.claims.map((claim, at) => (
                            <li key={at}>{claim.claim}</li>
                          ))}
                        </ul>
                      )}
                      {answer.versions.length > 0 ? (
                        <p className="flex flex-wrap gap-2 text-[11px] text-muted">
                          <span>{k.twin.sources}:</span>
                          {answer.versions.slice(0, 3).map((version) => (
                            <Link key={version.versionId} href={`/assets${version.publicId}`} className="text-brandink hover:underline">
                              {version.title} · {version.label}
                            </Link>
                          ))}
                        </p>
                      ) : null}
                      {answer.endorsement ? (
                        <p className="text-[11px] font-medium text-brandink">
                          {fill(answer.endorsement.superseded ? k.twin.endorsedOld : k.twin.endorsed, { label: answer.endorsement.versionLabel ?? '' })}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {channel.isPublic && channel.workspaceId && !channel.viewerIsOwner ? (
            <section id="ask-author" className="flex flex-col gap-3 rounded-lg border border-line bg-card p-5">
              <h2 className="text-[15px] font-medium text-ink">{k.askAuthor.title}</h2>
              <p className="text-[12px] leading-[1.6] text-muted">{k.askAuthor.body}</p>
              {asked ? (
                <p role="status" className={`text-[12px] ${asked === 'done' ? 'text-brandink' : 'text-rose'}`}>
                  {asked === 'done' ? k.askAuthor.done : (errors[asked] ?? errors.unavailable)}
                </p>
              ) : null}
              {session ? (
                <form action={askAuthorAction} className="flex flex-col gap-2">
                  <input type="hidden" name="slug" value={channel.slug} />
                  <input type="hidden" name="channelId" value={channel.id} />
                  <textarea name="question" required maxLength={2000} rows={3} placeholder={k.askAuthor.placeholder} className="w-full rounded-md border border-line bg-field px-3 py-2 text-[13px] text-ink" />
                  <label className="flex items-center gap-2 text-[11.5px] text-steel">
                    <input type="checkbox" name="nameConsent" value="yes" />
                    {k.askAuthor.consent}
                  </label>
                  <button type="submit" className="inline-flex h-8 w-fit items-center rounded-md border border-line bg-card px-3 text-[12px] font-medium text-steel hover:bg-subtle">
                    {k.askAuthor.button}
                  </button>
                </form>
              ) : (
                <Link href={`/login?returnTo=${encodeURIComponent(`/channels/${channel.slug}`)}`} className="text-[12.5px] text-brandink hover:underline">
                  {k.askAuthor.signIn}
                </Link>
              )}
            </section>
          ) : null}
          <p className="text-[11px] text-muted">{fill(c.assetCount, { count: String(stream.filter((item) => item.live).length) })}</p>
        </aside>
      </div>
    </div>
  );
}
