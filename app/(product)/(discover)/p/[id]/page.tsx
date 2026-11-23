import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { getPost, listFeed, postCover } from '@/lib/services/posts';
import { postMetadata } from '@/lib/og/post-meta';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { PostDetail } from '@/components/posts/post-detail';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { Icon } from '@/components/ui/icons';
import { PostJsonLd } from '@/components/site/structured-data';

type Props = { params: Promise<{ id: string }> };

/**
 * Per-language URLs like a public Ree's (`/zh/p/…`, `/en/p/…`: the page's
 * own words follow the reader, the post keeps its own), with the post's own
 * cover as its link preview (lib/og/post-meta.ts says when).
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ id }, { locale }] = await Promise.all([params, serverMessages()]);
  return postMetadata(id, await postCover(id), locale);
}

/**
 * `/p/[id]` -- a post's page in the three-column frame; the right column
 * lists the Rees that answered. A private post (only its author gets it from
 * `getPost`) is titled 私密提问, and its right column first says what
 * private means.
 */
export default async function PostPage({ params }: Props) {
  const { id } = await params;
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const post = await getPost(id, user?.id);
  if (!post) notFound();
  /* The posts quoting this one ("引用提问"), newest first. */
  const quoting = post.quotes > 0 ? await listFeed('latest', { quotesOf: id, viewerId: user?.id }) : undefined;
  const p = t.posts.page;
  const answered = post.answers.filter((entry) => entry.state === 'answered');
  const isPrivate = post.visibility === 'private';
  const rail = (
    <div className="discovery-page">
      {isPrivate && (
        <section className="rail-card private-rail">
          <h3>
            <Icon name="lock" className="size-4" />
            {p.privateRailTitle}
          </h3>
          <ul>
            <li>{p.privateRail1}</li>
            <li>{p.privateRail2}</li>
            <li>{p.privateRail3}</li>
          </ul>
        </section>
      )}
      <section className="rail-card">
        <h3>{isPrivate ? p.privateRailRees : p.railTitle}</h3>
        {answered.length === 0 ? (
          <p className="text-[12px] text-muted">{p.railEmpty}</p>
        ) : (
          <ol>
            {answered.map((entry) => (
              <li key={entry.id}>
                <ReeAvatar avatar={entry.reeAvatar} color={entry.reeColor} size="sm" />
                <Link href={`/r/${entry.reeSlug}`} className="min-w-0">
                  <strong>{entry.reeName}</strong>
                  <small>{t.posts.card.helpful} {formatNumber(entry.helpful, locale)}</small>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
      {/* A public post no Ree answered, beside its AI answer (its author's, or anyone's once reviewed): the way to become the Ree such posts wait for. */}
      {!isPrivate && answered.length === 0 && post.aiAnswer?.state === 'answered' && (
        <section className="rail-card ai-rail">
          <h3>{t.posts.ai.railTitle}</h3>
          <p>{t.posts.ai.railBody}</p>
          <Link href="/rees/new" className="btn-secondary btn-sm">
            <Icon name="plus" className="size-3.5" />
            {t.posts.ai.railGo}
          </Link>
        </section>
      )}
    </div>
  );
  return (
    <FeedColumns title={isPrivate ? p.privateTitle : p.back} back={isPrivate ? '/me/posts?tab=private' : '/'} rail={rail}>
      <PostJsonLd post={post} />
      <PostDetail initial={post} quoting={quoting} signedIn={Boolean(user)} now={Date.now()} loginHref={`/login?returnTo=${encodeURIComponent(`/p/${id}`)}`} />
    </FeedColumns>
  );
}
