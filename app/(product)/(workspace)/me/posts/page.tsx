import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { listMyPosts, myPostCounts } from '@/lib/services/posts';
import { myPrivateReeOptions } from '@/lib/services/private-posts';
import { MyPostsFilter, MyPostsTabs, parseMineFilter, type MyPostsTab } from '@/components/posts/my-posts-tabs';
import { PostFeed } from '@/components/posts/post-feed';
import { Icon } from '@/components/ui/icons';
import '@/components/posts/posts.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.common.nav.myPosts };
}

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

/**
 * `/me/posts` -- 我的帖子 (design 稿 2), four tabs of post cards, paged:
 * - 全部 (the bare path, or `?tab=all`): public posts and private questions
 *   together, newest first, private ones marked;
 * - 公开 (`?tab=public`): public posts, any state;
 * - 私密 (`?tab=private`): private questions, pinned first, archived ones
 *   left out unless the 筛选 asks for them (`q`, `ree`, `days`, `pinned`,
 *   `archived` in the address);
 * - 回收站 (`?tab=trash`, or the old `?view=trash`): trashed posts of both kinds.
 * Old private-list addresses (`/chats?…`, the sidebar's search) land on 私密.
 */
export default async function MyPostsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const requested = one(params.tab);
  const tab: MyPostsTab =
    requested === 'all' || requested === 'public' || requested === 'trash' || requested === 'private'
      ? requested
      : one(params.view) === 'trash'
        ? 'trash'
        : ['q', 'ree', 'days', 'pinned', 'archived', 'view', 'select', 'focus'].some((key) => params[key] !== undefined)
          ? 'private'
          : 'all';
  const m = t.posts.mine;
  const now = Date.now();
  const { filter, query } = tab === 'private' ? parseMineFilter(params, now) : { filter: {}, query: {} as Record<string, string> };
  const filtered = Object.keys(query).length > 0;
  const page = Math.max(1, Number(one(params.page)) || 1);
  const [counts, list, rees] = await Promise.all([
    myPostCounts(user!.id),
    listMyPosts(user!.id, tab, page, undefined, filter),
    tab === 'private' ? myPrivateReeOptions(user!.id) : Promise.resolve([]),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / list.size));
  const pageHref = (target: number) => `/me/posts?${new URLSearchParams({ tab, ...query, page: String(target) })}`;
  const empty = tab === 'trash' ? m.emptyTrash : tab === 'public' ? m.emptyPublic : tab === 'private' ? (filtered ? m.emptyFiltered : m.emptyPrivate) : m.emptyAll;
  return (
    <>
      <Topbar crumbs={[{ label: t.common.nav.myPosts }]} />
      <div className="my-posts">
        <div className="my-posts-bar">
          <MyPostsTabs t={t} locale={locale} tab={tab} counts={counts} />
          {tab === 'private' && <MyPostsFilter t={t} query={query} rees={rees} />}
        </div>
        {tab === 'private' && (
          <p className="private-list-note">
            <Icon name="lock" className="" />
            {m.privateListNote}
          </p>
        )}
        <PostFeed key={`${tab}:${list.page}:${JSON.stringify(query)}`} tab="latest" initial={{ items: list.items, next: null }} now={now} signedIn empty={<p className="py-10 text-center text-[13px] text-muted">{empty}</p>} />
        {pages > 1 && (
          <nav className="mt-6 flex items-center justify-center gap-3 text-[12px]" aria-label={t.common.nav.myPosts}>
            {list.page > 1 && <Link href={pageHref(list.page - 1)} className="btn-secondary btn-sm">←</Link>}
            <span className="text-muted">{list.page} / {pages}</span>
            {list.page < pages && <Link href={pageHref(list.page + 1)} className="btn-secondary btn-sm">→</Link>}
          </nav>
        )}
      </div>
    </>
  );
}
