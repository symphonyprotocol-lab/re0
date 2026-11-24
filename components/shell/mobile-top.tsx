'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useShell } from '@/components/shell/app-shell';
import { useI18n } from '@/i18n/client';
import { BrandMark, BrandName } from '@/components/ui/brand-mark';
import { Icon } from '@/components/ui/icons';
import { LanguageMenu } from '@/components/ui/language-menu';

/**
 * The phone's top line (`.xtop`, columns.css; hidden above 760px): the brand
 * on the left and, signed in, the menu that opens the navigation drawer
 * (with 活动's dot). Every page in the shell starts with it -- the feed
 * pages above their column head (`FeedColumns`), the full-width pages above
 * their top bar (`Topbar`) -- so 首页, 我的帖子, 我的 Rees, 活动 and 设置
 * open on the same header. The page's own title is the row under it.
 */
export function MobileTop() {
  const { t } = useI18n();
  const { openDrawer, activitiesPending, signedIn } = useShell();
  const nav = t.common.nav;
  return (
    <div className="xtop">
      <Link href="/" className="wordmark" aria-label={nav.home}>
        <BrandMark />
        <BrandName />
      </Link>
      {signedIn ? (
        <button
          type="button"
          className="icon-btn mobile-menu"
          onClick={openDrawer}
          aria-label={activitiesPending ? `${nav.openMenu} · ${nav.activitiesPending}` : nav.openMenu}
          title={nav.openMenu}
        >
          <Icon name="menu" className="" />
          {activitiesPending && <i className="nav-dot" aria-hidden="true" />}
        </button>
      ) : (
        /* A visitor's phone: the bottom bar is the sign-in (v6), so the head leads to Rees and has the language -- there is no sidebar. */
        <div className="xtop-actions">
          <LanguageMenu quiet className="icon-btn xtop-language" />
          <Link href="/explore" className="icon-btn" aria-label={nav.discover} title={nav.discover}>
            <Icon name="compass" className="" />
          </Link>
        </div>
      )}
    </div>
  );
}
