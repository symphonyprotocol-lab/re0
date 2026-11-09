import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import type { SessionUser } from '@/lib/services/auth';
import { shellBilling } from '@/lib/services/billing';
import { sidebarHistory } from '@/lib/services/conversations';
import { unreadNotices } from '@/lib/services/notices';
import { reeCount } from '@/lib/services/rees';
import { AppShell } from '@/components/shell/app-shell';

/** The persistent signed-in frame, owned by the product layout for workspace and discovery routes. */
export async function WorkspaceFrame({ user, children }: { user: SessionUser; children: ReactNode }) {
  const [billing, count, history, jar, unread] = await Promise.all([
    shellBilling(user.id),
    reeCount(user.id),
    sidebarHistory(user.id),
    cookies(),
    unreadNotices(user.id),
  ]);
  return (
    <AppShell
      user={{ name: user.name, avatar: user.avatarBlob, balance: billing.balance, welcome: billing.welcome, plan: billing.plan, reeCount: count, history, unreadNotices: unread }}
      initialCollapsed={jar.get('re0_sidebar')?.value === 'collapsed'}
    >
      {children}
    </AppShell>
  );
}
