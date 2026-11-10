import { notFound } from 'next/navigation';
import { joinableConversations } from '@/lib/services/conversations';
import { listReeComments } from '@/lib/services/ree-comments';
import { favoriteReeIds } from '@/lib/services/ree-favorites';
import { introsFor } from '@/lib/services/video';
import { exploreReturnPath } from '@/lib/domain/explore';
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
  const from = exploreReturnPath(one(query.from));
  const relatedPage = Number(one(query.rp)) || 1;
  const authorPage = Number(one(query.ap)) || 1;
  const [related, author, conversations, intros, comments] = await Promise.all([
    preview ? null : relatedFor(ree, relatedPage),
    preview ? null : authorOthers(ree, authorPage),
    !preview && viewerId ? joinableConversations(viewerId, ree.id) : [],
    introsFor([ree.id]),
    preview ? null : listReeComments(ree.id, undefined, viewerId),
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
      from={from}
      related={related}
      author={author}
      conversations={conversations}
      video={video}
      comments={comments}
      favoriteIds={favoriteIds}
      renderedAt={Date.now()}
    />
  );
}
