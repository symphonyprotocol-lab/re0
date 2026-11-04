import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { listFirecrawlKeys } from '@/lib/services/firecrawl-keys';
import { serverMessages } from '@/i18n/server';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { FirecrawlKeysBoard } from '@/components/admin/firecrawl-keys-board';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverMessages()).t.firecrawl.title };
}

export default async function FirecrawlPage() {
  await requireAdministrator();
  const [{ t }, data] = await Promise.all([serverMessages(), listFirecrawlKeys()]);
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: t.console.nav.firecrawl }]} />
      <FirecrawlKeysBoard initial={JSON.parse(JSON.stringify(data))} />
    </ConsolePage>
  );
}
