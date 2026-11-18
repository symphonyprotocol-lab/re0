import type { ReactNode } from 'react';
import { currentUser } from '@/lib/http/session';
import { WorkspaceFrame } from '@/components/shell/workspace-frame';
import { VisitorShell } from '@/components/shell/visitor-shell';

/** Keep the same sidebar mounted across 首页, discovery, public Rees and private workspace pages; visitors get the same three columns with a shorter navigation (v5). */
export default async function ProductLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return user ? <WorkspaceFrame user={user}>{children}</WorkspaceFrame> : <VisitorShell>{children}</VisitorShell>;
}
