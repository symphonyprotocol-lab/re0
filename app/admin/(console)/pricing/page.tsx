import { welcomeCredits } from '@/lib/services/signup-reward';
import { requireAdministrator } from '@/lib/http/admin';
import { currentPricing, paymentsConfigured } from '@/lib/services/pricing';
import { serverMessages } from '@/i18n/server';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { PricingBoard } from '@/components/admin/pricing-board';

export async function generateMetadata() {
  const { t } = await serverMessages();
  return { title: t.pricingAdmin.title };
}
export default async function PricingPage() {
  await requireAdministrator();
  const [{ t }, prices, welcome] = await Promise.all([serverMessages(), currentPricing(), welcomeCredits()]);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: t.pricingAdmin.title }]} />
      <PricingBoard welcome={welcome} initial={prices} configured={paymentsConfigured()} />
    </ConsolePage>
  );
}
