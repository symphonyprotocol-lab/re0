import type { Metadata } from 'next';
import { parseConversationQuery } from '@/lib/domain/conversation';
import { currentUser } from '@/lib/http/session';
import { conversationPosition, conversationReeOptions, listConversations } from '@/lib/services/conversations';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { ConversationSearch } from '@/components/conversations/conversation-search';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { formatRelative } from '@/i18n/format';
import { listMyPosts, myPostCounts } from '@/lib/services/posts';
import { MyPostsTabs, type MyPostsTab } from '@/components/posts/my-posts-tabs';
import { PostFeed } from '@/components/posts/post-feed';
import '@/components/conversations/conversations.css';
import '@/components/posts/posts.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.common.nav.myPosts };
}

/**
 * `/me/posts` -- 我的帖子 (v5; `/chats` until then), four tabs:
 * - 全部 (`?tab=all`, the navigation's link): my latest public posts and
 *   private questions together, newest first;
 * - 公开 (`?tab=public`): my public posts, any state;
 * - 私密 (the bare path): my private questions -- every conversation --
 *   searched and filtered, the URL holding the filters, paged on the server
 *   (prototype conversations.js). ⌘K opens it. `?select=<id>` (the sidebar's
 *   "选择此对话") opens the tab and page holding that conversation,
 *   unfiltered, with it selected;
 * - 回收站 (`?tab=trash`): my trashed public posts; trashed private
 *   questions stay in the 私密 tab's own trash view.
 */
export default async function MyPostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const tab: MyPostsTab = params.tab === 'all' || params.tab === 'public' || params.tab === 'trash' ? params.tab : 'private';
  const counts = await myPostCounts(user!.id);
  const m = t.posts.mine;
  const now = Date.now();
  if (tab === 'public' || tab === 'trash') {
    const page = Math.max(1, Number(params.page) || 1);
    const list = await listMyPosts(user!.id, tab, page);
    const pages = Math.max(1, Math.ceil(list.total / list.size));
    return (
      <>
        <Topbar crumbs={[{ label: t.common.nav.myPosts }]} />
        <div className="my-posts">
          <MyPostsTabs t={t} locale={locale} tab={tab} counts={counts} />
          <PostFeed key={`${tab}:${list.page}`} tab="latest" initial={{ items: list.items, next: null }} now={now} signedIn empty={<p className="py-10 text-center text-[13px] text-muted">{tab === 'trash' ? m.emptyTrash : m.emptyPublic}</p>} />
          {pages > 1 && (
            <nav className="mt-6 flex items-center justify-center gap-3 text-[12px]" aria-label={t.common.nav.myPosts}>
              {list.page > 1 && <Link href={`/me/posts?tab=${tab}&page=${list.page - 1}`} className="btn-secondary btn-sm">←</Link>}
              <span className="text-muted">{list.page} / {pages}</span>
              {list.page < pages && <Link href={`/me/posts?tab=${tab}&page=${list.page + 1}`} className="btn-secondary btn-sm">→</Link>}
            </nav>
          )}
          {tab === 'trash' && (
            <p className="mt-6 text-center text-[12px]">
              <Link href="/me/posts?view=trash" className="text-link">{m.privateTrash} →</Link>
            </p>
          )}
        </div>
      </>
    );
  }
  if (tab === 'all') {
    const [mine, conversations] = await Promise.all([listMyPosts(user!.id, 'public', 1, 20), listConversations(user!.id, parseConversationQuery({ size: '20' }))]);
    const rows = [
      ...mine.items.map((post) => ({ key: `p:${post.id}`, href: `/p/${post.id}`, title: post.question, at: post.createdAt, public: true, line: post.status === 'published' ? `${post.answered}` : null })),
      ...conversations.items.filter((item) => !item.deletedAt).map((item) => ({ key: `c:${item.id}`, href: `/chats/${item.id}`, title: item.title || t.conversations.sidebar.untitled, at: item.updatedAt.toISOString(), public: false, line: item.participants.map((ree) => ree.name).join('、') })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 30);
    return (
      <>
        <Topbar crumbs={[{ label: t.common.nav.myPosts }]} />
        <div className="my-posts">
          <MyPostsTabs t={t} locale={locale} tab="all" counts={counts} />
          <p className="mb-3 text-[12px] text-muted">{m.privateNote}</p>
          <ul className="my-posts-list">
            {rows.map((row) => (
              <li key={row.key}>
                <Link href={row.href}>
                  <span className={`tag${row.public ? ' is-public' : ''}`}>{row.public ? m.publicTag : m.privateTag}</span>
                  <span className="min-w-0 flex-1">
                    <strong>{row.title}</strong>
                    <small>
                      {formatRelative(row.at, now, locale, t.discover.public.qa.justNow)}
                      {row.line ? ` · ${row.public ? `${row.line} ${t.posts.card.answers}` : row.line}` : ''}
                    </small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 flex justify-center gap-6 text-[12px]">
            <Link href="/me/posts?tab=public" className="text-link">{m.morePublic} →</Link>
            <Link href="/me/posts" className="text-link">{m.morePrivate} →</Link>
          </p>
        </div>
      </>
    );
  }
  const parsed = parseConversationQuery(params);
  const selectId = typeof params.select === 'string' ? params.select : null;
  const position = selectId ? await conversationPosition(user!.id, selectId, parsed.size) : null;
  const query = position ? { ...parseConversationQuery({ size: String(parsed.size) }), ...position } : parsed;
  const [result, rees] = await Promise.all([listConversations(user!.id, query), conversationReeOptions(user!.id)]);
  return (
    <>
      <Topbar crumbs={[{ label: t.common.nav.myPosts }]} />
      <div className="my-posts is-head">
        <MyPostsTabs t={t} locale={locale} tab="private" counts={counts} />
      </div>
      <ConversationSearch
        query={query}
        result={{ ...result, items: result.items.map((item) => ({ ...item, archivedAt: item.archivedAt?.toISOString() ?? null, deletedAt: item.deletedAt?.toISOString() ?? null, updatedAt: item.updatedAt.toISOString() })) }}
        rees={rees}
        focus={params.focus === '1'}
        select={position ? selectId : null}
      />
    </>
  );
}
