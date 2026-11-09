import { ReePublication } from '@/components/rees/ree-publication';
import { ReeSettingsPreviewButton } from '@/components/rees/ree-settings-preview-button';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icons';
import { reeSourceCount } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { Topbar, type Crumb } from '@/components/shell/topbar';
import { ShareButton } from '@/components/share/share-button';

/**
 * A Ree's pages share one top bar: the way back to My Rees and the Ree's tabs
 * (settings, knowledge, video, statistics, chat). `crumbs` go after the Ree's
 * own, which then becomes a link (a source's page: 工作台 › 我的 Ree › Ree ›
 * 知识管理 › source, prototype app.js). The knowledge tab carries the number
 * of live sources (prototype knowledge.js `workTabs`). `actions` (a source's
 * previous / next) and the public page link sit at the end of the tab row;
 * on a phone the first row is only the way back and the Ree's name.
 */
export async function ReeTopbar({
  ree,
  active,
  actions,
  crumbs = [],
}: {
  ree: { id: string; name: string; slug?: string; isPublic?: boolean; isPublished?: boolean; moderatedAt?: Date | null };
  active: 'settings' | 'knowledge' | 'video' | 'statistics' | 'chat';
  actions?: ReactNode;
  crumbs?: Crumb[];
}) {
  const [{ t, locale }, sources] = await Promise.all([serverMessages(), reeSourceCount(ree.id)]);
  const tab = t.reeSetup.tabs;
  const nested = crumbs.length > 0;
  return (
    <Topbar
      crumbs={[
        { label: t.rees.title, href: '/rees' },
        { label: ree.name, ...(nested ? { href: `/rees/${ree.id}` } : {}) },
        ...crumbs,
      ]}
      tabsLabel={tab.label}
      tabs={[
        { label: tab.settings, href: `/rees/${ree.id}/settings`, active: active === 'settings', icon: 'settings' },
        { label: `${tab.knowledge} ${formatNumber(sources, locale)}`, href: `/rees/${ree.id}/knowledge`, active: active === 'knowledge', icon: 'file' },
        /* Step 7: the prototype's order is settings, knowledge, video, statistics, chat. */
        { label: t.video.tab, href: `/rees/${ree.id}/video`, active: active === 'video', icon: 'film' },
        { label: t.statistics.tab, href: `/rees/${ree.id}/statistics`, active: active === 'statistics', icon: 'dashboard' },
        { label: tab.chat, href: `/rees/${ree.id}/chat`, active: active === 'chat', icon: 'chat' },
      ]}
      mobileBack={{
        href: nested ? `/rees/${ree.id}/knowledge` : '/rees',
        label: ree.name,
        title: nested ? t.knowledge.page.back : t.reeSetup.wizard.backToList,
      }}
      rowActions={
        <>
          {actions}
          {active === 'settings' ? <ReeSettingsPreviewButton /> : (
            <Link href={`/rees/${ree.id}/preview`} className="btn-secondary btn-sm shrink-0">
              <Icon name="external" />
              {t.reeSetup.settings.preview}
            </Link>
          )}
          <ReePublication ree={{ ...ree, isPublic: Boolean(ree.isPublic), isPublished: Boolean(ree.isPublished) }} />
          {/* Step 4: a public Ree's page, apart from its tabs (prototype "公开页入口独立放在右侧"). */}
          {ree.isPublic && ree.isPublished && !ree.moderatedAt && ree.slug && (
            <Link href={`/r/${ree.slug}`} className="btn-ghost context-public-link" title={t.rees.publicPage} aria-label={t.rees.publicPage}>
              <Icon name="external" />
              <span>{t.rees.publicPage}</span>
            </Link>
          )}
          {/* Sharing: the share page `/s/[slug]`; a private or taken-down Ree's dialog says why it cannot be shared. */}
          {ree.slug && <ShareButton ree={{ name: ree.name, slug: ree.slug }} state={ree.moderatedAt ? 'moderated' : ree.isPublic ? 'public' : 'private'} settingsHref={`/rees/${ree.id}/settings`} />}
        </>
      }
    />
  );
}
