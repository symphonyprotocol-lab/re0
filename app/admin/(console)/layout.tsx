import type { ReactNode } from 'react';
import { requireAdministrator } from '@/lib/http/admin';
import { pendingVerifications } from '@/lib/services/roles';
import { ConsoleShell } from '@/components/admin/console-shell';

/** The console frame: its own session (checked here against the database), its sidebar and fixed bar. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const administrator = await requireAdministrator();
  return (
    <ConsoleShell email={administrator.email} pendingVerifications={await pendingVerifications()}>
      {children}
    </ConsoleShell>
  );
}
