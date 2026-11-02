import type { ReactNode } from 'react';
import { requireAdministrator } from '@/lib/http/admin';
import { pendingVerifications } from '@/lib/services/roles';
import { pendingKyc } from '@/lib/services/kyc';
import { openPayoutCount } from '@/lib/services/payouts';
import { ConsoleShell } from '@/components/admin/console-shell';

/** The console frame: its own session (checked here against the database), its sidebar and fixed bar. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const administrator = await requireAdministrator();
  const [verifications, kyc, payouts] = await Promise.all([pendingVerifications(), pendingKyc(), openPayoutCount()]);
  return (
    <ConsoleShell email={administrator.email} pendingVerifications={verifications} pendingKyc={kyc} openPayouts={payouts}>
      {children}
    </ConsoleShell>
  );
}
