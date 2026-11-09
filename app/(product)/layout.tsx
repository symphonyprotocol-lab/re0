import type { ReactNode } from 'react';
import { currentUser } from '@/lib/http/session';
import { WorkspaceFrame } from '@/components/shell/workspace-frame';
import { SiteShell } from '@/components/site/site-shell';

/** Keep the same sidebar mounted across discovery, public Rees and private workspace pages. */
export default async function ProductLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return user ? <WorkspaceFrame user={user}>{children}</WorkspaceFrame> : <SiteShell>{children}</SiteShell>;
}
