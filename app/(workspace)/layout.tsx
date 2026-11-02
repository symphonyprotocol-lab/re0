import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { PATH_HEADER } from '@/lib/http/cookies';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { balanceOf } from '@/lib/services/credits';
import { reeCount } from '@/lib/services/rees';

/** Every signed-in page: the session is checked here against the database, not by the middleware's cookie test. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) {
    /* The cookie outlived its session: come back here after signing in, as the middleware does. */
    const returnTo = (await headers()).get(PATH_HEADER);
    redirect(returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login');
  }
  const [balance, count, jar] = await Promise.all([balanceOf(db(), user.id), reeCount(user.id), cookies()]);
  return (
    <AppShell
      user={{ name: user.name, avatar: user.avatarBlob, balance, reeCount: count }}
      initialCollapsed={jar.get('re0_sidebar')?.value === 'collapsed'}
    >
      {children}
    </AppShell>
  );
}
