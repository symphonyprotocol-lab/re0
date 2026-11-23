import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { listCeilings, listRateLimitExemptions, listRateLimits } from '@/lib/services/rate-limit-settings';
import { serverMessages } from '@/i18n/server';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { RateLimitsBoard } from '@/components/admin/rate-limits-board';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverMessages()).t.rateLimits.title };
}

export default async function RateLimitsPage() {
  await requireAdministrator();
  const [{ t }, limits, exemptions, ceilings] = await Promise.all([serverMessages(), listRateLimits(), listRateLimitExemptions(), listCeilings()]);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: t.console.nav['rate-limits'] }]} />
      <RateLimitsBoard initial={{ limits, exemptions, ceilings }} />
    </ConsolePage>
  );
}
