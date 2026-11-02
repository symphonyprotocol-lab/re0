import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import type { SessionUser } from '@/lib/services/auth';
import { shellBilling } from '@/lib/services/billing';
import { sidebarHistory } from '@/lib/services/conversations';
import { reeCount } from '@/lib/services/rees';
import { AppShell } from '@/components/shell/app-shell';

/** The signed-in frame with its sidebar data, shared by the workspace and by `/explore` and `/r/[slug]` once signed in. */
export async function WorkspaceFrame({ user, children }: { user: SessionUser; children: ReactNode }) {
  const [billing, count, history, jar] = await Promise.all([shellBilling(user.id), reeCount(user.id), sidebarHistory(user.id), cookies()]);
  return (
    <AppShell
      user={{ name: user.name, avatar: user.avatarBlob, balance: billing.balance, plan: billing.plan, reeCount: count, history }}
      initialCollapsed={jar.get('re0_sidebar')?.value === 'collapsed'}
    >
      {children}
    </AppShell>
  );
}
