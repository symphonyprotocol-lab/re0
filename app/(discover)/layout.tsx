import type { ReactNode } from 'react';
import { currentUser } from '@/lib/http/session';
import { WorkspaceFrame } from '@/components/shell/workspace-frame';
import { SiteShell } from '@/components/site/site-shell';

/**
 * `/explore` and `/r/[slug]`: open to everyone. A visitor sees them in the
 * public site's frame; once signed in, in the workspace with its sidebar
 * (prototype public-dot.js "已登录时在统一工作台右侧内容区打开").
 */
export default async function DiscoverLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return user ? <WorkspaceFrame user={user}>{children}</WorkspaceFrame> : <SiteShell>{children}</SiteShell>;
}
