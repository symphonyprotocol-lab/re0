import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { listAdministrators } from '@/lib/services/admin-administrators';
import { serverMessages } from '@/i18n/server';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { AdministratorsBoard, type AdministratorItem } from '@/components/admin/administrators-board';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverMessages()).t.consoleRees.administrators.title };
}

/** The console's administrators (2.5): any signed-in administrator manages them, as `/api/admin/administrators` allows. */
export default async function AdministratorsPage() {
  const administrator = await requireAdministrator();
  const [{ t }, items] = await Promise.all([serverMessages(), listAdministrators()]);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: t.console.nav.administrators }]} />
      <AdministratorsBoard initial={JSON.parse(JSON.stringify(items)) as AdministratorItem[]} self={administrator.id} />
    </ConsolePage>
  );
}
