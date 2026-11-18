import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { absoluteUrl, localeUrl, oneLine, SITE_NAME, UNLISTED_ROBOTS } from '@/lib/seo';
import { localeAlternates } from '@/i18n/paths';
import { getPost, postMeta } from '@/lib/services/posts';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { PostDetail } from '@/components/posts/post-detail';
import { ReeAvatar } from '@/components/ui/ree-avatar';

type Props = { params: Promise<{ id: string }> };

/**
 * Per-language URLs like a public Ree's (`/zh/p/…`, `/en/p/…`: the page's
 * own words follow the reader, the post keeps its own); indexed only once it
 * is published and a Ree answered it (P11), so an empty or pending post
 * never lands in search results.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ id }, { locale }] = await Promise.all([params, serverMessages()]);
  const meta = await postMeta(id);
  if (!meta) return { title: { absolute: SITE_NAME }, robots: UNLISTED_ROBOTS };
  const path = `/p/${id}`;
  const url = localeUrl(locale, path);
  const title = oneLine(meta.question, 70);
  const description = oneLine(meta.detail || meta.question, 160);
  return {
    title,
    description,
    alternates: { canonical: url, languages: localeAlternates(path, absoluteUrl) },
    openGraph: { type: 'article', siteName: SITE_NAME, url, title, description },
    twitter: { card: 'summary', title, description },
    ...(meta.answered > 0 ? {} : { robots: UNLISTED_ROBOTS }),
  };
}

/** `/p/[id]` -- a post's page in the three-column frame; the right column lists the Rees that answered. */
export default async function PostPage({ params }: Props) {
  const { id } = await params;
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const post = await getPost(id, user?.id);
  if (!post) notFound();
  const p = t.posts.page;
  const answered = post.answers.filter((entry) => entry.state === 'answered');
  const rail = (
    <div className="discovery-page">
      <section className="rail-card">
        <h3>{p.railTitle}</h3>
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
    </div>
  );
  return (
    <FeedColumns title={p.back} back="/" rail={rail}>
      <PostDetail initial={post} signedIn={Boolean(user)} now={Date.now()} loginHref={`/login?returnTo=${encodeURIComponent(`/p/${id}`)}`} />
    </FeedColumns>
  );
}
