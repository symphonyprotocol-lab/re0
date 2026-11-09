import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { requireAdministrator } from '@/lib/http/admin';
import { pendingVerifications } from '@/lib/services/roles';
import { openPayoutCount } from '@/lib/services/payouts';
import { ConsoleShell } from '@/components/admin/console-shell';

/** The console frame: its own session (checked here against the database), its sidebar and fixed bar. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const administrator = await requireAdministrator();
  const [verifications, payouts, jar] = await Promise.all([pendingVerifications(), openPayoutCount(), cookies()]);
  // Deliberately loose: the badge only names where this console runs.
  const environment = process.env.VERCEL_ENV === 'production' ? 'production' : process.env.VERCEL_ENV === 'preview' ? 'preview' : process.env.NODE_ENV === 'production' ? 'production' : 'development';
  return (
    <ConsoleShell
      name={administrator.name}
      email={administrator.email}
      environment={environment}
      pendingVerifications={verifications}
      openPayouts={payouts}
      initialCollapsed={jar.get('re0_sidebar')?.value === 'collapsed'}
    >
      {children}
    </ConsoleShell>
  );
}
