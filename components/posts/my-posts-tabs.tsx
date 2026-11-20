import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { Messages } from '@/i18n';
import { formatNumber } from '@/i18n/format';
import { isUuid } from '@/lib/domain/list';
import type { MinePostsFilter } from '@/lib/services/posts';
import { Icon } from '@/components/ui/icons';
import '@/components/ui/tabs.css';

export type MyPostsTab = 'all' | 'public' | 'private' | 'trash';

/** 我的帖子's tabs (design 稿 2): 全部 (the bare `/me/posts`) / 公开 / 私密 / 回收站, each with how many posts it holds. */
export function MyPostsTabs({ t, locale, tab, counts }: { t: Messages; locale: 'zh' | 'en'; tab: MyPostsTab; counts: { all: number; public: number; private: number; trash: number } }) {
  const m = t.posts.mine;
  const tabs: [MyPostsTab, string, string, number | null][] = [
    ['all', m.all, '/me/posts?tab=all', counts.all],
    ['public', m.public, '/me/posts?tab=public', counts.public],
    ['private', m.private, '/me/posts?tab=private', counts.private],
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

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

/** 私密's 筛选 windows (days back). */
export const MINE_FILTER_DAYS = [7, 30, 90] as const;

/**
 * 私密's 筛选 from the address (`q`, `ree`, `days`, `pinned=1`, `archived=1`):
 * the filter `listMyPosts` takes, and the parameters that keep it across pages.
 * Anything malformed is dropped.
 */
export function parseMineFilter(params: Params, now = Date.now()): { filter: MinePostsFilter; query: Record<string, string> } {
  const query: Record<string, string> = {};
  const q = one(params.q)?.trim().slice(0, 200);
  if (q) query.q = q;
  const reeId = one(params.ree);
  if (reeId && isUuid(reeId)) query.ree = reeId;
  const days = Number(one(params.days));
  if ((MINE_FILTER_DAYS as readonly number[]).includes(days)) query.days = String(days);
  if (one(params.pinned) === '1') query.pinned = '1';
  if (one(params.archived) === '1') query.archived = '1';
  return {
    filter: { q: query.q ?? null, reeId: query.ree ?? null, since: query.days ? new Date(now - Number(query.days) * 86_400_000) : null, pinned: query.pinned === '1', archived: query.archived === '1' },
    query,
  };
}

/**
 * 筛选, at the right of the tab row on 私密: a plain form in a disclosure
 * (no script), its choices in the address so a filtered list can be shared
 * with oneself and paged.
 */
export function MyPostsFilter({ t, query, rees }: { t: Messages; query: Record<string, string>; rees: { id: string; name: string }[] }) {
  const m = t.posts.mine;
  const active = Object.keys(query).length > 0;
  return (
    <details className={`my-posts-filter${active ? ' is-active' : ''}`}>
      <summary>
        <Icon name="search" className="size-3.5" />
        {m.filter}
        {active && <span aria-hidden="true">·{Object.keys(query).length}</span>}
      </summary>
      <form action="/me/posts" method="get">
        <input type="hidden" name="tab" value="private" />
        <input type="search" name="q" aria-label={m.filterQ} placeholder={m.filterQ} defaultValue={query.q ?? ''} maxLength={200} />
        <label>
          {m.filterRee}
          <select name="ree" defaultValue={query.ree ?? ''}>
            <option value="">{m.filterAnyRee}</option>
            {rees.map((ree) => (
              <option key={ree.id} value={ree.id}>{ree.name}</option>
            ))}
          </select>
        </label>
        <label>
          {m.filterSince}
          <select name="days" defaultValue={query.days ?? ''}>
            <option value="">{m.filterDays.all}</option>
            {MINE_FILTER_DAYS.map((days) => (
              <option key={days} value={String(days)}>{m.filterDays[`d${days}`]}</option>
            ))}
          </select>
        </label>
        <label className="is-check">
          <input type="checkbox" name="pinned" value="1" defaultChecked={query.pinned === '1'} />
          {m.filterPinned}
        </label>
        <label className="is-check">
          <input type="checkbox" name="archived" value="1" defaultChecked={query.archived === '1'} />
          {m.filterArchived}
        </label>
        <div className="my-posts-filter-foot">
          {active && (
            <Link href="/me/posts?tab=private" className="text-link">
              {m.filterClear}
            </Link>
          )}
          <button type="submit" className="btn btn-sm">{m.filterApply}</button>
        </div>
      </form>
    </details>
  );
}
