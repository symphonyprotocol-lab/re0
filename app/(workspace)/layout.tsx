import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { balanceOf } from '@/lib/services/credits';
import { reeTotals } from '@/lib/services/rees';

/** Every signed-in page: the session is checked here against the database, not by the middleware's cookie test. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  const [balance, totals, jar] = await Promise.all([balanceOf(db(), user.id), reeTotals(user.id), cookies()]);
  return (
    <AppShell
      user={{ name: user.name, avatar: user.avatarBlob, balance, reeCount: totals.rees }}
      initialCollapsed={jar.get('re0_sidebar')?.value === 'collapsed'}
    >
      {children}
    </AppShell>
  );
}
