import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { Messages } from '@/i18n';
import { formatNumber } from '@/i18n/format';

export type MyPostsTab = 'all' | 'public' | 'private' | 'trash';

/** 我的帖子's tabs (v5): 全部 (the bare `/me/posts`) / 公开 / 私密 / 回收站. 私密 is the conversation search, at `?tab=private`. */
export function MyPostsTabs({ t, locale, tab, counts }: { t: Messages; locale: 'zh' | 'en'; tab: MyPostsTab; counts: { public: number; trash: number } }) {
  const m = t.posts.mine;
  const tabs: [MyPostsTab, string, string, number | null][] = [
    ['all', m.all, '/me/posts?tab=all', null],
    ['public', m.public, '/me/posts?tab=public', counts.public],
    ['private', m.private, '/me/posts?tab=private', null],
    ['trash', m.trash, '/me/posts?tab=trash', counts.trash || null],
  ];
  return (
    <div className="cl-tabs my-posts-tabs" role="tablist" aria-label={t.common.nav.myPosts}>
      {tabs.map(([key, label, href, count]) => (
        <Link key={key} href={href} role="tab" aria-selected={tab === key} className={`cl-tab${tab === key ? ' active' : ''}`} scroll={false}>
          {label}
          {count !== null && <span>{formatNumber(count, locale)}</span>}
        </Link>
      ))}
    </div>
  );
}
