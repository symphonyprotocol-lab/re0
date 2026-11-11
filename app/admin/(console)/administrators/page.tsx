import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { listAdministrators } from '@/lib/services/admin-administrators';
import { serverMessages } from '@/i18n/server';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { AdministratorsBoard } from '@/components/admin/administrators-board';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverMessages()).t.consoleRees.administrators.title };
}

/** The console's administrators (2.5): every administrator sees the list; only the owner manages it, as `/api/admin/administrators` enforces. */
export default async function AdministratorsPage() {
  const administrator = await requireAdministrator();
  const [{ t }, items] = await Promise.all([serverMessages(), listAdministrators(administrator)]);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: t.console.nav.administrators }]} />
      <AdministratorsBoard initial={items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() }))} self={administrator.id} owner={administrator.role === 'owner'} selfEmail={administrator.email} />
    </ConsolePage>
  );
}
