import type { ReactNode } from 'react';
import { SiteShell } from '@/components/site/site-shell';

/** `/`, `/pricing`, `/checkout`, `/legal/*`: the public site, open without signing in. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return <SiteShell>{children}</SiteShell>;
}
