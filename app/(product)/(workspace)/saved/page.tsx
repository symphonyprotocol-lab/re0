import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { reeCards } from '@/lib/services/explore';
import { listFavoriteRees } from '@/lib/services/ree-favorites';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { FeedRee } from '@/components/discover/feed-ree';
import { Icon } from '@/components/ui/icons';
import '@/components/discover/explore.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.common.nav.saved };
}

/**
 * `/saved` -- 收藏 (v5): the Rees I saved, newest first, as 首页 shows Rees.
 * The same list as 我的 Ree's 收藏 tab, which stays. Saved posts join it
 * once there are posts.
 */
export default async function SavedPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const [user, { t }, query] = await Promise.all([currentUser(), serverMessages(), searchParams]);
  const list = await listFavoriteRees(user!.id, Number(query.page) || 1);
  const cards = await reeCards(list.items.map((item) => item.id), new Map(), { includeIntros: true });
  const pages = Math.max(1, Math.ceil(list.total / list.size));
  const renderedAt = Date.now();
  return (
    <FeedColumns title={t.common.nav.saved}>
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
