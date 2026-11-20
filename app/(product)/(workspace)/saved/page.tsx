import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { reeCards } from '@/lib/services/explore';
import { listFavoriteRees } from '@/lib/services/ree-favorites';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { FeedRee } from '@/components/discover/feed-ree';
import { Icon } from '@/components/ui/icons';
import { listSavedPosts } from '@/lib/services/posts';
import { PostFeed } from '@/components/posts/post-feed';
import '@/components/discover/explore.css';
import '@/components/ui/tabs.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.common.nav.saved };
}

/**
 * `/saved` -- 收藏 (v5), two tabs: the Rees I saved, newest first, as 发现
 * shows Rees (the same list as 我的 Ree's 收藏 tab, which stays), and the
 * posts I saved (`?tab=posts`).
 */
export default async function SavedPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const [user, { t }, query] = await Promise.all([currentUser(), serverMessages(), searchParams]);
  const tab = query.tab === 'posts' ? 'posts' : 'rees';
  const tabs = (
    <div className="cl-tabs" role="tablist" aria-label={t.common.nav.saved}>
      {([['rees', t.posts.saved.rees, '/saved'], ['posts', t.posts.saved.posts, '/saved?tab=posts']] as const).map(([key, label, href]) => (
        <Link key={key} href={href} role="tab" aria-selected={tab === key} className={`cl-tab${tab === key ? ' active' : ''}`} scroll={false}>
          {label}
        </Link>
      ))}
    </div>
  );
  if (tab === 'posts') {
    const posts = await listSavedPosts(user!.id, Number(query.page) || 1);
    const pages = Math.max(1, Math.ceil(posts.total / posts.size));
    return (
      <FeedColumns title={t.common.nav.saved} tabs={tabs}>
        <PostFeed key={posts.page} tab="latest" initial={{ items: posts.items, next: null }} now={Date.now()} signedIn empty={<p className="px-[18px] py-10 text-center text-[13px] text-muted">{t.posts.saved.emptyPosts}</p>} />
        {pages > 1 && (
          <nav className="my-6 flex items-center justify-center gap-3 text-[12px]" aria-label={t.common.nav.saved}>
            {posts.page > 1 && <Link href={`/saved?tab=posts&page=${posts.page - 1}`} className="btn-secondary btn-sm">←</Link>}
            <span className="text-muted">{posts.page} / {pages}</span>
            {posts.page < pages && <Link href={`/saved?tab=posts&page=${posts.page + 1}`} className="btn-secondary btn-sm">→</Link>}
          </nav>
        )}
      </FeedColumns>
    );
  }
  const list = await listFavoriteRees(user!.id, Number(query.page) || 1);
  const cards = await reeCards(list.items.map((item) => item.id), new Map(), { includeIntros: true });
  const pages = Math.max(1, Math.ceil(list.total / list.size));
  const renderedAt = Date.now();
  return (
    <FeedColumns title={t.common.nav.saved} tabs={tabs}>
      <div className="discovery-page">
        {cards.length > 0 ? (
          <div className="discovery-feed">
            {cards.map((ree) => (
              <FeedRee key={ree.id} ree={ree} from="/saved" favorite viewerId={user!.id} now={renderedAt} />
            ))}
          </div>
        ) : (
          <div className="card empty mt-6">
            <Icon name="bookmark" />
            <h2>{t.rees.favorite.emptyTitle}</h2>
            <p>{t.rees.favorite.emptyBody}</p>
            <Link href="/explore" className="btn secondary">
              {t.common.nav.discover}
            </Link>
          </div>
        )}
        {pages > 1 && (
          <nav className="mt-6 flex items-center justify-center gap-3 text-[12px]" aria-label={t.common.nav.saved}>
            {list.page > 1 && <Link href={`/saved?page=${list.page - 1}`} className="btn-secondary btn-sm">←</Link>}
            <span className="text-muted">{list.page} / {pages}</span>
            {list.page < pages && <Link href={`/saved?page=${list.page + 1}`} className="btn-secondary btn-sm">→</Link>}
          </nav>
        )}
      </div>
    </FeedColumns>
  );
}
