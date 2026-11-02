import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icons';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';

/** A Ree's pages share one top bar: the way back to My Rees and the Ree's tabs (settings, knowledge, statistics, chat). */
export async function ReeTopbar({ ree, active, actions }: { ree: { id: string; name: string; slug?: string; isPublic?: boolean }; active: 'settings' | 'knowledge' | 'statistics' | 'chat'; actions?: ReactNode }) {
  const { t } = await serverMessages();
  const tab = t.reeSetup.tabs;
  return (
    <Topbar
      crumbs={[{ label: t.dashboard.title, href: '/dashboard' }, { label: t.rees.title, href: '/rees' }, { label: ree.name }]}
      tabsLabel={tab.label}
      tabs={[
        { label: tab.settings, href: `/rees/${ree.id}/settings`, active: active === 'settings', icon: 'settings' },
        { label: tab.knowledge, href: `/rees/${ree.id}/knowledge`, active: active === 'knowledge', icon: 'file' },
        { label: t.statistics.tab, href: `/rees/${ree.id}/statistics`, active: active === 'statistics', icon: 'dashboard' },
        { label: tab.chat, href: `/rees/${ree.id}/chat`, active: active === 'chat', icon: 'chat' },
      ]}
      actions={
        <>
          {actions}
          {/* Step 4: a public Ree's page, apart from its tabs (prototype "公开页入口独立放在右侧"). */}
          {ree.isPublic && ree.slug && (
            <Link href={`/r/${ree.slug}`} className="btn-ghost" title={t.discover.public.publicRee}>
              <Icon name="external" />
              <span className="hidden lg:inline">{t.discover.public.publicRee}</span>
            </Link>
          )}
        </>
      }
    />
  );
}
