import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { PATH_HEADER } from '@/lib/http/cookies';
import { currentUser } from '@/lib/http/session';
import { shellBilling } from '@/lib/services/billing';
import { unreadNotices } from '@/lib/services/notices';
import { reeCount } from '@/lib/services/rees';

/** Every signed-in page: the session is checked here against the database, not by the middleware's cookie test. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) {
    /* The cookie outlived its session: come back here after signing in, as the middleware does. */
    const returnTo = (await headers()).get(PATH_HEADER);
    redirect(returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login');
  }
  const [billing, count, jar, unread] = await Promise.all([shellBilling(user.id), reeCount(user.id), cookies(), unreadNotices(user.id)]);
  return (
    <AppShell
      user={{ name: user.name, avatar: user.avatarBlob, balance: billing.balance, plan: billing.plan, reeCount: count, unreadNotices: unread }}
      initialCollapsed={jar.get('re0_sidebar')?.value === 'collapsed'}
    >
      {children}
    </AppShell>
  );
}
