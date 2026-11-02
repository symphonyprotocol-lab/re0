import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { WorkspaceFrame } from '@/components/shell/workspace-frame';
import { PATH_HEADER } from '@/lib/http/cookies';
import { currentUser } from '@/lib/http/session';

/** Every signed-in page: the session is checked here against the database, not by the middleware's cookie test. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) {
    /* The cookie outlived its session: come back here after signing in, as the middleware does. */
    const returnTo = (await headers()).get(PATH_HEADER);
    redirect(returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login');
  }
  return <WorkspaceFrame user={user}>{children}</WorkspaceFrame>;
}
