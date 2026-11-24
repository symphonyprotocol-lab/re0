import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { getChannel } from '@/lib/services/channels';
import { competitionOfChannel } from '@/lib/services/competitions';
import { listFeed } from '@/lib/services/posts';
import { channelHref } from '@/lib/domain/hashtags';
import { publicPage, SITE_NAME, UNLISTED_ROBOTS } from '@/lib/seo';
import { localizeHref } from '@/i18n/paths';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { PostFeed } from '@/components/posts/post-feed';
import { Icon } from '@/components/ui/icons';
import '@/components/posts/posts.css';

type Props = { params: Promise<{ name: string }> };

/** The `[name]` segment as written: Next hands it over still percent-encoded in some versions; a malformed one is no name. */
function nameOf(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * Per-language URLs like a post's (`/zh/c/…`, `/en/c/…`). A channel with no
 * visible post (every post in it pending, rejected or taken down) is a real
 * page but not indexed, and not in the sitemap (lib/sitemaps.ts).
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ name }, { t, locale }] = await Promise.all([params, serverMessages()]);
  const channel = await getChannel(nameOf(name));
  if (!channel) return { title: { absolute: SITE_NAME }, robots: UNLISTED_ROBOTS };
  const c = t.posts.channels;
  const page = publicPage({ path: channelHref(channel.name), title: fill(c.title, { name: channel.name }), description: fill(c.description, { name: channel.name }), locale });
  return channel.posts > 0 ? page : { ...page, robots: UNLISTED_ROBOTS };
}

/**
 * `/c/[name]` -- one channel (`#name`): every visible post tagged with it,
 * newest first, in the post feed (`/api/posts?channel=`), and the way to
 * post in it (the composer, `#name` written in). A name nobody has used is
 * a real 404; one written another way (`/c/Travel`) goes to the one URL.
 */
export default async function ChannelPage({ params }: Props) {
  const { name } = await params;
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const written = nameOf(name);
  const channel = await getChannel(written);
  if (!channel) notFound();
  if (written !== channel.name) permanentRedirect(localizeHref(locale, channelHref(channel.name)));
  const [feed, contest] = await Promise.all([listFeed('latest', { channel: channel.name, viewerId: user?.id }), competitionOfChannel(channel.id)]);
  const c = t.posts.channels;
  const href = channelHref(channel.name);
  /* The composer over this page, the tag written in (composer.tsx `composeHref`, a client module). */
  const compose = `${href}?${new URLSearchParams({ compose: 'public', ask: `#${channel.name} ` })}`;
  const post = user ? (
    <Link href={compose} className="btn btn-sm">
      <Icon name="plus" className="size-3.5" />
      {fill(c.postHere, { name: channel.name })}
    </Link>
  ) : (
    <Link rel="nofollow" href={`/login?returnTo=${encodeURIComponent(compose)}`} className="btn btn-sm">
      {fill(c.signInToPost, { name: channel.name })}
    </Link>
  );
  const rail = (
    <div className="discovery-page">
      <section className="rail-card">
        <h3>{c.railTitle}</h3>
        <p className="text-[12px] text-muted">{fill(c.railBody, { name: channel.name })}</p>
        <p className="pt-2 text-[12px]">
          <Link href="/?tab=channels" className="text-link">
            {c.all} →
          </Link>
        </p>
      </section>
    </div>
  );
  return (
    <FeedColumns title={`#${channel.name}`} back="/?tab=channels" rail={rail}>
      {/* A competition's channel (docs/design/competitions.md C4): its state and the way to it, above the posts. */}
      {contest && (
        <div className="channel-head">
          <p>
            {fill(t.competitions.channel.banner, { title: contest.title })} · {t.competitions.status[contest.status]}
          </p>
          <Link href={`/competitions/${contest.slug}`} className="btn btn-sm">
            {t.competitions.channel.go}
          </Link>
        </div>
      )}
      <div className="channel-head">
        <p>{fill(c.count, { n: formatNumber(channel.posts, locale) })}</p>
        {post}
      </div>
      <PostFeed key={channel.name} tab="latest" channel={channel.name} initial={feed} now={Date.now()} signedIn={Boolean(user)} empty={<p className="px-[18px] py-10 text-center text-[13px] text-muted">{c.pageEmpty}</p>} />
    </FeedColumns>
  );
}
