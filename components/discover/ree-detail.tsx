import { notFound } from 'next/navigation';
import { listReeComments } from '@/lib/services/ree-comments';
import { reeAnsweredPosts } from '@/lib/services/posts';
import { favoriteReeIds } from '@/lib/services/ree-favorites';
import { introsFor } from '@/lib/services/video';
import { authorOthers, relatedFor, type PublicRee } from '@/lib/services/public-rees';
import { ReeDetailView } from '@/components/discover/ree-detail-view';

type Search = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** The public Ree layout is also used for the owner's read-only preview. */
export async function ReeDetail({ ree, query = {}, viewerId, preview = false, draftId }: {
  ree: PublicRee;
  query?: Search;
  viewerId?: string;
  preview?: boolean;
  draftId?: string;
}) {
  const authorPage = Number(one(query.ap)) || 1;
  const [related, author, intros, comments, posts] = await Promise.all([
    preview ? null : relatedFor(ree, 1),
    preview ? null : authorOthers(ree, authorPage),
    introsFor([ree.id]),
    preview ? null : listReeComments(ree.id, undefined, viewerId),
    preview ? null : reeAnsweredPosts(ree.id, { viewerId }),
  ]);
  if (!preview && !comments) notFound();
  const favoriteIds = viewerId && related && author
    ? await favoriteReeIds(viewerId, [ree.id, ...related.items.map(item => item.id), ...author.items.map(item => item.id)])
    : undefined;
  const video = intros.get(ree.id) ?? null;
  return (
    <ReeDetailView
      key={draftId}
      savedRee={ree}
      query={query}
      viewerId={viewerId}
      preview={preview}
      draftId={draftId}
      related={related}
      author={author}
      video={video}
      comments={comments}
      posts={posts}
      favoriteIds={favoriteIds}
      renderedAt={Date.now()}
    />
  );
}
